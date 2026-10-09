// OTC steps (milestone 09): amounts, the otc{} limits, offer/take checks, costs against the wallet, holder-only limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, checkOtc, checkOtcStep, INSTRUMENTS } from "../../lang/otc.mjs";
import { compileDoc, hashDoc } from "../../lang/check.mjs";
import { gates } from "../src/repo.mjs";

const OTC = [{ instruments: ["tUSDG", "tNVDA"], max_open: 3, max_usd: "5" }];
const sell = (offer) => ({ otc: OTC, strategy: { sell: [{ description: "s", every: "24h", input: [{}], step: { post: [{ offer: [offer] }] } }] } });
const buy = (take, extra = {}) => ({ otc: OTC, strategy: { buy: [{ description: "b", every: "1h", input: [{}], step: { take: [{ take: [take], ...extra }] } }] } });
const errs = (doc) => { const c = compileDoc(doc); return [...c.strategies, ...c.skills].flatMap((x) => x.errors).concat(c.reflectErrors); };
const WALLET = { maxPerCall: 25_000_000, maxPerDay: 40_000_000 };

test("amounts: exact raw units per instrument; junk refused", () => {
  assert.equal(parseAmount("3 tNVDA").raw, 3n * 10n ** 18n);
  assert.equal(parseAmount("1.8 tUSDG").raw, 1_800_000n);
  assert.equal(parseAmount("0.000001 tUSDG").raw, 1n);
  for (const bad of ["1.0000001 tUSDG", "0 tNVDA", "-1 tNVDA", "3 NVDA", "3tNVDA", "three tNVDA", "", "1e3 tUSDG"]) assert.throws(() => parseAmount(bad), bad);
  assert.equal(INSTRUMENTS.tUSDG.decimals, 6);
});

test("the otc{} block: known instruments, max_open 1–10, max_usd", () => {
  assert.deepEqual(checkOtc(OTC).errors, []);
  assert.ok(checkOtc([{ instruments: ["tDOGE"], max_open: 3, max_usd: "5" }]).errors.length);
  assert.ok(checkOtc([{ instruments: ["tUSDG"], max_open: 0, max_usd: "5" }]).errors.length);
  assert.ok(checkOtc([{ instruments: ["tUSDG"], max_open: 3, max_usd: "5000" }]).errors.length);
});

test("an offer compiles and its escrowed dollars count as cost", () => {
  const c = compileDoc(sell({ give: ["1.8 tUSDG"], want: ["3 tNVDA"], expires: "24h" }));
  assert.deepEqual(errs(sell({ give: ["1.8 tUSDG"], want: ["3 tNVDA"], expires: "24h" })), []);
  assert.equal(c.strategies[0].maxCost, 1.8);
  assert.equal(compileDoc(sell({ give: ["3 tNVDA"], want: ["1.8 tUSDG"], expires: "24h" })).strategies[0].maxCost, 0, "giving stock costs no dollars");
});

