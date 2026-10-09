# Milestone 04 — Daemons that run on their own, and the Floor

**Date:** 2026-10-07 · **Status:** live at **https://obol.sh** (Robinhood Chain testnet), served by the `obol`
Worker in the Workers account through `obol-proxy` in the zone's own account
**Code:** `agents/` (agentfiles + `build.mjs`), `obol/` (the Worker), `obol-proxy/`, `lang/compile.mjs` (strategies)
**Builds on:** [01](01-daemon-wallet.md), [02](02-sale-and-otc.md), [03](03-first-testnet-x402.md) ·
**Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

- **Daemons act without a script.** Each daemon is a Cloudflare Durable Object with its own memory, log and schedule.
  Daemon #2 wakes every hour, buys daemon #1's skill over x402, and keeps the answer — no one runs anything.
- **Behaviour comes from agentfiles.** Daemon #1's skill and daemon #2's strategy are written in the agentfile
  language and compiled (and checked) at build time; the Worker runs what the compiler produced.
- **The facilitator is a service**, not a script on a laptop, with an x402-shaped API.
- **The Floor v0**: one page with every daemon's balances, spend, schedule and last action, and a feed of every event,
  failures included, each linked to its transaction.

## 2. Architecture

| Piece | Where | What |
|---|---|---|
| `obol` Worker | a Cloudflare account (Workers Paid), `obol.sh` | routes below; Durable Objects; secrets |
| `Daemon` Durable Object (SQLite), one per token ID | same | the compiled agentfile, one alarm (≥ 1 h apart on testnet), a log of its last 500 actions |
| `Floor` Durable Object (SQLite), one | same | the shared feed, last 1,000 events |
| Facilitator | inside the Worker | `verify` (fields + on-chain simulation) and `settle` (`transferWithAuthorization(…, bytes)`, gas from its own key) |
| `obol-proxy` Worker | the account that holds the obol.sh zone (a separate Cloudflare account) | forwards obol.sh and www.obol.sh to the `obol` Worker unchanged |

**Routes:** `GET /` (the Floor) · `GET /api/floor` · `GET /api/daemon/:id` · `GET /d/:id/:skill` (x402 v2) ·
`POST /facilitator/verify` · `POST /facilitator/settle` · `GET /facilitator/supported` · `POST /admin/boot`.

**Why the proxy:** a Worker's custom domain must live in the same Cloudflare account as the zone. obol.sh's zone is in
the zone's own account; the Workers Paid plan is on the Workers account (plans are per account). Durable Objects themselves are
available on the Free plan with SQLite storage ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)),
but the Free plan's CPU limit makes the Workers account the better home; the proxy needs almost no CPU.

**A Worker can't fetch its own public URL**, so when one daemon buys from another on the same Worker the request goes
through a self service binding (`SELF`) — same HTTP, same 402 flow, routed internally.

## 3. Agentfiles (`agents/`)

```hcl
# agents/1.hcl — sells one skill
skill "top_movers" {
  description = "The two Robinhood Chain tokenized stocks that moved most in 24 h, each with its gap to the listed stock, read live from mob.markets."
  price = "0.02"
  timeout = "60s"
  input { }
  step "movers" { mob = "top_movers" }
  output = "${steps.movers.body}"
}

# agents/2.hcl — hourly, buys daemon #1's skill
strategy "watch_movers" {
  description = "Hourly: pay daemon #1 for the top movers and log them."
  every = "1h"
  input { }
  step "buy" {
    x402 = "https://obol.sh/d/1/top_movers"
    max  = "0.02"
  }
  output = "${steps.buy.body}"
}
```

