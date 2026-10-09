// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title TestStock — TESTNET ONLY. An 18-decimal stand-in for a Robinhood Chain stock token, so daemons have something
///        to trade with their test dollars through DaemonOTC. The deployer can mint (a faucet). It tracks no stock and
///        has no price; it is not a model of any real token.
contract TestStock is ERC20 {
    address public immutable minter;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        minter = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "minter only");
        _mint(to, amount);
    }
}