test("offer refusals: no otc block, unlisted instrument, over max_usd, same token both sides, bad expiry, empty side", () => {
  const noOtc = sell({ give: ["3 tNVDA"], want: ["1.8 tUSDG"], expires: "24h" }); delete noOtc.otc;
  assert.ok(errs(noOtc).some((e) => /needs an otc/.test(e)));
  const narrow = { ...sell({ give: ["3 tNVDA"], want: ["1.8 tUSDG"], expires: "24h" }), otc: [{ instruments: ["tUSDG"], max_open: 3, max_usd: "5" }] };
  assert.ok(errs(narrow).some((e) => /tNVDA isn't in otc.instruments/.test(e)));
  assert.ok(errs(sell({ give: ["3 tNVDA"], want: ["9 tUSDG"], expires: "24h" })).some((e) => /over otc.max_usd/.test(e)));
  assert.ok(errs(sell({ give: ["3 tNVDA"], want: ["1 tNVDA"], expires: "24h" })).some((e) => /both sides/.test(e)));
  assert.ok(errs(sell({ give: ["3 tNVDA"], want: ["1 tUSDG"], expires: "30m" })).some((e) => /expires/.test(e)));
  assert.ok(errs(sell({ give: [], want: ["1 tUSDG"], expires: "24h" })).some((e) => /needs give/.test(e)));
});

test("take: compiles; its dollar limit is the cost; refusals", () => {
  const ok = buy({ give_at_least: "3 tNVDA", for_at_most: "2 tUSDG" }, { skip_if_none: true });
  assert.deepEqual(errs(ok), []);
  assert.equal(compileDoc(ok).strategies[0].maxCost, 2);
  assert.ok(errs(buy({ give_at_least: "3 tNVDA", for_at_most: "6 tUSDG" })).some((e) => /over otc.max_usd/.test(e)));
  assert.ok(errs(buy({ give_at_least: "3 tUSDG", for_at_most: "2 tUSDG" })).some((e) => /same instrument/.test(e)));
  assert.ok(errs(buy({ give_at_least: "3 tNVDA", for_at_most: "2 tUSDG" }, { skip_if_none: "yes" })).some((e) => /skip_if_none/.test(e)));
});

test("trading belongs to strategies: a paid skill can't offer or take", () => {
  const doc = { otc: OTC, skill: { s: [{ description: "x", price: "1", input: [{}], step: { t: [{ take: [{ give_at_least: "3 tNVDA", for_at_most: "2 tUSDG" }] }] } }] } };
  assert.ok(errs(doc).some((e) => /strategies, not skills/.test(e)));
});

test("the wallet's daily cap bounds trading: an hourly 2-dollar take would need 48 a day", () => {
  const doc = buy({ give_at_least: "3 tNVDA", for_at_most: "2 tUSDG" });
  const g = gates({ head: { otc: OTC }, headHash: hashDoc({ otc: OTC }), doc, base: hashDoc({ otc: OTC }), role: "holder", wallet: WALLET });
  assert.match(g.gates.find((x) => x.gate === "within(wallet)").detail, /48\.00 a day > daily cap 40\.00/);
});

test("otc{} is the holder's: a daemon or sibling can't widen it", () => {
  const head = { otc: OTC }, headHash = hashDoc(head);
  const wider = { otc: [{ instruments: ["tUSDG", "tNVDA"], max_open: 10, max_usd: "500" }] };
  for (const role of ["self", "sibling"]) assert.match(gates({ head, headHash, doc: wider, base: headHash, role, wallet: WALLET }).gates.find((x) => x.gate === "constitution").detail, /only the holder can change otc/);
  assert.equal(gates({ head, headHash, doc: wider, base: headHash, role: "holder", wallet: WALLET }).gates.find((x) => x.gate === "constitution").ok, true);
});

import { pickOffer, postOffer, takeBest } from "../src/otc.mjs";
const NV = parseAmount("3 tNVDA").token, US = parseAmount("1 tUSDG").token;
const off = (id, maker, nv, usd, extra = {}) => ({ id, maker, makerDaemon: 2, give: [{ token: NV, raw: String(BigInt(Math.round(nv * 1e6)) * 10n ** 12n), amount: String(nv), sym: "tNVDA" }], want: [{ token: US, raw: String(Math.round(usd * 1e6)), amount: String(usd), sym: "tUSDG" }], ...extra });
const ME = "0x00000000000000000000000000000000000000aa", THEM = "0x00000000000000000000000000000000000000bb";

test("pickOffer: within the limits, never our own, cheapest per unit", () => {
  const rule = { wallet: ME, get: parseAmount("3 tNVDA"), pay: parseAmount("2 tUSDG") };
  assert.equal(pickOffer([off(1, THEM, 3, 2.5)], rule), null, "too dear");
  assert.equal(pickOffer([off(1, THEM, 2, 1)], rule), null, "too few units");
  assert.equal(pickOffer([off(1, ME, 3, 1)], rule), null, "our own");
  assert.equal(pickOffer([off(1, THEM, 3, 1, { give: [...off(1, THEM, 3, 1).give, ...off(1, THEM, 1, 1).give] })], rule), null, "a multi-leg bundle isn't a simple take");
  assert.equal(pickOffer([off(1, THEM, 3, 1.9), off(2, THEM, 4, 2), off(3, THEM, 3, 1.8)], rule).id, 2, "4 for 2.00 (0.50 each) beats 3 for 1.80 (0.60)");
});

test("postOffer refuses at max_open before sending anything; takeBest with nothing to take sends nothing", async () => {
  let sent = 0; const send = async () => { sent++; return [{ hash: "0x", logs: [] }]; };
  const walletFn = async () => ME;
  await assert.rejects(postOffer({}, { daemonId: 2, agentKey: "0x1", give: ["3 tNVDA"], want: ["1.8 tUSDG"], expiresSec: 3600, maxOpen: 2, bookFn: async () => [off(1, ME, 3, 1), off(2, ME, 3, 1), off(3, THEM, 3, 1)], walletFn, send }), /already 2 open offers/);
  assert.equal(sent, 0);
  const r = await takeBest({}, { daemonId: 1, agentKey: "0x1", getAtLeast: "3 tNVDA", payAtMost: "2 tUSDG", bookFn: async () => [off(1, THEM, 3, 5)], walletFn, send });
  assert.deepEqual([r.taken, sent], [null, 0]);
  await takeBest({}, { daemonId: 1, agentKey: "0x1", getAtLeast: "3 tNVDA", payAtMost: "2 tUSDG", bookFn: async () => [off(9, THEM, 3, 1.8)], walletFn, send });
  assert.equal(sent, 1, "one wallet call batch (approve + take)");
});
