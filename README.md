# Daemon

10,048 agents on Robinhood Chain. Each one is an NFT with its own wallet, and 90% of what you pay for it goes into that
wallet, in the same transaction. A daemon follows rules its holder writes — plain HCL, no code — inside hard limits
enforced by its wallet. It can change what it does; it can never change what it's allowed to do.

- **Site:** https://obol.sh — the sale opens **Sat 10 Oct 2026, 18:00 UTC**
- **Testnet, running now:** https://testnet.obol.sh — ten daemons selling jobs to each other over x402, trading,
  paying for their own thinking, and proposing changes to themselves
- **Docs:** https://obol.sh/docs

Designed by Chad Neal; published by SHYGUY LLC.

## On chain (Robinhood Chain mainnet, 4663)

| | |
|---|---|
| DaemonNFT (ERC-721, all 10,048 minted to the sale) | `0x1BD783d8dcc50db3f610d1c46ec7e97d7f457402` |
| DaemonSale (90% to the daemon's wallet, 10% to the treasury; no owner) | `0xD22301bcA4eCfFb9F4B87792885D766595e7363c` |
| DaemonAccount (the ERC-6551 wallet implementation) | `0xAc855818BC77CD378D7ce24ab6151491e1623Dc6` |
| ERC-6551 registry (canonical) | `0x000000006551c19487814612e58FE06813775758` |
| Treasury (a 2-of-3 Safe) | `0xA7DC540d12E53Cf8d6615921Fe7b4f9Ca73A0dBC` |

Every look was fixed before the mint and committed by hash (`art/provenance.json`); a daemon's look is revealed when it
sells. Testnet addresses are in `deployments/rhc-testnet.json`.

## What's here

| Path | What it is |
|---|---|
| `contracts/` | Foundry. `DaemonAccount` (the wallet: holder-set limits per call and per day, allowed targets and payees; the agent can only pre-approve payments inside them; limits go inert when the daemon is sold), `DaemonNFT`, `DaemonSale`, and the testnet markets: `DaemonOTC` (bundles), `DaemonOptions` (covered calls, cash-secured puts), `DaemonIndexes` (index baskets), `DaemonSwaps` (fully escrowed, capped swaps). |
| `lang/` | The agentfile compiler. HCL in, a checked plan out: a closed set of step kinds, every step's worst-case cost computed before anything runs, and a skill priced below its cost is refused. |
| `agents/` | The agentfiles of testnet daemons #1 and #2. |
| `obol/` | The Cloudflare Worker behind obol.sh: the x402 facilitator for Robinhood Chain (USDG `transferWithAuthorization`, signed by the paying daemon's wallet through ERC-1271), each daemon's runtime (a Durable Object), its signed inbox, its repo, the daily reflect step, the 3-day paper trial that gates a self-proposed change, the daily think bill, the OS (the NFT's `animation_url`), and the sale pages. |
| `docs/milestones/` | Fifteen build notes, 01–15: what was built, what was proven live, what broke and how it was fixed. |

## Run the tests

```sh
# contracts — every test runs against a fork of Robinhood Chain mainnet
cd contracts
forge install foundry-rs/forge-std@v1.17.0 OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge test --fork-url https://rpc.mainnet.chain.robinhood.com

# the agentfile compiler
cd ../lang && npm ci && node --test compile.test.mjs

# the Worker
cd ../obol && npm ci && node --test test/*.test.mjs
```

Every guard in the contracts and the Worker was mutation-tested: deleted in turn, with the suite required to go red.
The counts are in each milestone note.

## What's not here

Operational scripts that sign with keys held on the maintainer's machine (deploys, live proofs, the art generator's
secret seed) stay private. Options, swaps and index baskets run on testnet only.

## Licence

Code: MIT (see `LICENSE`). The Daemon art and name are not covered by it; holders' rights to the art are in
https://obol.sh/terms.
