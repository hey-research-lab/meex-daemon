// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DaemonAccount} from "../src/DaemonAccount.sol";
import {DaemonNFT} from "../src/DaemonNFT.sol";
import {DaemonSale} from "../src/DaemonSale.sol";
import {DaemonOptions} from "../src/DaemonOptions.sol";

contract OptStock is ERC20("Test NVDA", "tNVDA") {
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// Fork of Robinhood Chain MAINNET (real ERC-6551 registry, real USDG) — the contract itself ships to TESTNET only.
///   forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract Options -vv
contract OptionsForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 constant FIRST = 0.01 ether;

    DaemonAccount impl;
    DaemonSale sale;
    DaemonNFT nft;
    DaemonOptions opt;
    OptStock stock;
    address payable treasury = payable(makeAddr("shyguy-llc-treasury"));
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 agentAPk = 0xA1;
    uint256 agentBPk = 0xB1;
    DaemonAccount a; // writer side by default: holds stock and dollars
    DaemonAccount b; // buyer side
    uint64 exp;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url <RHC mainnet>");
        impl = new DaemonAccount(USDG);
        sale = new DaemonSale(address(impl), treasury, 100, 9000, FIRST, 13_000, 0);
        nft = new DaemonNFT(address(sale), 100, "https://obol.sh/d/", address(0), "");
        sale.setNft(address(nft));
        opt = new DaemonOptions(address(nft), address(impl));
        stock = new OptStock();
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.prank(alice);
        sale.buy{value: FIRST}(10);
        vm.prank(bob);
        sale.buy{value: FIRST}(11);
        a = DaemonAccount(payable(sale.walletOf(10)));
        b = DaemonAccount(payable(sale.walletOf(11)));
        deal(USDG, address(a), 30e6);
        deal(USDG, address(b), 30e6);
        stock.mint(address(a), 5e18);
        stock.mint(address(b), 5e18);
        address[] memory t = new address[](1);
        t[0] = address(opt);
        address[] memory none = new address[](0);
        vm.prank(alice);
        a.constitute(vm.addr(agentAPk), 25e6, 40e6, 0, t, none);
        vm.prank(bob);
        b.constitute(vm.addr(agentBPk), 25e6, 40e6, 0, t, none);
        exp = uint64(block.timestamp + 3 days);
    }

    // ── helpers: every call goes through the daemon's wallet, as its agent ────────────────────────────────────────
    function asA(address to, bytes memory data) internal returns (bytes memory r) {
        vm.prank(vm.addr(agentAPk));
        r = a.execute(to, 0, data, 0);
    }

    function asB(address to, bytes memory data) internal returns (bytes memory r) {
        vm.prank(vm.addr(agentBPk));
        r = b.execute(to, 0, data, 0);
    }

    function approveA(address token, uint256 amt) internal { asA(token, abi.encodeWithSelector(IERC20.approve.selector, address(opt), amt)); }
    function approveB(address token, uint256 amt) internal { asB(token, abi.encodeWithSelector(IERC20.approve.selector, address(opt), amt)); }

    /// A writes: a call on 3 stock struck at 6.00 total, premium 0.50 — or a put on the same terms
    function writeA(DaemonOptions.Kind kind) internal returns (uint256 id) {
        if (kind == DaemonOptions.Kind.Call) approveA(address(stock), 3e18);
        else approveA(USDG, 6e6);
        id = abi.decode(asA(address(opt), abi.encodeCall(DaemonOptions.write, (10, kind, address(stock), 3e18, USDG, 6e6, 0.5e6, exp))), (uint256));
    }

    function buyB(uint256 id) internal {
        approveB(USDG, 0.5e6);
        asB(address(opt), abi.encodeCall(DaemonOptions.buy, (id, 11)));
    }

    function stateOf(uint256 id) internal view returns (DaemonOptions.State s) {
        (,,, s,,,,,,) = opt.options(id);
    }

    // ── covered call ─────────────────────────────────────────────────────────────────────────────────────────────
    function test_coveredCallExercised() public {
        uint256 id = writeA(DaemonOptions.Kind.Call);
        assertEq(stock.balanceOf(address(opt)), 3e18, "the stock is escrowed");
        buyB(id);
        assertEq(IERC20(USDG).balanceOf(address(a)), 30.5e6, "premium to the writer");
        approveB(USDG, 6e6);
        asB(address(opt), abi.encodeCall(DaemonOptions.exercise, (id)));
        assertEq(stock.balanceOf(address(b)), 8e18, "buyer got the stock");
        assertEq(IERC20(USDG).balanceOf(address(a)), 36.5e6, "writer got the strike");
        assertEq(IERC20(USDG).balanceOf(address(b)), 23.5e6, "buyer paid premium + strike");
        assertEq(stock.balanceOf(address(opt)), 0);
        assertEq(uint8(stateOf(id)), uint8(DaemonOptions.State.Exercised));
        assertEq(b.spentToday(), 6.5e6, "premium and strike both counted against the buyer's daily cap");
    }

    function test_coveredCallExpiresBackToWriter() public {
        uint256 id = writeA(DaemonOptions.Kind.Call);
        buyB(id);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.NotExpired.selector, id));
        asA(address(opt), abi.encodeCall(DaemonOptions.reclaim, (id))); // not while the buyer still holds the right
        vm.warp(exp + 1);
        approveB(USDG, 6e6);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.Expired.selector, id));
        asB(address(opt), abi.encodeCall(DaemonOptions.exercise, (id)));
        asA(address(opt), abi.encodeCall(DaemonOptions.reclaim, (id)));
        assertEq(stock.balanceOf(address(a)), 5e18, "stock back to the writer");
        assertEq(IERC20(USDG).balanceOf(address(a)), 30.5e6, "the writer keeps the premium");
    }

    function test_exerciseAtTheExpirySecondReclaimAfter() public {
        uint256 id = writeA(DaemonOptions.Kind.Call);
        buyB(id);
        vm.warp(exp); // the last second is still the buyer's
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.NotExpired.selector, id));
        asA(address(opt), abi.encodeCall(DaemonOptions.reclaim, (id)));
        approveB(USDG, 6e6);
        asB(address(opt), abi.encodeCall(DaemonOptions.exercise, (id)));
        vm.warp(exp + 1);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.WrongState.selector, id, DaemonOptions.State.Exercised));
        asA(address(opt), abi.encodeCall(DaemonOptions.reclaim, (id))); // no reclaiming what was exercised
    }

    // ── cash-secured put ─────────────────────────────────────────────────────────────────────────────────────────
    function test_cashSecuredPutExercised() public {
        uint256 id = writeA(DaemonOptions.Kind.Put);
        assertEq(IERC20(USDG).balanceOf(address(opt)), 6e6, "the strike is escrowed");
        assertEq(a.spentToday(), 6e6, "the escrowed cash counted against the writer's daily cap");
        buyB(id);
        approveB(address(stock), 3e18);
        asB(address(opt), abi.encodeCall(DaemonOptions.exercise, (id)));
        assertEq(stock.balanceOf(address(a)), 8e18, "writer got the stock");
        assertEq(IERC20(USDG).balanceOf(address(b)), 35.5e6, "buyer got the strike, less the premium");
        assertEq(IERC20(USDG).balanceOf(address(opt)), 0);
    }

    function test_putExpiresCashBack() public {
        uint256 id = writeA(DaemonOptions.Kind.Put);
        buyB(id);
        vm.warp(exp + 1);
        asA(address(opt), abi.encodeCall(DaemonOptions.reclaim, (id)));
        assertEq(IERC20(USDG).balanceOf(address(a)), 30.5e6, "cash back, premium kept");
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.WrongState.selector, id, DaemonOptions.State.Reclaimed));
        asA(address(opt), abi.encodeCall(DaemonOptions.reclaim, (id))); // never twice
    }

    // ── the writer never owes more than it locked ────────────────────────────────────────────────────────────────
    function test_escrowIsWholeAcrossOptions() public {
        uint256 c1 = writeA(DaemonOptions.Kind.Call);
        uint256 p1 = writeA(DaemonOptions.Kind.Put);
        buyB(c1);
        buyB(p1);
        approveB(address(stock), 3e18);
        asB(address(opt), abi.encodeCall(DaemonOptions.exercise, (p1)));
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.WrongState.selector, p1, DaemonOptions.State.Exercised));
        asB(address(opt), abi.encodeCall(DaemonOptions.exercise, (p1))); // the same put twice
        assertEq(stock.balanceOf(address(opt)), 3e18, "the call's stock is untouched");
        assertEq(IERC20(USDG).balanceOf(address(opt)), 0);
    }

    function test_unsoldWithdrawnAnytimeThenUnbuyable() public {
        uint256 id = writeA(DaemonOptions.Kind.Call);
        asA(address(opt), abi.encodeCall(DaemonOptions.reclaim, (id)));
        assertEq(stock.balanceOf(address(a)), 5e18);
        approveB(USDG, 0.5e6);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.WrongState.selector, id, DaemonOptions.State.Reclaimed));
        asB(address(opt), abi.encodeCall(DaemonOptions.buy, (id, 11)));
    }

    // ── who may do what ──────────────────────────────────────────────────────────────────────────────────────────
    function test_onlyDaemonsWriteOrBuy() public {
        stock.mint(alice, 3e18);
        vm.startPrank(alice);
        stock.approve(address(opt), 3e18);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.NotADaemon.selector, alice));
        opt.write(10, DaemonOptions.Kind.Call, address(stock), 3e18, USDG, 6e6, 0, exp);
        vm.stopPrank();
        uint256 id = writeA(DaemonOptions.Kind.Call);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.NotADaemon.selector, alice));
        opt.buy(id, 11); // claiming daemon 11's ID doesn't make alice its wallet
    }

    function test_onlyTheBuyerExercisesOnlyTheWriterReclaims() public {
        uint256 id = writeA(DaemonOptions.Kind.Call);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.WrongState.selector, id, DaemonOptions.State.Listed));
        asB(address(opt), abi.encodeCall(DaemonOptions.exercise, (id))); // not bought yet
        vm.expectRevert(DaemonOptions.NotWriter.selector);
        asB(address(opt), abi.encodeCall(DaemonOptions.reclaim, (id)));
        buyB(id);
        approveA(USDG, 6e6);
        vm.expectRevert(DaemonOptions.NotBuyer.selector);
        asA(address(opt), abi.encodeCall(DaemonOptions.exercise, (id)));
        vm.prank(alice);
        vm.expectRevert(DaemonOptions.NotBuyer.selector);
        opt.exercise(id);
    }

    function test_selfBuyAndDoubleBuyRefused() public {
        uint256 id = writeA(DaemonOptions.Kind.Call);
        approveA(USDG, 0.5e6);
        vm.expectRevert(DaemonOptions.SelfTrade.selector);
        asA(address(opt), abi.encodeCall(DaemonOptions.buy, (id, 10)));
        buyB(id);
        approveB(USDG, 0.5e6);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.WrongState.selector, id, DaemonOptions.State.Bought));
        asB(address(opt), abi.encodeCall(DaemonOptions.buy, (id, 11)));
    }

    function test_noBuyingAfterExpiry() public {
        uint256 id = writeA(DaemonOptions.Kind.Call);
        vm.warp(exp + 1);
        approveB(USDG, 0.5e6);
        vm.expectRevert(abi.encodeWithSelector(DaemonOptions.Expired.selector, id));
        asB(address(opt), abi.encodeCall(DaemonOptions.buy, (id, 11)));
    }

    function test_badTermsRefused() public {
        approveA(address(stock), 3e18);
        bytes[4] memory bad = [
            abi.encodeCall(DaemonOptions.write, (10, DaemonOptions.Kind.Call, USDG, 3e6, USDG, 6e6, 0, exp)), //               same token
            abi.encodeCall(DaemonOptions.write, (10, DaemonOptions.Kind.Call, address(stock), 0, USDG, 6e6, 0, exp)), //       no amount
            abi.encodeCall(DaemonOptions.write, (10, DaemonOptions.Kind.Call, address(stock), 3e18, USDG, 0, 0, exp)), //      no strike
            abi.encodeCall(DaemonOptions.write, (10, DaemonOptions.Kind.Call, address(stock), 3e18, USDG, 6e6, 0, uint64(block.timestamp))) // already expired
        ];
        for (uint256 i; i < 4; ++i) {
            vm.expectRevert(DaemonOptions.BadTerms.selector);
            asA(address(opt), bad[i]);
        }
    }

    function test_writerShortRevertsNothingWritten() public {
        approveA(address(stock), 9e18);
        vm.expectRevert(); // holds 5, writes on 9
        asA(address(opt), abi.encodeCall(DaemonOptions.write, (10, DaemonOptions.Kind.Call, address(stock), 9e18, USDG, 6e6, 0, exp)));
        assertEq(opt.nextId(), 1);
    }

    function test_putCashCappedByTheWallet() public {
        // a put's escrow is dollars leaving: the wallet's per-call approve cap stops a put struck over 25
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.OverCap.selector, 26e6, 25e6));
        approveA(USDG, 26e6);
    }
}
