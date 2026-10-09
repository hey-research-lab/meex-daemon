# Milestone 10 — Options: covered calls and cash-secured puts between daemons

**Date:** 2026-10-08 · **Status:** live at **https://obol.sh** (Robinhood Chain **testnet only, until counsel**) ·
`SPEC.md` §9b item 2 · **Code:** `contracts/src/DaemonOptions.sol`, `contracts/test/Options.fork.t.sol`,
`lang/options.mjs` (the `options {}` limits, write/buy/exercise checks, in-the-money), `obol/src/options.mjs` (the book,
write, buy, exercise, reclaim), `obol/src/schedule.mjs` (per-strategy schedule), `tools/options-proofs.mjs` ·
**Builds on:** [09](09-otc-bundles.md) · **Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

**DaemonOptions** at `0x39155170c596DEDAae9E197246F96DC55832BD76` (RHC testnet). Physically settled, fully
collateralised, and the writer can never owe more than it locked:

- **Covered call:** the writer escrows the stock. The buyer pays the premium; until expiry it may pay the strike (the
  total for the lot) and take the stock.
- **Cash-secured put:** the writer escrows the strike in dollars. The buyer pays the premium; until expiry it may
  deliver the stock and take the dollars.
- **Reclaim:** an unsold option can be withdrawn by its writer at any time. A bought option that wasn't exercised
  returns to the writer after expiry. The expiry second still belongs to the buyer.
- No oracle, no margin, no owner, no fee, no admin. Writers and buyers must both be wallets of this collection
  (checked against the ERC-6551 registry), like DaemonOTC.
- Allowlisted on both daemon wallets by the holder (`constitute`, same agent and caps, one new target). Tx `0x77a1bd5a…`
  for #1 and `0xfc1778cf…` for #2. DaemonOTC is still allowed.

**In an agentfile:**

```hcl
options {                       # the holder's limits — only the holder can change them
  underlyings = ["tNVDA"]
  max_open    = 3               # live options (listed, or bought and unexpired), written or held
  max_usd     = "5"             # any strike or premium
}
strategy "write_calls" {        # daemon #2
  every = "24h"
  step "write" { write_option { kind = "call"  stock = "3 tNVDA"  strike = "1.50 tUSDG"  premium = "0.10 tUSDG"  expires = "72h" } }
}
strategy "calls" {              # daemon #1
  every = "12h"
  step "exercise" { exercise { reference = "otc" } }
  step "buy" { buy_option { kind = "call"  stock_at_least = "3 tNVDA"  strike_at_most = "1.60 tUSDG"  premium_at_most = "0.15 tUSDG" }  skip_if_none = true }
}
```

- **`write_option`** first reclaims the daemon's own bought-and-expired options, then counts `max_open`, then writes.
- **`buy_option`** buys the listed option with the lowest premium per share among those that fit: the same kind, at
  least the stock named, a strike within the bound (at most for a call, at least for a put), the premium within the
  bound, unexpired, and not the daemon's own.
- **`exercise`** acts only when an option is **in the money against the OTC book**: a call when its strike per share is
  below the cheapest ask, a put when its strike is above the best bid. With no reference it holds. No model decides.
- **Worst-case dollars count toward the strategy's cost:** a put escrows its strike, a buy pays at most its premium, and
  an exercise may pay `max_open × max_usd` of call strikes. So `within(wallet)` bounds options per day, and the wallet
  contract bounds them again on chain.
- **The options book:** `GET https://obol.sh/api/options`.

**Fixed along the way: a per-strategy schedule.** `alarm()` ran **every** strategy each time it fired, at the shortest
`every`. #2's daily `sell_nvda` would have posted every hour from 18:05 (it had run once since it merged at 17:00).
Each strategy now runs only when its own `every` has passed (5 min slack). A failed or skipped run counts as a run.
The alarm still wakes at least daily, because reflect rides on it. `POST /admin/run/<id>?strategy=<name>` forces one
strategy, and a force asked for during a running alarm is no longer pushed out by it. A run that moved anything is
always on the Floor, even when a later step skipped.

## 2. What was proven

**Contract** (`Options.fork.t.sol`, a fork of RHC mainnet with the real registry and USDG): **14/14.**

- A call exercised, and a call left to expire back to its writer, with the premium kept.
- A put exercised, and a put whose cash returns after expiry.
- The expiry second: exercise allowed, reclaim refused. After it, the reverse.
- Escrows stay whole across options; exercising the same option twice is refused.
- An unsold option withdrawn at any time, and unbuyable after.
- Only daemons write or buy. Only the buyer exercises, only the writer reclaims.
- Self-buy, double-buy, buying after expiry and bad terms are refused.
- A writer short of the stock reverts, and nothing is written.
- A put's cash is capped by the wallet's per-call approve cap.
- Premium and strike count against the buyer's daily cap.

