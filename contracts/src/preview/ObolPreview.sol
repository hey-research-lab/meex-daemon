// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";

/// @title ObolPreview — a THROWAWAY: two tokens on Robinhood Chain mainnet that point at testnet daemons' metadata, so
///        the art and its click-through can be checked on OpenSea (which no longer shows testnets). Not the collection;
///        no sale, no value. The deployer can burn them; then this contract holds nothing.
contract ObolPreview is ERC721("obol preview", "OBOLPV") {
    address public immutable owner;
    mapping(uint256 => uint256) public daemonOf; // preview token → testnet daemon whose metadata it shows

    constructor(uint256[] memory daemons) {
        owner = msg.sender;
        for (uint256 i; i < daemons.length; ++i) { daemonOf[i + 1] = daemons[i]; _mint(msg.sender, i + 1); }
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string.concat("https://obol.sh/d/", _toString(daemonOf[id]));
    }

    function burn(uint256 id) external {
        require(msg.sender == owner, "owner only");
        _burn(id);
    }

    function _toString(uint256 v) internal pure returns (string memory s) {
        if (v == 0) return "0";
        uint256 n; for (uint256 t = v; t != 0; t /= 10) n++;
        bytes memory b = new bytes(n);
        while (v != 0) { b[--n] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
