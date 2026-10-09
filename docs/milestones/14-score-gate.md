# Milestone 14 — The score gate: a daemon's own draft is paper-traded, and merges itself if it wins

**Date:** 2026-10-08 · **Status:** live at **https://obol.sh** (Robinhood Chain testnet); first trial running ·
`SPEC.md` §4 (the self-improvement loop) · TESTNET-PLAN proof 12 · **Code:** `obol/src/paper.mjs` (scope, paper send,
scoring), `obol/src/steps.mjs` (paper mode), `obol/src/daemon.mjs` (`startTrial`, `runTrials`) ·
**Builds on:** [08](08-reflect.md) · **Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

**The operator's rule (2026-10-08):** "paper-traded against the current version for 3 days and if it wins, auto
merge."

**Which drafts get a trial.** A self-draft (from reflect) that passes every gate and changes **only how a strategy
runs** gets a trial: its schedule (`every`), or a model step's `prompt` or `max`. Anything else stays held for the
holder, as before:
- a skill's **price or description**, because demand only answers the live price;
- any change beyond those paths, found by re-applying the changed paths to the head and comparing hashes.

**Paper mode.** For 3 days the draft's version of each changed strategy runs on **its own schedule**, beside the
current version. It uses the same inbox (its own cursor, starting at the trial) and the same order books.
- **The same runtime functions run**, with a `send` that records instead of submitting: the same pickers, books and
  `max_open` checks. Dollars out are the recorded approvals of the dollar token.
- **The current version's real runs are measured the same way**, through a counting wrapper around the real send.
- **x402 is quoted, not paid:** one unpaid GET, and the 402's amount. Messages aren't sent.
- **Model calls are real**, because they are what's being judged. They're metered against a **separate paper
  budget** of the same size, so a trial can't starve the version it competes with.

**Scoring.** The window opens at the draft's first paper run, when both versions are caught up. It needs ≥ 3 full
days and ≥ 3 paper runs per strategy. The draft **wins only if all three hold:**
1. **Uptime:** no more failed runs than the current version.
2. **Coverage:** every message that arrived early enough for its own schedule was handled, and it did its work at
   least as often. ("Did its work" means not skipped; the agentfile's own `skip_if_*` rules say when there was nothing
   to do.)
3. **Cost:** it spent **strictly less** (model + x402 + dollars out).

**Outcomes:**
- **Won → merged by itself**, through the same `decide` path a holder's approval takes, so every gate runs again on
  the way in. The scorecard is kept as the proposal's evidence.
- **Lost → closed**, with the reasons; rejected diffs stay public (SPEC §4).
- **Inconclusive** (not enough runs by day 7, or neither version did anything) → **still held for the holder**, with
  the scorecard.
- The trial ends early if the holder decides the draft first or the head moves.

**Watching it:** trials, paper-run counts, the last five paper runs and the outcome are at
`GET /api/daemon/<n>/repo`, and on the OS Repo screen under "Paper trials".

## 2. What was proven

**Unit** (`obol/test/paper.test.mjs`, 11):
- **Scope:** the three eligible kinds; price and description refused; a sneaky extra change, an added step, and no
  change at all are refused.
- **Dollar counting:** approvals of the dollar token only. Paper records and never sends; the current version is
  counted the same way.
- **Spend and "acted"** are defined the same way for both sides.
- **Winning:** the same work for less wins.
- **Losing,** each rule on its own: equal cost (and cost is the *only* reason given), a failure, a missed message,
  acting less.
- **A message too late for the draft's schedule** isn't held against it.
- **Running, inconclusive, and the day-7 cap.**
- **The window:** only rows in the window and only strategies under trial; the window opens at the first paper run,
  where the current version's pre-trial backlog would otherwise have counted against the draft.
- Paper runs on the draft's own schedule.
- **Paper mode in the runner:** x402 quoted with one unpaid GET; the message not sent.

**Mutations 25/25** (one more was equivalent and dropped: the decoder only knows `approve`). Two first survived:
- "strictly less": the equal-cost case was also failing on coverage. Fixed so cost is its only difference.
- the window start: tested once it moved into `paper.mjs`.

All suites: **117 Worker, 14 compiler.**

**Live:** daemon #1, proposal **#10**, a shorter `reply` prompt with the same rules in fewer words. It was entered
through reflect's admin stand-in answer and labelled as a proof.
- Every gate passes, so **trial 1 started 2026-10-08 19:26:50Z**.
- The first paper run found no new messages: its cursor starts at the trial. That's correct, and it's what exposed the
  backlog bias, now fixed.
- **Scored once 3 days have passed since its first paper run, ~2026-10-11 19:27Z.** It merges itself only if it handled
  every message, never failed more, and cost less. The outcome isn't known in advance.

## 3. Issues found

- **The current version's backlog biased the trial.** At the first alarm, the current version answered messages from
  before the trial, while the draft's cursor started at the trial. Counted from the trial's start, that was one extra
  "acted" against the draft. The window now opens at the first paper run (extracted, tested and mutation-checked).
- **One deploy went out with a new test failing** (the deploy wasn't chained after the tests). The deployed code was
  right and the test's window end was wrong; fixed. Rule kept: `node --test … && npm run deploy`.

## 4. Known gaps

- **Prices and descriptions can't be paper-traded**, so those drafts still wait for the holder. Judging them needs
  real demand, for example an A/B on the live price.
- **Trading strategies are compared on dollars out, not P&L.** There's no price feed for the test stocks, so "the same
  work for less" is the rule rather than "more profit". On mainnet, P&L after fees against Chainlink would join it.
- **One trial at a time**, because reflect drafts one change while a draft is held.
- Paper x402 can't see a paid response's body, so a later step that depends on it runs on `null`. Only the cost and
  whether it acted are compared.

## 5. How to reproduce

```
cd obol && node --test test/*.test.mjs && npm run deploy     # chained: no deploy on a red test
curl -s https://obol.sh/api/daemon/1/repo | python3 -c "import json,sys; print(json.load(sys.stdin)['trials'][0])"
open https://obol.sh/d/1/os                                                    # Repo → Paper trials
```
