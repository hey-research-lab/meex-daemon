# Milestone 15 — Think bills: a daemon's wallet pays for its own thinking

**Date:** 2026-10-08 · **Status:** live at **https://obol.sh** (Robinhood Chain testnet) · `SPEC.md` §7 ("the agent's
TBA, per call: tokens × a posted rate at our cost, no fee on inference") · **Code:** `obol/src/bill.mjs`,
`obol/src/daemon.mjs` (`billsOwed`, `bill`, `billPaid`, `payBills`, the meter's refusal), `obol/src/worker.mjs`
(`/think-bill/<n>/<day>`) · **Builds on:** [03](03-first-x402.md), [06](06-think.md) ·
**Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

Since milestone 06, model calls had been **metered** against each daemon's daily think budget but never **paid**. Now
they are.

- **One bill per closed UTC day** at `GET /think-bill/<n>/<YYYY-MM-DD>`: that day's metered model calls (strategies,
  reflect and paper trials alike), at the posted per-token rate, **at cost with no fee**. It answers **402** with the
  exact amount, payable over x402 in tUSDG to the **SHYGUY LLC treasury** (`DaemonSale.treasury()`; on testnet that's
  `0x76c4…2DFF`, which is also the holder).
  - A paid day answers 200 with its tx.
  - Today answers 404 "billed after midnight UTC".
  - A day with nothing metered answers 404.
- **The daemon pays its own bills** at the start of its next run, oldest first, through the same `pay()` it uses for
  skills. The wallet pre-approves exactly that payment (EIP-3009 via ERC-1271), the obol facilitator settles it, and
  the wallet's caps and payee list apply.
- **No pay, no thinking:** a bill unpaid for more than **2 days** makes the meter refuse every model call ("think bill
  overdue … it thinks again once it pays") until it's paid.
- **On the OS:** the Wallet screen lists bills owed and the last 7 paid.
- **Allowlist:** the holder added the treasury to both wallets' payee lists with `constitute` (same agent and caps,
  no new target). Tx `0x7c277e2d…` for #1 and `0x254fd323…` for #2.

## 2. What was proven

**Unit** (`obol/test/bill.test.mjs`, 3):
- Bills are per closed day, summed, oldest first whatever order the rows come in; today and paid days aren't billed;
  the last millisecond of a day belongs to that day.
- Overdue begins only past the 2 grace days.
- Day names round-trip, and junk isn't a day.

**Mutations 7/7** (one first survived, "oldest first", which matters because payment stops at the first failure; a
test was added). All suites: **120 Worker, 14 compiler.**

**Live:**

| | | |
|---|---|---|
| | `/think-bill/1/2026-10-07` → 402, 495 micro-USDG; 10-08 → 404 (open); 10-06 → 404 (nothing metered) | |
| 1 | #1's next run paid it | tx `0x064688ac…8627`; treasury **+495**, wallet #1 **−495** micro-USDG, read on chain; the bill now answers paid |

## 3. Known gaps

- **The overdue refusal is unit-tested in its rule**, but hasn't been seen live (no daemon has been 3 days unpaid).
- **The rate is our posted cost for Workers AI Qwen.** If Cloudflare's price changes, `lang/models.mjs` changes with
  it. Nobody audits that on chain.
- **On testnet the treasury is also the holder.** On mainnet it's a separate SHYGUY LLC address, and each holder's
  constitution would need it as a payee. That's a holder action at setup, part of the mint flow.

## 4. How to reproduce

```
cd obol && node --test test/*.test.mjs && npm run deploy
curl -i https://obol.sh/think-bill/1/2026-10-07      # paid → 200 with its tx
open https://obol.sh/d/1/os                          # Wallet → Think bills
```
