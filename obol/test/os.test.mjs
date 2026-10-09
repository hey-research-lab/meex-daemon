// The OS (milestone 13): market and positions read from the log and the books, the token metadata, the image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketOf, positionsOf, metadataOf, imageSvg, traitsOf, revealOf, mainnetMetadata } from "../src/os.mjs";
import { readFileSync } from "node:fs";
import { osHtml, viewHtml } from "../src/os-page.mjs";

const ME = "0x00000000000000000000000000000000000000A1", SIB = "0x00000000000000000000000000000000000000b2", Z = "0x0000000000000000000000000000000000000000";

test("market: skills sold, x402 paid by payee, trades by kind; failures and model calls don't count", () => {
  const log = [
    { kind: "sale", name: "top_movers", ok: true, detail: { amount: "20000" } },
    { kind: "sale", name: "top_movers", ok: true, detail: { amount: "20000" } },
    { kind: "sale", name: "top_movers", ok: false, detail: { amount: "20000" } },
    { kind: "strategy", name: "watch", ok: true, detail: { spent: [{ amount: "20000", to: SIB }, { kind: "model", micro: 30 }] } },
    { kind: "strategy", name: "buy", ok: true, detail: { spent: [{ kind: "otc-take" }, { kind: "option-buy" }, { kind: "otc-take" }] } },
    { kind: "strategy", name: "bad", ok: false, detail: { spent: [{ amount: "999999", to: SIB }] } },
  ];
  const m = marketOf(log);
  assert.deepEqual(m.sold, { top_movers: { n: 2, micro: 40000 } });
  assert.deepEqual(m.bought, { [SIB]: { n: 1, micro: 20000 } });
  assert.deepEqual(m.trades, { "otc-take": 2, "option-buy": 1 });
  assert.equal(m.netMicro, 20000);
});

test("positions: only this wallet's, only open ones, sides seen from its own seat", () => {
  const p = positionsOf(ME.toLowerCase(), {
    offers: [{ id: 1, maker: ME, give: [{ amount: "3", sym: "tNVDA" }], want: [{ amount: "1.8", sym: "tUSDG" }], expires: 9 }, { id: 2, maker: SIB, give: [], want: [] }],
    options: [{ id: 1, writer: ME, buyer: Z, state: "listed", terms: "a" }, { id: 2, writer: SIB, buyer: ME, state: "bought", terms: "b" }, { id: 3, writer: ME, buyer: SIB, state: "exercised", terms: "c" }, { id: 4, writer: SIB, buyer: Z, state: "listed", terms: "d" }],
    indexes: [{ id: 1, symbol: "tNVX", share: "0xS1", manager: SIB, supply: 3, backed: true }, { id: 2, symbol: "tOWN", share: "0xS2", manager: ME, supply: 0, backed: true }, { id: 3, symbol: "tNO", share: "0xS3", manager: SIB, supply: 1, backed: true }],
    swaps: [{ id: 1, maker: SIB, taker: ME, makerSide: "long", state: "live", terms: "x", escrow: "2000000" }, { id: 2, maker: ME, taker: Z, makerSide: "long", state: "offered", terms: "y" }, { id: 3, maker: ME, taker: SIB, makerSide: "short", state: "settled" }, { id: 4, maker: SIB, taker: Z, makerSide: "short", state: "offered" }],
    shares: { "0xs1": 2 },
  });
  assert.deepEqual(p.otc.map((o) => o.id), [1]);
  assert.deepEqual(p.options.map((o) => [o.id, o.role]), [[1, "writer"], [2, "holder"]]);
  assert.deepEqual(p.indexes.map((x) => [x.symbol, x.held, x.manager]), [["tNVX", 2, false], ["tOWN", 0, true]]);
  assert.deepEqual(p.swaps.map((s) => [s.id, s.side]), [[1, "short"], [2, "long"]], "a taker of a long-maker swap is short");
});

