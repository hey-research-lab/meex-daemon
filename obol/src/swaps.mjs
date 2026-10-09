// Bounded swaps on chain (milestone 12, TESTNET ONLY until counsel): the swap book, offering, taking, and the
// housekeeping that settles a daemon's expired swaps on the first price round at or after expiry (or refunds them when
// no price came within the grace period). Every call is the daemon's agent THROUGH its wallet's `execute`.
import { encodeFunctionData, parseAbi, parseEventLogs } from "viem";
import { D, pub } from "./chain.mjs";
import { parseAmount, INSTRUMENTS } from "../../lang/otc.mjs";
import { FEEDS, parsePct } from "../../lang/swaps.mjs";
import { AGG } from "./mirror.mjs";
import { walletOf, viaWallet } from "./otc.mjs";

const SWAP = "(address maker,address taker,bool makerLong,uint8 state,uint16 capBps,uint32 term,uint32 maxStale,uint64 offerExpires,uint64 start,address feed,address quote,uint256 notional,int256 entry)";
export const SWAPS = parseAbi([
  "struct Terms { address feed; address quote; uint256 notional; uint16 capBps; uint32 term; uint32 maxStale; bool makerLong; uint64 offerExpires; }",
  "function offer(uint256 makerTokenId,Terms t) returns (uint256)",
  "function take(uint256 id,uint256 takerTokenId)",
  "function settle(uint256 id,uint80 roundId)",
  "function refund(uint256 id)",
  "function nextId() view returns (uint256)",
  `function get(uint256 id) view returns (${SWAP})`,
  "event Offered(uint256 indexed id, address indexed maker, address feed, bool makerLong)",
]);
export const GRACE = 7 * 86400;
const ERC20 = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const STATE = ["none", "offered", "live", "settled", "refunded", "cancelled"];
const SYM_OF_FEED = Object.fromEntries(Object.entries(FEEDS).map(([s, f]) => [f.address.toLowerCase(), s]));
const USDG = INSTRUMENTS.tUSDG.address;
const enc = (functionName, args) => encodeFunctionData({ abi: SWAPS, functionName, args });
const escrowOf = (s) => (BigInt(s.notional) * BigInt(s.capBps)) / 10_000n;

/** every swap (newest first), terms readable, parties as daemon numbers when known */
export async function swapBook(env, { ids = 10, limit = 200, walletFn = walletOf } = {}) {
  const client = pub(env);
  const next = Number(await client.readContract({ address: D.swaps, abi: SWAPS, functionName: "nextId" }));
  const who = new Map(); for (let i = 1; i <= ids; i++) who.set((await walletFn(env, i)).toLowerCase(), i);
  const out = [];
  for (let id = next - 1; id >= 1 && id >= next - limit; id--) {
    const s = await client.readContract({ address: D.swaps, abi: SWAPS, functionName: "get", args: [BigInt(id)] });
    out.push({ id, state: STATE[s.state], underlying: SYM_OF_FEED[s.feed.toLowerCase()] ?? s.feed, feed: s.feed,
      maker: s.maker, makerDaemon: who.get(s.maker.toLowerCase()) ?? null, taker: s.taker, takerDaemon: who.get(s.taker.toLowerCase()) ?? null,
      makerSide: s.makerLong ? "long" : "short", notional: String(s.notional), capBps: Number(s.capBps), escrow: String(escrowOf(s)),
      term: Number(s.term), maxStale: Number(s.maxStale), offerExpires: Number(s.offerExpires), start: Number(s.start),
      end: s.start ? Number(s.start) + Number(s.term) : null, entry: String(s.entry),
      terms: `${SYM_OF_FEED[s.feed.toLowerCase()] ?? "?"} ±${Number(s.capBps) / 100}% on ${Number(s.notional) / 1e6} tUSDG for ${Number(s.term) / 3600}h, maker ${s.makerLong ? "long" : "short"}` });
  }
  return out;
}

const mineOf = (all, wallet) => all.filter((s) => (s.maker.toLowerCase() === wallet.toLowerCase() && s.state === "offered") || ((s.maker.toLowerCase() === wallet.toLowerCase() || s.taker.toLowerCase() === wallet.toLowerCase()) && s.state === "live"));

/** offer a swap: approve the escrow (notional × cap), then offer — max_open counted first */
export async function offerSwap(env, { daemonId, agentKey, underlying, side, notional, cap, termH, maxStaleH, expiresH, maxOpen, bookFn = swapBook, walletFn = walletOf, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId);
  const open = mineOf(await bookFn(env), wallet);
  if (open.length >= maxOpen) throw new Error(`already ${open.length} open swaps (swaps.max_open ${maxOpen})`);
  const n = parseAmount(notional).raw, capBps = parsePct(cap), escrow = (n * BigInt(capBps)) / 10_000n;
  const t = { feed: FEEDS[underlying].address, quote: USDG, notional: n, capBps, term: termH * 3600, maxStale: maxStaleH * 3600, makerLong: side === "long", offerExpires: BigInt(Math.floor(Date.now() / 1000) + expiresH * 3600) };
  const txs = await send(env, agentKey, wallet, [[USDG, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [D.swaps, escrow] })], [D.swaps, enc("offer", [BigInt(daemonId), t])]]);
  const ev = parseEventLogs({ abi: SWAPS, logs: txs.at(-1).logs, eventName: "Offered" })[0];
  return { offered: Number(ev?.args?.id ?? 0), underlying, side, notional, cap, escrow: Number(escrow) / 1e6, tx: txs.at(-1).hash };
}

