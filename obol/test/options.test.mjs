// Options steps (milestone 10, testnet): the options{} limits, write/buy/exercise checks and costs, holder-only limits,
// the buy picker, in-the-money against the OTC book, and the runtime refusals that send nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOptions, checkOptionStep, inTheMoney } from "../../lang/options.mjs";
import { INSTRUMENTS, parseAmount } from "../../lang/otc.mjs";
import { compileDoc, hashDoc } from "../../lang/check.mjs";
import { gates } from "../src/repo.mjs";
import { pickOption, liveFor, writeOption, buyBest, exerciseInTheMoney } from "../src/options.mjs";

const OPTS = [{ underlyings: ["tNVDA"], max_open: 2, max_usd: "5" }];
const strat = (step, extra = {}, every = "24h") => ({ options: OPTS, strategy: { s: [{ description: "s", every, input: [{}], step: { x: [{ ...step, ...extra }] } }] } });
const errs = (doc) => { const c = compileDoc(doc); return [...c.strategies, ...c.skills].flatMap((x) => x.errors).concat(c.reflectErrors); };
const WALLET = { maxPerCall: 25_000_000, maxPerDay: 40_000_000 };
const CALL = { kind: "call", stock: "3 tNVDA", strike: "1.50 tUSDG", premium: "0.10 tUSDG", expires: "72h" };
const NVDA = INSTRUMENTS.tNVDA.address, USDG = INSTRUMENTS.tUSDG.address;
const ME = "0x00000000000000000000000000000000000000a1", SIB = "0x00000000000000000000000000000000000000b2", ZERO = "0x0000000000000000000000000000000000000000";
const E18 = 10n ** 18n;

test("the options{} block: stock underlyings only, max_open 1–10, max_usd", () => {
  assert.deepEqual(checkOptions(OPTS).errors, []);
  assert.ok(checkOptions([{ underlyings: ["tUSDG"], max_open: 2, max_usd: "5" }]).errors.some((e) => /the dollar/.test(e)));
  assert.ok(checkOptions([{ underlyings: ["tDOGE"], max_open: 2, max_usd: "5" }]).errors.length);
  assert.ok(checkOptions([{ underlyings: [], max_open: 2, max_usd: "5" }]).errors.length);
  assert.ok(checkOptions([{ underlyings: ["tNVDA"], max_open: 11, max_usd: "5" }]).errors.length);
  assert.ok(checkOptions([{ underlyings: ["tNVDA"], max_open: 2, max_usd: "5000" }]).errors.length);
});

test("write: a covered call costs no dollars; a cash-secured put's strike is its cost", () => {
  assert.deepEqual(errs(strat({ write_option: [CALL] })), []);
  assert.equal(compileDoc(strat({ write_option: [CALL] })).strategies[0].maxCost, 0);
  assert.equal(compileDoc(strat({ write_option: [{ ...CALL, kind: "put" }] })).strategies[0].maxCost, 1.5);
  assert.deepEqual(errs(strat({ write_option: [{ ...CALL, premium: "0 tUSDG" }] })), [], "a zero premium is allowed");
});

