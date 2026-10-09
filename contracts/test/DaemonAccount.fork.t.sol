// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DaemonAccount} from "../src/DaemonAccount.sol";

interface IRegistry {
    function createAccount(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external returns (address);
}

interface IUSDG3009 {
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external;
}

contract TestDaemons is ERC721("Daemon (test)", "DMN") {
    function mint(address to, uint256 id) external { _mint(to, id); }
}

/// A target that takes up to `amount` of the dollar from the caller — stands in for a router doing a swap.
contract Puller {
    function pull(address token, uint256 amount) external { IERC20(token).transferFrom(msg.sender, address(this), amount); }
}

/// Runs against a fork of Robinhood Chain MAINNET: the real ERC-6551 registry and the real USDG.
///   forge test --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract DaemonAccountForkTest is Test {
    address constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    TestDaemons nft;
    DaemonAccount impl;
    DaemonAccount acct;
    address holder = makeAddr("holder");
    address buyer = makeAddr("buyer");
    uint256 agentPk = 0xA11CE;
    address agent;
    address sibling = makeAddr("sibling-tba");
    address stranger = makeAddr("stranger");
    Puller router;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url <RHC mainnet>");
        agent = vm.addr(agentPk);
        nft = new TestDaemons();
        impl = new DaemonAccount(USDG);
        router = new Puller();
        nft.mint(holder, 212);
        acct = DaemonAccount(payable(IRegistry(REGISTRY).createAccount(address(impl), bytes32(0), block.chainid, address(nft), 212)));
        deal(USDG, address(acct), 100e6); // 100 USDG in the daemon's wallet
        address[] memory targets = new address[](1);
        targets[0] = address(router);
        address[] memory payees = new address[](1);
        payees[0] = sibling;
        vm.prank(holder);
        acct.constitute(agent, 25e6, 40e6, 0, targets, payees); // ≤25 per call, ≤40 per day
    }

    function test_dealt() public view {
        assertEq(IERC20(USDG).balanceOf(address(acct)), 100e6, "deal() must work on USDG for the rest to mean anything");
    }

    // 1. the wallet follows the NFT
    function test_ownerFollowsTheNft() public {
        assertEq(acct.owner(), holder);
        vm.prank(holder);
        nft.transferFrom(holder, buyer, 212);
        assertEq(acct.owner(), buyer);
        vm.prank(holder);
        vm.expectRevert(); // the old holder is now nobody
        acct.execute(stranger, 0, "", 0);
        vm.prank(buyer);
        acct.execute(buyer, 0, abi.encodeWithSelector(IERC20.transfer.selector, buyer, 1e6), 0); // owner: anything
    }

    // 2. the agent's limits are inert after a sale (a seller's payee list must not survive)
    function test_constitutionInertAfterSale() public {
        vm.prank(holder);
        nft.transferFrom(holder, buyer, 212);
        vm.prank(agent);
        vm.expectRevert(DaemonAccount.InertAfterTransfer.selector);
        acct.approvePayment(sibling, 1e6, 0, type(uint256).max, bytes32("n1"));
    }

    // 3. tokens leave only to the holder
    function test_agentWithdrawsOnlyToHolder() public {
        vm.prank(agent);
        acct.execute(USDG, 0, abi.encodeWithSelector(IERC20.transfer.selector, holder, 5e6), 0);
        assertEq(IERC20(USDG).balanceOf(holder), 5e6);
        vm.prank(agent);
        vm.expectRevert(DaemonAccount.OnlyToHolder.selector);
        acct.execute(USDG, 0, abi.encodeWithSelector(IERC20.transfer.selector, stranger, 5e6), 0);
    }

    // 4. targets and approvals
    function test_agentTargetsAndApprovals() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.TargetNotAllowed.selector, stranger));
        acct.execute(stranger, 0, "", 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.TargetNotAllowed.selector, stranger));
        acct.execute(USDG, 0, abi.encodeWithSelector(IERC20.approve.selector, stranger, 1e6), 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.OverCap.selector, 26e6, 25e6));
        acct.execute(USDG, 0, abi.encodeWithSelector(IERC20.approve.selector, address(router), 26e6), 0);
    }

    // 5. measured outflow: whatever the target takes counts against the caps
    function test_measuredOutflowCaps() public {
        vm.startPrank(agent);
        acct.execute(USDG, 0, abi.encodeWithSelector(IERC20.approve.selector, address(router), 25e6), 0);
        acct.execute(address(router), 0, abi.encodeWithSelector(Puller.pull.selector, USDG, 25e6), 0); // 25: ok
        acct.execute(USDG, 0, abi.encodeWithSelector(IERC20.approve.selector, address(router), 20e6), 0);
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.OverCap.selector, 45e6, 40e6));
        acct.execute(address(router), 0, abi.encodeWithSelector(Puller.pull.selector, USDG, 20e6), 0); // 45 > 40/day
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        acct.execute(address(router), 0, abi.encodeWithSelector(Puller.pull.selector, USDG, 20e6), 0); // next day: ok
    }

    // 6. x402 on REAL USDG: a pre-approved EIP-3009 payment settles from the contract wallet (ERC-1271, bytes form)
    function test_x402PaymentSettlesOnRealUsdg() public {
        bytes32 nonce = keccak256("x402-1");
        vm.prank(agent);
        acct.approvePayment(sibling, 2e6, 0, type(uint256).max, nonce);
        vm.prank(stranger); // the facilitator: anyone may submit an authorization
        IUSDG3009(USDG).transferWithAuthorization(address(acct), sibling, 2e6, 0, type(uint256).max, nonce, "");
        assertEq(IERC20(USDG).balanceOf(sibling), 2e6);
        assertEq(IERC20(USDG).balanceOf(address(acct)), 98e6);
    }

    // 7. …and an unapproved one, or one the agent merely signs, is refused by USDG
    function test_unapprovedOrAgentSignedPaymentRefused() public {
        bytes32 nonce = keccak256("x402-2");
        bytes32 digest = acct.paymentDigest(stranger, 2e6, 0, type(uint256).max, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        vm.expectRevert();
        IUSDG3009(USDG).transferWithAuthorization(address(acct), stranger, 2e6, 0, type(uint256).max, nonce, abi.encodePacked(r, s, v));
        vm.expectRevert();
        IUSDG3009(USDG).transferWithAuthorization(address(acct), stranger, 2e6, 0, type(uint256).max, nonce, "");
    }

    // 8. payments only to allowed payees, and they spend the same caps
    function test_paymentPayeeAndCaps() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.PayeeNotAllowed.selector, stranger));
        acct.approvePayment(stranger, 1e6, 0, type(uint256).max, bytes32("a"));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(DaemonAccount.OverCap.selector, 26e6, 25e6));
        acct.approvePayment(sibling, 26e6, 0, type(uint256).max, bytes32("b"));
    }

    // 9. the holder's own signature is valid; a stranger's is not
    function test_ownerSignatureValid() public {
        (address h, uint256 hk) = makeAddrAndKey("holder2");
        vm.prank(holder);
        nft.transferFrom(holder, h, 212);
        bytes32 m = keccak256("hello");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hk, m);
        assertEq(acct.isValidSignature(m, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        (v, r, s) = vm.sign(agentPk, m);
        assertEq(acct.isValidSignature(m, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }
}
