// x402 v2 on Robinhood Chain testnet — both sides.
//   Seller side: requirement() + verify() + settle() — the facilitator obol.sh runs (it pays settlement gas).
//   Buyer side: pay() — a daemon's agent asks its own wallet to pre-approve exactly the required payment, then sends
//   the authorization with an EMPTY signature: the wallet vouches through ERC-1271, never the agent's key.
import { getAddress } from "viem";
import { D, NETWORK, SALE, DOLLAR, ACCOUNT, pub, signer, usd6 } from "./chain.mjs";

export const b64 = (o) => btoa(JSON.stringify(o));
export const unb64 = (s) => JSON.parse(atob(s));

export async function requirement(env, daemonId, skill) {
  const payTo = await pub(env).readContract({ address: D.sale, abi: SALE, functionName: "walletOf", args: [BigInt(daemonId)] });
  return { scheme: "exact", network: NETWORK, asset: D.dollar, amount: usd6(skill.price).toString(), payTo, maxTimeoutSeconds: skill.timeout ?? 60, extra: { name: "Global Dollar (test)", version: "1" } };
}

const txArgs = (a, sig) => [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, sig];

export async function verify(env, payload, req) {
  const a = payload?.payload?.authorization, sig = payload?.payload?.signature ?? "0x";
  const now = Math.floor(Date.now() / 1000);
  const why = !a ? "no authorization"
    : payload.accepted?.scheme !== "exact" || payload.accepted?.network !== req.network ? "wrong scheme or network"
    : getAddress(payload.accepted.asset) !== getAddress(req.asset) ? "wrong asset"
    : getAddress(a.to) !== getAddress(req.payTo) ? "pays the wrong wallet"
    : BigInt(a.value) < BigInt(req.amount) ? "pays too little"
    : BigInt(a.validBefore) <= BigInt(now + 6) ? "expires too soon"
    : null;
  if (why) return { isValid: false, invalidReason: why };
  const f = signer(env, env.FACILITATOR_KEY);
  try {
    await pub(env).simulateContract({ account: f.account, address: req.asset, abi: DOLLAR, functionName: "transferWithAuthorization", args: txArgs(a, sig) });
    return { isValid: true, payer: a.from };
  } catch (e) {
    return { isValid: false, invalidReason: `simulation reverted: ${e.shortMessage ?? e.message}`.slice(0, 160) };
  }
}

export async function settle(env, payload, req) {
  const a = payload.payload.authorization, sig = payload.payload.signature ?? "0x";
  const f = signer(env, env.FACILITATOR_KEY);
  const hash = await f.wallet.writeContract({ address: req.asset, abi: DOLLAR, functionName: "transferWithAuthorization", args: txArgs(a, sig) });
  const r = await pub(env).waitForTransactionReceipt({ hash });
  return { success: r.status === "success", transaction: hash, network: NETWORK, payer: a.from };
}

/** Buyer side. `fetcher` is how to reach the URL (the SELF binding for our own skills). */
export async function pay(env, { daemonId, agentKey, url, max, fetcher }) {
  const r1 = await fetcher(url);
  if (r1.status !== 402) return { ok: r1.ok, status: r1.status, body: await r1.text(), paid: null };
  const required = unb64(r1.headers.get("payment-required"));
  const req = required.accepts.find((x) => x.network === NETWORK && x.scheme === "exact");
  if (!req) return { ok: false, status: 402, error: "no payable option on this chain" };
  if (BigInt(req.amount) > usd6(max)) return { ok: false, status: 402, error: `asks ${req.amount}, the agentfile allows at most ${max}` };
  const me = await pub(env).readContract({ address: D.sale, abi: SALE, functionName: "walletOf", args: [BigInt(daemonId)] });
  const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const a = signer(env, agentKey);
  const approveTx = await a.wallet.writeContract({ address: me, abi: ACCOUNT, functionName: "approvePayment", args: [req.payTo, BigInt(req.amount), 0n, validBefore, nonce] });
  const ar = await pub(env).waitForTransactionReceipt({ hash: approveTx });
  if (ar.status !== "success") return { ok: false, status: 0, error: "the wallet refused to approve", approveTx };
  const payload = { x402Version: 2, accepted: req, payload: { signature: "0x", authorization: { from: me, to: req.payTo, value: req.amount, validAfter: "0", validBefore: validBefore.toString(), nonce } } };
  const r2 = await fetcher(url, { headers: { "PAYMENT-SIGNATURE": b64(payload) } });
  const body = await r2.json().catch(() => null);
  return { ok: r2.ok, status: r2.status, body: body?.result ?? body, paid: { amount: req.amount, to: req.payTo, approveTx, settleTx: body?.settlement?.transaction } };
}
