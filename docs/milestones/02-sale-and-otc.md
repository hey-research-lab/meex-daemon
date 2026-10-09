# Milestone 02 — The collection, the sale, and trades between daemons

**Date:** 2026-10-07 · **Status:** proven on a fork of Robinhood Chain mainnet; not yet deployed anywhere
**Code:** `contracts/src/DaemonNFT.sol`, `DaemonSale.sol`, `DaemonOTC.sol` · **Tests:** `contracts/test/SaleOTC.fork.t.sol`
**Builds on:** [Milestone 01 — the daemon wallet](01-daemon-wallet.md) · **Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

- **The collection:** all 10,048 Daemons exist from the moment the contract is deployed, owned by the sale contract.
- **The sale:** anyone buys a specific daemon at its band's price. Most of the price goes into that daemon's own
  wallet in the same transaction, so a new holder's daemon arrives funded.
- **Trades between daemons (OTC bundles):** one daemon escrows a bundle of tokens and names what it wants back; a
  sibling takes the offer by delivering it. Both sides move together or not at all.

## 2. Decisions this milestone implements

| Decision | Source |
|---|---|
| Supply 10,048 (the ASCII bytes of "daemon" sum to 628; × binary 10000 = 16) | operator, 2026-10-07; `SPEC.md` |
| All minted up front, then sold in ten bands, ×1.3 per band, from 0.01 ETH | operator, 2026-10-07 |
| ~90% of each price to the daemon's wallet, the rest to SHYGUY LLC | operator ("love it"), 2026-10-07 |
| Trades between siblings, escrowed, nothing on credit; bundles first | operator, 2026-10-07; `SPEC.md` §9b |

## 3. Standards and sources