The language grew two things this milestone (`lang/compile.mjs`): **`strategy` blocks** (same closed steps as skills,
an `every` interval of at least an hour, no price — strategies spend, they don't sell) and **`mob` queries as a closed
set** (`top_movers`, `gap:SYM`, `price:SYM`). `agents/build.mjs` refuses to build if any skill or strategy fails a
check. The obol hosts were added to the allowlist so daemons can buy each other's skills.

## 4. What was proven, live

1. `GET /d/1/top_movers` answers **402** with a base64 `PAYMENT-REQUIRED` (x402 v2) naming daemon #1's wallet.
2. `POST /admin/boot` armed the daemons; only daemon #2 has a strategy, so only it was scheduled.
3. **Daemon #2's first run, on its own:** the alarm fired; its strategy paid daemon #1 0.02 tUSDG through its wallet's
   pre-approval (approve `0x3793285a…f6a60d`), the facilitator settled (`0xb366250f…f2fbdf`), and the answer was logged
   (MRNA −10.35%, +0.83% vs the listed stock; PENG +9.60%, −2.69%). Both sides appear on the Floor: #2 "ran
   watch_movers", #1 "sold top_movers". Balances after: #1 100.04, #2 99.96 tUSDG (this run plus milestone 03's).
4. Its next run was scheduled for an hour later, and it keeps running hourly.

## 4b. Bringing obol.sh over (same day)

1. **Finding the zone.** The first account checked turned out to be empty. The archived
   `loom-coordinator/wrangler.toml` named the real account, a separate Cloudflare account.
   The operator logged in (`XDG_CONFIG_HOME=~/.cf/obol`).
2. **Inventory, archive, retire.** The account held three Workers from the old obol platform (`obol-worker` →
   api.obol.sh, `clanker-worker` → api2.obol.sh, `loom-coordinator` → loom.obol.sh), three KV namespaces, nothing
   else. Code, settings and KV data were archived to `a local archive`, then the routes, Workers and KV
   namespaces were deleted. Those Workers held secrets (Anthropic, GitHub, Coinbase CDP, Resend, Supabase, a Bluesky
   app password) that should be revoked at each provider.
3. **The proxy.** Deployed; `www.obol.sh` attached at once. The apex was blocked by its old A record to Vercel
   (`216.150.1.1`; Cloudflare error 100117 even with `override_existing_dns_record`), and the Wrangler login has no
   DNS permission — the operator deleted that record (and the api/api2/loom records) in the dashboard, and obol.sh
   attached.
4. **Switch-over.** `PUBLIC_ORIGIN` and daemon #2's agentfile now say `https://obol.sh`; the 402s name obol.sh;
   daemon-to-daemon calls on obol.sh still route internally through `SELF`.

## 5. Issues found

- **The agentfile version hash ignored nested content.** `JSON.stringify(doc, Object.keys(doc).sort())` only keeps
  top-level keys, so changing daemon #2's URL left its version hash unchanged — useless for anchoring versions.
  Fixed (keys sorted at every level), with a test that a changed URL changes the hash; reverting the fix turns it red.
- **One non-JSON response from `/api/floor`** while polling (probably a testnet RPC hiccup that threw). Fixed: every
  error now returns JSON (502 with the reason), so the Floor shows "couldn't refresh" instead of breaking.

## 6. Cost

Per hourly round: about 198,000 gas (approve ≈ 125k cold, ≈ 88k after + settle ≈ 73k) ≈ 0.0000016 ETH (corrected in milestone 05) at 0.02 gwei, plus 0.02 tUSDG
moving between the daemons. Daemon #2's agent has 0.0005 ETH of gas — months of hourly rounds; the facilitator's
0.0005 likewise. Cloudflare: inside the Workers account's Workers Paid plan.

## 7. Known gaps

- The Vercel project `obol-web` still lists obol.sh as a domain (the CLI login had expired). Harmless — no DNS points
  there — but remove it on the next Vercel login.
- obol.sh is not yet through the venture-launch checklist (security.txt, sitemap, legal pages, Search Console) —
  deliberately, while it is a testnet page.
- **Agent keys live in Worker secrets** (testnet only). Mainnet uses Privy server wallets under policies.
- No `model` step yet (the brain), no inbox or sibling messages, no self-improvement loop, no OTC on testnet yet.
- The Floor is a grid and a feed, not yet the graph of daemons with lines between them.
- No per-event ledger rows for the hourly runs yet: the Floor and the chain hold them; the ledger tool can import
  them by hash.

## 8. How to reproduce

```
cd obol && npm run deploy          # compiles agents/*.hcl, deploys to the Workers account
curl -X POST -H "Authorization: Bearer <ADMIN_KEY>" https://obol.sh/admin/boot
open https://obol.sh
```
