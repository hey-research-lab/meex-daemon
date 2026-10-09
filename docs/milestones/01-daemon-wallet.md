# Milestone 01 — The daemon wallet (DaemonAccount)

**Date:** 2026-10-07 · **Status:** proven on a fork of Robinhood Chain mainnet; not yet deployed anywhere
**Code:** `contracts/src/DaemonAccount.sol` · **Tests:** `contracts/test/DaemonAccount.fork.t.sol` · **Commit:** `0ec0356`
**Designed by Chad Neal; published by SHYGUY LLC.**

This record is the baseline for later documentation and guides. It says what was built, why it is shaped the way it is,
what was proven and how, and what is still open — with a source for every external fact.

---

## 1. What this milestone delivers

Every Daemon NFT owns a wallet. The wallet:

- belongs to the NFT, not to a person, so it moves with the NFT when it is sold;
- lets the NFT's current holder do anything;
- lets the daemon's **agent** (an automated signer) act only inside limits the holder set — its *constitution*;
- can pay for x402 services in USDG on Robinhood Chain without the agent ever holding signing power over the money.

## 2. The building blocks and where they come from

| Block | What it is | Source |
|---|---|---|
| ERC-6551 token-bound accounts | A smart-contract wallet deterministically derived from (chain, NFT contract, token ID), controlled by whoever owns the NFT | [EIP-6551](https://eips.ethereum.org/EIPS/eip-6551) |
| ERC-6551 registry | The canonical, chain-independent factory at `0x000000006551c19487814612e58FE06813775758` | [EIP-6551 § Registry](https://eips.ethereum.org/EIPS/eip-6551#registry); bytecode present on RHC mainnet and testnet (checked 2026-10-07, 571 bytes each) |
| ERC-1271 | How a contract wallet answers "is this signature valid?" — it receives only a hash and returns a magic value | [EIP-1271](https://eips.ethereum.org/EIPS/eip-1271) |
| EIP-3009 | `transferWithAuthorization`: a token transfer authorized by a signature and submitted by anyone | [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009) |
| EIP-712 | Typed-data hashing used to build the digest USDG checks | [EIP-712](https://eips.ethereum.org/EIPS/eip-712) |
| x402 | HTTP 402 payments: the server answers with payment requirements; the client pays with an EIP-3009 authorization that a facilitator verifies and settles | [x402 (Coinbase)](https://github.com/coinbase/x402); our production use: clawg.network and Re:TCG Appraise |
| USDG (Global Dollar) | Paxos's dollar token — the dollar on Robinhood Chain | [Paxos USDG](https://www.paxos.com/usdg); contract `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` on RHC (address from our DCA research config; name/symbol read on chain) |
| Robinhood Chain | Arbitrum Orbit L2; mainnet chain ID 4663, testnet 46630 (settles to Ethereum Sepolia) | [Connecting](https://docs.robinhood.com/chain/connecting), [Bridging](https://docs.robinhood.com/chain/bridging), [Protocol contracts](https://docs.robinhood.com/chain/protocol-contracts) |
| OpenZeppelin Contracts v5.1.0 | `IERC721`, `IERC20`, `IERC1271`, `ECDSA` | [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts/tree/v5.1.0) |

## 3. What we verified about USDG on Robinhood Chain (before writing code)

x402 needs EIP-3009, and a daemon's wallet is a contract, so USDG must accept a signature checked through ERC-1271.
Read directly from the chain on 2026-10-07 (`https://robinhood-rpc.publicnode.com`):

- `name()` = "Global Dollar", `symbol()` = "USDG", `decimals()` = 6. A proxy (ERC-1967 implementation
  `0x68184c44…6f8f`).
- `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` = `0x7c7c6cdb…2267`, `authorizationState(address,bytes32)` answers,
  `DOMAIN_SEPARATOR()` answers, `PERMIT_TYPEHASH()` answers → EIP-3009 and EIP-2612 are present.
- **Both** `transferWithAuthorization` forms exist: `(…, uint8 v, bytes32 r, bytes32 s)` (selector `0xe3ee160e`) and
  `(…, bytes signature)` (`0xcf092995`, the form contract wallets need). Each reverted with `InvalidSignature()` to a
  dummy call, while a made-up selector failed with a different error.
- `version()` returned empty — the EIP-712 domain version must be read from `DOMAIN_SEPARATOR()` rather than assumed
  (our contract does exactly that).
- No hosted x402 facilitator (Coinbase CDP, Circle Gateway) lists Robinhood Chain, so **obol.sh will run its own
  facilitator** — verify the authorization, submit it, pay gas in ETH.
- Testnet's own USDC (`0xbf4479C0…275F`) has no `transferWithAuthorization`, which is why the testnet plan deploys a
  test dollar with EIP-3009 (see `TESTNET-PLAN.md`).

## 4. Design

### 4.1 Ownership
`owner()` reads the NFT's current holder (`ownerOf`) through the token data the registry writes into the account's
bytecode (the reference layout: chain ID, token contract, token ID after a 0x4d offset). The holder may call
`execute` with anything. On another chain the account reports no owner.

### 4.2 The constitution (the agent's limits)
Set by the holder with `constitute(agent, maxPerCall, maxPerDay, maxEthPerCall, targets[], payees[])`:

- **agent** — the only other key allowed to act;
- **caps** — per call and per UTC day, in USDG units, plus an ETH cap per call;
- **targets** — contracts the agent may call or approve (routers, the OTC settlement contract);
- **payees** — addresses the agent may pay over x402 (sibling daemons' wallets, allowlisted services).

**Bound to the holder who set it.** The constitution records `configuredBy`; it works only while that address still
holds the NFT. Found during design: without this, a seller could add their own address as a payee, sell the daemon,
and keep receiving payments up to the daily cap. After a sale every agent action reverts `InertAfterTransfer` until
the new holder constitutes again.

### 4.3 What the agent can do
| Call | Rule |
|---|---|
| `token.transfer(to, amt)` (any token) | only to the current holder — a withdrawal |
| `token.approve(spender, amt)` (any token) | spender must be an allowlisted target; USDG approvals capped per call |
| `token.transferFrom` | never |
| any other call | target must be allowlisted; ETH value capped |
| after every allowed call | the account's **USDG balance is measured before and after**; the outflow counts against the per-call and per-day caps, whatever the target did |

### 4.4 x402 payments without giving the agent signing power
ERC-1271 passes the wallet only a hash. If the agent could answer "valid" for any hash, it could authorize a USDG
transfer to anyone and bypass every limit. So the agent never signs payments. Instead:

1. The agent calls `approvePayment(to, value, validAfter, validBefore, nonce)`.
2. The account checks `to` is an allowed payee and `value` fits the caps, then computes the exact EIP-3009 digest
   (`\x19\x01 ‖ USDG.DOMAIN_SEPARATOR() ‖ keccak(typehash, from=this, to, value, validAfter, validBefore, nonce)`)
   and stores it as approved.
3. The facilitator (anyone) calls USDG's bytes-form `transferWithAuthorization(from = the wallet, …, signature = "")`.
4. USDG calls the wallet's `isValidSignature(digest, "")`; the wallet answers yes because that digest was approved.

`isValidSignature` answers yes only for approved digests and for the current holder's own ECDSA signatures.

## 5. What was proven

**Environment:** Foundry 1.7.1 (Solc 0.8.33), a fork of Robinhood Chain mainnet at block ≈82,209,627
(`forge test --fork-url https://rpc.mainnet.chain.robinhood.com`). Real ERC-6551 registry, real USDG; a test NFT
contract and a test "router" deployed inside the fork. Forge's `deal()` works on USDG's storage. No ETH was spent.

| # | Test | Proves |
|---|---|---|
| 1 | `test_dealt` | the fork really holds USDG in the wallet (guards the meaning of every other test) |
| 2 | `test_ownerFollowsTheNft` | ownership moves with the NFT; the previous holder is refused at once |
| 3 | `test_constitutionInertAfterSale` | a seller's constitution cannot survive the sale |
| 4 | `test_agentWithdrawsOnlyToHolder` | the agent can send tokens to the holder and to no one else |
| 5 | `test_agentTargetsAndApprovals` | unknown targets refused; approvals only to allowlisted spenders; USDG approvals capped |
| 6 | `test_measuredOutflowCaps` | a target pulling 25 then 20 USDG is stopped at the 40/day cap; the next day it passes |
| 7 | `test_x402PaymentSettlesOnRealUsdg` | **a pre-approved payment settles through real USDG from the contract wallet** (203,335 gas including the approval) |
| 8 | `test_unapprovedOrAgentSignedPaymentRefused` | USDG refuses a payment the agent merely signs, and an unapproved one |
| 9 | `test_paymentPayeeAndCaps` | payments only to allowed payees; the same caps apply |
| 10 | `test_ownerSignatureValid` | the holder's signature is valid through ERC-1271; the agent's is not |

**10/10 pass.** Then, per house rule, each guard was deleted in turn and the suite re-run; every deletion turned at
least one test red:

| Mutation | Result |
|---|---|
| no inert-after-sale check | 1 failed |
| agent may transfer to anyone | 1 failed |
| outflow not measured | 1 failed |
| any payee | 1 failed |
| ERC-1271 says yes to anything | 2 failed |
| approve any spender | 1 failed |
| no per-call cap | 1 failed |

## 6. Known gaps (carried to the next pass)

- Outflows of **stock tokens and ETH** through an allowed target are bounded only by that target's own logic (e.g. a
  router's minimum-out); the account measures USDG outflow only.
- Only `CALL` is supported — no delegatecall or contract creation from the wallet.
- Not yet tested on testnet with real time passing, a real facilitator service, or the agent's Privy signer.
- An approved digest stays approved until USDG consumes its nonce or `validBefore` passes; there is no explicit
  revoke yet.
- No external review or audit.

## 7. Testnet funding, for context

Robinhood Chain testnet settles to Ethereum Sepolia; its Delayed Inbox on Sepolia is
`0xF2939afA86F6f933A3CE17fCAB007907B6b0B7a4` ([Protocol contracts](https://docs.robinhood.com/chain/protocol-contracts);
verified on chain: `inbox.bridge()` and `bridge.rollup()` match the published Bridge and Rollup). The testnet bank is
`0x76c4…2DFF` (0.1 ETH). An earlier 0.035 went to Base Sepolia by mistake and is being withdrawn. Every funding
transaction is in `ledger/LEDGER-testnet.md`.

## 8. How to reproduce

```
cd contracts
forge test --fork-url https://rpc.mainnet.chain.robinhood.com -vv
```

## 9. Next milestone

The sale contract (10,048 daemons, ten bands at ×1.3 from 0.01 ETH, most of each price funding that daemon's wallet)
and the OTC settlement contract (bundles first) — on the fork, then the first testnet deployment with obol.sh's
facilitator.
