// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DaemonAccount} from "../src/DaemonAccount.sol";
import {DaemonNFT} from "../src/DaemonNFT.sol";
import {DaemonSale} from "../src/DaemonSale.sol";
import {DaemonOTC} from "../src/DaemonOTC.sol";

contract TestStock is ERC20("Test Tesla", "tTSLA") {
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// Fork of Robinhood Chain MAINNET (real ERC-6551 registry, real USDG).
///   forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract SaleOTC -vv
contract SaleOTCForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 constant SUPPLY = 10_048;
    uint256 constant FIRST = 0.01 ether;

    DaemonAccount impl;
    DaemonSale sale;
    DaemonNFT nft;
    DaemonOTC otc;
    TestStock stock;
    address payable treasury = payable(makeAddr("shyguy-llc-treasury"));
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 agentAPk = 0xA1;
    uint256 agentBPk = 0xB1;

    function deploy(uint256 supply) internal returns (DaemonSale s, DaemonNFT n) {
        s = new DaemonSale(address(impl), treasury, supply, 9000, FIRST, 13_000, 0);
        n = new DaemonNFT(address(s), uint96(supply), "https://obol.sh/d/", address(0), "");
        s.setNft(address(n));
    }

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url <RHC mainnet>");
        impl = new DaemonAccount(USDG);
        (sale, nft) = deploy(SUPPLY);
        otc = new DaemonOTC(address(nft), address(impl));
        stock = new TestStock();
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ── the collection ───────────────────────────────────────────────────────────────────────────────────────────
    function test_allMintedUpFrontToTheSale() public view {
        assertEq(nft.supply(), SUPPLY);
        assertEq(nft.balanceOf(address(sale)), SUPPLY);
        assertEq(nft.ownerOf(0), address(sale));
        assertEq(nft.ownerOf(SUPPLY - 1), address(sale));
        assertEq(nft.tokenURI(212), "https://obol.sh/d/212");
    }

    function test_bandPricesAreExact() public view {
        uint256[10] memory want = [uint256(0.01 ether), 0.013 ether, 0.0169 ether, 0.02197 ether, 0.028561 ether, 0.0371293 ether, 0.04826809 ether, 0.062748517 ether, 0.0815730721 ether, 0.10604499373 ether];
        for (uint256 i; i < 10; ++i) assertEq(sale.bandPrice(i), want[i]);
    }

    function test_sellOutTotal() public pure {
        // what a full sellout raises, by the same band rule the contract uses (sold * 10 / supply)
        uint256 total;
        uint256 p = FIRST;
        uint256 b;
        for (uint256 sold; sold < SUPPLY; ++sold) {
            uint256 band = (sold * 10) / SUPPLY;
            if (band != b) { b = band; p = FIRST; for (uint256 i; i < band; ++i) p = (p * 13_000) / 10_000; }
            total += p;
        }
        assertEq(total, 428.19134170042 ether); // a full sellout; 90% of it lands in daemons' own wallets
    }

    // ── buying ───────────────────────────────────────────────────────────────────────────────────────────────────
    function test_buyFundsTheDaemonsOwnWallet() public {
        vm.prank(alice);
        sale.buy{value: FIRST}(212);
        assertEq(nft.ownerOf(212), alice);
        address w = sale.walletOf(212);
        assertEq(w.balance, 0.009 ether, "90% to the daemon's wallet");
        assertEq(treasury.balance, 0.001 ether, "10% to SHYGUY LLC");
        assertEq(address(sale).balance, 0, "the sale keeps nothing");
        assertEq(DaemonAccount(payable(w)).owner(), alice);
    }

    function test_wrongPriceOrSoldTokenRefused() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DaemonSale.WrongPrice.selector, 0.02 ether, FIRST));
        sale.buy{value: 0.02 ether}(1);
        vm.prank(alice);
        sale.buy{value: FIRST}(1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DaemonSale.NotForSale.selector, 1));
        sale.buy{value: FIRST}(1);
    }

    function test_bandsStepAtEachTenth() public {
        (DaemonSale s, DaemonNFT n) = deploy(100); // a tenth = 10 tokens
        n; // silence
        for (uint256 id; id < 100; ++id) {
            uint256 want = FIRST;
            for (uint256 i; i < id / 10; ++i) want = (want * 13_000) / 10_000;
            assertEq(s.price(), want);
            vm.prank(alice);
            s.buy{value: want}(id);
        }
        assertEq(s.sold(), 100);
    }

    function test_setNftOnceOnly() public {
        vm.expectRevert(DaemonSale.AlreadySet.selector);
        sale.setNft(address(1));
    }

    // ── OTC between two daemons that each came through the sale ────────────────────────────────────────────────
    function twoDaemons() internal returns (DaemonAccount a, DaemonAccount b) {
        vm.prank(alice);
        sale.buy{value: FIRST}(10);
        vm.prank(bob);
        sale.buy{value: FIRST}(11);
        a = DaemonAccount(payable(sale.walletOf(10)));
        b = DaemonAccount(payable(sale.walletOf(11)));
        deal(USDG, address(a), 50e6);
        stock.mint(address(b), 5e18);
        address[] memory t = new address[](1);
        t[0] = address(otc);
        address[] memory none = new address[](0);
        vm.prank(alice);
        a.constitute(vm.addr(agentAPk), 25e6, 40e6, 0, t, none);
        vm.prank(bob);
        b.constitute(vm.addr(agentBPk), 25e6, 40e6, 0, t, none);
    }

    function legs(address token, uint256 amount) internal pure returns (DaemonOTC.Leg[] memory l) {
        l = new DaemonOTC.Leg[](1);
        l[0] = DaemonOTC.Leg(token, amount);
    }

    function postAsAgent(DaemonAccount a, uint256 tokenId) internal returns (uint256 id) {
        vm.startPrank(vm.addr(agentAPk));
        a.execute(USDG, 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 10e6), 0);
        bytes memory r = a.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.post.selector, tokenId, legs(USDG, 10e6), legs(address(stock), 3e18), uint64(block.timestamp + 1 days)), 0);
        vm.stopPrank();
        id = abi.decode(r, (uint256));
    }

    function test_bundleSettlesAtomicallyBetweenSiblings() public {
        (DaemonAccount a, DaemonAccount b) = twoDaemons();
        uint256 id = postAsAgent(a, 10);
        assertEq(IERC20(USDG).balanceOf(address(otc)), 10e6, "maker's leg escrowed");
        assertEq(a.spentToday(), 10e6, "the escrow counted against A's daily cap");
        vm.startPrank(vm.addr(agentBPk));
        b.execute(address(stock), 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 3e18), 0);
        b.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.take.selector, id, 11), 0);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(address(b)), 10e6);
        assertEq(stock.balanceOf(address(a)), 3e18);
        assertEq(IERC20(USDG).balanceOf(address(otc)), 0);
    }

    function test_takerShortRevertsAndNothingMoves() public {
        (DaemonAccount a, DaemonAccount b) = twoDaemons();
        uint256 id = postAsAgent(a, 10);
        vm.prank(address(b));
        stock.transfer(alice, 4e18); // B now holds 1, offer wants 3 (done as the wallet itself, to set the scene)
        vm.startPrank(vm.addr(agentBPk));
        b.execute(address(stock), 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 3e18), 0);
        vm.expectRevert();
        b.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.take.selector, id, 11), 0);
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(address(otc)), 10e6, "maker's escrow untouched");
        (,, bool open) = otc.offers(id);
        assertTrue(open);
    }

    function test_onlyDaemonsOfThisCollection() public {
        stock.mint(alice, 5e18);
        vm.startPrank(alice);
        stock.approve(address(otc), 5e18);
        vm.expectRevert(abi.encodeWithSelector(DaemonOTC.NotADaemon.selector, alice));
        otc.post(10, legs(address(stock), 1e18), legs(USDG, 1e6), uint64(block.timestamp + 1));
        vm.stopPrank();
        (DaemonAccount a,) = twoDaemons();
        uint256 id = postAsAgent(a, 10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DaemonOTC.NotADaemon.selector, alice));
        otc.take(id, 11); // claiming daemon 11's ID doesn't make alice its wallet
    }

    function test_cancelExpiryAndDoubleTake() public {
        (DaemonAccount a, DaemonAccount b) = twoDaemons();
        uint256 id = postAsAgent(a, 10);
        vm.prank(address(b));
        vm.expectRevert(DaemonOTC.NotMaker.selector);
        otc.cancel(id);
        vm.prank(vm.addr(agentAPk));
        a.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.cancel.selector, id), 0);
        assertEq(IERC20(USDG).balanceOf(address(a)), 50e6, "escrow back to the maker");
        vm.prank(vm.addr(agentBPk));
        vm.expectRevert(abi.encodeWithSelector(DaemonOTC.NotOpen.selector, id));
        b.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.take.selector, id, 11), 0);
        uint256 id2 = postAsAgent(a, 10);
        vm.warp(block.timestamp + 2 days);
        vm.startPrank(vm.addr(agentBPk));
        b.execute(address(stock), 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 3e18), 0);
        vm.expectRevert(abi.encodeWithSelector(DaemonOTC.Expired.selector, id2));
        b.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.take.selector, id2, 11), 0);
        vm.stopPrank();
    }

    function test_escrowCountsAgainstTheMakersDailyCap() public {
        (DaemonAccount a,) = twoDaemons();
        vm.startPrank(vm.addr(agentAPk));
        a.execute(USDG, 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 25e6), 0);
        a.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.post.selector, 10, legs(USDG, 25e6), legs(address(stock), 1e18), uint64(block.timestamp + 1 days)), 0);
        a.execute(USDG, 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 20e6), 0);
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.OverCap.selector, 45e6, 40e6));
        a.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.post.selector, 10, legs(USDG, 20e6), legs(address(stock), 1e18), uint64(block.timestamp + 1 days)), 0);
        // and a per-call escrow over 25 can't even be approved: two layers stop it
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.OverCap.selector, 30e6, 25e6));
        a.execute(USDG, 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 30e6), 0);
        vm.stopPrank();
    }

    function test_doubleTakeRefusedAndOtherEscrowsSafe() public {
        (DaemonAccount a, DaemonAccount b) = twoDaemons();
        uint256 id1 = postAsAgent(a, 10);
        uint256 id2 = postAsAgent(a, 10); // a second escrow sits in the same contract
        stock.mint(address(b), 5e18);
        vm.startPrank(vm.addr(agentBPk));
        b.execute(address(stock), 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 6e18), 0);
        b.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.take.selector, id1, 11), 0);
        vm.expectRevert(abi.encodeWithSelector(DaemonOTC.NotOpen.selector, id1));
        b.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.take.selector, id1, 11), 0); // the same offer twice
        vm.stopPrank();
        assertEq(IERC20(USDG).balanceOf(address(otc)), 10e6, "offer 2's escrow is still whole");
        (,, bool open2) = otc.offers(id2);
        assertTrue(open2);
    }

    function test_selfTradeRefused() public {
        (DaemonAccount a,) = twoDaemons();
        uint256 id = postAsAgent(a, 10);
        stock.mint(address(a), 3e18);
        vm.startPrank(vm.addr(agentAPk));
        a.execute(address(stock), 0, abi.encodeWithSelector(IERC20.approve.selector, address(otc), 3e18), 0);
        vm.expectRevert(DaemonOTC.SelfTrade.selector);
        a.execute(address(otc), 0, abi.encodeWithSelector(DaemonOTC.take.selector, id, 10), 0);
        vm.stopPrank();
    }

    // ── the opening time and the memo ────────────────────────────────────────────────────────────────────────────
    function test_closedUntilOpensAtThenOpen() public {
        uint256 at = block.timestamp + 1 days;
        DaemonSale s = new DaemonSale(address(impl), treasury, SUPPLY, 9000, FIRST, 13_000, at);
        DaemonNFT n = new DaemonNFT(address(s), uint96(SUPPLY), "https://obol.sh/d/", address(0), "");
        s.setNft(address(n));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DaemonSale.NotOpen.selector, at));
        s.buy{value: FIRST}(7);
        vm.warp(at - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DaemonSale.NotOpen.selector, at));
        s.buy{value: FIRST}(7);
        vm.warp(at); // the opening second itself sells
        vm.prank(alice);
        s.buy{value: FIRST}(7);
        assertEq(n.ownerOf(7), alice);
    }

    function test_everyPurchaseEmitsAReadableMemo() public {
        vm.expectEmit(true, false, false, true, address(sale));
        emit DaemonSale.Memo(212, unicode"Daemon #212 · band 1 of 10 · 0.01 ETH: 90% to its own wallet, 10% to SHYGUY LLC");
        vm.prank(alice);
        sale.buy{value: FIRST}(212);
        assertEq(sale.memo(9, 2, 0.0169 ether), unicode"Daemon #9 · band 3 of 10 · 0.0169 ETH: 90% to its own wallet, 10% to SHYGUY LLC");
        assertEq(sale.memo(0, 9, 0.10604499373 ether), unicode"Daemon #0 · band 10 of 10 · 0.10604499373 ETH: 90% to its own wallet, 10% to SHYGUY LLC");
        assertEq(sale.memo(10047, 0, 1 ether), unicode"Daemon #10047 · band 1 of 10 · 1 ETH: 90% to its own wallet, 10% to SHYGUY LLC");
    }

    function test_aSafeTreasuryReceives() public {
        // the real Re:TCG Safe on RHC MAINNET (SafeL2 1.4.1) as the treasury: the sale's full-gas call must succeed
        address payable safe = payable(0xA7DC540d12E53Cf8d6615921Fe7b4f9Ca73A0dBC);
        require(safe.code.length > 0, "the Safe exists on this fork");
        DaemonSale s = new DaemonSale(address(impl), safe, SUPPLY, 9000, FIRST, 13_000, 0);
        DaemonNFT n = new DaemonNFT(address(s), uint96(SUPPLY), "https://obol.sh/d/", address(0), "");
        s.setNft(address(n));
        uint256 before = safe.balance;
        vm.prank(alice);
        s.buy{value: FIRST}(5);
        assertEq(safe.balance - before, FIRST / 10, "10% reached the Safe");
    }

    function test_collectionOwnerIsInformationalAndContractUri() public {
        address safe = 0xA7DC540d12E53Cf8d6615921Fe7b4f9Ca73A0dBC;
        DaemonSale s = new DaemonSale(address(impl), treasury, SUPPLY, 9000, FIRST, 13_000, 0);
        DaemonNFT n = new DaemonNFT(address(s), uint96(SUPPLY), "https://obol.sh/d/", safe, "https://obol.sh/collection");
        assertEq(n.owner(), safe);
        assertEq(n.contractURI(), "https://obol.sh/collection");
        assertEq(n.tokenURI(212), "https://obol.sh/d/212");
        assertEq(n.balanceOf(address(s)), SUPPLY, "still all minted to the sale; the owner holds nothing");
    }
}
