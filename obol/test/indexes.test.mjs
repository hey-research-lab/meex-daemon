// Indexes (milestone 11): the index blocks, mint/redeem checks and costs, holder-only publishing, the basket fixed
// once on chain, and the runtime refusals that send nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIndexes, checkIndexStep } from "../../lang/indexes.mjs";
import { INSTRUMENTS, parseAmount } from "../../lang/otc.mjs";
import { compileDoc, hashDoc } from "../../lang/check.mjs";
import { gates } from "../src/repo.mjs";
import { legsOf, sameBasket, ensureIndexes, mintIndex, redeemIndex, backedOf } from "../src/indexes.mjs";

const IX = { tNVX: [{ name: "NVDA + cash (testnet)", basket: ["1 tNVDA", "0.40 tUSDG"] }] };
const strat = (step, extra = {}, every = "24h") => ({ index: IX, strategy: { s: [{ description: "s", every, input: [{}], step: { x: [{ ...step, ...extra }] } }] } });
const errs = (doc) => { const c = compileDoc(doc); return [...c.strategies, ...c.skills].flatMap((x) => x.errors).concat(c.reflectErrors); };
const WALLET = { maxPerCall: 25_000_000, maxPerDay: 40_000_000 };
const NVDA = INSTRUMENTS.tNVDA.address, USDG = INSTRUMENTS.tUSDG.address;
const ME = "0x00000000000000000000000000000000000000a1", SIB = "0x00000000000000000000000000000000000000b2", SHARE = "0x00000000000000000000000000000000000000c3";

test("index blocks: a fixed basket of known instruments, per share", () => {
  const c = checkIndexes(IX);
  assert.deepEqual(c.errors, []);
  assert.equal(c.indexes[0].dollarsPerShare, 0.4);
  assert.doesNotThrow(() => JSON.stringify(compileDoc(strat({ mint_index: [{ index: "tNVX", shares: 1 }] }))), "the compiled doc is JSON-safe (it is stored and served)");
  const bad = (v, re) => assert.ok(checkIndexes(v).errors.some((e) => re.test(e)), JSON.stringify(v));
  bad({ tNVX: [{ name: "x", basket: [] }] }, /basket = \[...\] required/);
  bad({ tNVX: [{ name: "x", basket: ["1 tNVDA", "2 tNVDA"] }] }, /tNVDA twice/);
  bad({ tNVX: [{ name: "x", basket: ["1 tDOGE"] }] }, /basket/);
  bad({ tNVX: [{ basket: ["1 tNVDA"] }] }, /name required/);
  bad({ "1x": [{ name: "x", basket: ["1 tNVDA"] }] }, /symbol must be/);
  bad({ tNVDA: [{ name: "x", basket: ["1 tUSDG"] }] }, /already an instrument/);
  bad({ a1: [{ name: "x", basket: ["1 tNVDA"] }], b1: [{ name: "x", basket: ["1 tNVDA"] }], c1: [{ name: "x", basket: ["1 tNVDA"] }], d1: [{ name: "x", basket: ["1 tNVDA"] }] }, /at most 3/);
  bad({ tNVX: [{ name: "x", basket: Array.from({ length: 9 }, () => "1 tNVDA") }] }, /at most 8 legs/);
});

test("no indexes of indexes: a listed index can't be a leg", () => {
  INSTRUMENTS.tIDX = { address: SHARE, decimals: 0, index: true };
  try { assert.ok(checkIndexes({ tNV2: [{ name: "x", basket: ["1 tIDX"] }] }).errors.some((e) => /no indexes of indexes/.test(e))); }
  finally { delete INSTRUMENTS.tIDX; }
});

test("mint: its own index only, whole shares; the dollar legs × shares are the cost", () => {
  assert.deepEqual(errs(strat({ mint_index: [{ index: "tNVX", shares: 3 }] })), []);
  assert.equal(compileDoc(strat({ mint_index: [{ index: "tNVX", shares: 3 }] })).strategies[0].maxCost.toFixed(6), "1.200000");
  assert.ok(errs(strat({ mint_index: [{ index: "tOTHER", shares: 1 }] })).some((e) => /own index/.test(e)));
  for (const shares of [0, 1.5, "2", 101]) assert.ok(errs(strat({ mint_index: [{ index: "tNVX", shares }] })).some((e) => /whole number/.test(e)), String(shares));
});