test("metadata: ERC-721 shape, the OS as animation_url, attributes from its limits", () => {
  const v = { id: 2, version: "ee16245a7839", skills: [], strategies: [1, 2, 3], limits: { otc: {}, options: null, swaps: {}, indexes: [{ symbol: "tNVX" }] } };
  const m = metadataOf("https://obol.sh", v);
  assert.equal(m.name, "Daemon #2");
  assert.equal(m.animation_url, "https://obol.sh/d/2/view", "the spin, full-bleed");
  assert.equal(m.external_url, "https://obol.sh/d/2/os", "the OS is one click away");
  assert.equal(m.image, "https://obol.sh/d/2/image.svg");
  assert.match(m.description, /0 skills/);
  const t = Object.fromEntries(m.attributes.map((a) => [a.trait_type, a.value]));
  assert.deepEqual([t.Strategies, t["Trades OTC"], t.Options, t.Swaps, t["Publishes an index"]], [3, "yes", undefined, "yes", "tNVX"]);
});

test("the image and the page escape what they print", () => {
  const svg = imageSvg("1", { skills: 1, strategies: 2, version: '<script>"x"' });
  assert.ok(!svg.includes("<script>") && svg.includes("&lt;script&gt;&quot;x&quot;"));
  assert.match(svg, /^<svg/);
  const html = osHtml("https://obol.sh", 3);
  assert.match(html, /const ORIGIN = "https:\/\/obol.sh", ID = 3;/);
});

test("the page renders hostile sibling text inert, on every screen", async () => {
  const EVIL = '<img src=x onerror=alert(1)>';
  const els = {};
  const el = (id) => (els[id] ??= { id, innerHTML: "", textContent: "", classList: { toggle() {} }, setAttribute() {} });
  const document = { getElementById: el, querySelectorAll: () => [] };
  const data = {
    id: 3, version: EVIL, nextRun: null, wallet: ME, owner: SIB, agent: SIB, constitutionLive: true, caps: { perCall: 25, perDay: 40, spentToday: 1 }, think: { budget: 0.05, today: 0 },
    balances: [{ sym: EVIL, amount: 1 }], skills: [{ name: EVIL, price: "0.02", description: EVIL }], strategies: [{ name: EVIL, every: 3600, description: EVIL, lastRun: null }],
    limits: { indexes: [{ symbol: EVIL, name: EVIL, basket: [EVIL] }] },
    positions: { otc: [{ id: 1, give: [EVIL], want: [EVIL], expires: 9 }], options: [{ id: 1, role: "writer", state: "listed", terms: EVIL }], swaps: [{ id: 1, side: "long", state: "offered", terms: EVIL, escrow: "1" }], indexes: [{ symbol: EVIL, held: 1, supply: 1, backed: true }] },
    log: [{ at: 1, kind: "message", name: EVIL, ok: true, detail: { body: EVIL } }, { at: 1, kind: "strategy", name: "x", ok: false, detail: { error: EVIL } }, { at: 1, kind: "strategy", name: "x", ok: true, detail: { skipped: EVIL } }],
    inbox: [{ at: 1, sender: EVIL, kind: EVIL, body: EVIL, role: "agent" }],
    repo: { head: { hash: EVIL, at: 1, reason: EVIL }, commits: [{ hash: EVIL, author: EVIL, at: 1, reason: EVIL }], proposals: [{ id: 1, role: EVIL, status: EVIL, reason: EVIL, plan: [EVIL], failed: [EVIL] }] },
    market: { sold: { [EVIL]: { n: 1, micro: 1 } }, bought: {}, trades: { [EVIL]: 1 }, netMicro: 1 },
  };
  const script = osHtml("https://obol.sh", 3).match(/<script>([\s\S]*)<\/script>/)[1];
  new Function("document", "fetch", "setInterval", script)(document, async () => ({ ok: true, json: async () => data }), () => 0);
  await new Promise((r) => setTimeout(r, 10));
  const out = Object.values(els).map((e) => e.innerHTML).join("\n");
  assert.ok(out.length > 1000, "it rendered");
  assert.ok(!out.includes("<img"), "no sibling-written tag survives");
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"), "it is shown, escaped");
});

