# Milestone 07 — The repo: proposals, gates, merges

**Date:** 2026-10-07 · **Status:** live at **https://obol.sh** (Robinhood Chain testnet) · build-order step 3 of
`SPEC.md` §8 (the repo + plan/apply + gates; holder and self) and the sibling half of step 4
**Code:** `obol/src/repo.mjs` (signatures, plan, gates), `obol/src/daemon.mjs` (commits, proposals, head),
`lang/check.mjs` (the checks without the parser), `tools/propose.mjs`, `tools/repo-proofs.mjs`
**Builds on:** [06](06-daemons-think.md) · **Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

- **Every daemon has a repo** — its agentfile's history, readable by anyone at `GET /api/daemon/<id>/repo`: the head,
  commits (hash, parent, author, reason) and every proposal with every gate's verdict. **The head is what runs**:
  skills are served and strategies scheduled from it. The build's bundled agentfile is only the genesis commit.
- **Proposals, by who may make them** (SPEC §3 `evolve{}`):

  | Author | How | What happens |
  |---|---|---|
  | **Holder** | EIP-712 `Proposal` signed by `ownerOf(daemon)` | gates now → merged or rejected |
  | **Sibling** | signed by another daemon's holder or active agent (`by = N`) | **held**; the holder reviews; the preview shows the gates |
  | **Self** | from inside the Durable Object (the next milestone's reflect step) | held for the holder until a scoring gate exists |

  The holder approves a held proposal with an EIP-712 `Approval` over that proposal's exact agentfile; then the gates
  decide, as for the holder's own.
- **The holder's workflow:** edit `agents/<id>.hcl`, then `node tools/propose.mjs <id> agents/<id>.hcl "<reason>"` —
  it compiles locally, signs with the Keychain key, posts, and prints the plan and each gate.

## 2. The gates (all run; every reason kept)

| Gate | Passes when |
|---|---|
| change | the proposal changes something (a no-op is refused) |
| base | it was written against the current head (otherwise: rebase) |
| lint | the full compiler checks pass (`lang/check.mjs`, the same code the Mac runs) |
| within(wallet) | no x402/model step's `max` exceeds the wallet's per-call cap, and no strategy's worst case × runs a day exceeds the daily cap — caps **read live from the wallet's on-chain constitution** |
| constitution | `think_budget` changes only with the holder's authority |

**Not yet** (named so nobody assumes them): `backtest("90d")` and `paper("3d")` from the spec — they need trading
strategies, which don't exist yet — and a **score** gate (does the change beat the head). Until score exists, the
daemon's own drafts are held for the holder, never auto-merged.

The invariant from the spec holds structurally: a proposal can change what a daemon *does*; what it *may* do is the
wallet's constitution on chain, which only the holder can change, and no agentfile can exceed it.

## 3. Why the repo stores JSON

The HCL parser is Go compiled to WebAssembly (1.7 MB gzipped, loaded through Go's wasm bridge) — it stays on the Mac.
The repo stores the parsed form; all checks run on it, in the Worker and on the Mac alike. Step order is the order of
the `step` object's keys; the version hash covers it (sorting keys for the hash would otherwise erase it — fixed here,
with a test). The daemon's model will draft this JSON directly.

## 4. What was proven

**Unit:** `obol/test/repo.test.mjs` 20/20 — holder, sibling and approval signatures; refusals for a stranger as holder,
a stranger as sibling, a self-proposal over HTTP, another daemon, stale, no reason, unknown sibling, swapped
agentfile, swapped reason; each gate as a refusal; the plan. **Mutations 17/17.** Compiler 13/13 (step order and the
order-covering hash each caught when deleted). All suites: 42 Worker, 13 compiler, 27 contracts.

**Live:**
- **A. Holder, from HCL** (`tools/propose.mjs 2 agents/2.hcl "…"`): plan `~ strategy "watch_movers": step "tell"
  changed`; 5/5 gates; **merged**, head `f1d95382ae6c` → `6da975b76aec`.
- **`tools/repo-proofs.mjs`: 10/10**

| | Case | Result |
|---|---|---|
| B | the same proposal again, on the old head | rejected: change, base |
| C | two 1.00 payments an hour | rejected: within(wallet) — "up to 48.00 a day > daily cap 40.00" |
| D | `every = "30m"` | rejected: lint |
| E | a stranger signing as the holder | 401 |
| F | #1's agent proposes a receipt text to #2 | **held**; head unchanged |
| G | a stranger approves it | 401 |
| H | the holder approves it | **merged**, head → `34e191362001` |
| I | #1's agent proposes raising #2's think_budget | held; preview: "only the holder can change think_budget" |
| J | #2 runs (admin trigger) | its receipt to #1 now reads "Receipt (suggested by daemon #1): …" — the merged head ran |

Round J: approve `0x08bff812…`, settle `0xb4bc3520…` (ledgered).

## 5. Issues found

- **A Durable Object serves the old code for tens of seconds after a deploy** — the first call to the new `repo()`
  answered "The RPC receiver does not implement the method". Same as milestone 06's first trigger. Anything that calls
  a new DO method right after a deploy must retry or wait.
- The version hash sorted every key, which erased step order — two agentfiles that differ only in order would have
  had one hash. It now hashes the order too.

## 6. Known gaps

- Held proposals wait forever; no expiry, no notification to the holder (the Floor shows them).
- Commit hashes aren't anchored on chain yet ("the version running is provable" in the spec).
- No UI for review — the API and the Floor's feed only.
- The reflect step (the daemon drafting its own diff) is next; it will use `propose({ role: "self" })`.

## 7. How to reproduce

```
cd obol && node --test test/*.test.mjs && npm run deploy   # wait ~30 s before new DO methods answer
cd .. && node tools/propose.mjs 2 agents/2.hcl "<reason>"                     # holder proposal from HCL
node tools/repo-proofs.mjs
curl https://obol.sh/api/daemon/2/repo
```
