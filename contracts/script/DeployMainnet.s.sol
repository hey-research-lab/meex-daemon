// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DaemonAccount} from "../src/DaemonAccount.sol";
import {DaemonSale} from "../src/DaemonSale.sol";
import {DaemonNFT} from "../src/DaemonNFT.sol";

/// The Daemon collection on Robinhood Chain MAINNET (operator's go, 2026-10-08). Phased launch: the wallet implementation,
/// the sale and the NFT only — no OTC/options/indexes/swaps on mainnet (options + swaps stay testnet until counsel).
///   Treasury = the Re:TCG Safe 0xA7DC…0dBC (SafeL2 1.4.1, 2-of-3), receiving 10% of each price; 90% to each daemon's
///   own wallet. 10,048 daemons, band 1 = 0.01 ETH, ×1.3 per tenth. The sale opens at OPENS_AT (unix seconds), fixed.
///   PK=<deployer> OPENS_AT=<unix> forge script script/DeployMainnet.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com [--broadcast]
contract DeployMainnet is Script {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address payable constant SAFE = payable(0xA7DC540d12E53Cf8d6615921Fe7b4f9Ca73A0dBC);
    uint256 constant SUPPLY = 10_048;

    function run() external {
        require(block.chainid == 4663, "Robinhood Chain mainnet only");
        require(SAFE.code.length > 0, "the treasury Safe must exist on this chain");
        uint256 opensAt = vm.envUint("OPENS_AT");
        require(opensAt > block.timestamp, "opens in the future");
        vm.startBroadcast(vm.envUint("PK"));
        DaemonAccount impl = new DaemonAccount(USDG);
        DaemonSale sale = new DaemonSale(address(impl), SAFE, SUPPLY, 9000, 0.01 ether, 13_000, opensAt);
        DaemonNFT nft = new DaemonNFT(address(sale), uint96(SUPPLY), "https://obol.sh/d/", SAFE, "https://obol.sh/collection");
        sale.setNft(address(nft));
        vm.stopBroadcast();
        require(nft.balanceOf(address(sale)) == SUPPLY && address(sale.nft()) == address(nft) && sale.treasury() == SAFE);
        console.log("accountImpl", address(impl));
        console.log("sale", address(sale));
        console.log("nft", address(nft));
        console.log("opensAt", opensAt);
    }
}