test("redeem: its own or a listed index; a number or all; costs nothing", () => {
  assert.deepEqual(errs(strat({ redeem_index: [{ index: "tNVX", shares: "all" }] })), []);
  assert.equal(compileDoc(strat({ redeem_index: [{ index: "tNVX", shares: 2 }] })).strategies[0].maxCost, 0);
  assert.ok(errs(strat({ redeem_index: [{ index: "tZZZ", shares: 1 }] })).some((e) => /isn't an index/.test(e)));
  assert.ok(errs(strat({ redeem_index: [{ index: "tNVX", shares: "some" }] })).some((e) => /"all" or a whole number/.test(e)));
  INSTRUMENTS.tIDX = { address: SHARE, decimals: 0, index: true };
  try { const d = strat({ redeem_index: [{ index: "tIDX", shares: 1 }] }); delete d.index; assert.deepEqual(errs(d), [], "a listed index, without publishing one"); }
  finally { delete INSTRUMENTS.tIDX; }
});

test("index steps belong to strategies; the daily cap bounds minting", () => {
  const doc = { index: IX, skill: { s: [{ description: "s", price: "1", input: [{}], step: { m: [{ mint_index: [{ index: "tNVX", shares: 1 }] }] } }] } };
  assert.ok(errs(doc).some((e) => /index steps run in strategies/.test(e)));
  const g = gates({ head: null, headHash: null, doc: strat({ mint_index: [{ index: "tNVX", shares: 5 }] }, {}, "1h"), base: null, role: "holder", wallet: WALLET });
  assert.match(g.gates.find((x) => x.gate === "within(wallet)").detail, /48\.00 a day > daily cap 40\.00/);
});

test("publishing is the holder's: a daemon or sibling can't add, change or drop an index block", () => {
  const head = strat({ mint_index: [{ index: "tNVX", shares: 1 }] }), headHash = hashDoc(head);
  const changed = { ...head, index: { tNVX: [{ name: "NVDA + cash (testnet)", basket: ["1 tNVDA", "0.10 tUSDG"] }] } };
  for (const role of ["self", "sibling"]) assert.match(gates({ head, headHash, doc: changed, base: headHash, role, wallet: WALLET }).gates.find((x) => x.gate === "constitution").detail, /only the holder can change index/);
  const h = gates({ head, headHash, doc: changed, base: headHash, role: "holder", wallet: WALLET });
  assert.equal(h.ok, true, JSON.stringify(h.gates));
  assert.ok(h.plan.some((l) => /~ index: tNVX → tNVX \[1 tNVDA, 0\.10 tUSDG\]/.test(l)), h.plan.join("\n"));
  const none = { strategy: head.strategy }; const nh = hashDoc(none);
  assert.equal(gates({ head: none, headHash: nh, doc: head, base: nh, role: "self", wallet: WALLET }).gates.find((x) => x.gate === "constitution").ok, false, "nor add one");
});

test("legs: sorted ascending by address with exact raw amounts; basket equality is exact", () => {
  const legs = legsOf(checkIndexes({ x1: [{ name: "x", basket: ["0.40 tUSDG", "1 tNVDA"] }] }).indexes[0].basket);
  assert.ok(BigInt(legs[0].token) < BigInt(legs[1].token));
  assert.ok(sameBasket(legs, legs.map((l) => ({ token: l.token.toUpperCase().replace("0X", "0x"), amount: String(l.amount) }))));
  assert.equal(sameBasket(legs, [{ ...legs[0] }, { ...legs[1], amount: legs[1].amount + 1n }]), false);
  assert.equal(sameBasket(legs, legs.slice(0, 1)), false);
});

const env = {};
const walletFn = async () => ME;
const never = async () => { throw new Error("must not send"); };
const onChain = (o) => ({ id: 1, symbol: "tNVX", share: SHARE, manager: ME, supply: 0, basket: legsOf(checkIndexes(IX).indexes[0].basket).map((l) => ({ token: l.token, amount: String(l.amount) })), ...o });
const declared = checkIndexes(IX).indexes;

test("publishing: creates what's missing; the same basket again sends nothing; a different basket is refused, not re-made", async () => {
  const sent = [];
  const send = async (_e, _k, _w, calls) => { sent.push(...calls); return calls.map(() => ({ hash: "0x1", logs: [] })); };
  assert.equal((await ensureIndexes(env, { daemonId: 2, agentKey: "0x1", declared, listFn: async () => [], walletFn, send }))[0].symbol, "tNVX");
  assert.equal(sent.length, 1);
  assert.deepEqual(await ensureIndexes(env, { daemonId: 2, agentKey: "0x1", declared, listFn: async () => [onChain()], walletFn, send: never }), []);
  const other = checkIndexes({ tNVX: [{ name: "x", basket: ["1 tNVDA", "0.10 tUSDG"] }] }).indexes;
  const r = await ensureIndexes(env, { daemonId: 2, agentKey: "0x1", declared: other, listFn: async () => [onChain()], walletFn, send: never });
  assert.match(r[0].error, /different basket/);
  const sibs = await ensureIndexes(env, { daemonId: 2, agentKey: "0x1", declared, listFn: async () => [onChain({ manager: SIB })], walletFn, send });
  assert.ok(sibs[0].symbol === "tNVX" && sent.length === 2, "a sibling's same symbol doesn't count as ours");
});

test("mint approves exactly basket × shares; redeem all of nothing sends nothing; over-redeeming refuses before sending", async () => {
  const sent = [];
  const send = async (_e, _k, _w, calls) => { sent.push(...calls); return calls.map(() => ({ hash: "0x1", logs: [] })); };
  await mintIndex(env, { daemonId: 2, agentKey: "0x1", symbol: "tNVX", shares: 3, listFn: async () => [onChain()], walletFn, send });
  assert.equal(sent.length, 3, "approve two legs, then mint");
  const amounts = sent.slice(0, 2).map(([t, d]) => [t.toLowerCase(), BigInt("0x" + d.slice(-64))]);
  assert.deepEqual(Object.fromEntries(amounts), { [NVDA.toLowerCase()]: 3n * 10n ** 18n, [USDG.toLowerCase()]: 1_200_000n });
  await assert.rejects(mintIndex(env, { daemonId: 2, agentKey: "0x1", symbol: "tNVX", shares: 1, listFn: async () => [onChain({ manager: SIB })], walletFn, send: never }), /isn't on chain yet/);
  assert.deepEqual(await redeemIndex(env, { daemonId: 1, agentKey: "0x1", symbol: "tNVX", shares: "all", listFn: async () => [onChain()], walletFn, balanceFn: async () => 0n, send: never }), { redeemed: 0, symbol: "tNVX" });
  await assert.rejects(redeemIndex(env, { daemonId: 1, agentKey: "0x1", symbol: "tNVX", shares: 2, listFn: async () => [onChain()], walletFn, balanceFn: async () => 1n, send: never }), /holds 1/);
  sent.length = 0;
  const r = await redeemIndex(env, { daemonId: 1, agentKey: "0x1", symbol: "tNVX", shares: "all", listFn: async () => [onChain()], walletFn, balanceFn: async () => 2n, send });
  assert.deepEqual([r.redeemed, sent.length, r.received], [2, 1, ["0.8 tUSDG", "2 tNVDA"]]);
});

test("redeem finds a listed index by its share address, not by a lookalike symbol", async () => {
  INSTRUMENTS.tIDX = { address: SHARE, decimals: 0, index: true };
  try {
    const fake = onChain({ id: 7, symbol: "tIDX", share: "0x00000000000000000000000000000000000000ee", manager: SIB });
    const real = onChain({ id: 1, symbol: "tIDX", manager: SIB });
    const r = await redeemIndex(env, { daemonId: 1, agentKey: "0x1", symbol: "tIDX", shares: 1, listFn: async () => [fake, real], walletFn, balanceFn: async () => 1n,
      send: async (_e, _k, _w, calls) => calls.map(() => ({ hash: "0x1", logs: [] })) });
    assert.equal(r.index, 1);
  } finally { delete INSTRUMENTS.tIDX; }
});

test("backed: every leg held at supply × amount or more", () => {
  const legs = [{ amount: "1000000000000000000", held: "3000000000000000000" }, { amount: "400000", held: "1200000" }];
  assert.equal(backedOf(legs, 3n), true);
  assert.equal(backedOf(legs, 0n), true);
  assert.equal(backedOf([legs[0], { ...legs[1], held: "1199999" }], 3n), false, "one micro short on one leg");
});
