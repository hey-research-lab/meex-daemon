// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DaemonAccount} from "../src/DaemonAccount.sol";
import {DaemonNFT} from "../src/DaemonNFT.sol";
import {DaemonSale} from "../src/DaemonSale.sol";
import {DaemonSwaps, IAggregatorV3} from "../src/DaemonSwaps.sol";
import {MirrorFeed} from "../src/test-chain/MirrorFeed.sol";

/// Fork of Robinhood Chain MAINNET: the real ERC-6551 registry, real USDG, and Chainlink's real NVDA/USD feed.
///   forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract Swaps -vv
contract SwapsForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant CL_NVDA = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15; // Chainlink "Robinhood NVDA / USD", 8 decimals
    uint256 constant FIRST = 0.01 ether;

    DaemonAccount impl;
    DaemonSale sale;
    DaemonNFT nft;
    DaemonSwaps sw;
    MirrorFeed feed;
    address feeder = makeAddr("feeder");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 agentAPk = 0xA1;
    uint256 agentBPk = 0xB1;
    DaemonAccount a; // maker
    DaemonAccount b; // taker
    uint80 rid;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url <RHC mainnet>");
        impl = new DaemonAccount(USDG);
        sale = new DaemonSale(address(impl), payable(makeAddr("treasury")), 100, 9000, FIRST, 13_000, 0);
        nft = new DaemonNFT(address(sale), 100, "https://obol.sh/d/", address(0), "");
        sale.setNft(address(nft));
        sw = new DaemonSwaps(address(nft), address(impl));
        feed = new MirrorFeed(feeder, 8, "NVDA / USD (mirror, testnet)", CL_NVDA);
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
        address[] memory t = new address[](1);
        t[0] = address(sw);
        address[] memory none = new address[](0);
        vm.prank(alice);
        a.constitute(vm.addr(agentAPk), 25e6, 40e6, 0, t, none);
        vm.prank(bob);
        b.constitute(vm.addr(agentBPk), 25e6, 40e6, 0, t, none);
        price(200e8); // the entry round
    }

    function price(int256 px) internal {
        vm.prank(feeder);
        feed.post(++rid, px, block.timestamp);
    }

    function asA(address to, bytes memory data) internal returns (bytes memory r) {
        vm.prank(vm.addr(agentAPk));
        r = a.execute(to, 0, data, 0);
    }

    function asB(address to, bytes memory data) internal returns (bytes memory r) {
        vm.prank(vm.addr(agentBPk));
        r = b.execute(to, 0, data, 0);
    }

    function terms(address f, bool makerLong) internal view returns (DaemonSwaps.Terms memory) {
        // notional 10 USDG, cap ±20% → each side escrows 2.00; a 1-day term; entry no older than 1 h
        return DaemonSwaps.Terms(f, USDG, 10e6, 2000, 1 days, 1 hours, makerLong, uint64(block.timestamp + 1 days));
    }

    function offerA(address f, bool makerLong) internal returns (uint256 id) {
        asA(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(sw), 2e6));
        id = abi.decode(asA(address(sw), abi.encodeCall(DaemonSwaps.offer, (10, terms(f, makerLong)))), (uint256));
    }

    function takeB(uint256 id) internal {
        asB(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(sw), 2e6));
        asB(address(sw), abi.encodeCall(DaemonSwaps.take, (id, 11)));
    }

    /// a live swap, A long; then the price at expiry is `exit` (one round just before expiry at 200, then the exit)
    function liveThenExit(int256 exit, bool makerLong) internal returns (uint256 id, uint80 settling) {
        id = offerA(address(feed), makerLong);
        takeB(id);
        vm.warp(block.timestamp + 1 days - 60);
        price(200e8);
        vm.warp(block.timestamp + 120);
        price(exit);
        settling = rid;
    }

    function usdg(address w) internal view returns (uint256) { return IERC20(USDG).balanceOf(w); }

    // ── against Chainlink's real feed ────────────────────────────────────────────────────────────────────────────
    function test_entryIsChainlinksRealNvdaRound() public {
        (, int256 real,, uint256 at,) = IAggregatorV3(CL_NVDA).latestRoundData();
        assertGt(real, 0);
        DaemonSwaps.Terms memory t = terms(CL_NVDA, true);
        t.maxStale = uint32(block.timestamp - at + 60); // accept the real feed's age at the fork block
        asA(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(sw), 2e6));
        uint256 id = abi.decode(asA(address(sw), abi.encodeCall(DaemonSwaps.offer, (10, t))), (uint256));
        takeB(id);
        assertEq(sw.get(id).entry, real, "entry is the real NVDA/USD answer");
        assertEq(usdg(address(sw)), 4e6, "both sides escrowed their max loss");
    }

    function test_settlesOnChainlinksRealFeedShape() public {
        // the real proxy's round ids are phase-encoded; settle against mocked rounds at those ids
        (uint80 r0, int256 real,, uint256 at,) = IAggregatorV3(CL_NVDA).latestRoundData();
        DaemonSwaps.Terms memory t = terms(CL_NVDA, true);
        t.maxStale = uint32(block.timestamp - at + 60);
        asA(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(sw), 2e6));
        uint256 id = abi.decode(asA(address(sw), abi.encodeCall(DaemonSwaps.offer, (10, t))), (uint256));
        takeB(id);
        uint256 end = block.timestamp + 1 days;
        vm.warp(end + 3 days);
        vm.mockCall(CL_NVDA, abi.encodeCall(IAggregatorV3.getRoundData, (r0 + 5)), abi.encode(r0 + 5, real * 105 / 100, end + 10, end + 10, r0 + 5));
        vm.mockCall(CL_NVDA, abi.encodeCall(IAggregatorV3.getRoundData, (r0 + 4)), abi.encode(r0 + 4, real, end - 10, end - 10, r0 + 4));
        sw.settle(id, r0 + 5);
        assertApproxEqAbs(usdg(address(a)), 30e6 + 0.5e6, 1, "long +5% of 10 = +0.50, to the micro (not rounded to a whole bp)");
    }

    // ── settlement arithmetic ────────────────────────────────────────────────────────────────────────────────────
    function test_longGainsShortLosesWithinTheCap() public {
        (uint256 id, uint80 r) = liveThenExit(210e8, true); // +5%
        sw.settle(id, r);
        assertEq(usdg(address(a)), 30.5e6, "long: 2.00 back + 0.50");
        assertEq(usdg(address(b)), 29.5e6, "short: 2.00 back - 0.50");
        assertEq(usdg(address(sw)), 0);
    }

    function test_moveBeyondTheCapIsClamped() public {
        (uint256 id, uint80 r) = liveThenExit(300e8, true); // +50%, capped at +20%
        sw.settle(id, r);
        assertEq(usdg(address(a)), 32e6, "long takes the short's whole escrow, no more");
        assertEq(usdg(address(b)), 28e6, "short loses exactly its max loss");
    }

    function test_makerShortWinsADrop() public {
        (uint256 id, uint80 r) = liveThenExit(190e8, false); // -5%, A short
        sw.settle(id, r);
        assertEq(usdg(address(a)), 30.5e6);
        assertEq(usdg(address(b)), 29.5e6);
    }

    function test_crashClampedToo() public {
        (uint256 id, uint80 r) = liveThenExit(1e8, true); // -99.5%
        sw.settle(id, r);
        assertEq(usdg(address(a)), 28e6, "long loses its max loss, never more");
        assertEq(usdg(address(b)), 32e6);
    }

    function testFuzz_conserved(int256 exit, bool makerLong) public {
        exit = bound(exit, 1, 1e14);
        (uint256 id,) = liveThenExit(200e8, makerLong);
        (uint256 l, uint256 s) = sw.payout(id, exit);
        assertEq(l + s, 4e6, "the two escrows, exactly, between them");
        assertLe(l, 4e6);
        assertLe(s, 4e6);
    }

    // ── the settling round is the first at or after expiry, and only that ───────────────────────────────────────
    function test_onlyTheFirstRoundAfterExpirySettles() public {
        (uint256 id, uint80 r) = liveThenExit(210e8, true);
        vm.warp(block.timestamp + 60);
        price(250e8); // a later, more convenient round
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.NotTheSettlingRound.selector, r + 1));
        sw.settle(id, r + 1);
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.NotTheSettlingRound.selector, r - 1));
        sw.settle(id, r - 1); // before expiry
        sw.settle(id, r);
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.WrongState.selector, id, DaemonSwaps.State.Settled));
        sw.settle(id, r);
    }

    function test_notBeforeExpiry() public {
        uint256 id = offerA(address(feed), true);
        takeB(id);
        vm.warp(block.timestamp + 1 days - 1);
        price(210e8);
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.NotEnded.selector, id));
        sw.settle(id, rid);
    }

    function test_aBadExitPriceDoesntSettle() public {
        (uint256 id, uint80 r) = liveThenExit(210e8, true);
        vm.mockCall(address(feed), abi.encodeCall(IAggregatorV3.getRoundData, (r)), abi.encode(r, int256(0), block.timestamp, block.timestamp, r));
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.NotTheSettlingRound.selector, r));
        sw.settle(id, r);
    }

    // ── no price → no loss ───────────────────────────────────────────────────────────────────────────────────────
    function test_refundAfterGraceOnlyByAParty() public {
        uint256 id = offerA(address(feed), true);
        takeB(id);
        vm.warp(block.timestamp + 1 days + 7 days - 1);
        vm.prank(address(a));
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.GraceNotOver.selector, id));
        sw.refund(id);
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        vm.expectRevert(DaemonSwaps.NotAParty.selector);
        sw.refund(id);
        asB(address(sw), abi.encodeCall(DaemonSwaps.refund, (id)));
        assertEq(usdg(address(a)), 30e6);
        assertEq(usdg(address(b)), 30e6);
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.WrongState.selector, id, DaemonSwaps.State.Refunded));
        sw.settle(id, rid);
    }

    function test_noRefundOfASettledSwap() public {
        (uint256 id, uint80 r) = liveThenExit(210e8, true);
        uint256 other = offerA(address(feed), true); // another escrow sits in the contract
        sw.settle(id, r);
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.WrongState.selector, id, DaemonSwaps.State.Settled));
        asB(address(sw), abi.encodeCall(DaemonSwaps.refund, (id)));
        assertEq(usdg(address(sw)), sw.maxLoss(other), "the other offer's escrow is whole");
    }

    // ── offers ───────────────────────────────────────────────────────────────────────────────────────────────────
    function test_staleEntryRefused() public {
        uint256 id = offerA(address(feed), true);
        vm.warp(block.timestamp + 1 hours + 1);
        asB(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(sw), 2e6));
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.StalePrice.selector, block.timestamp - 1 hours - 1));
        asB(address(sw), abi.encodeCall(DaemonSwaps.take, (id, 11)));
    }

    function test_cancelExpiryTwiceSelf() public {
        uint256 id = offerA(address(feed), true);
        vm.prank(address(b));
        vm.expectRevert(DaemonSwaps.NotMaker.selector);
        sw.cancel(id);
        asA(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(sw), 2e6));
        vm.expectRevert(DaemonSwaps.SelfTrade.selector);
        asA(address(sw), abi.encodeCall(DaemonSwaps.take, (id, 10)));
        asA(address(sw), abi.encodeCall(DaemonSwaps.cancel, (id)));
        assertEq(usdg(address(a)), 30e6, "escrow back");
        asB(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(sw), 2e6));
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.WrongState.selector, id, DaemonSwaps.State.Cancelled));
        asB(address(sw), abi.encodeCall(DaemonSwaps.take, (id, 11)));
        uint256 id2 = offerA(address(feed), true);
        vm.warp(block.timestamp + 1 days + 1);
        price(200e8);
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.OfferExpired.selector, id2));
        asB(address(sw), abi.encodeCall(DaemonSwaps.take, (id2, 11)));
        takeB(offerA(address(feed), true));
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.WrongState.selector, 3, DaemonSwaps.State.Live));
        asB(address(sw), abi.encodeCall(DaemonSwaps.take, (3, 11))); // taken twice
    }

    function test_onlyDaemons() public {
        DaemonSwaps.Terms memory t = terms(address(feed), true);
        deal(USDG, alice, 5e6);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(sw), 2e6);
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.NotADaemon.selector, alice));
        sw.offer(10, t);
        vm.stopPrank();
        uint256 id = offerA(address(feed), true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DaemonSwaps.NotADaemon.selector, alice));
        sw.take(id, 11);
    }

    function test_badTermsRefused() public {
        asA(USDG, abi.encodeWithSelector(IERC20.approve.selector, address(sw), 25e6));
        DaemonSwaps.Terms[8] memory bad;
        for (uint256 i; i < 8; ++i) bad[i] = terms(address(feed), true);
        bad[0].capBps = 0; // nothing at stake
        bad[1].capBps = 5001;
        bad[2].term = 0;
        bad[3].maxStale = 0;
        bad[4].offerExpires = uint64(block.timestamp);
        bad[5].feed = alice;
        bad[6].quote = alice;
        bad[7].notional = 4; // max loss rounds to zero
        for (uint256 i; i < 8; ++i) {
            vm.expectRevert(DaemonSwaps.BadTerms.selector);
            asA(address(sw), abi.encodeCall(DaemonSwaps.offer, (10, bad[i])));
        }
        DaemonSwaps.Terms memory ok = terms(address(feed), true);
        ok.capBps = 5000; // the most allowed
        asA(address(sw), abi.encodeCall(DaemonSwaps.offer, (10, ok)));
    }

    function test_escrowsCountAgainstDailyCaps() public {
        uint256 id = offerA(address(feed), true);
        takeB(id);
        assertEq(a.spentToday(), 2e6);
        assertEq(b.spentToday(), 2e6);
    }

    // ── the testnet mirror ───────────────────────────────────────────────────────────────────────────────────────
    function test_mirrorFeedRules() public {
        vm.expectRevert("feeder only");
        feed.post(rid + 1, 1, block.timestamp);
        vm.startPrank(feeder);
        vm.expectRevert("round ids rise");
        feed.post(rid, 1, block.timestamp);
        vm.expectRevert("no price");
        feed.post(rid + 1, 0, block.timestamp);
        vm.expectRevert(bytes("time"));
        feed.post(rid + 1, 1, block.timestamp + 1);
        vm.warp(block.timestamp + 10);
        feed.post(rid + 1, 5, block.timestamp - 5);
        vm.expectRevert(bytes("time"));
        feed.post(rid + 2, 5, block.timestamp - 6); // never back in time
        vm.stopPrank();
        vm.expectRevert("no data present");
        feed.getRoundData(rid + 7);
        (uint80 id, int256 px,,,) = feed.latestRoundData();
        assertEq(id, rid + 1);
        assertEq(px, 5);
    }
}
