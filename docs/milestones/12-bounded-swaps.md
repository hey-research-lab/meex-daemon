# Milestone 12 — Bounded swaps: long or short a stock against a sibling, nothing on credit

**Date:** 2026-10-08 · **Status:** live at **https://obol.sh** (Robinhood Chain **testnet only, until counsel**) ·
`SPEC.md` §9b item 4 · **Code:** `contracts/src/DaemonSwaps.sol`, `contracts/src/test-chain/MirrorFeed.sol`,
`contracts/test/Swaps.fork.t.sol`, `lang/swaps.mjs`, `obol/src/swaps.mjs`, `obol/src/mirror.mjs`,
`obol/src/clock.mjs`, `tools/swap-proofs.mjs` · **Builds on:** [10](10-options.md), [11](11-indexes.md) ·
**Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

**DaemonSwaps** at `0x47b46b07eE60bEE0037d4Fd4ba8B698fFee82B77` (RHC testnet). It's the SPEC's answer to perps: one
daemon is long a Chainlink price feed and a sibling is short it, for a fixed term.

- **The move is capped:** at most ±50%, set per swap.
- **Both sides escrow their maximum loss up front:** notional × cap. There's no margin, no liquidation and no
  funding, and neither side can lose more than it locked.
- **Entry:** the feed's latest round when the swap is taken. That round may be no older than the maker's `maxStale`,
  so a stale feed can't be used to pick the maker off.
- **Exit:** the **first round at or after expiry**. Anyone may settle by naming that round; the contract checks that
  the round before it is earlier than expiry, so no one can choose a convenient later price.
- **Payout:** the long gets its escrow + notional × (exit − entry) / entry, clamped to ± the escrow, and the short gets
  the rest. That's exact to the micro-dollar, and the two always sum to both escrows.
- **No price, no loss:** if no settling round can be shown within **7 days** of expiry, either party refunds both
  escrows whole.
- **Who may use it:** only daemons of the collection. There's no owner, no fee and no admin.
- **Allowlist:** the holder added it to both wallets with `constitute` (same agent and caps). Tx `0xd78949a8…` for #1
  and `0xe0c92abd…` for #2.

**Prices on testnet.** Chainlink has 58 feeds on RHC **mainnet** and none on testnet. So **MirrorFeed**
`0x5f7aDC6E114c7a5beAd0f6cfc05517b6c974fC49` (testnet only) carries the rounds of Chainlink's mainnet "Robinhood NVDA
/ USD" (`0x379E…9F15`, 8 decimals, a 1-day heartbeat and 0.5% deviation) across, in order and never skipping one.
Settling needs the previous round, so a skipped round would make a swap unsettleable.
- **It's a trusted relay**, posted by one feeder key (`0x381F…B83f`, Worker secret
  `FEEDER_KEY`). That's exactly why it never goes to mainnet; there, DaemonSwaps reads Chainlink's own proxy.
- **The rules are on chain:** round ids only rise, prices are positive, and timestamps are never ahead of the chain
  and never go back.
- **The schedule:** the **Clock** Durable Object's own alarm runs the mirror every 10 minutes. The cron trigger and
  `POST /admin/mirror[?now=1]` only kick it. `GET /api/mirror` shows the last run.

**In an agentfile:**

```hcl
swaps {                      # the holder's limits — max_usd is the most ONE swap may lose (its escrow)
  underlyings = ["NVDA"]
  max_open    = 2
  max_usd     = "3"
}
strategy "nvda_long" {       # daemon #2
  every = "24h"
  step "offer" { swap_offer { underlying = "NVDA"  side = "long"  notional = "10 tUSDG"  cap = "20%"  term = "6h"  max_stale = "6h"  expires = "24h" } }
}
strategy "nvda_short" {      # daemon #1
  every = "24h"
  step "take" { swap_take { underlying = "NVDA"  side = "short"  notional_at_most = "10 tUSDG"  cap_at_most = "20%"  term_at_most = "24h" }  skip_if_none = true }
}
```

- **Cost:** the escrow (notional × cap) is the step's dollar cost and can't exceed `swaps.max_usd`, so the daily-cap
  gate bounds swaps.
- **`swap_take`** takes the oldest offer on the other side that's within every bound. When the price is older than the
  maker allows, it skips instead of sending a transaction that would revert.
- **Settling and refunds are housekeeping** on each daemon's own run, for swaps it's a party to.
- **`GET https://obol.sh/api/swaps`** is the swap book.

## 2. What was proven

**Contract** (`Swaps.fork.t.sol`, a fork of RHC mainnet with the real registry, USDG and **Chainlink's real NVDA/USD
feed**): **18/18.** Coverage:

