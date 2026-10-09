// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC6551RegistryView {
    function account(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external view returns (address);
}

interface IAggregatorV3 {
    function getRoundData(uint80 roundId) external view returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80);
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80);
}

/// @title DaemonSwaps — bounded swaps between sibling daemons, instead of perps. TESTNET until counsel.
/// @notice One side is long a price feed, the other short, for a fixed term. The move is capped (±capBps), and BOTH
///         sides escrow their maximum loss (notional × cap) in the quote token up front — so nothing is on credit, there
///         is no margin and no liquidation, and neither side can lose more than it locked.
///         - entry: the feed's latest round when the swap is taken, no older than the maker's `maxStale`
///         - exit: the FIRST round at or after expiry — the settler names it; the contract checks the round before it
///           is earlier than expiry, so no one can pick a convenient later price
///         - if no settling round can be shown within GRACE after expiry, either side may refund both escrows whole
///         No owner, no fee, no admin. Only wallets of this collection may offer or take.
contract DaemonSwaps {
    using SafeERC20 for IERC20;

    IERC6551RegistryView public constant REGISTRY = IERC6551RegistryView(0x000000006551c19487814612e58FE06813775758);
    uint256 public constant GRACE = 7 days;
    uint16 public constant MAX_CAP_BPS = 5000;
    address public immutable nft;
    address public immutable accountImpl;

    enum State { None, Offered, Live, Settled, Refunded, Cancelled }

    struct Swap {
        address maker;
        address taker;
        bool makerLong;
        State state;
        uint16 capBps;
        uint32 term;
        uint32 maxStale;
        uint64 offerExpires;
        uint64 start;
        address feed;
        address quote;
        uint256 notional; // quote units
        int256 entry; //    feed answer at take
    }

    mapping(uint256 => Swap) internal swaps;
    uint256 public nextId = 1;

    event Offered(uint256 indexed id, address indexed maker, address feed, bool makerLong);
    event Taken(uint256 indexed id, address indexed taker, int256 entry, uint64 start);
    event Settled(uint256 indexed id, int256 exit, uint256 toLong, uint256 toShort);
    event Refunded(uint256 indexed id);
    event Cancelled(uint256 indexed id);

    error NotADaemon(address who);
    error BadTerms();
    error WrongState(uint256 id, State state);
    error OfferExpired(uint256 id);
    error SelfTrade();
    error StalePrice(uint256 updatedAt);
    error NotEnded(uint256 id);
    error NotTheSettlingRound(uint80 roundId);
    error GraceNotOver(uint256 id);
    error NotAParty();
    error NotMaker();

    constructor(address nft_, address accountImpl_) {
        nft = nft_;
        accountImpl = accountImpl_;
    }

    function _isDaemon(address who, uint256 tokenId) internal view returns (bool) {
        return REGISTRY.account(accountImpl, bytes32(0), block.chainid, nft, tokenId) == who;
    }

    function get(uint256 id) external view returns (Swap memory) {
        return swaps[id];
    }

    /// @notice the most either side can lose — and what each escrows
    function maxLoss(uint256 id) public view returns (uint256) {
        Swap storage s = swaps[id];
        return s.notional * s.capBps / 10_000;
    }

    struct Terms {
        address feed; //        a Chainlink AggregatorV3 proxy
        address quote; //       the dollar both sides escrow in
        uint256 notional; //    quote units
        uint16 capBps; //       the most the price may count as moving, either way (≤ MAX_CAP_BPS)
        uint32 term; //         seconds from take to expiry
        uint32 maxStale; //     the entry round may be at most this old when taken
        bool makerLong;
        uint64 offerExpires;
    }

    function offer(uint256 makerTokenId, Terms calldata t) external returns (uint256 id) {
        if (!_isDaemon(msg.sender, makerTokenId)) revert NotADaemon(msg.sender);
        if (t.feed.code.length == 0 || t.quote.code.length == 0 || t.capBps > MAX_CAP_BPS || t.term == 0 || t.maxStale == 0 || t.offerExpires <= block.timestamp) revert BadTerms();
        if (t.notional * t.capBps / 10_000 == 0) revert BadTerms(); // also refuses a zero cap: nothing at stake
        id = nextId++;
        swaps[id] = Swap(msg.sender, address(0), t.makerLong, State.Offered, t.capBps, t.term, t.maxStale, t.offerExpires, 0, t.feed, t.quote, t.notional, 0);
        IERC20(t.quote).safeTransferFrom(msg.sender, address(this), maxLoss(id));
        emit Offered(id, msg.sender, t.feed, t.makerLong);
    }

    function take(uint256 id, uint256 takerTokenId) external {
        Swap storage s = swaps[id];
        if (s.state != State.Offered) revert WrongState(id, s.state);
        if (block.timestamp > s.offerExpires) revert OfferExpired(id);
        if (!_isDaemon(msg.sender, takerTokenId)) revert NotADaemon(msg.sender);
        if (msg.sender == s.maker) revert SelfTrade();
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(s.feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || block.timestamp - updatedAt > s.maxStale) revert StalePrice(updatedAt);
        (s.state, s.taker, s.entry, s.start) = (State.Live, msg.sender, answer, uint64(block.timestamp));
        IERC20(s.quote).safeTransferFrom(msg.sender, address(this), maxLoss(id));
        emit Taken(id, msg.sender, answer, uint64(block.timestamp));
    }

    /// @notice what the long and the short receive for an exit price (pure arithmetic, exposed for checking)
    function payout(uint256 id, int256 exit) public view returns (uint256 toLong, uint256 toShort) {
        Swap storage s = swaps[id];
        uint256 m = maxLoss(id);
        // the long's P&L on the notional, to the quote's smallest unit, clamped to ± the max loss; the short's is its negative
        int256 pnl = int256(s.notional) * (exit - s.entry) / s.entry;
        if (pnl > int256(m)) pnl = int256(m);
        if (pnl < -int256(m)) pnl = -int256(m);
        toLong = uint256(int256(m) + pnl);
        toShort = 2 * m - toLong;
    }

    /// @param roundId the first feed round updated at or after expiry (the previous round must be before expiry)
    function settle(uint256 id, uint80 roundId) external {
        Swap storage s = swaps[id];
        if (s.state != State.Live) revert WrongState(id, s.state);
        uint256 end = uint256(s.start) + s.term;
        if (block.timestamp < end) revert NotEnded(id);
        (, int256 exit,, uint256 at,) = IAggregatorV3(s.feed).getRoundData(roundId);
        (,,, uint256 before,) = IAggregatorV3(s.feed).getRoundData(roundId - 1);
        if (exit <= 0 || at < end || before >= end) revert NotTheSettlingRound(roundId);
        s.state = State.Settled;
        (uint256 toLong, uint256 toShort) = payout(id, exit);
        (address long_, address short_) = s.makerLong ? (s.maker, s.taker) : (s.taker, s.maker);
        if (toLong != 0) IERC20(s.quote).safeTransfer(long_, toLong);
        if (toShort != 0) IERC20(s.quote).safeTransfer(short_, toShort);
        emit Settled(id, exit, toLong, toShort);
    }

    /// @notice no settling round shown within GRACE after expiry: either party takes both escrows back, whole
    function refund(uint256 id) external {
        Swap storage s = swaps[id];
        if (s.state != State.Live) revert WrongState(id, s.state);
        if (msg.sender != s.maker && msg.sender != s.taker) revert NotAParty();
        if (block.timestamp < uint256(s.start) + s.term + GRACE) revert GraceNotOver(id);
        s.state = State.Refunded;
        uint256 m = maxLoss(id);
        IERC20(s.quote).safeTransfer(s.maker, m);
        IERC20(s.quote).safeTransfer(s.taker, m);
        emit Refunded(id);
    }

    /// @notice the maker withdraws an untaken offer (any time; an expired one, too)
    function cancel(uint256 id) external {
        Swap storage s = swaps[id];
        if (s.state != State.Offered) revert WrongState(id, s.state);
        if (msg.sender != s.maker) revert NotMaker();
        s.state = State.Cancelled;
        IERC20(s.quote).safeTransfer(s.maker, maxLoss(id));
        emit Cancelled(id);
    }
}
