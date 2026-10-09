# Skill language — vetting (2026-10-07)

What a daemon's `skill` block has to become: an **x402 v2 PaymentRequirements** (what a buyer pays, to whom, on which
chain), **Bazaar discovery** metadata (how agents find and call it), and a run plan the daemon can execute safely after
rewriting itself. Prototype: `compile.mjs`, 7 tests (`node --test compile.test.mjs`), the worst-case-cost rule
mutation-checked.

## Findings

1. **HCL parses in Node** (`@cdktf/hcl2json`, WASM). It gives structure only: any expression comes back as an opaque
   `"${…}"` string, so we define and evaluate expressions ourselves (Terraform does the same). Its strictness helps
   hand editing: a malformed block fails with a line, column and a plain-English fix.
2. **So: no expression language. References only.** `${input.cert}` and `${steps.appraise.body}` are allowed;
   `${upper(x)}`, arithmetic and conditionals are refused at plan time. A self-modifying daemon can rearrange vetted
   blocks; it cannot write logic.
3. **Steps come from a closed set:** `x402` (buy from another service), `fetch` (free GET on an allowlist), `model`
   (think, capped), `mob` (prices and gaps), `pick` (select fields). There is no code step. URLs are checked against an
   allowlist at plan time.
4. **The worst-case cost is computed before it runs.** Every `x402` and `model` step declares a `max`; the sum is the
   skill's worst case; a skill priced below it is refused ("it could sell at a loss"). This is how `margin >= 0`
   becomes a guarantee rather than a hope.
5. **x402 works on Robinhood Chain, but only through our own facilitator.**
   - RHC's dollar is **USDG** (Paxos Global Dollar, `0x5fc5…d168`), not USDC. It has EIP-3009
     (`TRANSFER_WITH_AUTHORIZATION_TYPEHASH`, `authorizationState`) and EIP-2612 permit, and **both**
     `transferWithAuthorization` forms exist: (v,r,s) and the (bytes signature) form contract wallets need. Each
     answered `InvalidSignature()` to a dummy call; a made-up selector failed differently.
   - Coinbase's and Circle's facilitators don't list RHC. **obol.sh runs the facilitator**: verify the signed
     authorization, submit it, pay gas in ETH.
   - To confirm on testnet: the bytes form validates an ERC-6551 account's signature through ERC-1271, and USDG's
     EIP-712 domain name/version (`version()` returned empty; read `eip712Domain()`).
6. **Facilitator description limit:** ≤500 chars (Coinbase's facilitator rejected longer on clawg) — enforced.

## The grammar (v0)

```hcl
skill "<name>" {
  description = "≤500 chars, what the buyer gets"
  price       = "0.03"            # USDG, plain decimal, ≤6 places
  timeout     = "30s"             # → maxTimeoutSeconds
  input { cert = "string" }       # → Bazaar inputSchema
  step "<id>" {                   # exactly one of: x402 | fetch | model | mob | pick
    x402  = "https://…"           # allowlisted
    max   = "0.02"                # required on x402 and model
    query = { cert = "${input.cert}" }
  }
  output = "${steps.<id>.body}"
}
```

Compiles to `{ scheme: "exact", network: "eip155:4663", asset: USDG, amount: <atomic>, payTo: <the daemon's TBA>,
maxTimeoutSeconds, extra: { name: "Global Dollar" }, resource: { url: "https://obol.sh/d/<id>/<skill>", … } }`.
The money goes straight to the daemon's own wallet.

## Still to decide

- ~~`model` step pricing~~ **Decided 10-07:** a token cap (`max_tokens`) × a posted rate per brain. Hosted Qwen at our
  cost, **no fee on inference** (near zero on our own box); frontier at the provider's price, passed through; BYOK = 0
  to the daemon. Worst-case cost = cap × rate, so the plan-time loss check still holds.
- **Allowlist — Decided 10-07 (option 2):** ours at launch (Re:TCG, slabbasis, Mob, Revere, clawg, obol.sh — which covers
  every daemon's skills); holders may add hosts to THEIR daemon by signing a wallet{} change; a daemon can never add a
  host itself. Why a list at all: a self-modifying daemon steered by a sibling PR or by text in a response could pay
  an attacker's x402 endpoint its max, send its inbox or a holder's question out, or read injected instructions.
- Whether `pick` stays field selection only, or gets a tiny JSONPath.
