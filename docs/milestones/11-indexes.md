# Milestone 11 — Indexes: a daemon publishes a basket, siblings hold it, everyone can redeem

**Date:** 2026-10-08 · **Status:** live at **https://obol.sh** (Robinhood Chain testnet) · `SPEC.md` §9b item 3 ·
**Code:** `contracts/src/DaemonIndexes.sol`, `contracts/test/Indexes.fork.t.sol`, `lang/indexes.mjs` (the `index` blocks,
mint/redeem checks), `obol/src/indexes.mjs` (the index list, publish, mint, redeem), `tools/index-proofs.mjs` ·
**Builds on:** [09](09-otc-bundles.md), [10](10-options.md) · **Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

**DaemonIndexes** at `0xF9e6770316633d7510e86A36F293bF0af3e2E4e1` (RHC testnet) follows the Corpus rule:

- **Fixed baskets:** a daemon creates an index with a fixed **per-share** basket. No one can add an asset, change an
  amount or withdraw the backing: there's no owner, no fee and no admin, and the manager has no special power after
  creation.
- **Mint:** anyone mints whole shares by depositing exactly that many baskets. Each leg's receipt is checked, so a
  fee-on-transfer token can't under-back a share.
- **Redeem:** whoever holds shares (a daemon, or a holder who withdrew them) burns them for exactly that many baskets,
  in kind.
- **Always backed:** the vault holds at least `supply × amount` of every leg at all times.
- **Shares:** each share is an ordinary ERC-20 with **0 decimals**, so there's no rounding anywhere. Shares trade
  through **DaemonOTC**; there's no new market code.
- **Creation:** only daemons of the collection can create an index (checked against the ERC-6551 registry). A basket
  has at most 8 legs, in strictly ascending address order with no duplicates; every amount is above 0 and every token
  is a contract.
- **Allowlist:** the holder added the vault to both wallets with `constitute` (same agent and caps, one new target).
  Tx `0x0f9eb166…` for #1 and `0x64ba8822…` for #2.

**In an agentfile:**

```hcl
index "tNVX" {                                    # what the daemon publishes — only the holder can add or change it
  name   = "NVDA + cash (testnet)"
  basket = ["1 tNVDA", "0.40 tUSDG"]              # per share
}
strategy "make_tnvx" {                            # daemon #2
  every = "24h"
  step "mint" { mint_index { index = "tNVX"  shares = 1 } }
  step "sell" { offer { give = ["1 tNVX"]  want = ["1.00 tUSDG"]  expires = "24h" } }
}
strategy "redeem_tnvx" {                          # daemon #1
  every = "168h"
  step "redeem" { redeem_index { index = "tNVX"  shares = "all" } }
}
```

- **Publishing:** on each alarm the daemon creates any `index` block that isn't on chain yet. An existing symbol with
  a *different* basket is refused and logged, never re-made, because the basket is fixed. To change it, publish under a
  new symbol.
- **`mint_index`** mints the daemon's own index only. Its dollar legs × shares count toward the strategy's worst-case
  cost (the daily-cap gate).
- **`redeem_index`** redeems the daemon's own index or any listed index; `"all"` means whatever it holds, and holding
  none sends nothing.
- **Trading shares:** once created, a share token is added to the instrument list, as `tNVX` is here. The holder adds
  it to `otc.instruments`, and then it trades with the ordinary `offer` and `take`. An index can't be a leg of another
  index.
- **`GET https://obol.sh/api/indexes`** lists every index with its supply, its basket, what the vault holds, and
  `backed` (live).

## 2. What was proven

**Contract** (`Indexes.fork.t.sol`): **12/12**, including a fuzzed invariant (256 runs) that any mix of mints and
redeems leaves every share backed, and that the last redeemer empties the vault exactly. The other tests cover:

- Creation fixes the basket.
- Only daemons create.
- Six bad-basket shapes are refused (duplicate, descending, a zero amount, an EOA, empty, 9 legs); 8 legs is allowed.
- Mint takes exact baskets, and redeem returns exactly that many.
- Redeeming more than is held, zero shares, and unknown indexes are all refused.
- Only the vault mints or burns shares.
- A minter who is short reverts, and nothing is minted.
- A fee-on-transfer leg is refused, so it can't under-back a share.
- **The manager can't take the backing:** once it moves its shares to the holder, the holder redeems directly.
- A sibling buys a share over DaemonOTC and redeems it in kind.

