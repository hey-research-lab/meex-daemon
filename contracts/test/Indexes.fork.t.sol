// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DaemonAccount} from "../src/DaemonAccount.sol";
import {DaemonNFT} from "../src/DaemonNFT.sol";
import {DaemonSale} from "../src/DaemonSale.sol";
import {DaemonOTC} from "../src/DaemonOTC.sol";
import {DaemonIndexes, IndexShare} from "../src/DaemonIndexes.sol";

contract IdxStock is ERC20 {
    constructor(string memory s) ERC20(s, s) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// takes 1% of every transfer — a leg like this must never under-back a share
contract FeeToken is ERC20("Fee", "FEE") {
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 v) internal override {
        if (from != address(0) && to != address(0)) { uint256 fee = v / 100; super._update(from, address(0xdead), fee); v -= fee; }
        super._update(from, to, v);
    }
}

/// Fork of Robinhood Chain MAINNET (real ERC-6551 registry, real USDG) — the contract ships to TESTNET first.
///   forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract Indexes -vv
contract IndexesForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 constant FIRST = 0.01 ether;

    DaemonAccount impl;
    DaemonSale sale;
    DaemonNFT nft;
    DaemonIndexes vault;
    DaemonOTC otc;
    IdxStock nvda;
    IdxStock aapl;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 agentAPk = 0xA1;
    uint256 agentBPk = 0xB1;
    DaemonAccount a; // the manager
    DaemonAccount b; // a sibling

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url <RHC mainnet>");
        impl = new DaemonAccount(USDG);
        sale = new DaemonSale(address(impl), payable(makeAddr("treasury")), 100, 9000, FIRST, 13_000, 0);
        nft = new DaemonNFT(address(sale), 100, "https://obol.sh/d/", address(0), "");
        sale.setNft(address(nft));
        vault = new DaemonIndexes(address(nft), address(impl));
        otc = new DaemonOTC(address(nft), address(impl));
        nvda = new IdxStock("tNVDA");
        aapl = new IdxStock("tAAPL");
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.prank(alice);
        sale.buy{value: FIRST}(10);
        vm.prank(bob);
        sale.buy{value: FIRST}(11);
        a = DaemonAccount(payable(sale.walletOf(10)));
        b = DaemonAccount(payable(sale.walletOf(11)));
        deal(USDG, address(a), 20e6);
        deal(USDG, address(b), 20e6);
        nvda.mint(address(a), 10e18);
        aapl.mint(address(a), 10e18);
        address[] memory t = new address[](2);
        (t[0], t[1]) = (address(vault), address(otc));
        address[] memory none = new address[](0);
        vm.prank(alice);
        a.constitute(vm.addr(agentAPk), 25e6, 40e6, 0, t, none);
        vm.prank(bob);
        b.constitute(vm.addr(agentBPk), 25e6, 40e6, 0, t, none);
    }

    function asA(address to, bytes memory data) internal returns (bytes memory r) {
        vm.prank(vm.addr(agentAPk));
        r = a.execute(to, 0, data, 0);
    }

    function asB(address to, bytes memory data) internal returns (bytes memory r) {
        vm.prank(vm.addr(agentBPk));
        r = b.execute(to, 0, data, 0);
    }

    /// per share: 1 tNVDA + 2 tAAPL + 0.50 USDG, in ascending address order as create requires
    function basketOf() internal view returns (DaemonIndexes.Leg[] memory l) {
        address[3] memory tk = [address(nvda), address(aapl), USDG];
        uint256[3] memory am = [uint256(1e18), 2e18, 0.5e6];
        for (uint256 i; i < 3; ++i) for (uint256 j = i + 1; j < 3; ++j) if (tk[j] < tk[i]) { (tk[i], tk[j]) = (tk[j], tk[i]); (am[i], am[j]) = (am[j], am[i]); }
        l = new DaemonIndexes.Leg[](3);
        for (uint256 i; i < 3; ++i) l[i] = DaemonIndexes.Leg(tk[i], am[i]);
    }

    function create() internal returns (uint256 id, IndexShare s) {
        (uint256 i, address sh) = abi.decode(asA(address(vault), abi.encodeCall(DaemonIndexes.create, (10, "Test index", "tIDX", basketOf()))), (uint256, address));
        (id, s) = (i, IndexShare(sh));
    }

    function mintA(uint256 id, uint256 n) internal {
        asA(address(nvda), abi.encodeWithSelector(IERC20.approve.selector, address(vault), 1e18 * n));
        asA(address(aapl), abi.encodeWithSelector(IERC20.approve.selector, address(vault), 2e18 * n));
        asA(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(vault), 0.5e6 * n));
        asA(address(vault), abi.encodeCall(DaemonIndexes.mint, (id, n)));
    }

    function solvent(uint256 id, IndexShare s) internal view {
        DaemonIndexes.Leg[] memory l = vault.basket(id);
        for (uint256 i; i < l.length; ++i) assertGe(IERC20(l[i].token).balanceOf(address(vault)), s.totalSupply() * l[i].amount, "every share backed");
    }

    // ── create ───────────────────────────────────────────────────────────────────────────────────────────────────
    function test_createFixesTheBasket() public {
        (uint256 id, IndexShare s) = create();
        assertEq(s.decimals(), 0);
        assertEq(s.symbol(), "tIDX");
        assertEq(s.vault(), address(vault));
        assertEq(vault.idOfShare(address(s)), id);
        (address manager,) = vault.indexes(id);
        assertEq(manager, address(a));
        assertEq(vault.basket(id).length, 3);
    }

    function test_onlyDaemonsCreate() public {
        DaemonIndexes.Leg[] memory l = basketOf();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DaemonIndexes.NotADaemon.selector, alice));
        vault.create(10, "x", "x", l);
    }

    function test_badBasketsRefused() public {
        DaemonIndexes.Leg[] memory l = basketOf();
        DaemonIndexes.Leg[] memory dup = new DaemonIndexes.Leg[](2);
        (dup[0], dup[1]) = (l[0], l[0]);
        DaemonIndexes.Leg[] memory desc = new DaemonIndexes.Leg[](2);
        (desc[0], desc[1]) = (l[1], l[0]);
        DaemonIndexes.Leg[] memory zero = basketOf();
        zero[1].amount = 0;
        DaemonIndexes.Leg[] memory eoa = new DaemonIndexes.Leg[](1);
        eoa[0] = DaemonIndexes.Leg(alice, 1);
        DaemonIndexes.Leg[] memory empty = new DaemonIndexes.Leg[](0);
        DaemonIndexes.Leg[] memory many = new DaemonIndexes.Leg[](9);
        for (uint256 i; i < 9; ++i) many[i] = DaemonIndexes.Leg(address(new IdxStock("x")), 1);
        for (uint256 i; i < 9; ++i) for (uint256 j = i + 1; j < 9; ++j) if (many[j].token < many[i].token) (many[i], many[j]) = (many[j], many[i]);
        DaemonIndexes.Leg[][6] memory bad = [dup, desc, zero, eoa, empty, many];
        for (uint256 i; i < 6; ++i) {
            vm.expectRevert(DaemonIndexes.BadBasket.selector);
            asA(address(vault), abi.encodeCall(DaemonIndexes.create, (10, "x", "x", bad[i])));
        }
        DaemonIndexes.Leg[] memory eight = new DaemonIndexes.Leg[](8);
        for (uint256 i; i < 8; ++i) eight[i] = many[i];
        asA(address(vault), abi.encodeCall(DaemonIndexes.create, (10, "x", "x", eight))); // eight legs is the most
    }

    // ── mint and redeem, in kind ─────────────────────────────────────────────────────────────────────────────────
    function test_mintTakesExactBasketsRedeemReturnsThem() public {
        (uint256 id, IndexShare s) = create();
        mintA(id, 3);
        assertEq(s.balanceOf(address(a)), 3);
        assertEq(nvda.balanceOf(address(vault)), 3e18);
        assertEq(aapl.balanceOf(address(vault)), 6e18);
        assertEq(IERC20(USDG).balanceOf(address(vault)), 1.5e6);
        assertEq(a.spentToday(), 1.5e6, "the dollar leg counted against the wallet's daily cap");
        asA(address(vault), abi.encodeCall(DaemonIndexes.redeem, (id, 2)));
        assertEq(s.balanceOf(address(a)), 1);
        assertEq(nvda.balanceOf(address(a)), 9e18);
        assertEq(aapl.balanceOf(address(a)), 8e18);
        assertEq(IERC20(USDG).balanceOf(address(a)), 19.5e6);
        solvent(id, s);
    }

    function test_redeemMoreThanHeldReverts() public {
        (uint256 id, IndexShare s) = create();
        mintA(id, 1);
        vm.expectRevert();
        asA(address(vault), abi.encodeCall(DaemonIndexes.redeem, (id, 2)));
        vm.expectRevert(); // b holds none
        asB(address(vault), abi.encodeCall(DaemonIndexes.redeem, (id, 1)));
        solvent(id, s);
    }

    function test_zeroAndUnknownRefused() public {
        (uint256 id,) = create();
        vm.expectRevert(DaemonIndexes.ZeroShares.selector);
        asA(address(vault), abi.encodeCall(DaemonIndexes.mint, (id, 0)));
        vm.expectRevert(DaemonIndexes.ZeroShares.selector);
        asA(address(vault), abi.encodeCall(DaemonIndexes.redeem, (id, 0)));
        vm.expectRevert(abi.encodeWithSelector(DaemonIndexes.NoSuchIndex.selector, 99));
        asA(address(vault), abi.encodeCall(DaemonIndexes.mint, (99, 1)));
        vm.expectRevert(abi.encodeWithSelector(DaemonIndexes.NoSuchIndex.selector, 99));
        asA(address(vault), abi.encodeCall(DaemonIndexes.redeem, (99, 1)));
    }

    function test_onlyTheVaultMintsOrBurnsShares() public {
        (uint256 id, IndexShare s) = create();
        mintA(id, 1);
        vm.prank(address(a));
        vm.expectRevert("vault only");
        s.mint(address(a), 5);
        vm.prank(address(a));
        vm.expectRevert("vault only");
        s.burn(address(a), 1);
    }

    function test_shortMinterRevertsNothingMinted() public {
        (uint256 id, IndexShare s) = create();
        asA(address(nvda), abi.encodeWithSelector(IERC20.approve.selector, address(vault), 20e18));
        asA(address(aapl), abi.encodeWithSelector(IERC20.approve.selector, address(vault), 40e18));
        asA(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(vault), 10e6));
        vm.expectRevert(); // holds 10 tNVDA; 20 shares need 20
        asA(address(vault), abi.encodeCall(DaemonIndexes.mint, (id, 20)));
        assertEq(s.totalSupply(), 0);
        assertEq(nvda.balanceOf(address(vault)), 0);
    }

    function test_feeOnTransferLegCantUnderBack() public {
        FeeToken fee = new FeeToken();
        fee.mint(address(a), 100e18);
        DaemonIndexes.Leg[] memory l = new DaemonIndexes.Leg[](1);
        l[0] = DaemonIndexes.Leg(address(fee), 1e18);
        (uint256 id,) = abi.decode(asA(address(vault), abi.encodeCall(DaemonIndexes.create, (10, "f", "f", l))), (uint256, address));
        asA(address(fee), abi.encodeWithSelector(IERC20.approve.selector, address(vault), 1e18));
        vm.expectRevert(abi.encodeWithSelector(DaemonIndexes.ShortReceipt.selector, address(fee), 0.99e18, 1e18));
        asA(address(vault), abi.encodeCall(DaemonIndexes.mint, (id, 1)));
    }

    // ── the manager has no power over what backs the shares ──────────────────────────────────────────────────────
    function test_managerCantTakeTheBacking() public {
        (uint256 id, IndexShare s) = create();
        mintA(id, 2);
        vm.prank(vm.addr(agentAPk));
        a.execute(address(s), 0, abi.encodeWithSelector(IERC20.transfer.selector, alice, 2), 0); // to the holder: allowed
        // the manager's wallet now holds no shares, and there's no other way out of the vault
        vm.expectRevert();
        asA(address(vault), abi.encodeCall(DaemonIndexes.redeem, (id, 1)));
        solvent(id, s);
        // whoever holds a share redeems it — here the holder, directly, not a daemon
        vm.prank(alice);
        vault.redeem(id, 2);
        assertEq(nvda.balanceOf(alice), 2e18);
        assertEq(aapl.balanceOf(alice), 4e18);
        assertEq(IERC20(USDG).balanceOf(alice), 1e6);
        assertEq(s.totalSupply(), 0);
    }

    // ── shares trade through DaemonOTC like any token ────────────────────────────────────────────────────────────
    function test_siblingBuysSharesOverOtcAndRedeemsInKind() public {
        (uint256 id, IndexShare s) = create();
        mintA(id, 2);
        DaemonOTC.Leg[] memory give = new DaemonOTC.Leg[](1);
        give[0] = DaemonOTC.Leg(address(s), 1);
        DaemonOTC.Leg[] memory want = new DaemonOTC.Leg[](1);
        want[0] = DaemonOTC.Leg(USDG, 3e6);
        asA(address(s), abi.encodeWithSelector(IERC20.approve.selector, address(otc), 1));
        uint256 offer = abi.decode(asA(address(otc), abi.encodeCall(DaemonOTC.post, (10, give, want, uint64(block.timestamp + 1 days)))), (uint256));
        asB(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 3e6));
        asB(address(otc), abi.encodeCall(DaemonOTC.take, (offer, 11)));
        assertEq(s.balanceOf(address(b)), 1);
        asB(address(vault), abi.encodeCall(DaemonIndexes.redeem, (id, 1)));
        assertEq(nvda.balanceOf(address(b)), 1e18);
        assertEq(aapl.balanceOf(address(b)), 2e18);
        assertEq(IERC20(USDG).balanceOf(address(b)), 17.5e6, "paid 3.00, got back 0.50 in kind");
        solvent(id, s);
    }

    /// any sequence of mints and redeems leaves every share backed, and the last redeemer empties the vault exactly
    function testFuzz_alwaysBacked(uint8[6] calldata ops) public {
        (uint256 id, IndexShare s) = create();
        for (uint256 i; i < ops.length; ++i) {
            uint256 n = ops[i] % 4 + 1;
            if (ops[i] & 0x80 == 0 || s.balanceOf(address(a)) < n) { if (nvda.balanceOf(address(a)) >= n * 1e18 && aapl.balanceOf(address(a)) >= n * 2e18) mintA(id, n); }
            else asA(address(vault), abi.encodeCall(DaemonIndexes.redeem, (id, n)));
            solvent(id, s);
        }
        uint256 left = s.balanceOf(address(a));
        if (left > 0) asA(address(vault), abi.encodeCall(DaemonIndexes.redeem, (id, left)));
        assertEq(nvda.balanceOf(address(vault)), 0);
        assertEq(aapl.balanceOf(address(vault)), 0);
        assertEq(IERC20(USDG).balanceOf(address(vault)), 0);
    }
}
