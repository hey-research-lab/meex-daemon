// obol.sh front page + legal set (mainnet launch, 2026-10-08): what the page sends, and the words we never use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homeHtml } from "../src/home-page.mjs";
import { termsHtml, privacyHtml, riskHtml } from "../src/legal-pages.mjs";
import M from "../src/deployment-mainnet.json" with { type: "json" };

test("the buy flow sends buy(n) to the sale, at the chain's price read just before, on chain 4663", () => {
  const h = homeHtml("https://obol.sh", M);
  assert.match(h, /const SALE = "0xD22301bcA4eCfFb9F4B87792885D766595e7363c", CHAIN = "0x1237"/);
  assert.match(h, /"0xd96a094a" \+ BigInt\(id\)\.toString\(16\)\.padStart\(64, "0"\)/, "buy(uint256) selector + the number");
  assert.match(h, /data: "0xa035b1fe"/, "price() read from the chain");
  assert.match(h, /value: "0x" \+ BigInt\(price\)\.toString\(16\)/, "pays exactly that price");
  assert.ok(h.indexOf("wallet_switchEthereumChain") < h.indexOf("eth_sendTransaction"), "switches to Robinhood Chain before sending");
  assert.match(h, /OPENS = 1791655200 \* 1000/);
  assert.match(h, new RegExp(M.provenance.tableSha256), "the provenance commitment is on the page");
});

test("the legal set: SHYGUY LLC, Idaho, the US$100 cap, final sales, the licence excludes the models — and never 'invest' or 'earn' as a promise", () => {
  const t = termsHtml(M), p = privacyHtml(M), r = riskHtml(M);
  assert.match(t, /SHYGUY LLC<\/strong>, an Idaho limited liability company/);
  assert.match(t, /Ada County, Idaho/); assert.match(t, /US\$100/); assert.match(t, /no refunds/);
  assert.match(t, /not the 3D models, rigs, textures or tools/, "third-party models are never licensed onward");
  assert.match(t, new RegExp(M.nft)); assert.match(t, new RegExp(M.sale));
  assert.match(p, /no cookies and no analytics/);
  assert.match(r, /not had an independent audit/);
  for (const [name, h] of [["terms", t], ["privacy", p], ["risk", r], ["home", homeHtml("https://obol.sh", M)]]) {
    const words = h.replace(/<[^>]+>/g, " ");
    assert.ok(!/\bearn(s|ing)?\b/i.test(words), `${name}: never "earn"`);
    assert.ok(!/\b(return on|profit|guaranteed|moon|to the moon)\b/i.test(words), `${name}: no return promises`);
  }
});

test("the docs state the compiler's own limits, and what's live where", async () => {
  const { docsHtml } = await import("../src/docs-page.mjs");
  const { MODELS, worstCost } = await import("../../lang/check.mjs");
  const h = docsHtml(M);
  assert.match(h, new RegExp(worstCost(MODELS.qwen).toFixed(6)), "the model step's minimum max matches the compiler");
  assert.match(h, new RegExp(`${MODELS.qwen.in} / ${MODELS.qwen.out} USDG per 1M tokens`), "the posted rate matches");
  for (const k of ["mob", "fetch", "x402", "model", "pick", "inbox", "message", "offer", "take", "write_option", "buy_option", "exercise", "mint_index", "redeem_index", "swap_offer", "swap_take"]) assert.match(h, new RegExp(`<code>${k}</code>`), `step ${k} documented`);
  assert.match(h, /Everything in the guide and the reference runs today on the testnet daemons/);
  assert.match(h, /strictly less/);
  const words = h.replace(/<[^>]+>/g, " ");
  assert.ok(!/\bearn(s|ing)?\b/i.test(words), "never 'earn' as money");
});

test("crawler files: robots points at the sitemap; the testnet host is closed to search; security.txt is valid", async () => {
  const site = await import("../src/site-files.mjs");
  assert.match(site.robots("https://obol.sh", false), /Sitemap: https:\/\/obol.sh\/sitemap.xml/);
  assert.match(site.robots("https://obol.sh", false), /Disallow: \/api\//);
  assert.match(site.robots("https://testnet.obol.sh", true), /Disallow: \/\n/);
  const sm = site.sitemap("https://obol.sh", "2026-10-08");
  for (const p of ["/", "/docs", "/terms", "/privacy", "/risk"]) assert.match(sm, new RegExp(`<loc>https://obol.sh${p.replace("/", "\\/")}</loc>`));
  assert.ok(!/testnet/.test(sm));
  const sec = site.securityTxt("https://obol.sh");
  assert.match(sec, /^Contact: mailto:security@meex.work$/m); assert.match(sec, /^Canonical: https:\/\/obol.sh\/.well-known\/security.txt$/m);
  const exp = Date.parse(sec.match(/^Expires: (.+)$/m)[1]); assert.ok(exp > Date.parse("2026-10-08") && exp - Date.parse("2026-10-08") <= 366 * 864e5, "Expires within a year (RFC 9116)");
  const l = site.llms("https://obol.sh", M);
  assert.match(l, new RegExp(M.nft)); assert.match(l, /Not an investment/);
  assert.ok(!/\bearn(s|ing)?\b/i.test(l));
});
