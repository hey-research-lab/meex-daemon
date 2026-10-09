# Milestone 03 — First testnet deployment, and the first x402 call between two daemons

**Date:** 2026-10-07 · **Status:** live on Robinhood Chain testnet (46630); the facilitator ran locally
**Code:** `contracts/script/DeployTestnet.s.sol`, `contracts/src/test-chain/TestDollar.sol`, `tools/obol-local/`
(`server.mjs`, `client.mjs`, `refusals.mjs`), `tools/ledger.mjs` · **Addresses:** `deployments/rhc-testnet.json` ·
**Ledger:** `ledger/LEDGER-testnet.md`, `ledger/ledger-testnet.csv`
**Builds on:** [01 — the daemon wallet](01-daemon-wallet.md), [02 — the sale and OTC](02-sale-and-otc.md) ·
**Designed by Chad Neal; published by SHYGUY LLC.**

---

## 1. What this milestone delivers

The contracts from milestones 01–02 running on a public chain, ten daemons sold through the sale, and **one daemon
paying another for a skill over x402**: request → 402 with the price → the buyer's wallet pre-approves exactly that
payment → the facilitator verifies and settles → the skill's answer comes back. The same flow obol.sh will run.

## 2. What is deployed (Robinhood Chain testnet, 46630)

| Contract | Address | Note |
|---|---|---|
| TestDollar (tUSDG) | `0x2Ce7B2d37DF6fFb1EB30b7Ebc86E033f1628B914` | testnet only: testnet has no dollar with EIP-3009 (its USDC has no `transferWithAuthorization`) |
| DaemonAccount (implementation) | `0xbE6296C9d98056983b29F9598840F0C4186BBAF7` | milestone 01, bound to tUSDG |
| DaemonSale | `0xf862c4DaAfCEc95dfaA22Ab946Cf60ca23cB0e4A` | treasury = the testnet bank, standing in for SHYGUY LLC |
| DaemonNFT | `0x336923B1E796202B3a59690ea3680240C3eA4c7d` | all 10,048 minted to the sale |
| DaemonOTC | `0x3369a6B7686f532Bd23EacD2c0d1276334428897` | milestone 02 |
| ERC-6551 registry | `0x000000006551c19487814612e58FE06813775758` | canonical, already on testnet ([EIP-6551](https://eips.ethereum.org/EIPS/eip-6551)) |

**Testnet parameters:** identical to mainnet except the first band price: **0.0001 ETH** (1/100 of 0.01), so ten test
purchases don't lock up the testnet bank. The price math itself is proven to the wei on the mainnet fork (milestone 02).

## 3. Sources

| | Source |
|---|---|
| x402 v2: `PAYMENT-REQUIRED` (base64 JSON with `x402Version`, `accepts[]`, `resource`), `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`; scheme `exact` = EIP-3009 | [x402 (Coinbase)](https://github.com/coinbase/x402); the same shapes our production services use (clawg.network, Re:TCG Appraise) |
| EIP-3009 `transferWithAuthorization` and its standard typehash | [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009); tUSDG's typehash equals USDG's on mainnet (`0x7c7c…2267`, tested) |
| ERC-1271 checks in tUSDG | [OpenZeppelin `SignatureChecker` v5.1.0](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.1.0/contracts/utils/cryptography/SignatureChecker.sol) |
| Robinhood Chain testnet RPC, chain ID | [Connecting to Robinhood Chain](https://docs.robinhood.com/chain/connecting) |
| Live data the skill sold | mob.markets `/api/board` (our own service, mainnet prices) |

## 4. The steps

### 4.1 Before spending anything
- **tUSDG parity test** (`test/TestDollar.t.sol`, on the mainnet fork): same typehash as real USDG; a pre-approved
  payment from a daemon wallet settles; a replay and an unapproved payment are refused; a normal EOA signature works.
  3/3 pass.
- **Dry run:** `forge script` simulated the whole deployment: 15.8M gas, ≈ 0.00032 ETH.

### 4.2 Keys (all created straight into the macOS Keychain, never printed)
| Role | Keychain item | Address |
|---|---|---|
| Bank, deployer, holder of the ten test daemons, stand-in treasury | (Keychain) | `0x76c4…2DFF` |
| Daemon #1's agent | (Keychain) | `0x72cE…5ED1` |
| Daemon #2's agent | (Keychain) | `0x7cb3…557E` |
| Facilitator (pays settlement gas) | (Keychain) | `0x74A9…9010` |

### 4.3 Deployment (`DeployTestnet.s.sol`, one broadcast, 23 transactions, all successful)
Deploy the five contracts → link the sale to the collection → **buy daemons #1–#10 through the sale** → give daemons
#1 and #2 agents and limits (25 tUSDG per call, 40 per day; the OTC contract allowed; each other as payee) → 100 tUSDG
into each of their wallets → 0.0005 test ETH of gas to each agent and the facilitator.

Verified afterwards from the chain, not from the script: 10 sold, 10,038 still with the sale; daemons #1–#10 owned
by the bank; each of their wallets holding 0.00009 ETH (90% of 0.0001); daemon #11's wallet empty; wallets #1 and #2
holding 100 tUSDG with the right agent and caps.

### 4.4 The x402 call
1. Daemon #2's agent requested `GET /d/1/top_movers` and got **402** — pay **0.02 tUSDG** to **daemon #1's wallet**
   (`0x00e6…2783`) on `eip155:46630`.
2. The agent asked daemon #2's wallet to pre-approve exactly that payment: `approvePayment`, tx
   `0x706c75bf…99a3f2` (125,452 gas). The wallet checked the payee and the caps on chain.
3. It retried with `PAYMENT-SIGNATURE` = the EIP-3009 authorization and an **empty signature** — the wallet, not the
   agent, vouches for it through ERC-1271.
4. The facilitator verified every field and **simulated** the transfer, the skill ran (Mob's two biggest-moving
   tokenized stocks: PENG +9.89% in 24 h, −2.47% vs the listed stock; MRNA −9.59%, +0.72%), and the facilitator settled:
   `transferWithAuthorization(…, bytes)`, tx `0x4beb1653…4d5288` (73,037 gas).
5. **Result:** daemon #2 100 → 99.98 tUSDG; daemon #1 100 → 100.02; daemon #2's daily spend counter 0.02.

### 4.5 Refusals, run live
At the facilitator (simulation only, nothing spent):

| Attempt | Refused because |
|---|---|
| replay of the settled payment | the token's `AuthorizationUsedAlready` (nonce already used) |
| a payment the wallet never approved | `InvalidSignature` (the wallet's ERC-1271 said no) |
| pays the wrong wallet | facilitator: "pays the wrong wallet" |
| pays too little | facilitator: "pays too little" |

At the wallet (simulated `approvePayment` calls), each reverted with the right error: a stranger as payee →
`PayeeNotAllowed`; 26 tUSDG (cap 25) → `OverCap`; a stranger posing as the agent → `NotAgent`.

## 5. Cost

| Item | Gas | Fee (ETH) |
|---|---|---|
| Deploy DaemonAccount implementation | 2,531,129 | 0.0000253 |
| Deploy DaemonNFT (10,048 minted) | 2,184,537 | 0.0000218 |
| Deploy TestDollar | 2,039,071 | 0.0000204 |
| Deploy DaemonOTC | 1,455,541 | 0.0000146 |
| Deploy DaemonSale | 1,302,077 | 0.0000130 |
| One buy (creates the wallet, funds it) | 186,373–220,573 | ≈ 0.000002 |
| One x402 payment: approve + settle | 125,452 + 73,037 | ≈ 0.000002 |
| **The whole milestone (25 transactions)** | | **≈ 0.00012 in fees**, plus 0.0025 moved into wallets and keys |

Testnet bank: 0.1 → **0.09748 ETH**. Testnet gas 0.02 gwei.

## 6. Known gaps

- The facilitator and skill server ran **locally** (`localhost:8402`); obol.sh must be detached from the `sunset`
  redirect before it can serve them.
- Settlement happens **after** the skill runs; a failed settlement is reported (HTTP 502), but the answer was already
  computed. Production order and refunds are open.
- One skill, hard-coded in the server; skills are not yet compiled from agentfiles (the compiler exists:
  `lang/compile.mjs`).
- Agents act only when a script runs them — no Durable Object, no schedule, no inbox yet.
- No TestMarket or MockFeed yet; OTC not yet exercised on testnet; the Floor doesn't exist yet.
- Base Sepolia funds (0.0345) still mid-withdrawal; not needed.

## 7. How to reproduce

```
cd tools/obol-local
node server.mjs &                       # skill server + facilitator (keys from the environment)
node client.mjs                         # daemon #2's agent buys daemon #1's skill (keys from the environment)
node refusals.mjs '{"validBefore":"…","nonce":"0x…"}'   # replay the settled nonce + three more refusals
```

## 8. Next milestone

Agents that run on their own: one Cloudflare Durable Object per daemon (memory, schedule, inbox), skills compiled from
agentfiles and served on obol.sh, the facilitator as a Worker, and the first version of the Floor showing it all.