test("art: a token's eight traits from the shipped table; the GIF is the image once it's uploaded, the placeholder until then", () => {
  const table = JSON.parse(readFileSync(new URL("../src/art-traits.json", import.meta.url)));
  assert.equal(table.tokens.length, 10048);
  const t = traitsOf(table, 1);
  assert.deepEqual(t.map((x) => x.trait_type), ["Top", "Colourway", "Pants", "Shoes", "Casing", "Phosphor", "Face", "Hat"]);
  assert.ok(t.every((x) => typeof x.value === "string" && x.value.length));
  assert.equal(traitsOf(table, 10048), null, "no row past the supply");
  const v = { id: 1, version: "x", skills: [], strategies: [], limits: {} };
  assert.equal(metadataOf("https://obol.sh", v).image, "https://obol.sh/d/1/image.svg");
  const m = metadataOf("https://obol.sh", v, { art: t, gif: true });
  assert.equal(m.image, "https://obol.sh/d/1/image.gif");
  assert.deepEqual(m.attributes.slice(0, 8), t, "the art traits lead the attributes");
  const seen = new Set(table.tokens.map((r) => r.join(",")));
  assert.equal(seen.size, 10048, "every token looks different");
});

test("one page, no exits: the view opens on the spin, a tap switches to Wallet in place; nothing links away", () => {
  const view = viewHtml("https://obol.sh", 7, true), os = osHtml("https://obol.sh", 7, { gif: true });
  assert.match(view, /<body class="spinning">/, "the animation_url opens on the spin");
  assert.match(os, /<body class="">/, "/os opens on Wallet");
  assert.match(view, /<img src="https:\/\/obol.sh\/d\/7\/image.gif"/);
  assert.match(viewHtml("https://obol.sh", 7, false), /image.svg/, "the placeholder until the GIF is uploaded");
  for (const h of [view, os]) {
    const body = h.slice(h.indexOf("<body"));
    assert.ok(!/<a\s/i.test(body), "no links — a marketplace frame has no back button");
    assert.ok(!/target=|window\.open|location\s*=|location\.href/.test(body), "no new tabs, no navigation");
    assert.match(body, /data-s="spin">Spin</, "Spin is a screen like the others");
  }
});

test("reveal on sale: only a SOLD token shows its own art and traits; unsold ones all look the same", () => {
  const SALE = "0x00000000000000000000000000000000000000aa", BUYER = "0x00000000000000000000000000000000000000bb";
  const unsold = revealOf(212, { owner: SALE.toUpperCase().replace("0X", "0x"), sale: SALE });
  assert.deepEqual(unsold, { exists: true, sold: false, image: "mainnet/unrevealed.gif" }, "the sale holds it (any case)");
  const sold = revealOf(212, { owner: BUYER, sale: SALE });
  assert.deepEqual(sold, { exists: true, sold: true, image: "mainnet/gif/212.gif" });
  for (const bad of [-1, 10048, 1.5, NaN]) assert.equal(revealOf(bad, { owner: BUYER, sale: SALE }).exists, false, String(bad));
  assert.equal(revealOf(5, { owner: null, sale: SALE }).exists, false);
  const traits = [{ trait_type: "Top", value: "Tee" }];
  const mu = mainnetMetadata("https://obol.sh", 212, unsold, traits), ms = mainnetMetadata("https://obol.sh", 212, sold, traits);
  assert.deepEqual(mu.attributes, [{ trait_type: "Status", value: "Unrevealed" }], "no trait leaks before the sale");
  assert.ok(!JSON.stringify(mu).includes("Tee"));
  assert.deepEqual(ms.attributes, [...traits, { trait_type: "Status", value: "Revealed" }]);
  assert.equal(ms.animation_url, "https://obol.sh/d/212/view");
});
