// Bounded swaps (milestone 12, testnet): the swaps{} limits, offer/take checks and escrow costs, holder-only limits,
// the take picker, the settling-round search, settle/refund housekeeping, and the price mirror's round plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSwaps, checkSwapStep, FEEDS } from "../../lang/swaps.mjs";
import { compileDoc, hashDoc } from "../../lang/check.mjs";
import { gates } from "../src/repo.mjs";
import { pickSwap, settlingRound, settleDue, offerSwap, takeSwap, GRACE } from "../src/swaps.mjs";
import { toPost } from "../src/mirror.mjs";

const LIM = [{ underlyings: ["NVDA"], max_open: 2, max_usd: "3" }];
const OFFER = { underlying: "NVDA", side: "long", notional: "10 tUSDG", cap: "20%", term: "24h", max_stale: "2h", expires: "24h" };
const TAKE = { underlying: "NVDA", side: "short", notional_at_most: "10 tUSDG", cap_at_most: "20%", term_at_most: "48h" };
const strat = (step, extra = {}, every = "24h") => ({ swaps: LIM, strategy: { s: [{ description: "s", every, input: [{}], step: { x: [{ ...step, ...extra }] } }] } });
const errs = (doc) => { const c = compileDoc(doc); return [...c.strategies, ...c.skills].flatMap((x) => x.errors).concat(c.reflectErrors); };
const WALLET = { maxPerCall: 25_000_000, maxPerDay: 40_000_000 };
const ME = "0x00000000000000000000000000000000000000a1", SIB = "0x00000000000000000000000000000000000000b2", ZERO = "0x0000000000000000000000000000000000000000";

test("the swaps{} block: underlyings with a feed, max_open, max_usd (the most one swap may lose)", () => {
  assert.deepEqual(checkSwaps(LIM).errors, []);
  assert.ok(checkSwaps([{ underlyings: ["TSLA"], max_open: 2, max_usd: "3" }]).errors.some((e) => /no price feed/.test(e)));
  assert.ok(checkSwaps([{ underlyings: [], max_open: 2, max_usd: "3" }]).errors.length);
  assert.ok(checkSwaps([{ underlyings: ["NVDA"], max_open: 0, max_usd: "3" }]).errors.length);
  assert.ok(checkSwaps([{ underlyings: ["NVDA"], max_open: 2, max_usd: "0" }]).errors.length);
});

test("an offer's cost is its escrow, notional × cap; a take's is its worst case", () => {
  assert.deepEqual(errs(strat({ swap_offer: [OFFER] })), []);
  assert.equal(compileDoc(strat({ swap_offer: [OFFER] })).strategies[0].maxCost, 2);
  assert.equal(compileDoc(strat({ swap_offer: [{ ...OFFER, cap: "12.5%" }] })).strategies[0].maxCost, 1.25);
  assert.deepEqual(errs(strat({ swap_take: [TAKE] }, { skip_if_none: true })), []);
  assert.equal(compileDoc(strat({ swap_take: [TAKE] })).strategies[0].maxCost, 2);
});