test("write refusals: no options block, kind, stock not listed or a dollar, strike in a stock, over max_usd, expiry", () => {
  const none = strat({ write_option: [CALL] }); delete none.options;
  assert.ok(errs(none).some((e) => /need an options/.test(e)));
  const bad = [[{ kind: "straddle" }, /kind/], [{ stock: "3 tUSDG" }, /must be a stock/], [{ strike: "3 tNVDA" }, /strike must be in tUSDG/],
    [{ strike: "6 tUSDG" }, /over options.max_usd/], [{ premium: "6 tUSDG" }, /premium 6 over/], [{ expires: "30m" }, /expires/], [{ expires: "721h" }, /expires/], [{ stock: "3 NVDA" }, /stock/]];
  for (const [patch, re] of bad) assert.ok(errs(strat({ write_option: [{ ...CALL, ...patch }] })).some((e) => re.test(e)), JSON.stringify(patch));
  INSTRUMENTS.tTSLA = { address: "0x00000000000000000000000000000000000000c3", decimals: 18 };   // a second stock, for this check only
  try { assert.ok(errs(strat({ write_option: [{ ...CALL, stock: "3 tTSLA" }] })).some((e) => /tTSLA isn't in options.underlyings/.test(e))); }
  finally { delete INSTRUMENTS.tTSLA; }
  const narrow = { ...strat({ write_option: [CALL] }), options: [{ underlyings: ["tNVDA"], max_open: 2, max_usd: "1" }] };
  assert.ok(errs(narrow).some((e) => /over options.max_usd 1/.test(e)));
});

test("buy: a call names strike_at_most, a put strike_at_least; the premium bound is the cost", () => {
  const call = { kind: "call", stock_at_least: "3 tNVDA", strike_at_most: "1.60 tUSDG", premium_at_most: "0.15 tUSDG" };
  assert.deepEqual(errs(strat({ buy_option: [call] }, { skip_if_none: true })), []);
  assert.equal(compileDoc(strat({ buy_option: [call] })).strategies[0].maxCost, 0.15);
  assert.ok(errs(strat({ buy_option: [{ ...call, kind: "put" }] })).some((e) => /a put buyer names strike_at_least/.test(e)));
  const put = { kind: "put", stock_at_least: "3 tNVDA", strike_at_least: "1.40 tUSDG", premium_at_most: "0.15 tUSDG" };
  assert.deepEqual(errs(strat({ buy_option: [put] })), []);
  assert.ok(errs(strat({ buy_option: [call] }, { skip_if_none: "yes" })).some((e) => /skip_if_none/.test(e)));
});

test("exercise: needs the OTC reference; its worst case is every call it may hold, at the largest strike", () => {
  assert.deepEqual(errs(strat({ exercise: [{ reference: "otc" }] })), []);
  assert.equal(compileDoc(strat({ exercise: [{ reference: "otc" }] })).strategies[0].maxCost, 10);
  assert.ok(errs(strat({ exercise: [{}] })).some((e) => /reference = "otc"/.test(e)));
});

test("options belong to strategies: a paid skill can't write, buy or exercise", () => {
  const doc = { options: OPTS, skill: { s: [{ description: "s", price: "1", input: [{}], step: { w: [{ write_option: [CALL] }] } }] } };
  assert.ok(errs(doc).some((e) => /options steps run in strategies/.test(e)));
});

test("the wallet's daily cap bounds options: an hourly exercise could need 240 a day", () => {
  const g = gates({ head: null, headHash: null, doc: strat({ exercise: [{ reference: "otc" }] }, {}, "1h"), base: null, role: "holder", wallet: WALLET });
  assert.match(g.gates.find((x) => x.gate === "within(wallet)").detail, /240\.00 a day > daily cap 40\.00/);
});

test("options{} is the holder's: a daemon or sibling can't add, widen or remove it", () => {
  const head = strat({ write_option: [CALL] }), headHash = hashDoc(head);
  const wider = { ...head, options: [{ underlyings: ["tNVDA"], max_open: 9, max_usd: "5" }] };
  for (const role of ["self", "sibling"]) {
    const g = gates({ head, headHash, doc: wider, base: headHash, role, wallet: WALLET });
    assert.equal(g.ok, false, role);
    assert.match(g.gates.find((x) => x.gate === "constitution").detail, /only the holder can change options/);
  }
  const off = { ...head }; delete off.options;
  assert.equal(gates({ head, headHash, doc: off, base: headHash, role: "self", wallet: WALLET }).gates.find((x) => x.gate === "constitution").ok, false);
  const h = gates({ head, headHash, doc: wider, base: headHash, role: "holder", wallet: WALLET });
  assert.equal(h.ok, true, JSON.stringify(h.gates));
  assert.ok(h.plan.some((l) => /~ options:/.test(l)), "the plan shows it");
});

// a book row in optionBook's shape
const opt = (id, o) => ({ id, kind: "call", state: "listed", expires: 2e9, expired: false, writer: SIB, writerDaemon: 2, buyer: ZERO, buyerDaemon: null,
  underlying: NVDA, amount: String(3n * E18), quote: USDG, strike: "1500000", premium: "100000", terms: `#${id}`, ...o });

test("pickOption: kind, size, strike and premium bounds, unexpired, never our own; cheapest premium per share wins", () => {
  const rule = { wallet: ME, kind: "call", stock: parseAmount("3 tNVDA"), strikeBound: parseAmount("1.60 tUSDG"), premiumMax: 150_000n, now: 1e9 };
  const book = [
    opt(1, { premium: "120000" }),
    opt(2, { premium: "90000", strike: "1700000" }),        // strike too high
    opt(3, { premium: "80000", writer: ME }),               // ours
    opt(4, { premium: "70000", kind: "put" }),              // a put
    opt(5, { premium: "60000", state: "bought" }),          // taken
    opt(6, { premium: "50000", amount: String(2n * E18) }), // too small
    opt(7, { premium: "40000", expires: 1e9 - 1 }),         // expired
    opt(8, { premium: "200000" }),                          // too dear
    opt(9, { premium: "100000" }),
    opt(10, { premium: "200000", amount: String(6n * E18) }), // 6 shares at 0.0333/share: the cheapest per share — but strike 1.5 for 6 fits too
  ];
  assert.equal(pickOption(book.slice(0, 9), rule).id, 9, "0.10 beats 0.12; everything else is out");
  assert.equal(pickOption([opt(8, { premium: "200000" })], rule), null, "alone, the too-dear one still isn't bought");
  assert.equal(pickOption(book, { ...rule, premiumMax: 250_000n }).id, 10, "per share, not per option");
  assert.equal(pickOption([opt(1, { premium: "100000", strike: "1500000" }), opt(2, { premium: "100000", strike: "1400000" })], rule).id, 2, "a tie goes to the lower call strike");
  const putRule = { ...rule, kind: "put", strikeBound: parseAmount("1.40 tUSDG") };
  assert.equal(pickOption([opt(1, { kind: "put", strike: "1300000" }), opt(2, { kind: "put", strike: "1450000" })], putRule).id, 2, "a put buyer wants the strike at least the bound");
});

// an OTC book row in book()'s shape
const ask = (id, shares, dollars) => ({ id, maker: SIB, give: [{ token: NVDA, raw: String(BigInt(shares) * E18) }], want: [{ token: USDG, raw: String(dollars) }] });
const bid = (id, dollars, shares) => ({ id, maker: SIB, give: [{ token: USDG, raw: String(dollars) }], want: [{ token: NVDA, raw: String(BigInt(shares) * E18) }] });

test("in the money against the OTC book: calls below the cheapest ask, puts above the best bid, exactly; no book → no", () => {
  const call = opt(1, { state: "bought", strike: "1500000" }); // 0.50 a share
  assert.deepEqual(inTheMoney(call, []), { itm: false, ref: null });
  assert.equal(inTheMoney(call, [ask(7, 3, 1_800_000)]).itm, true, "0.50 < 0.60");
  assert.equal(inTheMoney(call, [ask(7, 3, 1_500_000)]).itm, false, "at the money is not in");
  assert.equal(inTheMoney(call, [ask(7, 3, 1_800_000), ask(8, 6, 2_400_000)]).ref.id, 8, "the cheapest ask per share (0.40) is the reference");
  assert.equal(inTheMoney(call, [ask(7, 3, 1_800_000), ask(8, 6, 2_400_000)]).itm, false);
  assert.equal(inTheMoney(call, [bid(9, 3_000_000, 3)]).ref, null, "a bid is no reference for a call");
  const put = opt(2, { kind: "put", state: "bought", strike: "1500000" });
  assert.equal(inTheMoney(put, [bid(9, 1_200_000, 3)]).itm, true, "0.50 > 0.40");
  assert.equal(inTheMoney(put, [bid(9, 1_200_000, 3), bid(10, 1_800_000, 3)]).itm, false, "the best bid (0.60) is the reference");
  assert.equal(inTheMoney(put, [ask(7, 3, 900_000)]).ref, null, "an ask is no reference for a put");
});

test("liveFor counts listed, and bought-unexpired, on either side", () => {
  const all = [opt(1, { writer: ME }), opt(2, { buyer: ME, state: "bought" }), opt(3, { buyer: ME, state: "bought", expired: true }), opt(4, { writer: ME, state: "exercised" }), opt(5, {})];
  assert.deepEqual(liveFor(all, ME).map((o) => o.id), [1, 2]);
});

const env = {};
const walletFn = async () => ME;
const never = async () => { throw new Error("must not send"); };

test("runtime: write refuses at max_open before sending; buy and exercise with nothing to do send nothing", async () => {
  const full = async () => [opt(1, { writer: ME }), opt(2, { buyer: ME, state: "bought" })];
  await assert.rejects(writeOption(env, { daemonId: 1, agentKey: "0x1", ...CALL, expiresSec: 3600, maxOpen: 2, bookFn: full, walletFn, send: never }), /max_open 2/);
  const r = await buyBest(env, { daemonId: 1, agentKey: "0x1", kind: "call", stockAtLeast: "3 tNVDA", strikeBound: "1.00 tUSDG", premiumAtMost: "0.15 tUSDG", maxOpen: 2, bookFn: async () => [opt(1, {})], walletFn, send: never });
  assert.equal(r.bought, null);
  await assert.rejects(buyBest(env, { daemonId: 1, agentKey: "0x1", kind: "call", stockAtLeast: "3 tNVDA", strikeBound: "1.60 tUSDG", premiumAtMost: "0.15 tUSDG", maxOpen: 2, bookFn: async () => [opt(1, {}), opt(2, { writer: ME }), opt(3, { writer: ME })], walletFn, send: never }), /max_open 2/);
  const x = await exerciseInTheMoney(env, { daemonId: 1, agentKey: "0x1", bookFn: async () => [opt(1, { buyer: ME, state: "bought" })], otcFn: async () => [ask(7, 3, 1_500_000)], walletFn, send: never });
  assert.deepEqual([x.exercised.length, x.waiting[0].why], [0, "out of the money against offer #7"]);
});

test("runtime: write reclaims its expired escrow first; exercise approves exactly the strike, then exercises", async () => {
  const sent = [];
  const send = async (_e, _k, _w, calls) => { sent.push(...calls); return calls.map((_, i) => ({ hash: `0x${i}`, logs: [] })); };
  await writeOption(env, { daemonId: 1, agentKey: "0x1", ...CALL, expiresSec: 3600, maxOpen: 2, walletFn, send,
    bookFn: async () => [opt(4, { writer: ME, state: "bought", expired: true })] });
  assert.equal(sent.length, 3, "reclaim #4, approve the stock, write");
  sent.length = 0;
  const x = await exerciseInTheMoney(env, { daemonId: 1, agentKey: "0x1", walletFn, send,
    bookFn: async () => [opt(1, { buyer: ME, state: "bought" }), opt(2, { buyer: ME, state: "bought", expired: true })], otcFn: async () => [ask(7, 3, 1_800_000)] });
  assert.deepEqual(x.exercised.map((e) => e.id), [1], "only the unexpired one");
  assert.equal(sent[0][0], USDG, "approves the dollar");
  assert.ok(sent[0][1].endsWith(1_500_000n.toString(16).padStart(64, "0")), "for exactly the strike");
});
