// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC6551RegistryView {
    function account(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external view returns (address);
}

/// @title DaemonOptions — covered calls and cash-secured puts between sibling daemons. TESTNET until counsel.
/// @notice Physically settled and fully collateralised: a writer can never owe more than it locked here.
///         - A covered CALL escrows `amount` of the stock. Its buyer may, until expiry, pay `strike` (the total, in the
///           quote token) to the writer and receive the stock.
///         - A cash-secured PUT escrows `strike` of the quote token. Its buyer may, until expiry, deliver `amount` of the
///           stock to the writer and receive the quote.
///         The buyer pays `premium` (quote token) to the writer when it buys. An option nobody bought can be withdrawn
///         by its writer at any time; a bought one that wasn't exercised returns to the writer after expiry. No oracle,
///         no margin, no owner, no fee, no admin. Only wallets of this collection (checked against the ERC-6551
///         registry) may write or buy.
contract DaemonOptions {
    using SafeERC20 for IERC20;

    IERC6551RegistryView public constant REGISTRY = IERC6551RegistryView(0x000000006551c19487814612e58FE06813775758);
    address public immutable nft;
    address public immutable accountImpl;

    enum Kind { Call, Put }
    enum State { None, Listed, Bought, Exercised, Reclaimed }

    struct Option {
        address writer;
        address buyer;
        Kind kind;
        State state;
        uint64 expires;
        address underlying; // the stock
        uint256 amount; //     of the stock
        address quote; //      the dollar
        uint256 strike; //     total quote for the whole amount
        uint256 premium; //    quote, paid once, to the writer
    }

    mapping(uint256 => Option) public options;
    uint256 public nextId = 1;

    event Written(uint256 indexed id, address indexed writer, Kind kind, uint64 expires);
    event Bought(uint256 indexed id, address indexed writer, address indexed buyer);
    event Exercised(uint256 indexed id, address indexed writer, address indexed buyer);
    event Reclaimed(uint256 indexed id, address indexed writer);

    error NotADaemon(address who);
    error BadTerms();
    error WrongState(uint256 id, State state);
    error Expired(uint256 id);
    error NotExpired(uint256 id);
    error NotWriter();
    error NotBuyer();
    error SelfTrade();

    constructor(address nft_, address accountImpl_) {
        nft = nft_;
        accountImpl = accountImpl_;
    }

    function _isDaemon(address who, uint256 tokenId) internal view returns (bool) {
        return REGISTRY.account(accountImpl, bytes32(0), block.chainid, nft, tokenId) == who;
    }

    /// @notice write a covered call (escrows `amount` of `underlying`) or a cash-secured put (escrows `strike` of `quote`)
    function write(uint256 writerTokenId, Kind kind, address underlying, uint256 amount, address quote, uint256 strike, uint256 premium, uint64 expires)
        external
        returns (uint256 id)
    {
        if (!_isDaemon(msg.sender, writerTokenId)) revert NotADaemon(msg.sender);
        if (underlying == quote || amount == 0 || strike == 0 || expires <= block.timestamp) revert BadTerms();
        id = nextId++;
        options[id] = Option(msg.sender, address(0), kind, State.Listed, expires, underlying, amount, quote, strike, premium);
        if (kind == Kind.Call) IERC20(underlying).safeTransferFrom(msg.sender, address(this), amount);
        else IERC20(quote).safeTransferFrom(msg.sender, address(this), strike);
        emit Written(id, msg.sender, kind, expires);
    }

    /// @notice buy a listed option before its expiry: the premium goes to the writer, the right to the buyer
    function buy(uint256 id, uint256 buyerTokenId) external {
        Option storage o = options[id];
        if (o.state != State.Listed) revert WrongState(id, o.state);
        if (block.timestamp > o.expires) revert Expired(id);
        if (!_isDaemon(msg.sender, buyerTokenId)) revert NotADaemon(msg.sender);
        if (msg.sender == o.writer) revert SelfTrade();
        o.state = State.Bought;
        o.buyer = msg.sender;
        if (o.premium != 0) IERC20(o.quote).safeTransferFrom(msg.sender, o.writer, o.premium);
        emit Bought(id, o.writer, msg.sender);
    }

    /// @notice the buyer exercises, until expiry: a call pays the strike for the stock; a put delivers the stock for the strike
    function exercise(uint256 id) external {
        Option storage o = options[id];
        if (o.state != State.Bought) revert WrongState(id, o.state);
        if (msg.sender != o.buyer) revert NotBuyer();
        if (block.timestamp > o.expires) revert Expired(id);
        o.state = State.Exercised;
        if (o.kind == Kind.Call) {
            IERC20(o.quote).safeTransferFrom(msg.sender, o.writer, o.strike);
            IERC20(o.underlying).safeTransfer(msg.sender, o.amount);
        } else {
            IERC20(o.underlying).safeTransferFrom(msg.sender, o.writer, o.amount);
            IERC20(o.quote).safeTransfer(msg.sender, o.strike);
        }
        emit Exercised(id, o.writer, msg.sender);
    }

    /// @notice the writer takes its escrow back: an unsold option at any time, a bought one only after expiry
    function reclaim(uint256 id) external {
        Option storage o = options[id];
        if (msg.sender != o.writer) revert NotWriter();
        if (o.state == State.Bought) {
            if (block.timestamp <= o.expires) revert NotExpired(id);
        } else if (o.state != State.Listed) {
            revert WrongState(id, o.state);
        }
        o.state = State.Reclaimed;
        if (o.kind == Kind.Call) IERC20(o.underlying).safeTransfer(o.writer, o.amount);
        else IERC20(o.quote).safeTransfer(o.writer, o.strike);
        emit Reclaimed(id, o.writer);
    }
}
