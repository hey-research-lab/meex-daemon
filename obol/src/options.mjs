// Options on chain (milestone 10, TESTNET ONLY until counsel): the options book, and a daemon writing, buying,
// exercising or reclaiming through DaemonOptions — every call made by the daemon's agent THROUGH its wallet's `execute`,
// so the wallet's constitution applies (allowlisted targets only; `approve` only to an allowlisted spender; every dollar
// that leaves measured against the daily cap).
import { encodeFunctionData, parseAbi, parseEventLogs } from "viem";
import { D, pub } from "./chain.mjs";
import { parseAmount, INSTRUMENTS } from "../../lang/otc.mjs";
import { inTheMoney } from "../../lang/options.mjs";
import { book as otcBook, walletOf, viaWallet } from "./otc.mjs";

export const OPTIONS = parseAbi([
  "function write(uint256 writerTokenId,uint8 kind,address underlying,uint256 amount,address quote,uint256 strike,uint256 premium,uint64 expires) returns (uint256)",
  "function buy(uint256 id,uint256 buyerTokenId)",
  "function exercise(uint256 id)",
  "function reclaim(uint256 id)",
  "function nextId() view returns (uint256)",
  "function options(uint256) view returns (address writer,address buyer,uint8 kind,uint8 state,uint64 expires,address underlying,uint256 amount,address quote,uint256 strike,uint256 premium)",
  "event Written(uint256 indexed id, address indexed writer, uint8 kind, uint64 expires)",
]);
const ERC20 = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const KIND = ["call", "put"], STATE = ["none", "listed", "bought", "exercised", "reclaimed"];
const BY_ADDR = Object.fromEntries(Object.entries(INSTRUMENTS).map(([sym, x]) => [x.address.toLowerCase(), { sym, ...x }]));
const human = (token, raw) => { const i = BY_ADDR[token.toLowerCase()]; return i ? `${+(Number(raw) / 10 ** i.decimals).toFixed(i.decimals)} ${i.sym}` : `${raw} ${token}`; };
const enc = (functionName, args) => encodeFunctionData({ abi: OPTIONS, functionName, args });
const approve = (token, raw) => [token, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [D.options, raw] })];

/** every option (newest first) with its state, terms in raw and human units, and the parties as daemon numbers when known */
export async function optionBook(env, { ids = 10, limit = 200, walletFn = walletOf } = {}) {
  const client = pub(env);
  const next = Number(await client.readContract({ address: D.options, abi: OPTIONS, functionName: "nextId" }));
  const who = new Map(); for (let i = 1; i <= ids; i++) who.set((await walletFn(env, i)).toLowerCase(), i);
  const now = Math.floor(Date.now() / 1000), out = [];
  for (let id = next - 1; id >= 1 && id >= next - limit; id--) {
    const [writer, buyer, kind, state, expires, underlying, amount, quote, strike, premium] = await client.readContract({ address: D.options, abi: OPTIONS, functionName: "options", args: [BigInt(id)] });
    out.push({
      id, kind: KIND[kind], state: STATE[state], expires: Number(expires), expired: Number(expires) < now,
      writer, writerDaemon: who.get(writer.toLowerCase()) ?? null, buyer, buyerDaemon: who.get(buyer.toLowerCase()) ?? null,
      underlying, amount: String(amount), quote, strike: String(strike), premium: String(premium),
      terms: `${KIND[kind]} on ${human(underlying, amount)}, strike ${human(quote, strike)}, premium ${human(quote, premium)}`,
    });
  }
  return out;
}

/** what counts against max_open: options this wallet wrote or holds that are still live (listed, or bought and unexpired) */
export const liveFor = (all, wallet) => all.filter((o) => (o.writer.toLowerCase() === wallet.toLowerCase() || o.buyer.toLowerCase() === wallet.toLowerCase())
  && (o.state === "listed" || (o.state === "bought" && !o.expired)));

/** the writer's housekeeping: reclaim every option it wrote that is bought-and-expired (the escrow is its own again) */
export async function reclaimExpired(env, { daemonId, agentKey, bookFn = optionBook, walletFn = walletOf, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId);
  const due = (await bookFn(env)).filter((o) => o.writer.toLowerCase() === wallet.toLowerCase() && o.expired && (o.state === "bought" || o.state === "listed"));
  if (!due.length) return [];
  const txs = await send(env, agentKey, wallet, due.map((o) => [D.options, enc("reclaim", [BigInt(o.id)])]));
  return due.map((o, i) => ({ reclaimed: o.id, terms: o.terms, tx: txs[i].hash }));
}