**Mutations 23/23**, each caught by a failing test, not by a compile error.

**Unit tests** (`obol/test/options.test.mjs` 13, `schedule.test.mjs` 4):
- The `options {}` block, and every write and buy refusal.
- Costs: call 0, put strike, buy premium, exercise `max_open × max_usd`. The daily cap refuses an hourly exercise
  ("240.00 a day > daily cap 40.00").
- `options {}` is holder-only: a daemon or a sibling can't add, widen or remove it, and the plan shows it.
- The buy picker; in the money, exactly, both ways; at the money is not in.
- The live count.
- At runtime: refused at `max_open` before sending; nothing matching sends nothing; reclaim before write; exercise
  approves exactly the strike.

**Mutations 38/38** (two first survived: no second stock to be unlisted, and a too-dear option that never won the sort
anyway; tests added for both). Scheduler mutations **9/9** (one first survived: the daily wake). All suites: **81
Worker, 13 compiler.**

**Live (`tools/options-proofs.mjs`, after the holder's proposals #2→8 and #1→7, both merged, each plan only the intended
additions):**

| | | |
|---|---|---|
| 1 | #2 `write_calls` writes call #1: 3 tNVDA, strike 1.50, premium 0.10, 72 h | 3 tNVDA moved into escrow |
| 2 | #1 `calls` buys it | #2 +0.10 premium |
| 3 | #2 `sell_nvda` posts OTC ask #2: 3 tNVDA for 1.80 (0.60 a share) | the reference |
| 4 | #1 `calls`: 0.50 a share < 0.60, so it **exercises** against offer #2 | tx `0x9cc1c043…6ed7`; #1 +3 tNVDA from escrow, −1.50; #2 +1.50; the ask still open (exercising beat buying it) |
| 5 | #1 `write_puts` writes cash-secured puts #2 and #3: strike 1.20, premium 0.05, 24 h | 1.20 escrowed per put |
| 6 | #2 `puts` buys #2, then #3 (tx `0x71704efb…f949`) | no bid on the book, so it **holds and does not exercise** |
| | **escrow on chain afterwards** | **0 tNVDA, 2.40 tUSDG**: exactly the two held puts' strikes |

## 3. Issues found

- **The scheduler ignored each strategy's `every`** (above). The on-chain daily cap still bounded real spending, but the
  plan-time gate's per-day arithmetic was wrong for every daemon with more than one strategy. Fixed and mutation-checked.
- **The first proof run had three red checks, all from sequencing:**
  - A never-run strategy is due, so forcing `calls` also ran the brand-new `write_puts`. That put #2 was written early;
    #1's −1.30 in step 2 was the 0.10 premium plus the 1.20 put escrow.
  - Step 5 then wrote put #3, and its escrow check read before the second put landed.
  - Step 6's second forced run arrived while the first alarm was still running, and that alarm's closing `setAlarm`
    pushed it out an hour. Fixed: a pending force now keeps the next alarm at +3 s.
  - The puts leg was then re-run on its own and confirmed (row 6). The script now waits between forced runs, looks for
    a *new* put, and its header warns that never-run strategies ride along.
- Daemon #2 still has a **held proposal #6**: the milestone-07 refusal proof (a sibling setting `think_budget`) on a stale
  base. It's the holder's to reject.

## 4. Known gaps

- **Testnet only.** Options and swaps stay off mainnet until counsel.
- **The in-the-money reference is the sibling OTC book**, which is thin: no bid has ever been posted, so puts can't be
  exercised until something posts one. On mainnet a reference would want a price feed (Mob's Chainlink stock feeds).
- **Expired escrow returns at the writer's next `write_option`, not at expiry.** #1's puts #2 and #3 expire about
  10-09 17:35Z. The daily `write_puts` that comes due a few minutes before then won't see them expired yet, so they come
  back the day after. There's no standalone `reclaim` step.
- **No partial exercise, no transfer of a bought option**, and no early close by the writer once it's sold.
- `exercise` is all-or-nothing per option, in book order, with no ranking among in-the-money options.
- Strategies run in name order (the HCL parser sorts block labels). #1's `buy_nvda` runs before `calls`, so on a
  scheduled run the OTC ask can be taken before `calls` judges against it.

## 5. How to reproduce

```
cd contracts && forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract Options
cd ../obol && node --test test/*.test.mjs && npm run deploy
cd .. && node tools/propose.mjs 2 agents/2.hcl "<reason>" && node tools/propose.mjs 1 agents/1.hcl "<reason>"
node tools/options-proofs.mjs            # every strategy must have run once first (see the header)
curl https://obol.sh/api/options
```
