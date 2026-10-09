// OTC on chain (milestone 09): the offer book, and a daemon posting or taking a bundle through DaemonOTC — every call
// made by the daemon's agent THROUGH its wallet's `execute`, so the wallet contract's constitution applies (allowlisted
// targets only; `approve` only to an allowlisted spender; every dollar that leaves measured against the daily cap).
import { encodeFunctionData, parseAbi, parseEventLogs } from "viem";
import { D, SALE, pub, signer } from "./chain.mjs";
import { parseAmount, INSTRUMENTS } from "../../lang/otc.mjs";

export const OTC = parseAbi([
  "function post(uint256 makerTokenId,(address token,uint256 amount)[] give,(address token,uint256 amount)[] want,uint64 expires) returns (uint256)",
  "function take(uint256 id,uint256 takerTokenId)",
  "function cancel(uint256 id)",
  "function offers(uint256) view returns (address maker,uint64 expires,bool open)",
  "function nextId() view returns (uint256)",
  "function legs(uint256 id) view returns ((address token,uint256 amount)[] give,(address token,uint256 amount)[] want)",
  "event Posted(uint256 indexed id, address indexed maker, uint64 expires)",
  "event Taken(uint256 indexed id, address indexed maker, address indexed taker)",
]);
const ACCT = parseAbi(["function execute(address to,uint256 value,bytes data,uint8 operation) payable returns (bytes)"]);
const ERC20 = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const BY_ADDR = Object.fromEntries(Object.entries(INSTRUMENTS).map(([sym, x]) => [x.address.toLowerCase(), { sym, ...x }]));
const human = (l) => { const i = BY_ADDR[l.token.toLowerCase()]; if (!i) return { token: l.token, raw: String(l.amount) }; const v = Number(l.amount) / 10 ** i.decimals; return { sym: i.sym, amount: String(+v.toFixed(i.decimals)), token: l.token, raw: String(l.amount) }; };

const walletCache = new Map();
export async function walletOf(env, id) {
  if (!walletCache.has(id)) walletCache.set(id, await pub(env).readContract({ address: D.sale, abi: SALE, functionName: "walletOf", args: [BigInt(id)] }));
  return walletCache.get(id);
}

/** open, unexpired offers (newest first), legs in human units, the maker as a daemon number when it's one of 1–`ids` */
export async function book(env, { ids = 10, limit = 200 } = {}) {
  const client = pub(env);
  const next = Number(await client.readContract({ address: D.otc, abi: OTC, functionName: "nextId" }));
  const makers = new Map(); for (let i = 1; i <= ids; i++) makers.set((await walletOf(env, i)).toLowerCase(), i);
  const now = Math.floor(Date.now() / 1000), out = [];
  for (let id = next - 1; id >= 1 && id >= next - limit; id--) {
    const [maker, expires, open] = await client.readContract({ address: D.otc, abi: OTC, functionName: "offers", args: [BigInt(id)] });
    if (!open || Number(expires) < now) continue;
    const [give, want] = await client.readContract({ address: D.otc, abi: OTC, functionName: "legs", args: [BigInt(id)] });
    out.push({ id, maker, makerDaemon: makers.get(maker.toLowerCase()) ?? null, expires: Number(expires), give: give.map(human), want: want.map(human) });
  }
  return out;
}

export async function viaWallet(env, agentKey, wallet, calls) {
  const { wallet: w } = signer(env, agentKey), client = pub(env), hashes = [];
  for (const [to, data] of calls) {
    const hash = await w.writeContract({ address: wallet, abi: ACCT, functionName: "execute", args: [to, 0n, data, 0] });
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
    hashes.push({ hash, logs: r.logs });
  }
  return hashes;
}

/** post a bundle: approve each give leg to DaemonOTC, then post — max_open counted from the book first */
export async function postOffer(env, { daemonId, agentKey, give, want, expiresSec, maxOpen, bookFn = book, walletFn = walletOf, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId);
  const mine = (await bookFn(env)).filter((o) => o.maker.toLowerCase() === wallet.toLowerCase());
  if (mine.length >= maxOpen) throw new Error(`already ${mine.length} open offers (otc.max_open ${maxOpen})`);
  const g = give.map(parseAmount), wnt = want.map(parseAmount);
  const leg = (a) => ({ token: a.token, amount: a.raw });
  const expires = BigInt(Math.floor(Date.now() / 1000) + expiresSec);
  const calls = [...g.map((a) => [a.token, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [D.otc, a.raw] })]),
    [D.otc, encodeFunctionData({ abi: OTC, functionName: "post", args: [BigInt(daemonId), g.map(leg), wnt.map(leg), expires] })]];
  const txs = await send(env, agentKey, wallet, calls);
  const posted = parseEventLogs({ abi: OTC, logs: txs.at(-1).logs, eventName: "Posted" })[0];
  return { posted: Number(posted?.args?.id ?? 0), tx: txs.at(-1).hash, give, want, expires: Number(expires) };
}

/**
 * The offer a take rule accepts, from the book: the only give leg is ≥ `get` of that token, the only want leg ≤ `pay`
 * of that token, not our own; the cheapest per unit received wins (want/give, compared exactly). Pure. null = none.
 */
export function pickOffer(offers, { wallet, get, pay }) {
  const fits = offers.filter((o) => o.maker.toLowerCase() !== wallet.toLowerCase()
    && o.give.length === 1 && o.want.length === 1
    && o.give[0].token.toLowerCase() === get.token.toLowerCase() && BigInt(o.give[0].raw) >= get.raw
    && o.want[0].token.toLowerCase() === pay.token.toLowerCase() && BigInt(o.want[0].raw) <= pay.raw);
  fits.sort((a, b) => (BigInt(a.want[0].raw) * BigInt(b.give[0].raw) < BigInt(b.want[0].raw) * BigInt(a.give[0].raw) ? -1 : 1));
  return fits[0] ?? null;
}

/** take what pickOffer chooses: approve its want leg to DaemonOTC, then take. Nothing matching → { taken: null }. */
export async function takeBest(env, { daemonId, agentKey, getAtLeast, payAtMost, bookFn = book, walletFn = walletOf, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId), get = parseAmount(getAtLeast), pay = parseAmount(payAtMost);
  const o = pickOffer(await bookFn(env), { wallet, get, pay });
  if (!o) return { taken: null, looked: getAtLeast, for: payAtMost };
  const txs = await send(env, agentKey, wallet, [
    [o.want[0].token, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [D.otc, BigInt(o.want[0].raw)] })],
    [D.otc, encodeFunctionData({ abi: OTC, functionName: "take", args: [BigInt(o.id), BigInt(daemonId)] })],
  ]);
  return { taken: o.id, from: o.makerDaemon, got: o.give.map((l) => `${l.amount} ${l.sym}`), paid: o.want.map((l) => `${l.amount} ${l.sym}`), tx: txs.at(-1).hash };
}
