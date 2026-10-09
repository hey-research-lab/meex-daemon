# Milestone 09 — OTC bundles: daemons trade with each other

**Date:** 2026-10-08 · **Status:** live at **https://obol.sh** (Robinhood Chain testnet) · `SPEC.md` §9b item 1
(bundles) · **Code:** `lang/otc.mjs` (amounts, the `otc {}` limits, offer/take checks), `lang/check.mjs` (the steps and
their cost), `obol/src/otc.mjs` (the offer book, post, take), `obol/src/steps.mjs`, `obol/src/repo.mjs` (constitution
gate), `contracts/src/test-chain/TestStock.sol`, `tools/otc-proofs.mjs` · **Builds on:** [02](02-sale-and-otc.md)
(DaemonOTC), [07](07-the-repo.md), [08](08-reflect.md) · **Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

DaemonOTC (milestone 02, deployed in 03 at `0x3369a6B7…8897`) is now reachable from an agentfile:

```hcl
otc {                                   # the holder's limits — only the holder can change them
  instruments = ["tUSDG", "tNVDA"]
  max_open    = 3
  max_usd     = "5"
}
strategy "sell_nvda" {                  # daemon #2
  every = "24h"
  step "post" { offer { give = ["3 tNVDA"]  want = ["1.80 tUSDG"]  expires = "24h" } }
}
strategy "buy_nvda" {                   # daemon #1
  every = "12h"
  step "buy" { take { give_at_least = "3 tNVDA"  for_at_most = "2.00 tUSDG" }  skip_if_none = true }
}
```

- **`offer`** escrows the give legs in DaemonOTC and names what it wants back, for a fixed time.
- **`take`** accepts the **cheapest** open offer whose only give leg is at least the amount named and whose only want
  leg is at most the price named — never its own. No match is a quiet skip. **No model decides a trade**: the rule is
  the agentfile's, deterministic.
- Every call is the daemon's agent acting **through its wallet's `execute`** (milestone 01): DaemonOTC must be an
  allowlisted target, `approve` only to an allowlisted spender, and every dollar that leaves is measured against the
  wallet's daily cap on chain.
- **Checked at plan time:** amounts parse exactly per instrument (`"3 tNVDA"`); instruments must be on the allowlist and in
  `otc.instruments`; a trade's dollar side ≤ `otc.max_usd`; an offer's escrowed dollars and a take's dollar limit count
  toward the strategy's worst-case cost, so `within(wallet)` bounds trading per day; trading runs in strategies only (a
  skill someone pays for never trades the daemon's own funds). **At run time:** `max_open` against the book.
- **The offer book:** `GET https://obol.sh/api/otc` — open, unexpired offers, legs in human units, maker as a daemon.
- **TestStock** `tNVDA` at `0xb3691574f47F2d2b0e526DB8E7074D03336C1db2` (18 decimals, deployer-mintable, testnet only, no
  price) — something besides the test dollar to trade; 10 minted to daemon #2.

## 2. What was proven

**Unit:** `obol/test/otc.test.mjs` 10/10 — exact amounts and junk refused; the `otc {}` block; offers and takes compile and
carry their dollar cost; every refusal (no otc block, unlisted instrument, over max_usd, same token both sides, bad
expiry, empty side, a skill trading, bad skip_if_none); the daily cap bounds an hourly take ("48.00 a day > daily cap
40.00"); `otc{}` is holder-only; the offer picker (too dear, too few, our own, multi-leg, cheapest per unit); `max_open`
refuses before sending; nothing matching sends nothing. **Mutations 18/18.** All suites: 64 Worker, 13 compiler.

**Live (`tools/otc-proofs.mjs`), after the holder's proposals (#2 proposal 7, #1 proposal 6 — both merged, each plan
only the intended additions):**

| | | |
|---|---|---|
| 1 | #2's `sell_nvda` posts offer #1: 3 tNVDA for 1.80 tUSDG | tx `0x4fca8762…29a5`; 3 tNVDA moved into DaemonOTC's escrow |
| 2 | #1's `buy_nvda` finds it and takes it | tx `0xc3aab7b5…f24e`; offer closed |
| 3 | balances | #1 +3 tNVDA, −1.80 tUSDG · #2 +1.80 tUSDG · escrow empty — read on chain |
| 4 | the Floor | `buy_nvda` ok, spent `otc-take` 3 tNVDA for 1.8 tUSDG, with the tx |

## 3. Issues found

- **The agentfiles on disk had drifted from the heads.** Daemon #1's head carried its own merged changes (milestone 08)
  and #2's a sibling's (07); proposing the old files would have silently reverted them. Both files were synced to their
  heads first; the plans confirmed only the intended additions. Rule: before a holder proposal, the file must match the
  head (the plan shows any unintended change — read it).

## 4. Known gaps

- Bundles only: covered calls / cash-secured puts, index vaults and bounded swaps are later (§9b); options and swaps
  stay on testnet until counsel.
- `take` matches single-leg offers only; no partial fills; offers can't be cancelled from an agentfile yet (they expire).
- Prices are the agentfile's fixed numbers — there is no price feed for test tokens; on mainnet a limit would want a
  reference (Mob's Chainlink stock feeds).
- The book reads every offer from chain on each request (fine at this scale; an indexer later).

## 5. How to reproduce

```
cd obol && node --test test/*.test.mjs && npm run deploy
cd .. && node tools/propose.mjs 2 agents/2.hcl "<reason>" && node tools/propose.mjs 1 agents/1.hcl "<reason>"
node tools/otc-proofs.mjs
curl https://obol.sh/api/otc
```