**Mutations 19/19.** `nonReentrant` isn't mutation-tested: that would need a hostile-token harness, and only the
tokens a creator picks enter a basket.

**Unit tests** (`obol/test/indexes.test.mjs`, 12):
- The block rules: symbol, name, legs, at most 3 indexes and at most 8 legs, no duplicates, no indexes of indexes, and
  no clash with an existing instrument.
- Mint and redeem rules and costs; strategies only; the daily cap refuses an hourly 5-share mint.
- Publishing is holder-only, and the plan shows the basket.
- Exact basket equality; publishing creates only what's missing, sends nothing for the same basket, and refuses a
  different one; a sibling's same symbol doesn't count as ours.
- Mint approves exactly basket × shares; redeem refusals send nothing.
- A listed index is found by its share address, not by a lookalike symbol.
- The live `backed` check.

**Mutations 30/30** (one first survived, the `backed` flag; it was extracted and tested). All suites: **92 Worker,
14 compiler.**

**Live (`tools/index-proofs.mjs`, all 13 checks passed on the first run):**

| | | |
|---|---|---|
| 0 | The holder merges `index "tNVX"` (#2 proposal 10); on its next run **#2 creates index #1 itself** | tx `0xdc877c26…49ad`; share `0xe7c1…e512` |
| 1 | #2 `make_tnvx` mints 1 share | tx `0xe6c5f4b5…67b8`; the vault took exactly 1 tNVDA + 0.40 tUSDG; supply 1; backed |
| | …and offers it: OTC #3, 1 tNVX for 1.00 | tx `0xd0a174cc…0e0b` |
| 2 | #1 `buy_tnvx` takes it | tx `0x6d890f08…8ba6`; #2 +1.00 |
| 3 | #1 `redeem_tnvx` redeems in kind | tx `0x358ecda7…6242`; the share burned; #1 +1 tNVDA +0.40 (net −0.60); the vault is back to empty |

## 3. Issues found

- **The compiled index carried BigInt amounts.** The compiled doc is stored and served as JSON, so this would have
  crashed in the Worker. Amounts are now strings, with a test that the compiled doc serializes.
- **The step-order parser dropped steps.** `stepOrder` located a block with `(^|\n)\s*strategy "<name>"`. The `\s*`
  could swallow a blank line, so for a block that followed a blank line with *no comment above it*, the next-block
  search stopped at once and the block compiled with **no steps**. Every earlier agentfile block happened to have a
  comment above it. Fixed to start at the keyword, with a regression test that fails on the old code. No head was
  affected (all compiled with every step).
- **A proposal was judged by stale Durable Object code.** #2 proposal 9 came back "no change" because it arrived about
  20 s after a deploy, before the DO picked up the new code. It stays rejected on the record; #10 merged after a 45 s
  wait. Rule: wait ≥ 45 s after `npm run deploy` before proposing.

## 4. Known gaps

- **Index shares are listed by hand** (added to `lang/otc.mjs`, then deployed), like every instrument. There's no
  automatic listing of new indexes.
- **No rebalancing, by design** (the Corpus rule). A new weighting is a new index.
- **No NAV or price.** `make_tnvx` offers at a fixed 1.00. On mainnet a quote would want reference prices (Mob's
  Chainlink stock feeds) for the legs.
- Real RHC stock tokens may have corporate actions (splits, dividends) that a fixed raw amount doesn't follow. Check
  how they're implemented before any mainnet index.
- Minting other daemons' indexes isn't an agentfile step yet: a sibling gets shares over OTC. The contract allows
  anyone to mint.

## 5. How to reproduce

```
cd contracts && forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract Indexes
cd ../obol && node --test test/*.test.mjs && npm run deploy        # then wait ≥ 45 s
cd .. && node tools/propose.mjs 2 agents/2.hcl "<reason>" && node tools/propose.mjs 1 agents/1.hcl "<reason>"
node tools/index-proofs.mjs
curl https://obol.sh/api/indexes
```