/** the offer a take rule accepts (pure): same underlying, the OTHER side to ours, within every bound, not ours; oldest first */
export function pickSwap(all, { wallet, underlying, side, notionalMax, capMax, termMax, now = Math.floor(Date.now() / 1000) }) {
  return all.filter((s) => s.state === "offered" && s.underlying === underlying && s.makerSide !== side && s.offerExpires > now
    && s.maker.toLowerCase() !== wallet.toLowerCase() && BigInt(s.notional) <= notionalMax && s.capBps <= capMax && s.term <= termMax)
    .sort((a, b) => a.id - b.id)[0] ?? null;
}

export async function takeSwap(env, { daemonId, agentKey, underlying, side, notionalAtMost, capAtMost, termAtMostH, maxOpen, bookFn = swapBook, walletFn = walletOf, priceAgeFn = null, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId), all = await bookFn(env);
  const s = pickSwap(all, { wallet, underlying, side, notionalMax: parseAmount(notionalAtMost).raw, capMax: parsePct(capAtMost), termMax: termAtMostH * 3600 });
  if (!s) return { taken: null, looked: `${side} ${underlying}` };
  if (mineOf(all, wallet).length >= maxOpen) throw new Error(`already ${mineOf(all, wallet).length} open swaps (swaps.max_open ${maxOpen})`);
  const age = priceAgeFn ? await priceAgeFn(s.feed) : await (async () => { const [, , , at] = await pub(env).readContract({ address: s.feed, abi: AGG, functionName: "latestRoundData" }); return Math.floor(Date.now() / 1000) - Number(at); })();
  if (age > s.maxStale) return { taken: null, why: `swap #${s.id}: the price is ${Math.round(age / 60)} min old; its maker allows ${s.maxStale / 60}` };
  const txs = await send(env, agentKey, wallet, [[USDG, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [D.swaps, BigInt(s.escrow)] })], [D.swaps, enc("take", [BigInt(s.id), BigInt(daemonId)])]]);
  return { taken: s.id, from: s.makerDaemon, terms: s.terms, side, escrow: Number(s.escrow) / 1e6, tx: txs.at(-1).hash };
}

/**
 * The settling round: the first round updated at or after `end`, whose previous round is before it. Walks back from the
 * latest. → round id (bigint) | null (no round at/after end yet, or the history needed isn't there).
 */
export async function settlingRound(latestId, end, roundAt) {
  let id = BigInt(latestId);
  if (id === 0n || (await roundAt(id)) < end) return null;
  for (let steps = 0; steps < 500; steps++) {
    const prev = await roundAt(id - 1n);
    if (prev == null) return null;          // a gap (or a phase start): can't prove it's the first
    if (prev < end) return id;
    id -= 1n;
  }
  return null;
}

/** housekeeping: settle every live swap this daemon is party to that has ended; refund those past the grace period */
export async function settleDue(env, { daemonId, agentKey, bookFn = swapBook, walletFn = walletOf, feedFn = null, send = viaWallet, now = Math.floor(Date.now() / 1000) }) {
  const wallet = (await walletFn(env, daemonId)).toLowerCase();
  const due = (await bookFn(env)).filter((s) => s.state === "live" && now >= s.end && (s.maker.toLowerCase() === wallet || s.taker.toLowerCase() === wallet));
  const out = [];
  for (const s of due) {
    const f = feedFn ? feedFn(s.feed) : (() => {
      const c = pub(env);
      return { latest: () => c.readContract({ address: s.feed, abi: AGG, functionName: "latestRound" }),
        at: async (id) => { try { const [, , , u] = await c.readContract({ address: s.feed, abi: AGG, functionName: "getRoundData", args: [id] }); return Number(u); } catch { return null; } } };
    })();
    const r = await settlingRound(await f.latest(), s.end, f.at);
    if (r != null) { const [t] = await send(env, agentKey, await walletFn(env, daemonId), [[D.swaps, enc("settle", [BigInt(s.id), r])]]); out.push({ settled: s.id, round: String(r), terms: s.terms, tx: t.hash }); }
    else if (now >= s.end + GRACE) { const [t] = await send(env, agentKey, await walletFn(env, daemonId), [[D.swaps, enc("refund", [BigInt(s.id)])]]); out.push({ refunded: s.id, terms: s.terms, tx: t.hash }); }
    else out.push({ waiting: s.id, why: "no price round at or after expiry yet" });
  }
  return out;
}
