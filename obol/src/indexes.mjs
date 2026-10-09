// Indexes on chain (milestone 11): the index list (with a live backing check), a daemon publishing its declared
// indexes, minting its own, and redeeming any — every call made by the daemon's agent THROUGH its wallet's `execute`.
import { encodeFunctionData, parseAbi, parseEventLogs } from "viem";
import { D, pub } from "./chain.mjs";
import { parseAmount, INSTRUMENTS } from "../../lang/otc.mjs";
import { walletOf, viaWallet } from "./otc.mjs";

export const VAULT = parseAbi([
  "function create(uint256 managerTokenId,string name,string symbol,(address token,uint256 amount)[] legs) returns (uint256 id,address share)",
  "function mint(uint256 id,uint256 shares)",
  "function redeem(uint256 id,uint256 shares)",
  "function nextId() view returns (uint256)",
  "function indexes(uint256) view returns (address manager,address share)",
  "function basket(uint256 id) view returns ((address token,uint256 amount)[])",
  "event Created(uint256 indexed id, address indexed manager, address share, string symbol)",
]);
const ERC20 = parseAbi(["function approve(address spender,uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)", "function symbol() view returns (string)", "function name() view returns (string)"]);
const BY_ADDR = Object.fromEntries(Object.entries(INSTRUMENTS).map(([sym, x]) => [x.address.toLowerCase(), { sym, ...x }]));
const human = (token, raw) => { const i = BY_ADDR[token.toLowerCase()]; return i ? `${+(Number(raw) / 10 ** i.decimals).toFixed(i.decimals)} ${i.sym}` : `${raw} ${token}`; };
const enc = (functionName, args) => encodeFunctionData({ abi: VAULT, functionName, args });

/** sorted legs, as the vault requires and stores them: [{ token, amount (bigint) }] ascending by address */
export const legsOf = (basket) => basket.map((l) => ({ token: l.token, amount: BigInt(l.raw) })).sort((a, b) => (BigInt(a.token) < BigInt(b.token) ? -1 : 1));
export const sameBasket = (a, b) => a.length === b.length && a.every((l, i) => l.token.toLowerCase() === b[i].token.toLowerCase() && BigInt(l.amount) === BigInt(b[i].amount));

/** does the vault hold at least supply × amount of every leg? (it must, always — the API shows it live) */
export const backedOf = (legs, supply) => legs.every((l) => BigInt(l.held) >= BigInt(l.amount) * BigInt(supply));

/** every index: manager (as a daemon when known), share, supply, basket, and whether the vault backs every share now */
export async function indexList(env, { ids = 10, walletFn = walletOf } = {}) {
  const client = pub(env), read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const next = Number(await read(D.indexes, VAULT, "nextId"));
  const who = new Map(); for (let i = 1; i <= ids; i++) who.set((await walletFn(env, i)).toLowerCase(), i);
  const out = [];
  for (let id = 1; id < next; id++) {
    const [manager, share] = await read(D.indexes, VAULT, "indexes", [BigInt(id)]);
    const [symbol, name, supply, basket] = await Promise.all([read(share, ERC20, "symbol"), read(share, ERC20, "name"), read(share, ERC20, "totalSupply"), read(D.indexes, VAULT, "basket", [BigInt(id)])]);
    const legs = await Promise.all(basket.map(async (l) => { const held = await read(l.token, ERC20, "balanceOf", [D.indexes]); return { token: l.token, amount: String(l.amount), perShare: human(l.token, l.amount), held: String(held) }; }));
    out.push({ id, symbol, name, share, manager, managerDaemon: who.get(manager.toLowerCase()) ?? null, supply: Number(supply), basket: legs,
      backed: backedOf(legs, supply) });
  }
  return out;
}

/** create each declared index not yet on chain; an existing symbol with a different basket is refused, never re-made */
export async function ensureIndexes(env, { daemonId, agentKey, declared, listFn = indexList, walletFn = walletOf, send = viaWallet }) {
  if (!declared?.length) return [];
  const wallet = (await walletFn(env, daemonId)).toLowerCase(), all = await listFn(env), out = [];
  for (const d of declared) {
    const mine = all.find((x) => x.manager.toLowerCase() === wallet && x.symbol === d.symbol);
    const legs = legsOf(d.basket);
    if (mine) { if (!sameBasket(mine.basket, legs)) out.push({ symbol: d.symbol, error: `index #${mine.id} ${d.symbol} already exists with a different basket — the basket is fixed; publish under a new symbol` }); continue; }
    const txs = await send(env, agentKey, await walletFn(env, daemonId), [[D.indexes, enc("create", [BigInt(daemonId), d.name, d.symbol, legs])]]);
    const ev = parseEventLogs({ abi: VAULT, logs: txs.at(-1).logs, eventName: "Created" })[0];
    out.push({ symbol: d.symbol, created: Number(ev?.args?.id ?? 0), share: ev?.args?.share ?? null, tx: txs.at(-1).hash });
  }
  return out;
}

/** mint `shares` of this daemon's own index: approve each leg × shares to the vault, then mint */
export async function mintIndex(env, { daemonId, agentKey, symbol, shares, listFn = indexList, walletFn = walletOf, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId);
  const ix = (await listFn(env)).find((x) => x.manager.toLowerCase() === wallet.toLowerCase() && x.symbol === symbol);
  if (!ix) throw new Error(`${symbol} isn't on chain yet (it's created on the daemon's next run after the index block merges)`);
  const n = BigInt(shares);
  const calls = [...ix.basket.map((l) => [l.token, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [D.indexes, BigInt(l.amount) * n] })]),
    [D.indexes, enc("mint", [BigInt(ix.id), n])]];
  const txs = await send(env, agentKey, wallet, calls);
  return { minted: Number(n), symbol, index: ix.id, deposited: ix.basket.map((l) => human(l.token, BigInt(l.amount) * n)), tx: txs.at(-1).hash };
}

/** redeem shares of an index (its own, or a listed index instrument) for the basket, in kind; "all" = what it holds */
export async function redeemIndex(env, { daemonId, agentKey, symbol, shares, listFn = indexList, walletFn = walletOf, balanceFn = null, send = viaWallet }) {
  const wallet = await walletFn(env, daemonId), all = await listFn(env);
  const listed = INSTRUMENTS[symbol]?.index ? INSTRUMENTS[symbol].address.toLowerCase() : null;
  const ix = all.find((x) => x.share.toLowerCase() === listed) ?? all.find((x) => x.manager.toLowerCase() === wallet.toLowerCase() && x.symbol === symbol);
  if (!ix) throw new Error(`no index ${symbol} on chain`);
  const held = balanceFn ? await balanceFn(ix.share, wallet) : await pub(env).readContract({ address: ix.share, abi: ERC20, functionName: "balanceOf", args: [wallet] });
  const n = shares === "all" ? BigInt(held) : BigInt(shares);
  if (n === 0n) return { redeemed: 0, symbol };
  if (n > BigInt(held)) throw new Error(`holds ${held} ${symbol}, can't redeem ${n}`);
  const txs = await send(env, agentKey, wallet, [[D.indexes, enc("redeem", [BigInt(ix.id), n])]]);
  return { redeemed: Number(n), symbol, index: ix.id, received: ix.basket.map((l) => human(l.token, BigInt(l.amount) * n)), tx: txs.at(-1).hash };
}
