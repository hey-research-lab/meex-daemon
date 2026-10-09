// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

interface IERC6551RegistryView {
    function account(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external view returns (address);
}

/// @title IndexShare — one share of one DaemonIndexes basket. Whole shares only (0 decimals); only the vault mints and
///        burns, and only against the exact basket. An ordinary ERC-20 otherwise: it trades through DaemonOTC.
contract IndexShare is ERC20 {
    address public immutable vault;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        vault = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 n) external {
        require(msg.sender == vault, "vault only");
        _mint(to, n);
    }

    function burn(address from, uint256 n) external {
        require(msg.sender == vault, "vault only");
        _burn(from, n);
    }
}

/// @title DaemonIndexes — a daemon publishes a fixed basket; anyone mints shares by depositing it and redeems them for it.
/// @notice The Corpus rule: the basket is fixed at creation — no one can add an asset, change an amount, or withdraw what
///         backs the shares. Every share is backed by exactly one basket held here, so the vault always holds at least
///         `totalSupply × amount` of every leg, and any share redeems in kind, by whoever holds it. Only a daemon of this
///         collection (checked against the ERC-6551 registry) may create an index. No owner, no fee, no admin.
contract DaemonIndexes is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC6551RegistryView public constant REGISTRY = IERC6551RegistryView(0x000000006551c19487814612e58FE06813775758);
    uint256 public constant MAX_LEGS = 8;
    address public immutable nft;
    address public immutable accountImpl;

    struct Leg { address token; uint256 amount; } // per ONE share

    struct Index { address manager; IndexShare share; }

    mapping(uint256 => Index) public indexes;
    mapping(uint256 => Leg[]) internal baskets;
    mapping(address => uint256) public idOfShare;
    uint256 public nextId = 1;

    event Created(uint256 indexed id, address indexed manager, address share, string symbol);
    event Minted(uint256 indexed id, address indexed by, uint256 shares);
    event Redeemed(uint256 indexed id, address indexed by, uint256 shares);

    error NotADaemon(address who);
    error BadBasket();
    error NoSuchIndex(uint256 id);
    error ZeroShares();
    error ShortReceipt(address token, uint256 got, uint256 want);

    constructor(address nft_, address accountImpl_) {
        nft = nft_;
        accountImpl = accountImpl_;
    }

    function _isDaemon(address who, uint256 tokenId) internal view returns (bool) {
        return REGISTRY.account(accountImpl, bytes32(0), block.chainid, nft, tokenId) == who;
    }

    /// @param legs per-share amounts; tokens strictly ascending by address (so no duplicates), every amount > 0
    function create(uint256 managerTokenId, string calldata name, string calldata symbol, Leg[] calldata legs) external returns (uint256 id, address share) {
        if (!_isDaemon(msg.sender, managerTokenId)) revert NotADaemon(msg.sender);
        if (legs.length == 0 || legs.length > MAX_LEGS) revert BadBasket();
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].amount == 0 || legs[i].token.code.length == 0) revert BadBasket();
            if (i > 0 && uint160(legs[i].token) <= uint160(legs[i - 1].token)) revert BadBasket();
        }
        id = nextId++;
        IndexShare s = new IndexShare(name, symbol);
        indexes[id] = Index(msg.sender, s);
        idOfShare[address(s)] = id;
        for (uint256 i; i < legs.length; ++i) baskets[id].push(legs[i]);
        share = address(s);
        emit Created(id, msg.sender, share, symbol);
    }

    /// @notice deposit exactly `shares` baskets (each leg's receipt checked) and receive `shares` shares
    function mint(uint256 id, uint256 shares) external nonReentrant {
        IndexShare s = indexes[id].share;
        if (address(s) == address(0)) revert NoSuchIndex(id);
        if (shares == 0) revert ZeroShares();
        Leg[] storage b = baskets[id];
        for (uint256 i; i < b.length; ++i) {
            IERC20 t = IERC20(b[i].token);
            uint256 want = b[i].amount * shares;
            uint256 before = t.balanceOf(address(this));
            t.safeTransferFrom(msg.sender, address(this), want);
            uint256 got = t.balanceOf(address(this)) - before;
            if (got != want) revert ShortReceipt(address(t), got, want); // no fee-on-transfer leg can under-back a share
        }
        s.mint(msg.sender, shares);
        emit Minted(id, msg.sender, shares);
    }

    /// @notice burn `shares` and receive exactly that many baskets, in kind — whoever holds them
    function redeem(uint256 id, uint256 shares) external nonReentrant {
        IndexShare s = indexes[id].share;
        if (address(s) == address(0)) revert NoSuchIndex(id);
        if (shares == 0) revert ZeroShares();
        s.burn(msg.sender, shares);
        Leg[] storage b = baskets[id];
        for (uint256 i; i < b.length; ++i) IERC20(b[i].token).safeTransfer(msg.sender, b[i].amount * shares);
        emit Redeemed(id, msg.sender, shares);
    }

    function basket(uint256 id) external view returns (Leg[] memory) {
        return baskets[id];
    }
}
