// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC6551RegistryView {
    function account(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external view returns (address);
}

/// @title DaemonOTC — bundles between sibling daemons, escrowed, all-or-nothing.
/// @notice A maker daemon posts an offer: it escrows its legs here and names the legs it wants back. A sibling takes it
///         by delivering those legs; both sides move in the same transaction or none do. Only wallets of this
///         collection (checked against the ERC-6551 registry) may post or take. Nothing is on credit; the maker can
///         cancel an open offer and get its escrow back at any time. No owner, no fee, no admin.
contract DaemonOTC {
    using SafeERC20 for IERC20;

    IERC6551RegistryView public constant REGISTRY = IERC6551RegistryView(0x000000006551c19487814612e58FE06813775758);
    address public immutable nft;
    address public immutable accountImpl;

    struct Leg { address token; uint256 amount; }
    struct Offer { address maker; uint64 expires; bool open; }

    mapping(uint256 => Offer) public offers;
    mapping(uint256 => Leg[]) internal gives;
    mapping(uint256 => Leg[]) internal wants;
    uint256 public nextId = 1;

    event Posted(uint256 indexed id, address indexed maker, uint64 expires);
    event Taken(uint256 indexed id, address indexed maker, address indexed taker);
    event Cancelled(uint256 indexed id);

    error NotADaemon(address who);
    error NotOpen(uint256 id);
    error Expired(uint256 id);
    error NotMaker();
    error EmptyBundle();
    error SelfTrade();

    constructor(address nft_, address accountImpl_) {
        nft = nft_;
        accountImpl = accountImpl_;
    }

    function _isDaemon(address who, uint256 tokenId) internal view returns (bool) {
        return REGISTRY.account(accountImpl, bytes32(0), block.chainid, nft, tokenId) == who;
    }

    /// @param makerTokenId the maker's own daemon ID (proves msg.sender is a daemon of this collection)
    function post(uint256 makerTokenId, Leg[] calldata give, Leg[] calldata want, uint64 expires) external returns (uint256 id) {
        if (!_isDaemon(msg.sender, makerTokenId)) revert NotADaemon(msg.sender);
        if (give.length == 0 || want.length == 0) revert EmptyBundle();
        id = nextId++;
        offers[id] = Offer(msg.sender, expires, true);
        for (uint256 i; i < give.length; ++i) {
            IERC20(give[i].token).safeTransferFrom(msg.sender, address(this), give[i].amount);
            gives[id].push(give[i]);
        }
        for (uint256 i; i < want.length; ++i) wants[id].push(want[i]);
        emit Posted(id, msg.sender, expires);
    }

    function take(uint256 id, uint256 takerTokenId) external {
        Offer memory o = offers[id];
        if (!o.open) revert NotOpen(id);
        if (block.timestamp > o.expires) revert Expired(id);
        if (!_isDaemon(msg.sender, takerTokenId)) revert NotADaemon(msg.sender);
        if (msg.sender == o.maker) revert SelfTrade();
        offers[id].open = false;
        Leg[] storage w = wants[id];
        for (uint256 i; i < w.length; ++i) IERC20(w[i].token).safeTransferFrom(msg.sender, o.maker, w[i].amount);
        Leg[] storage g = gives[id];
        for (uint256 i; i < g.length; ++i) IERC20(g[i].token).safeTransfer(msg.sender, g[i].amount);
        emit Taken(id, o.maker, msg.sender);
    }

    function cancel(uint256 id) external {
        Offer memory o = offers[id];
        if (!o.open) revert NotOpen(id);
        if (msg.sender != o.maker) revert NotMaker();
        offers[id].open = false;
        Leg[] storage g = gives[id];
        for (uint256 i; i < g.length; ++i) IERC20(g[i].token).safeTransfer(o.maker, g[i].amount);
        emit Cancelled(id);
    }

    function legs(uint256 id) external view returns (Leg[] memory give, Leg[] memory want) {
        return (gives[id], wants[id]);
    }
}
