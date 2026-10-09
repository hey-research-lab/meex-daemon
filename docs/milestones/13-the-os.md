# Milestone 13 — The OS: each daemon's own screen, as its NFT's animation

**Date:** 2026-10-08 · **Status:** live at **https://obol.sh/d/1/os** … **/d/10/os** (Robinhood Chain testnet) ·
`SPEC.md` §6b and build-order step 1 ("the OS shell") · **Code:** `obol/src/os.mjs` (data, metadata, image),
`obol/src/os-page.mjs` (the page), `obol/src/daemon.mjs` (`osData()`), `obol/src/worker.mjs` (routes) ·
**Builds on:** [07](07-the-repo.md)–[12](12-bounded-swaps.md) · **Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

The chain now resolves to a live screen: `tokenURI(n)` (already `https://obol.sh/d/<n>` on the deployed DaemonNFT) →
**ERC-721 metadata** → **`animation_url` = `/d/<n>/os`**, the daemon's own screen. A marketplace shows it in its
viewer, and a holder sees what their daemon is doing without reading a log.

| Route | What |
|---|---|
| `GET /d/<n>` | metadata: name, description, image, `animation_url`, `external_url`, and attributes from its limits (skills, strategies, version, OTC / options / swaps, the index it publishes) |
| `GET /d/<n>/os` | the OS page: five screens, refreshed every 30 s |
| `GET /d/<n>/image.svg` | a generated typographic image: number, skills, strategies, version. **A placeholder while the art is parked**, and it says so by being plain |
| `GET /api/daemon/<n>/os` | everything the page shows, as JSON (CORS open) |

**The five screens** (SPEC §6b):
- **Wallet:**
  - Every balance, including gas.
  - **Today's spend against its on-chain caps**, as a bar that turns amber past 75%, plus thinking against its budget.
    A daemon with no budget says "doesn't think".
  - A warning when the constitution was set by a previous holder (inert until the new one sets it).
  - Every open position, seen from its own seat: OTC offers, options (writer or holder), swaps (long or short, with
    entry and time to expiry) and index shares (with the vault's live "fully backed").
  - Who controls it: the wallet, the holder and the agent key.
- **Log:** the last 100 events, **skips included with their reasons** (the Floor leaves skips out). Each line is in
  the event's own words.
- **Inbox:** the last 30 messages, sender, kind, and whether it came from its holder.
- **Repo:** the head, what it runs (each strategy's schedule and when it last ran), proposals with their plan and any
  failed gates, and the commits.
- **Market:** what it sells and at what price; what it sold and paid over x402, and its net; its trades by kind; the
  index it publishes and what one share holds.

**Built for a marketplace iframe:** no storage, links open a new tab, it works at 600×600 and at phone width with no
horizontal scroll, and it uses the Floor's visual system.

## 2. What was proven

**Unit** (`obol/test/os.test.mjs`, 5):
- **The market tally:** failures and model calls don't count as sales, purchases or trades.
- **Positions:** only this wallet's and only open ones; a taker of a long-maker swap is shown short; an index it
  manages is shown even with no shares.
- The metadata shape and attributes.
- The SVG escapes what it prints.
- **The page renders hostile sibling text inert on every screen.** The page's own script runs against a stub DOM with
  `<img src=x onerror=…>` planted in every sibling- or holder-writable field (messages, log details, proposal reasons
  and plans, symbols, names); nothing comes out unescaped.

**Mutations 16/16:** escaping removed per field (inbox, log, plan, market keys, the whole `esc`, the SVG); the tally
filters; the position filters; the taker's side; the `animation_url`.

All suites: **106 Worker, 14 compiler.**

**Live:**
- `tokenURI(2)` → `https://obol.sh/d/2` → metadata with `animation_url` `https://obol.sh/d/2/os`.
- #2's OS shows the real state: 101.2 tUSDG, 10 tNVDA, spend 2.90 of 40.00; OTC offer #2; puts #2 and #3 held; swap
  #1 long with its entry; tNVX published (fully backed); 34 x402 payments to #1 (−0.68 net); 12 proposals.
- `/d/1/top_movers` still answers 402. The OS routes are registered before the skill route, which would otherwise
  have read `/d/1/os` as a skill named "os". Unknown daemons answer 404.
- One look at 600×600 and 390×844. That led to one fix: "thinking today 0.000000 of 0.00" now reads "doesn't think".
  The captures were deleted.

## 3. Known gaps

- **The image is a placeholder.** The 3D art is parked; when it resumes, `image` changes and the OS stays the
  animation.
- **The Farcaster snap form** of the OS (SPEC §6b "also served as a Farcaster snap, like Open Books") isn't built.
- **Paid analytics** (SPEC §6) isn't built: P&L after fees, attribution, the network view.
- Positions read every book from chain on each request (cached 15 s), which is fine at ten daemons; an indexer comes
  before ten thousand.
- The Market screen counts from the last 100 events, not all history.

## 4. How to reproduce

```
cd obol && node --test test/*.test.mjs && npm run deploy
cast call 0x336923B1E796202B3a59690ea3680240C3eA4c7d 'tokenURI(uint256)(string)' 2 --rpc-url https://rpc.testnet.chain.robinhood.com
curl https://obol.sh/d/2          # metadata → animation_url
open https://obol.sh/d/2/os
```
