// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MirrorFeed — TESTNET ONLY. Chainlink has no feeds on Robinhood Chain testnet, so this carries a mainnet feed's
///        rounds across, posted by one feeder key (a trusted relay, which is why it never goes to mainnet — there,
///        DaemonSwaps reads Chainlink's own proxy). AggregatorV3-compatible; rounds are append-only, ids strictly rising,
///        timestamps never ahead of the chain and never going back.
contract MirrorFeed {
    struct Round { int256 answer; uint64 updatedAt; }

    address public immutable feeder;
    uint8 public immutable decimals;
    string public description;
    uint256 public constant version = 1;
    address public immutable source; // the mainnet proxy being mirrored, for the record

    mapping(uint80 => Round) internal rounds;
    uint80 public latestRound;

    event Mirrored(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    constructor(address feeder_, uint8 decimals_, string memory description_, address source_) {
        (feeder, decimals, description, source) = (feeder_, decimals_, description_, source_);
    }

    function post(uint80 roundId, int256 answer, uint256 updatedAt) external {
        require(msg.sender == feeder, "feeder only");
        require(roundId > latestRound, "round ids rise");
        require(answer > 0, "no price");
        require(updatedAt <= block.timestamp && updatedAt >= rounds[latestRound].updatedAt, "time");
        rounds[roundId] = Round(answer, uint64(updatedAt));
        latestRound = roundId;
        emit Mirrored(roundId, answer, updatedAt);
    }

    function getRoundData(uint80 id) public view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[id];
        require(r.updatedAt != 0, "no data present");
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRound);
    }
}