| | Source |
|---|---|
| ERC-721 and the consecutive-mint extension (ERC-2309: one `ConsecutiveTransfer` event per batch instead of one write per token) | [EIP-721](https://eips.ethereum.org/EIPS/eip-721), [EIP-2309](https://eips.ethereum.org/EIPS/eip-2309), [OpenZeppelin `ERC721Consecutive` v5.1.0](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.1.0/contracts/token/ERC721/extensions/ERC721Consecutive.sol) (max 5,000 per batch) |
| ERC-6551 registry (account creation, deterministic addresses) | [EIP-6551](https://eips.ethereum.org/EIPS/eip-6551); `0x000000006551c19487814612e58FE06813775758` on RHC |
| `SafeERC20` for escrow transfers | [OpenZeppelin `SafeERC20` v5.1.0](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.1.0/contracts/token/ERC20/utils/SafeERC20.sol) |
| Robinhood Chain mainnet gas, 0.020 gwei | read on chain 2026-10-07 (`eth_gasPrice`) |

## 4. Design

### 4.1 DaemonNFT
- Mints the whole supply to the sale contract in the constructor, in batches of 5,000 (OpenZeppelin's ceiling): two
  of 5,000 and one of 48. No mint function afterwards, no owner, no admin.
- `tokenURI(id)` = `https://obol.sh/d/<id>` — the daemon's live page (its OS).

### 4.2 DaemonSale
- **Price:** band = `sold × 10 / supply` (0–9, a tenth of the supply each); band price = 0.01 ETH × 1.3^band, computed
  once at deployment and immutable.

  | Band | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | ETH | 0.01 | 0.013 | 0.0169 | 0.02197 | 0.028561 | 0.0371293 | 0.04826809 | 0.062748517 | 0.0815730721 | 0.10604499373 |

  A full sellout raises **428.19134170042 ETH** (computed with the contract's own rule in `test_sellOutTotal`), 90% of
  it into daemons' own wallets.
- **Buy:** `buy(tokenId)` with exactly the current price. The sale creates the daemon's ERC-6551 account if needed,
  sends 90% to it and 10% to the treasury, and transfers the NFT. It keeps nothing between transactions.
- **Fixed at deployment:** prices, split, treasury, supply. `setNft` links the collection once (the NFT is deployed
  after the sale, because it mints to it) and only the deployer can call it, once.

### 4.3 DaemonOTC (bundles)
- `post(makerTokenId, give[], want[], expires)` — the caller must be the ERC-6551 wallet of `makerTokenId` in this
  collection (checked against the registry). The `give` legs are escrowed in the contract.
- `take(id, takerTokenId)` — a different daemon of the collection delivers every `want` leg straight to the maker and
  receives the escrowed legs. Any shortfall reverts the whole transaction.
- `cancel(id)` — maker only; the escrow returns.
- No owner, no fee, no admin. Only ERC-20 legs (ETH trades via WETH).
- **It composes with milestone 01:** a daemon's agent can only reach the OTC contract if the holder allowlisted it,
  can only approve it within the per-call cap, and every escrow it posts is measured against the per-day cap.

## 5. What was proven

**Environment:** Foundry 1.7.1, a fork of Robinhood Chain mainnet (real registry, real USDG); a test stock token
deployed in the fork. `forge test --fork-url https://rpc.mainnet.chain.robinhood.com`.

| Test | Proves |
|---|---|
| `test_allMintedUpFrontToTheSale` | all 10,048 exist, owned by the sale; token URI points at obol.sh |
| `test_bandPricesAreExact` | the ten prices, to the wei |
| `test_sellOutTotal` | a full sellout = 428.19134170042 ETH |
| `test_buyFundsTheDaemonsOwnWallet` | 0.009 ETH lands in the daemon's wallet, 0.001 at the treasury, 0 left in the sale; the buyer owns the wallet |
| `test_wrongPriceOrSoldTokenRefused` | wrong payment refused; a sold daemon can't be sold again |
| `test_bandsStepAtEachTenth` | on a 100-token instance, the price steps exactly every 10 sales through all ten bands |
| `test_setNftOnceOnly` | the collection link can't be changed |
| `test_bundleSettlesAtomicallyBetweenSiblings` | two daemons bought through the sale trade 10 USDG for 3 stock tokens through their own agents; the escrow counts against the maker's cap |
| `test_takerShortRevertsAndNothingMoves` | a taker short of its leg reverts; the maker's escrow and the offer are untouched |
| `test_onlyDaemonsOfThisCollection` | an outside address can't post, and can't take by claiming a daemon's ID |
| `test_cancelExpiryAndDoubleTake` | only the maker cancels; cancelled and expired offers can't be taken |
| `test_escrowCountsAgainstTheMakersDailyCap` | 25 then 20 USDG of escrow stops at the 40/day cap; an approval over 25 is refused — two layers |
| `test_doubleTakeRefusedAndOtherEscrowsSafe` | the same offer can't be taken twice, and another maker's escrow stays whole |
| `test_selfTradeRefused` | a daemon can't take its own offer |

**14/14 pass here; with milestone 01, 24/24.**

**Mutation pass:** each guard deleted in turn, the suite re-run. The first pass caught 9 of 11. Two survived:
*take leaves the offer open* and *self-trade allowed*. No test had tried them. The first is serious: without it, a
second take of the same offer would pay out escrow again, from other makers' funds. Both tests were added
(`test_doubleTakeRefusedAndOtherEscrowsSafe`, `test_selfTradeRefused`); after that, **11/11** caught:

| Mutation | Caught |
|---|---|
| daemon's wallet gets nothing | ✓ |
| a sold daemon re-sellable | ✓ |
| any price accepted | ✓ |
| bands never step | ✓ |
| collection link reusable | ✓ |
| anyone may take / anyone may post | ✓ / ✓ |
| take leaves the offer open | ✓ (after the added test) |
| no expiry | ✓ |
| anyone may cancel | ✓ |
| self-trade | ✓ (after the added test) |

## 6. Cost

| Item | Gas | At 0.020 gwei (RHC mainnet, 2026-10-07) |
|---|---|---|
| Deploy DaemonNFT, minting all 10,048 | 2,184,537 | ≈ 0.000044 ETH + L1 data fee |
| Deploy DaemonSale | 1,302,077 | ≈ 0.000026 ETH + L1 data fee |
| One buy (creates the daemon's wallet, funds it, transfers the NFT) | ≈ 259,000 (test total, incl. setup) | ≈ 0.000005 ETH |

## 7. Known gaps

- `DaemonSale.buy` takes exact ETH only; no batch buy; no allowlist or per-wallet limit (none decided).
- The sale funds the daemon's wallet in **ETH**; the daemon swaps to USDG through an allowlisted router (milestone 01).
- OTC is bundles only. Covered calls, cash-secured puts, index vaults and bounded swaps are later milestones;
  options and swaps wait for counsel (`SPEC.md` §9b).
- An offer's `want` legs are fixed amounts; no partial fills.
- Not yet on testnet; no external review.

## 8. How to reproduce

```
cd contracts
forge test --fork-url https://rpc.mainnet.chain.robinhood.com -vv
```

## 9. Next milestone

The first testnet deployment (RHC testnet 46630): the three contracts plus DaemonAccount, the test dollar (EIP-3009),
TestMarket and MockFeed; ten daemons bought through the sale; obol.sh's facilitator settling a real x402 call between
two of them. See `TESTNET-PLAN.md`.
