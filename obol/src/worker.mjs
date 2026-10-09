// obol — the Daemon network's front door (testnet). Runs in the Workers account; obol.sh reaches it through a thin proxy in the
// account that holds the obol.sh zone.
//   GET  /                         the Floor (every daemon, every event — failures included)
//   GET  /api/floor                the same, as JSON
//   GET  /api/daemon/:id           one daemon's status and log
//   GET  /d/:id/:skill             a daemon's skill over x402 v2 (402 until paid; paid → verify, run, settle)
//   POST /d/:id/inbox              a signed message for daemon :id (EIP-712; holder or active agent of the sender)
//   GET  /api/daemon/:id/inbox     the messages it has accepted
//   GET  /api/daemon/:id/repo      its repo: head agentfile, commits, proposals (with every gate's reason)
//   POST /d/:id/proposals          a signed proposal (holder → gates → merged/rejected; sibling → held)
//   POST /d/:id/proposals/:pid/approve   the holder approves a held proposal (then the gates decide)
//   POST /facilitator/verify|settle   x402 facilitator API for RHC testnet (paymentPayload, paymentRequirements)
//   POST /admin/boot               (Bearer ADMIN_KEY) arm daemons 1–10
//   POST /admin/run/:id[?strategy=] (Bearer ADMIN_KEY) run one daemon's strategies now (all, or the one named)
//   POST /admin/reflect/:id        (Bearer ADMIN_KEY) reflect now ({ model } = a stand-in answer, for proofs)
import { Hono } from "hono";
import { D, SALE, NFT, DOLLAR, ACCOUNT, NETWORK, pub, fmt6, senderOf } from "./chain.mjs";
import { requirement, verify, settle, b64, unb64 } from "./x402.mjs";
import { floorHtml } from "./floor-page.mjs";
import { verifyMessage } from "./messages.mjs";
import { verifyProposal, verifyApproval, verifyRejection } from "./repo.mjs";
import { book } from "./otc.mjs";
import { optionBook } from "./options.mjs";
import { indexList } from "./indexes.mjs";
import { swapBook } from "./swaps.mjs";
import { osView, metadataOf, imageSvg, traitsOf } from "./os.mjs";
import ART_TRAITS from "./art-traits.json";
import { osHtml, viewHtml } from "./os-page.mjs";
import * as mainnet from "./mainnet.mjs";
import { homeHtml } from "./home-page.mjs";
import { termsHtml, privacyHtml, riskHtml } from "./legal-pages.mjs";
import { docsHtml } from "./docs-page.mjs";
import * as site from "./site-files.mjs";
import { dayFromIso } from "./bill.mjs";
import { parseAbi } from "viem";
import { FEEDS } from "../../lang/swaps.mjs";
export { Daemon, Floor } from "./daemon.mjs";
export { Clock } from "./clock.mjs";
export { SaleFeed } from "./sales.mjs";
const clock = (env) => env.CLOCK.get(env.CLOCK.idFromName("mirror"));

const IDS = Array.from({ length: 10 }, (_, i) => i + 1);
const app = new Hono();
const daemon = (env, id) => env.DAEMON.get(env.DAEMON.idFromName(String(id)));
const floor = (env) => env.FLOOR.get(env.FLOOR.idFromName("floor"));

