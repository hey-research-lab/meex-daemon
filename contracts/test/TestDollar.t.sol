// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {DaemonAccount} from "../src/DaemonAccount.sol";
import {TestDollar} from "../src/test-chain/TestDollar.sol";

interface IRegistry {
    function createAccount(address impl, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external returns (address);
}

contract N is ERC721("n", "n") {
    function mint(address to, uint256 id) external { _mint(to, id); }
}

/// The test dollar must behave like real USDG toward a daemon wallet (milestone 01 proved real USDG on the fork).
/// Runs locally — the canonical ERC-6551 registry bytecode is etched in from mainnet via the fork test's address.
///   forge test --match-contract TestDollarTest --fork-url https://rpc.mainnet.chain.robinhood.com
contract TestDollarTest is Test {
    address constant REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    TestDollar usd;
    DaemonAccount acct;
    N nft;
    address holder = makeAddr("holder");
    address payee = makeAddr("payee");
    address agent = makeAddr("agent");

    function setUp() public {
        usd = new TestDollar();
        nft = new N();
        nft.mint(holder, 1);
        DaemonAccount impl = new DaemonAccount(address(usd));
        acct = DaemonAccount(payable(IRegistry(REGISTRY).createAccount(address(impl), 0, block.chainid, address(nft), 1)));
        usd.mint(address(acct), 100e6);
        address[] memory none = new address[](0);
        address[] memory payees = new address[](1);
        payees[0] = payee;
        vm.prank(holder);
        acct.constitute(agent, 25e6, 40e6, 0, none, payees);
    }

    function test_typehashMatchesUsdg() public view {
        assertEq(usd.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267);
    }

    function test_approvedPaymentSettles_unapprovedRefused_noReplay() public {
        bytes32 nonce = keccak256("n1");
        vm.prank(agent);
        acct.approvePayment(payee, 3e6, 0, type(uint256).max, nonce);
        usd.transferWithAuthorization(address(acct), payee, 3e6, 0, type(uint256).max, nonce, "");
        assertEq(usd.balanceOf(payee), 3e6);
        vm.expectRevert(TestDollar.AuthorizationUsedAlready.selector);
        usd.transferWithAuthorization(address(acct), payee, 3e6, 0, type(uint256).max, nonce, "");
        vm.expectRevert(TestDollar.InvalidSignature.selector);
        usd.transferWithAuthorization(address(acct), payee, 3e6, 0, type(uint256).max, keccak256("n2"), "");
    }

    function test_eoaSignaturePathWorks() public {
        (address eoa, uint256 pk) = makeAddrAndKey("eoa");
        usd.mint(eoa, 5e6);
        bytes32 nonce = keccak256("e1");
        bytes32 structHash = keccak256(abi.encode(usd.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), eoa, payee, 1e6, 0, type(uint256).max, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        usd.transferWithAuthorization(eoa, payee, 1e6, 0, type(uint256).max, nonce, v, r, s);
        assertEq(usd.balanceOf(payee), 1e6);
    }
}