/** write a covered call or cash-secured put — expired escrows reclaimed first, then max_open counted */
export async function writeOption(env, { daemonId, agentKey, kind, stock, strike, premium, expiresSec, maxOpen, bookFn = optionBook, walletFn = walletOf, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId);
  const reclaimed = await reclaimExpired(env, { daemonId, agentKey, bookFn, walletFn, send });
  const live = liveFor(await bookFn(env), wallet);
  if (live.length >= maxOpen) throw new Error(`already ${live.length} live options (options.max_open ${maxOpen})`);
  const s = parseAmount(stock), k = parseAmount(strike), p = /^0+(\.0+)?\s/.test(premium) ? { raw: 0n } : parseAmount(premium);
  const expires = BigInt(Math.floor(Date.now() / 1000) + expiresSec);
  const calls = [kind === "call" ? approve(s.token, s.raw) : approve(k.token, k.raw),
    [D.options, enc("write", [BigInt(daemonId), kind === "call" ? 0 : 1, s.token, s.raw, k.token, k.raw, p.raw, expires])]];
  const txs = await send(env, agentKey, wallet, calls);
  const w = parseEventLogs({ abi: OPTIONS, logs: txs.at(-1).logs, eventName: "Written" })[0];
  return { written: Number(w?.args?.id ?? 0), kind, stock, strike, premium, expires: Number(expires), tx: txs.at(-1).hash, reclaimed };
}

/**
 * The listed option a buy rule accepts. Pure. null = none. Same kind; at least the stock named; a call's strike ≤ the
 * bound (a put's ≥); premium ≤ the bound; unexpired; not our own. Cheapest premium per share wins, then the best strike.
 */
export function pickOption(all, { wallet, kind, stock, strikeBound, premiumMax, now = Math.floor(Date.now() / 1000) }) {
  const fits = all.filter((o) => o.state === "listed" && o.kind === kind && o.expires > now && o.writer.toLowerCase() !== wallet.toLowerCase()
    && o.underlying.toLowerCase() === stock.token.toLowerCase() && BigInt(o.amount) >= stock.raw
    && o.quote.toLowerCase() === strikeBound.token.toLowerCase()
    && (kind === "call" ? BigInt(o.strike) <= strikeBound.raw : BigInt(o.strike) >= strikeBound.raw)
    && BigInt(o.premium) <= premiumMax);
  const per = (o, f) => BigInt(o[f]) * 10n ** 18n / BigInt(o.amount);
  fits.sort((a, b) => {
    const pa = per(a, "premium"), pb = per(b, "premium");
    if (pa !== pb) return pa < pb ? -1 : 1;
    const sa = per(a, "strike"), sb = per(b, "strike");
    return (kind === "call" ? sa < sb : sa > sb) ? -1 : sa === sb ? 0 : 1;
  });
  return fits[0] ?? null;
}

/** buy what pickOption chooses: approve its premium, then buy. Nothing matching → { bought: null }. */
export async function buyBest(env, { daemonId, agentKey, kind, stockAtLeast, strikeBound, premiumAtMost, maxOpen, bookFn = optionBook, walletFn = walletOf, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId), all = await bookFn(env);
  const premiumMax = /^0+(\.0+)?\s/.test(premiumAtMost) ? 0n : parseAmount(premiumAtMost).raw;
  const o = pickOption(all, { wallet, kind, stock: parseAmount(stockAtLeast), strikeBound: parseAmount(strikeBound), premiumMax });
  if (!o) return { bought: null, looked: `${kind} on ≥ ${stockAtLeast}` };
  const live = liveFor(all, wallet);
  if (live.length >= maxOpen) throw new Error(`already ${live.length} live options (options.max_open ${maxOpen})`);
  const calls = [...(BigInt(o.premium) > 0n ? [approve(o.quote, BigInt(o.premium))] : []), [D.options, enc("buy", [BigInt(o.id), BigInt(daemonId)])]];
  const txs = await send(env, agentKey, wallet, calls);
  return { bought: o.id, from: o.writerDaemon, terms: o.terms, tx: txs.at(-1).hash };
}

/** exercise every option this daemon holds that is in the money against the OTC book now; the rest wait (or lapse) */
export async function exerciseInTheMoney(env, { daemonId, agentKey, bookFn = optionBook, otcFn = otcBook, walletFn = walletOf, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId);
  const held = (await bookFn(env)).filter((o) => o.state === "bought" && !o.expired && o.buyer.toLowerCase() === wallet.toLowerCase());
  if (!held.length) return { exercised: [], held: 0 };
  const offers = await otcFn(env), done = [], waiting = [];
  for (const o of held) {
    const r = inTheMoney(o, offers);
    if (!r.itm) { waiting.push({ id: o.id, terms: o.terms, why: r.ref ? `out of the money against offer #${r.ref.id}` : "no reference offer in the book" }); continue; }
    const pay = o.kind === "call" ? approve(o.quote, BigInt(o.strike)) : approve(o.underlying, BigInt(o.amount));
    const txs = await send(env, agentKey, wallet, [pay, [D.options, enc("exercise", [BigInt(o.id)])]]);
    done.push({ id: o.id, terms: o.terms, against: `offer #${r.ref.id}`, tx: txs.at(-1).hash });
  }
  return { exercised: done, waiting, held: held.length };
}