- **The real feed:** entry is the feed's actual answer, and settlement works on its phase-encoded round ids.
- **The payout:** +5% to the long; beyond the cap clamped; a maker short wins a drop; a −99.5% crash is clamped too.
- **Fuzzed conservation:** 256 runs show the payouts always sum to the two escrows.
- **The settling round:** only the first round at or after expiry is accepted, never a later or an earlier one; there's
  no settling before expiry, a bad exit price can't settle, and nothing settles twice.
- **Refunds:** only after the grace period, and only by a party; there's no refund of a settled swap, and the other
  swaps' escrows stay whole.
- **Offers:** a stale entry is refused; cancel, expiry, double-take and self-trade are handled; only daemons can offer
  or take; bad terms are refused; the escrows count against the daily caps.
- **The mirror's rules.**

**Mutations 36/36**, after two fixes:
- One survivor was a real gap: a refund of an already settled swap would have paid out of *other* swaps' escrow. The
  test was added.
- A redundant zero-cap clause was removed, because the dust check already refuses it.

**Unit tests** (`obol/test/swaps.test.mjs`, 9):
- The limits and every refusal; the escrow as the cost; strategies only; the daily cap; holder-only limits.
- The take picker: the other side, within every bound, oldest first.
- The settling-round search: the first at or after expiry, exact expiry counted, and nothing when the history can't
  prove which round is first.
- Housekeeping: settle what ended, wait without a price, refund past the grace period, ignore swaps it isn't party to.
- Runtime refusals send nothing; a take approves exactly the escrow.
- The mirror's plan: every round in order, catch-up, a phase jump, and nothing when the source is behind.

**Mutations 36/36** (two first survived, "oldest first" and "nothing new"; tests added for both). All suites: **101
Worker, 14 compiler.**

**Live (`tools/swap-proofs.mjs`, after the holder's proposals #2→12 and #1→9):**

| | | |
|---|---|---|
| | The mirror posted Chainlink's NVDA round `…552813`: **$230.93487262**, updated 17:22:04Z | tx `0x05def4bf…e3ba` |
| 1 | #2 `nvda_long` offers swap #1: long NVDA, 10 tUSDG notional, ±20%, 6 h | 2.00 escrowed |
| 2 | #1 `nvda_short` takes the short side | entry **230.93487262** = the feed's latest round; 2.00 escrowed; **4.00 held, all either side can ever lose** |
| 3 | Expiry **2026-10-09 00:51:16Z**; daemon #1 settled it on its own run, on round `…552814` (01:44:44Z, the first after expiry): exit **$232.08976716** | long **+0.05**, short **−0.05**; the contract holds exactly the open escrows; tx `0xb1cdfe7f…7657` |

## 3. Issues found

- **The P&L was rounded to whole basis points.** The first version computed the move in whole bps before multiplying,
  so +4.999…% paid 0.499 instead of 0.500. Found by the real-feed test; the payout is now computed from the prices and
  is exact to the micro-dollar.
- **A refund-after-settle drain:** the survivor described above, caught by mutation testing before deploy.
- **Cron triggers don't fire on this account** (Playset's ccsales had the same problem). After 11 minutes the mirror
  hadn't run. The Clock Durable Object's alarm is now the schedule, and the cron is only a kick.
- **The public RPCs answer 429 under load.** The mirror's clients retry 5 times starting at 1 s. A failed run is kept
  in `/api/mirror` and retried in 10 minutes.

## 4. Known gaps

- **Testnet only, until counsel.** These are derivatives on stock tokens (CFTC/SEC territory).
- **The testnet price is a trusted relay** (one feeder key). On mainnet the contract would read Chainlink's proxy
  directly; that's tested on the fork, not deployed.
- **Settling across a Chainlink phase change** can't prove the first round, so such a swap refunds after the grace
  period.
- **Stock feeds are stale outside market hours.** A maker who sets a long `max_stale` accepts overnight or weekend
  entries.
- Settling only happens on a party's own run. Anyone may settle on chain, but there's no keeper.
- Only NVDA has a feed so far; any of Chainlink's 58 RHC feeds could be mirrored the same way.

## 5. How to reproduce

```
cd contracts && forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract Swaps
cd ../obol && node --test test/*.test.mjs && npm run deploy        # then wait ≥ 45 s
curl https://obol.sh/api/mirror                                     # the Clock's last mirror run
cd .. && node tools/propose.mjs 2 agents/2.hcl "<reason>" && node tools/propose.mjs 1 agents/1.hcl "<reason>"
node tools/swap-proofs.mjs            # open a swap
node tools/swap-proofs.mjs --settled  # after expiry + a new price round
```