// crawler files (site-files.mjs). testnet.obol.sh says noindex on every response.
app.use("*", async (c, next) => { await next(); if (onTestnet(c)) c.res.headers.set("x-robots-tag", "noindex, nofollow"); });
// one canonical host, and the standard headers. 🔴 A daemon's view and OS MUST stay frameable: marketplaces show them in
// an iframe (animation_url). Every other page refuses to be framed.
app.use("*", async (c, next) => {
  const host = c.req.header("x-forwarded-host") ?? new URL(c.req.url).host;
  if (host === "www.obol.sh") { const u = new URL(c.req.url); return c.redirect(`https://obol.sh${u.pathname}${u.search}`, 301); }
  await next();
  const h = c.res.headers, framed = /^\/d\/\d+\/(view|os)$/.test(new URL(c.req.url).pathname);
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), usb=(), payment=()");
  if (!framed && (h.get("content-type") ?? "").startsWith("text/html")) { h.set("x-frame-options", "DENY"); h.set("content-security-policy", "frame-ancestors 'none'"); h.set("cross-origin-opener-policy", "same-origin-allow-popups"); }
});
app.get("/robots.txt", (c) => c.text(site.robots(originOf(c), onTestnet(c)), 200, { "cache-control": "public, max-age=3600" }));
app.get("/sitemap.xml", (c) => (onTestnet(c) ? c.text("", 404) : c.body(site.sitemap(c.env.PUBLIC_ORIGIN, "2026-10-08"), 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" })));
app.get("/llms.txt", (c) => c.text(site.llms(c.env.PUBLIC_ORIGIN, mainnet.M), 200, { "cache-control": "public, max-age=3600" }));
app.get("/.well-known/security.txt", (c) => c.text(site.securityTxt(c.env.PUBLIC_ORIGIN), 200, { "cache-control": "public, max-age=86400" }));
app.get("/:key{[0-9a-f]+\\.txt}", (c, next) => (c.env.INDEXNOW_KEY && c.req.param("key") === `${c.env.INDEXNOW_KEY}.txt` ? c.text(c.env.INDEXNOW_KEY) : next()));   // IndexNow
// obol.sh = the mainnet collection's front page and buy flow; testnet.obol.sh = the testnet Floor
app.get("/", (c) => (onTestnet(c) ? c.html(floorHtml(originOf(c))) : c.html(homeHtml(c.env.PUBLIC_ORIGIN, mainnet.M, { gsv: c.env.GOOGLE_SITE_VERIFICATION }))));
app.get("/docs", (c) => c.html(docsHtml(mainnet.M), 200, { "cache-control": "public, max-age=300" }));
for (const [path, fn] of [["/terms", termsHtml], ["/privacy", privacyHtml], ["/risk", riskHtml]]) app.get(path, (c) => c.html(fn(mainnet.M), 200, { "cache-control": "public, max-age=300" }));
app.get("/api/sale", async (c) => { try { return c.json(await mainnet.saleState(c.env), 200, { ...CORS, "cache-control": "no-store" }); } catch (e) { return c.json({ error: "the chain didn't answer — try again" }, 503, CORS); } });
// the live sale feed: purchases from the SaleFeed index (never the RPC per view); each call also keeps the indexer awake
const feed = (env) => env.SALES.get(env.SALES.idFromName("mainnet"));
app.get("/api/sales", async (c) => { const f = feed(c.env); c.executionCtx.waitUntil(f.kick()); return c.json(await f.recent(Math.min(60, +(c.req.query("n") ?? 24) || 24)), 200, { ...CORS, "cache-control": "public, max-age=10" }); });
app.get("/api/sale/random", async (c) => c.json(await mainnet.randomUnsold(c.env), 200, { ...CORS, "cache-control": "no-store" }));
app.get("/api/sale/:id{[0-9]+}", async (c) => c.json(await mainnet.available(c.env, +c.req.param("id")), 200, { ...CORS, "cache-control": "no-store" }));

// an RPC hiccup must come back as JSON the Floor can show, never as an HTML error page
app.onError((e, c) => c.json({ error: String(e.message ?? e).slice(0, 200) }, 502));

app.get("/api/floor", async (c) => {
  const client = pub(c.env);
  const wallets = await Promise.all(IDS.map((id) => client.readContract({ address: D.sale, abi: SALE, functionName: "walletOf", args: [BigInt(id)] })));
  const reads = await Promise.all(IDS.map(async (id, i) => {
    const w = wallets[i];
    const [owner, usd, eth, spent] = await Promise.all([
      client.readContract({ address: D.nft, abi: NFT, functionName: "ownerOf", args: [BigInt(id)] }),
      client.readContract({ address: D.dollar, abi: DOLLAR, functionName: "balanceOf", args: [w] }),
      client.getBalance({ address: w }),
      client.readContract({ address: w, abi: ACCOUNT, functionName: "spentToday" }).catch(() => 0n),
    ]);
    const st = await daemon(c.env, id).status().catch(() => null);
    return { id, wallet: w, owner, tusdg: fmt6(usd), eth: (Number(eth) / 1e18).toFixed(6), spentToday: fmt6(spent), skills: st?.skills ?? [], strategies: st?.strategies ?? [], nextRun: st?.nextRun ?? null, version: st?.version ?? null, thinkBudget: st?.thinkBudget ?? 0, thinkToday: st?.thinkSpentToday ?? 0, last: st?.log?.[0] ?? null };
  }));
  const sold = await client.readContract({ address: D.sale, abi: SALE, functionName: "sold" });
  return c.json({ chain: "Robinhood Chain testnet (46630)", sold: Number(sold), daemons: reads, events: await floor(c.env).recent(60) }, 200, { "cache-control": "public, max-age=15" });
});

app.get("/api/daemon/:id", async (c) => c.json(await daemon(c.env, c.req.param("id")).status()));

app.post("/d/:id/inbox", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1 || id > 10048) return c.json({ ok: false, reason: "no such daemon" }, 404);
  const msg = await c.req.json().catch(() => null);
  const v = await verifyMessage(msg ?? {}, id, { nft: D.nft, sender: senderOf(c.env) });
  const inbox = daemon(c.env, id);
  if (!v.ok) {
    let from = null; try { from = Number(BigInt(msg?.message?.from)); } catch {}
    await inbox.refused(from, v.reason);
    return c.json(v, v.reason === "signer is neither the sender's holder nor its active agent" ? 401 : 400);
  }
  const r = await inbox.receive(v, msg.body);
  return c.json(r.ok ? { ok: true, from: v.from, role: v.role } : r, r.ok ? 202 : 409);
});
app.get("/api/daemon/:id/inbox", async (c) => c.json(await daemon(c.env, c.req.param("id")).inbox()));

// ── the repo ──
// the OTC offer book: open, unexpired bundle offers between daemons (read from DaemonOTC on chain)
app.get("/api/otc", async (c) => c.json({ contract: D.otc, offers: await book(c.env) }));
app.get("/api/swaps", async (c) => c.json({ contract: D.swaps, network: "Robinhood Chain testnet", feeds: FEEDS, swaps: await swapBook(c.env) }));
app.get("/api/indexes", async (c) => c.json({ contract: D.indexes, network: "Robinhood Chain testnet", indexes: await indexList(c.env) }));
app.get("/api/options", async (c) => c.json({ contract: D.options, network: "Robinhood Chain testnet", options: await optionBook(c.env) }));
app.get("/api/daemon/:id/repo", async (c) => c.json(await daemon(c.env, c.req.param("id")).repo()));
// one proposal with its full agentfile — what a holder reviews (and signs over) before approving a held one
app.get("/api/daemon/:id/proposals/:pid", async (c) => { const p = await daemon(c.env, c.req.param("id")).proposal(Number(c.req.param("pid"))); return p ? c.json({ ...p, gates: p.gates ? JSON.parse(p.gates) : null, plan: p.plan ? JSON.parse(p.plan) : null, evidence: p.evidence ? JSON.parse(p.evidence) : null }) : c.json({ error: "no such proposal" }, 404); });
app.post("/d/:id/proposals", async (c) => {
  const id = Number(c.req.param("id"));
  const p = await c.req.json().catch(() => null);
  const v = await verifyProposal(p ?? {}, id, { nft: D.nft, sender: senderOf(c.env) });
  if (!v.ok) return c.json(v, /holder|neither|signature/.test(v.reason) ? 401 : 400);
  const r = await daemon(c.env, id).propose({ doc: p.doc, reason: p.reason, role: v.role, by: v.by, signer: v.signer, base: v.base });
  return c.json(r, r.status === "merged" ? 201 : r.status === "held" ? 202 : 422);
});
app.post("/d/:id/proposals/:pid/approve", async (c) => {
  const id = Number(c.req.param("id")), pid = Number(c.req.param("pid"));
  const d = daemon(c.env, id);
  const prop = await d.proposal(pid);
  if (!prop) return c.json({ ok: false, reason: "no such proposal" }, 404);
  const v = await verifyApproval(await c.req.json().catch(() => null), id, prop, { nft: D.nft, sender: senderOf(c.env) });
  if (!v.ok) return c.json(v, 401);
  const r = await d.approve(pid);
  return c.json(r, r.status === "merged" ? 201 : r.ok === false && !r.status ? 409 : 422);
});

app.post("/d/:id/proposals/:pid/reject", async (c) => {
  const id = Number(c.req.param("id")), pid = Number(c.req.param("pid"));
  const d = daemon(c.env, id);
  const prop = await d.proposal(pid);
  if (!prop) return c.json({ ok: false, reason: "no such proposal" }, 404);
  const v = await verifyRejection(await c.req.json().catch(() => null), id, prop, { nft: D.nft, sender: senderOf(c.env) });
  if (!v.ok) return c.json(v, 401);
  const r = await d.reject(pid, v.reason);
  return c.json(r, r.ok ? 200 : 409);
});

// the OS (milestone 13): a daemon's own screen + its token metadata — registered BEFORE /d/:id/:skill (the skill route
// would otherwise answer /d/<id>/os as a skill named "os")
const known = (id) => /^\d+$/.test(id) && +id >= 1 && IDS.includes(+id);
// MAINNET (deployed 2026-10-08): obol.sh/d/<n> is the mainnet collection; the ten testnet daemons answer on
// testnet.obol.sh (the proxy forwards the original host). Registered first; a testnet host falls through to the testnet
// routes below. Every mainnet token is unrevealed until it sells (reveal on sale).
const onTestnet = (c) => (c.req.header("x-forwarded-host") ?? new URL(c.req.url).host).startsWith("testnet.");
const originOf = (c) => (onTestnet(c) ? "https://testnet.obol.sh" : c.env.PUBLIC_ORIGIN);
const mid = (c) => (/^\d+$/.test(c.req.param("id")) ? +c.req.param("id") : -1);
// social cards (art/tools/og.py): the front-page card switches to "on sale now" at the opening, by itself
const sitePng = (key) => async (c) => { const o = await c.env.ART.get(`site/${typeof key === "function" ? key() : key}.png`); return o ? c.body(o.body, 200, { "content-type": "image/png", ...CORS, "cache-control": "public, max-age=600" }) : c.text("not found", 404); };
app.get("/og.png", sitePng(() => (Date.now() >= mainnet.M.opensAt * 1000 ? "og-open" : "og")));
app.get("/og-docs.png", sitePng("og-docs"));
app.get("/banner.png", sitePng("banner"));
app.get("/unrevealed.gif", async (c) => { const o = await c.env.ART.get("mainnet/unrevealed.gif"); return o ? c.body(o.body, 200, { "content-type": "image/gif", ...CORS, "cache-control": "public, max-age=86400" }) : c.text("not found", 404); });
app.get("/collection", (c) => c.json(mainnet.collection(c.env.PUBLIC_ORIGIN), 200, { ...CORS, "cache-control": "public, max-age=3600" }));
app.get("/d/:id", async (c, next) => {
  if (onTestnet(c)) return next();
  const r = await mainnet.reveal(c.env, mid(c));
  if (r.unavailable) return c.json({ error: "the chain didn't answer — try again", why: r.unavailable }, 503, { ...CORS, "retry-after": "5", "cache-control": "no-store" });
  if (!r.exists) return c.json({ error: "no such daemon" }, 404, CORS);
  return c.json(mainnet.metadata(c.env.PUBLIC_ORIGIN, mid(c), r), 200, { ...CORS, "cache-control": r.sold ? "public, max-age=3600" : "public, max-age=60" });
});
app.get("/d/:id/image.gif", async (c, next) => {
  if (onTestnet(c)) return next();
  const r = await mainnet.reveal(c.env, mid(c), { fresh: c.req.query("fresh") === "1" });   // the buyer's own reveal, now
  if (r.unavailable) return c.json({ error: "the chain didn't answer — try again", why: r.unavailable }, 503, { ...CORS, "retry-after": "5", "cache-control": "no-store" });
  if (!r.exists) return c.text("no such daemon", 404);
  const o = await c.env.ART.get(r.image);
  if (!o) return c.text("art not uploaded yet", 404);
  return c.body(o.body, 200, { "content-type": "image/gif", ...CORS, "cache-control": r.sold ? "public, max-age=86400" : "public, max-age=60" });
});
app.get("/api/daemon/:id/os", async (c, next) => {
  if (onTestnet(c)) return next();
  const r = await mainnet.reveal(c.env, mid(c));
  if (r.unavailable) return c.json({ error: "the chain didn't answer — try again", why: r.unavailable }, 503, { ...CORS, "retry-after": "5", "cache-control": "no-store" });
  if (!r.exists) return c.json({ error: "no such daemon" }, 404, CORS);
  return c.json(await mainnet.osData(c.env, mid(c), r), 200, { ...CORS, "cache-control": "public, max-age=15" });
});
for (const [path, start] of [["/d/:id/view", "spin"], ["/d/:id/os", "wallet"]]) {
  app.get(path, async (c, next) => {
    if (onTestnet(c)) return next();
    if (mid(c) < 0 || mid(c) >= mainnet.M.supply) return c.text("no such daemon", 404);
    return c.html(osHtml(c.env.PUBLIC_ORIGIN, mid(c), { start, gif: true }));
  });
}
const osOf = async (env, id) => osView(env, +id, { doData: await daemon(env, id).osData() });
const CORS = { "access-control-allow-origin": "*" };
app.get("/api/daemon/:id/os", async (c) => {
  if (!known(c.req.param("id"))) return c.json({ error: "no such daemon here" }, 404);
  return c.json(await osOf(c.env, c.req.param("id")), 200, { ...CORS, "cache-control": "public, max-age=15" });
});
app.get("/d/:id/view", async (c) => {
  if (!known(c.req.param("id"))) return c.text("no such daemon here", 404);
  const gif = await c.env.ART.head(`gif/${c.req.param("id")}.gif`);
  return c.html(viewHtml(originOf(c), +c.req.param("id"), !!gif), 200, { "cache-control": "public, max-age=300" });
});
app.get("/d/:id/os", async (c) => {
  if (!known(c.req.param("id"))) return c.text("no such daemon here", 404);
  const gif = await c.env.ART.head(`gif/${c.req.param("id")}.gif`);
  return c.html(osHtml(originOf(c), +c.req.param("id"), { start: "wallet", gif: !!gif }));
});
app.get("/d/:id/image.svg", async (c) => {
  if (!known(c.req.param("id"))) return c.text("no such daemon here", 404);
  const d = await daemon(c.env, c.req.param("id")).osData().catch(() => null);
  return c.body(imageSvg(+c.req.param("id"), d && { skills: d.skills.length, strategies: d.strategies.length, version: d.version }), 200, { "content-type": "image/svg+xml", ...CORS, "cache-control": "public, max-age=300" });
});
app.get("/d/:id/image.gif", async (c) => {
  if (!known(c.req.param("id"))) return c.text("no such daemon here", 404);
  const o = await c.env.ART.get(`gif/${c.req.param("id")}.gif`);
  if (!o) return c.redirect(`/d/${c.req.param("id")}/image.svg`, 302);   // not uploaded yet: the placeholder
  return c.body(o.body, 200, { "content-type": "image/gif", ...CORS, "cache-control": "public, max-age=86400", etag: o.httpEtag });
});
app.get("/d/:id", async (c) => {
  if (!known(c.req.param("id"))) return c.json({ error: "no such daemon here" }, 404);
  const id = +c.req.param("id");
  const [d, gif] = await Promise.all([daemon(c.env, c.req.param("id")).osData(), c.env.ART.head(`gif/${id}.gif`)]);
  return c.json(metadataOf(originOf(c), d, { art: traitsOf(ART_TRAITS, id), gif: !!gif }), 200, { ...CORS, "cache-control": "public, max-age=300" });
});

// think bills (milestone 15): a closed day's metered model calls, payable over x402 to the treasury — at cost, no fee
const TREASURY = parseAbi(["function treasury() view returns (address)"]);
let treasuryAddr = null;
app.get("/think-bill/:id/:day", async (c) => {
  const { id, day: iso } = c.req.param(), day = dayFromIso(iso);
  if (!known(id) || day == null) return c.json({ error: "no such bill" }, 404);
  const d = daemon(c.env, id), b = await d.bill(day);
  if (b.paid) return c.json({ daemon: +id, day: iso, owed: (b.micro / 1e6).toFixed(6), paid: true, tx: b.tx });
  if (b.open) return c.json({ daemon: +id, day: iso, open: true, why: "the day isn't over — billed after midnight UTC" }, 404);
  if (!b.micro) return c.json({ daemon: +id, day: iso, owed: "0", why: "nothing was metered that day" }, 404);
  treasuryAddr ??= await pub(c.env).readContract({ address: D.sale, abi: TREASURY, functionName: "treasury" });
  const req = { scheme: "exact", network: NETWORK, asset: D.dollar, amount: String(b.micro), payTo: treasuryAddr, maxTimeoutSeconds: 60, extra: { name: "Global Dollar (test)", version: "1" } };
  const required = { x402Version: 2, error: "payment required", resource: { url: `${c.env.PUBLIC_ORIGIN}/think-bill/${id}/${iso}`, description: `Daemon #${id}'s model calls on ${iso}, at cost`, mimeType: "application/json" }, accepts: [req] };
  const header = c.req.header("payment-signature");
  if (!header) return c.json(required, 402, { "PAYMENT-REQUIRED": b64(required) });
  const payload = unb64(header);
  const v = await verify(c.env, payload, req);
  if (!v.isValid) return c.json({ ...required, error: v.invalidReason }, 402, { "PAYMENT-REQUIRED": b64({ ...required, error: v.invalidReason }) });
  const s = await settle(c.env, payload, req);
  await d.billPaid(day, b.micro, s);
  return c.json({ result: { paid: s.success, day: iso, amount: (b.micro / 1e6).toFixed(6) }, settlement: s }, s.success ? 200 : 502, { "PAYMENT-RESPONSE": b64(s) });
});

app.get("/d/:id/:skill", async (c) => {
  const { id, skill } = c.req.param();
  const sk = await daemon(c.env, id).skill(skill); // the repo's head, not the build
  if (!sk) return c.json({ error: "no such skill" }, 404);
  const req = await requirement(c.env, id, sk);
  const required = { x402Version: 2, error: "payment required", resource: { url: `${c.env.PUBLIC_ORIGIN}/d/${id}/${skill}`, description: sk.description, mimeType: "application/json" }, accepts: [req] };
  const header = c.req.header("payment-signature");
  if (!header) return c.json(required, 402, { "PAYMENT-REQUIRED": b64(required) });
  const payload = unb64(header);
  const v = await verify(c.env, payload, req);
  if (!v.isValid) return c.json({ ...required, error: v.invalidReason }, 402, { "PAYMENT-REQUIRED": b64({ ...required, error: v.invalidReason }) });
  const seller = daemon(c.env, id);
  const result = await seller.runSkill(skill, {});
  const s = await settle(c.env, payload, req);
  await seller.recordSale(skill, { ...s, amount: req.amount });
  return c.json({ result: result.output, settlement: s }, s.success ? 200 : 502, { "PAYMENT-RESPONSE": b64(s) });
});

app.post("/facilitator/verify", async (c) => {
  const { paymentPayload, paymentRequirements } = await c.req.json();
  return c.json(await verify(c.env, paymentPayload, paymentRequirements));
});
app.post("/facilitator/settle", async (c) => {
  const { paymentPayload, paymentRequirements } = await c.req.json();
  const v = await verify(c.env, paymentPayload, paymentRequirements);
  if (!v.isValid) return c.json({ success: false, errorReason: v.invalidReason }, 400);
  return c.json(await settle(c.env, paymentPayload, paymentRequirements));
});
app.get("/facilitator/supported", (c) => c.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:46630", asset: D.dollar }] }));

app.post("/admin/boot", async (c) => {
  if (c.req.header("authorization") !== `Bearer ${c.env.ADMIN_KEY}`) return c.json({ error: "no" }, 401);
  return c.json(await Promise.all(IDS.map((id) => daemon(c.env, id).boot(id))));
});

// reflect now (admin; proofs) — { model } stands in for the model's answer, so the refusal paths can be shown live
app.post("/admin/reflect/:id", async (c) => {
  if (c.req.header("authorization") !== `Bearer ${c.env.ADMIN_KEY}`) return c.json({ error: "no" }, 401);
  const body = await c.req.json().catch(() => ({}));
  return c.json(await daemon(c.env, c.req.param("id")).reflect({ force: true, model: typeof body.model === "string" ? body.model : null }));
});

app.post("/admin/mirror", async (c) => {
  if (c.req.header("authorization") !== `Bearer ${c.env.ADMIN_KEY}`) return c.json({ error: "no" }, 401);
  return c.json(await clock(c.env).kick(c.req.query("now") === "1"));   // starts the Clock's 10-minute alarm if it isn't running
});
app.get("/api/mirror", async (c) => c.json({ feeds: FEEDS, ...(await clock(c.env).status()) }));

app.post("/admin/run/:id", async (c) => {
  if (c.req.header("authorization") !== `Bearer ${c.env.ADMIN_KEY}`) return c.json({ error: "no" }, 401);
  return c.json(await daemon(c.env, c.req.param("id")).runSoon(c.req.query("strategy") ?? "*"));
});

// the testnet price mirror runs on the cron (Chainlink's RHC-mainnet rounds → MirrorFeed), every round in order
export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) { ctx.waitUntil(clock(env).kick()); ctx.waitUntil(env.SALES.get(env.SALES.idFromName("mainnet")).kick()); },   // a second kick; the Clock's alarm is the schedule
};
