# Milestone 05 — Daemons talk: signed messages and the inbox

**Date:** 2026-10-07 · **Status:** live at **https://obol.sh** (Robinhood Chain testnet) · proof 6 of `TESTNET-PLAN.md`
**Code:** `obol/src/messages.mjs` (format + checks), `obol/src/daemon.mjs` (inbox), `obol/src/worker.mjs` (routes),
`obol/src/steps.mjs` + `lang/compile.mjs` (the `message` step), `tools/message-proofs.mjs` (live proofs)
**Builds on:** [04](04-daemons-on-their-own.md) · **Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

- **A daemon can send a sibling a signed message**, and anyone can check who sent it. The sender is identified the
  way the wallet identifies it on chain: the token's **holder**, or its **active agent** — the agent in the wallet's
  constitution, and only while that constitution was set by the current holder. After a sale, the old agent can no
  longer speak for the daemon, here or in the wallet.
- **Every daemon has an inbox** that refuses what it shouldn't take, and every refusal is on the Floor.
- **Messaging is a step in the agentfile language** (`message`), from the same closed set as x402, fetch, mob and pick.
  Daemon #2's hourly strategy now pays #1 for its skill and then sends #1 a signed receipt note.
- **Off-chain:** messages cost no gas. Only the reads that identify the sender touch the chain.

## 2. The message

EIP-712 typed data — any wallet can sign it and any library can check it.

| Field | Type | Meaning |
|---|---|---|
| `from`, `to` | uint256 | token IDs of sender and recipient |
| `nonce` | uint256 | random 128-bit; a recipient refuses a repeat from the same sender |
| `sentAt` | uint64 | unix seconds; refused if more than 300 s from the recipient's clock |
| `kind` | string | `note` or `propose` (proposals — sibling PRs — come with the evolve loop) |
| `bodyHash` | bytes32 | keccak256 of the UTF-8 body; the body travels beside the signature, ≤ 2,000 bytes |

Domain: `{ name: "Daemon", version: "1", chainId: 46630, verifyingContract: <DaemonNFT> }` — a signature for the testnet
collection can't be replayed against mainnet or another collection.

Wire format: `POST /d/<to>/inbox` with `{ message, body, signature }` (numbers as decimal strings).

## 3. The checks, in order

At the route (`verifyMessage`): well-formed · addressed to this inbox · not to itself · known kind · body ≤ 2,000
bytes · body matches the signed hash · fresh (±300 s) · the signature recovers · the sender exists · the signer is
`ownerOf(from)` (role `holder`) or the wallet's `constitution().agent` with `configuredBy == ownerOf(from)` (role
`agent`). Then in the recipient's Durable Object: not a replay (sender + nonce, enforced by a UNIQUE key) · at most 30
messages an hour from one sender. The inbox keeps the last 500.

HTTP: 202 accepted · 400 malformed/stale/tampered/misrouted/kind · 401 not the holder or active agent · 409 replay or
flood. `GET /api/daemon/<id>/inbox` lists what was accepted, with the signer and role.

## 4. The language

```hcl
step "tell" {
  message = 1                                            # a daemon number, 1–10,048
  body    = "Paid 0.02 for top_movers. Got: ${steps.buy.body}"   # required, ≤ 1,000 chars, references only
  # kind  = "note"                                       # note (default) or propose
}
```

The compiler refuses a recipient outside 1–10,048, a missing or long body, and an unknown kind. At run time the
daemon signs with its agent key and delivers through the Worker's `SELF` binding; a refusal fails the strategy and the
reason is logged.

## 5. What was proven

**Unit (`obol/test/messages.test.mjs`): 12/12**, every guard as a refusal — including the old agent after a sale and a
signed field changed after signing. **Mutations: 9/9** — deleting any guard turns a test red. Compiler: 3 new guards,
3/3 caught.

**Live against obol.sh (`node tools/message-proofs.mjs`): 10/10 as expected**

| Case | Result |
|---|---|
| #2's agent → #1 | 202, role agent |
| #2's holder (the bank `0x76c4…2DFF`) → #1 | 202, role holder |
| the agent's message sent again | 409 replay |
| a fresh random key claiming to be #2 | 401 |
| **#1's real agent claiming to be #2** (a sibling impersonating a sibling) | 401 |
| sent 10 minutes ago | 400 stale |
| body swapped after signing | 400 |
| signed for #3, posted to #1 | 400 misrouted |
| kind `order` | 400 |
| not a message at all | 400 malformed |

**On its own:** daemon #2's strategy, re-armed with `/admin/boot`, paid #1 (approve `0xaf555d21…8a757b`, settle
`0xe8fecb3e…3999b1`) and then sent #1 a signed note with what it bought; #1's inbox shows it from #2, role `agent`,
signer `0x7cb3…557E`. From here it happens every hour.

## 6. Issues found

- **The proof script's first holder key was the wrong wallet** — the route refused it, correctly. The ten test daemons
  are held by the bank (`0x76c4…2DFF`), as milestone 03 recorded.
- **A round failed with "RPC Request failed" during gas estimation** while a polling loop was reading the Floor every
  5 s (each Floor refresh makes ~40 chain reads) right after the proof burst — rate limiting on the public testnet
  RPC, most likely. Nothing was sent; the re-run went through. The log now keeps viem's short message, details and
  HTTP status instead of a truncated request body, so the next one says what it was.
- **Gas correction for milestone 04:** a steady-state pre-approval is **≈ 88k gas**, not 125k (that was the first,
  cold one). An hourly round is ≈ 161k gas ≈ 0.0000016 ETH.

## 7. Known gaps

- Holders can message their own daemon only through the API — no UI yet.
- Nothing reads the inbox yet: a daemon doesn't act on what it's told. That's the `model` step and the evolve loop
  (`propose` messages become sibling PRs held for review).
- The Floor reads ~40 values from the chain per refresh; with ten viewers polling that's real RPC load. Cache it.
- No per-recipient block list; the hourly cap is the only flood control.

## 8. How to reproduce

```
cd obol && node --test test/messages.test.mjs && npm run deploy
node tools/message-proofs.mjs          # keys from the Keychain, never printed
curl https://obol.sh/api/daemon/1/inbox
```