test("offer and take refusals", () => {
  const none = strat({ swap_offer: [OFFER] }); delete none.swaps;
  assert.ok(errs(none).some((e) => /need a swaps/.test(e)));
  const bad = [[{ underlying: "TSLA" }, /isn't in swaps.underlyings/], [{ side: "up" }, /side/], [{ notional: "10 tNVDA" }, /in dollars/],
    [{ cap: "20" }, /cap must be/], [{ cap: "51%" }, /cap must be/], [{ cap: "0%" }, /cap must be/], [{ term: "30m" }, /term/], [{ term: "721h" }, /term/],
    [{ max_stale: "0h" }, /max_stale/], [{ max_stale: "73h" }, /max_stale/], [{ expires: "169h" }, /expires/], [{ notional: "20 tUSDG" }, /escrow 4 .*over swaps.max_usd 3/]];
  for (const [patch, re] of bad) assert.ok(errs(strat({ swap_offer: [{ ...OFFER, ...patch }] })).some((e) => re.test(e)), JSON.stringify(patch));
  assert.ok(errs(strat({ swap_take: [{ ...TAKE, term_at_most: "999h" }] })).some((e) => /term_at_most/.test(e)));
  assert.ok(errs(strat({ swap_take: [{ ...TAKE, cap_at_most: "40%" }] })).some((e) => /over swaps.max_usd/.test(e)));
  assert.ok(errs(strat({ swap_take: [TAKE] }, { skip_if_none: 1 })).some((e) => /skip_if_none/.test(e)));
});

test("swaps belong to strategies; the daily cap bounds them; the limits are the holder's", () => {
  const skill = { swaps: LIM, skill: { s: [{ description: "s", price: "5", input: [{}], step: { o: [{ swap_offer: [OFFER] }] } }] } };
  assert.ok(errs(skill).some((e) => /swap steps run in strategies/.test(e)));
  const g = gates({ head: null, headHash: null, doc: strat({ swap_offer: [OFFER] }, {}, "1h"), base: null, role: "holder", wallet: WALLET });
  assert.match(g.gates.find((x) => x.gate === "within(wallet)").detail, /48\.00 a day > daily cap 40\.00/);
  const head = strat({ swap_offer: [OFFER] }), headHash = hashDoc(head);
  const wider = { ...head, swaps: [{ underlyings: ["NVDA"], max_open: 9, max_usd: "3" }] };
  for (const role of ["self", "sibling"]) assert.match(gates({ head, headHash, doc: wider, base: headHash, role, wallet: WALLET }).gates.find((x) => x.gate === "constitution").detail, /only the holder can change swaps/);
  const h = gates({ head, headHash, doc: wider, base: headHash, role: "holder", wallet: WALLET });
  assert.equal(h.ok, true);
  assert.ok(h.plan.some((l) => /~ swaps:/.test(l)));
});

const sw = (id, o) => ({ id, state: "offered", underlying: "NVDA", feed: FEEDS.NVDA.address, maker: SIB, makerDaemon: 2, taker: ZERO, makerSide: "long",
  notional: "10000000", capBps: 2000, escrow: "2000000", term: 86400, maxStale: 7200, offerExpires: 2e9, start: 0, end: null, terms: `#${id}`, ...o });

test("pickSwap: the other side, within every bound, unexpired, not ours; oldest first", () => {
  const rule = { wallet: ME, underlying: "NVDA", side: "short", notionalMax: 10_000_000n, capMax: 2000, termMax: 172800, now: 1e9 };
  const book = [sw(9, {}), sw(2, { makerSide: "short" }), sw(3, { notional: "11000000" }), sw(4, { capBps: 2500 }), sw(5, { term: 200000 }),
    sw(6, { maker: ME }), sw(7, { offerExpires: 1e9 - 1 }), sw(8, { state: "live" }), sw(10, { underlying: "TSLA" }), sw(11, {})];
  assert.equal(pickSwap(book, rule).id, 9);
  assert.equal(pickSwap(book.slice(1), rule).id, 11);
  assert.equal(pickSwap(book.slice(1, 9), rule), null, "everything else is out");
  assert.equal(pickSwap([sw(12, {}), sw(11, {})], rule).id, 11, "the book is newest-first; the oldest offer is taken");
});

test("the settling round: first at or after expiry, with the round before it earlier", async () => {
  const times = { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 };
  const at = async (id) => times[Number(id)] ?? null;
  assert.equal(await settlingRound(5n, 250, at), 3n);
  assert.equal(await settlingRound(5n, 300, at), 3n, "exactly at expiry counts");
  assert.equal(await settlingRound(5n, 301, at), 4n);
  assert.equal(await settlingRound(5n, 600, at), null, "no round at or after expiry yet");
  assert.equal(await settlingRound(5n, 50, at), null, "the history before the first round isn't there — can't prove it's first");
  assert.equal(await settlingRound(0n, 50, at), null);
});

test("housekeeping: settles what ended, waits without a price, refunds past the grace, ignores others' swaps", async () => {
  const now = 1_000_000, sent = [];
  const send = async (_e, _k, _w, calls) => { sent.push(calls); return calls.map(() => ({ hash: "0x1", logs: [] })); };
  const live = (id, o) => sw(id, { state: "live", taker: ME, start: now - 86400 - 10, end: now - 10, ...o });
  const book = async () => [live(1, {}), live(2, { end: now + 10 }), live(3, { start: now - 86400 - GRACE - 10, end: now - GRACE - 10 }), live(4, { taker: SIB, maker: "0x00000000000000000000000000000000000000c3" }), live(5, {})];
  const feedFn = () => ({ latest: async () => 3n, at: async (id) => ({ 1: now - 100, 2: now - 5, 3: now + 1 })[Number(id)] ?? null });
  const r = await settleDue({}, { daemonId: 1, agentKey: "0x1", bookFn: book, walletFn: async () => ME, feedFn, send, now });
  assert.deepEqual(r.map((x) => `${Object.keys(x)[0]} ${x.settled ?? x.refunded ?? x.waiting}`), ["settled 1", "refunded 3", "settled 5"], "#2 hasn't ended; #4 isn't ours; #3's history ends before its expiry and it's past the grace");
  assert.deepEqual(r.filter((x) => x.settled).map((x) => [x.settled, x.round]), [[1, "2"], [5, "2"]], "round 2 is the first at/after expiry");
  const noPrice = () => ({ latest: async () => 1n, at: async () => now - 1000 });
  const r2 = await settleDue({}, { daemonId: 1, agentKey: "0x1", bookFn: book, walletFn: async () => ME, feedFn: noPrice, send, now });
  assert.deepEqual(r2.map((x) => x.refunded ?? x.waiting ?? x.settled), [1, 3, 5].map((id) => id), "1 and 5 wait, 3 is past the grace");
  assert.deepEqual(r2.map((x) => Object.keys(x)[0]), ["waiting", "refunded", "waiting"]);
});

test("runtime refusals send nothing: max_open; nothing to take; a price older than the maker allows", async () => {
  const full = async () => [sw(1, { maker: ME }), sw(2, { state: "live", taker: ME })];
  await assert.rejects(offerSwap({}, { daemonId: 1, agentKey: "0x1", underlying: "NVDA", side: "long", notional: "10 tUSDG", cap: "20%", termH: 24, maxStaleH: 2, expiresH: 24, maxOpen: 2, bookFn: full, walletFn: async () => ME, send: async () => { throw new Error("sent"); } }), /max_open 2/);
  const args = { daemonId: 1, agentKey: "0x1", underlying: "NVDA", side: "short", notionalAtMost: "10 tUSDG", capAtMost: "20%", termAtMostH: 48, maxOpen: 2, walletFn: async () => ME, send: async () => { throw new Error("sent"); } };
  assert.equal((await takeSwap({}, { ...args, bookFn: async () => [], priceAgeFn: async () => 0 })).taken, null);
  const stale = await takeSwap({}, { ...args, bookFn: async () => [sw(1, {})], priceAgeFn: async () => 7201 });
  assert.match(stale.why, /older|min old/);
  let calls = null;
  const ok = await takeSwap({}, { ...args, bookFn: async () => [sw(1, {})], priceAgeFn: async () => 7200, send: async (_e, _k, _w, c) => { calls = c; return c.map(() => ({ hash: "0x1", logs: [] })); } });
  assert.equal(ok.taken, 1);
  assert.ok(calls[0][1].endsWith((2_000_000).toString(16).padStart(64, "0")), "approves exactly the escrow");
});

test("the mirror posts every source round in order; a fresh mirror or a new phase starts at the latest", () => {
  const P = 1n << 64n;
  assert.deepEqual(toPost(0n, P + 50n), [P + 50n]);
  assert.deepEqual(toPost(P + 48n, P + 50n), [P + 49n, P + 50n]);
  assert.deepEqual(toPost(P + 50n, P + 50n), []);
  assert.deepEqual(toPost(P + 1n, P + 100n).length, 24, "catch up 24 a run");
  assert.deepEqual(toPost(P + 1n, P + 100n)[23], P + 100n, "…ending at the latest");
  assert.deepEqual(toPost(P + 60n, 2n * P + 3n), [2n * P + 3n], "a new phase");
  assert.deepEqual(toPost(2n * P + 3n, P + 60n), [], "a source behind the mirror posts nothing (ids only rise)");
});
