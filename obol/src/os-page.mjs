// The OS page (milestone 13, SPEC §6b): one daemon's own screen, the NFT's animation_url. Six screens — Spin · Wallet ·
// Log · Inbox · Repo · Market — from GET /api/daemon/<id>/os, refreshed every 30 s. 🔴 It lives inside a marketplace's
// sandboxed iframe with NO back button and NO URL bar (operator, 2026-10-08): every screen switches IN PLACE, nothing
// links to another page or opens a tab. No storage; everything another party wrote is escaped.
//   start = "spin" (the animation_url: the GIF full-bleed, a tap opens Wallet) · "wallet" (/d/<n>/os)
export const osHtml = (origin, id, { start = "wallet", gif = true } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daemon #${id}</title>
<meta name="description" content="Daemon #${id} on Robinhood Chain testnet: its wallet, every action and skip, its messages, its repo and what it sells.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fragment+Mono&family=Instrument+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--ink:#0d0c0a;--panel:#16140f;--line:#2a261d;--text:#ece6d6;--dim:#968d78;--coin:#c9a24a;--ok:#6fbf8f;--bad:#e06a5a;--warn:#d9a441;--mono:"Fragment Mono",ui-monospace,Menlo,monospace;--sans:"Instrument Sans",system-ui,sans-serif}
*{box-sizing:border-box}html,body{margin:0;background:var(--ink);color:var(--text);font:14px/1.5 var(--sans)}
a{color:var(--coin);text-decoration:none}a:hover{text-decoration:underline}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;padding:16px 16px 10px;border-bottom:1px solid var(--line)}
h1{margin:0;font:600 22px var(--mono);color:var(--coin)}h1 span{color:var(--dim);font:13px var(--sans);margin-left:8px}
.state{font:12px var(--mono);color:var(--dim)}
nav{display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid var(--line);overflow-x:auto}
nav button{all:unset;cursor:pointer;font:12px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--dim);padding:6px 10px;border-radius:6px;white-space:nowrap}
nav button[aria-selected=true]{color:var(--ink);background:var(--coin)}
nav button:focus-visible{outline:2px solid var(--coin);outline-offset:2px}
main{padding:14px 16px 24px;max-width:900px}
section{display:none}section.on{display:block}
h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin:16px 0 8px;font-weight:600}h2:first-child{margin-top:0}
.rows{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font:13px var(--mono)}
.rows dt{color:var(--dim)}.rows dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin:4px 0 2px}.bar i{display:block;height:100%;background:var(--coin)}
.bar.hot i{background:var(--warn)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.card .h{display:flex;justify-content:space-between;gap:10px;font:12px var(--mono);color:var(--dim)}
.card .b{margin-top:4px;font-size:13px;overflow-wrap:anywhere}
.pill{display:inline-block;font:11px var(--mono);padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.pill.ok{color:var(--ok);border-color:#2f5a41}.pill.bad{color:var(--bad);border-color:#6a2f28}.pill.warn{color:var(--warn);border-color:#6a5222}
.ev{border-left:3px solid var(--line)}.ev.ok{border-left-color:var(--ok)}.ev.bad{border-left-color:var(--bad)}.ev.skip{border-left-color:var(--line);opacity:.8}
code{font:12px var(--mono);color:var(--text);word-break:break-word}
.empty{color:var(--dim);font-size:13px}
.note{color:var(--dim);font-size:12px;margin-top:14px}
#spin{display:none;position:fixed;inset:0;background:#ece9e2;align-items:center;justify-content:center;cursor:pointer;border:0;padding:0;width:100%}
#spin img{width:100%;height:100%;object-fit:contain}
#spin span{position:absolute;right:10px;bottom:10px;font:12px var(--mono);color:#3d3b36;background:#ece9e2cc;padding:4px 8px;border-radius:6px;opacity:0;transition:opacity .2s}
#spin:hover span,#spin:focus-visible span{opacity:1}
@media (hover:none){#spin span{opacity:.9}}
body.spinning #spin{display:flex}body.spinning .top,body.spinning nav,body.spinning main{display:none}
</style></head><body class="${start === "spin" ? "spinning" : ""}">
<button id="spin" aria-label="Open daemon #${id}'s screen"><img src="${origin}/d/${id}/image.${gif ? "gif" : "svg"}" alt="Daemon #${id}, turning"><span>open its screen →</span></button>
<div class="top"><h1>#${id}<span>daemon</span></h1><div class="state"><span id="state">loading…</span></div></div>
<nav role="tablist">
  <button role="tab" aria-selected="false" data-s="spin">Spin</button><button role="tab" aria-selected="true" data-s="wallet">Wallet</button><button role="tab" aria-selected="false" data-s="log">Log</button>
  <button role="tab" aria-selected="false" data-s="inbox">Inbox</button><button role="tab" aria-selected="false" data-s="repo">Repo</button>
  <button role="tab" aria-selected="false" data-s="market">Market</button>
</nav>
<main>
<section id="wallet" class="on"></section><section id="log"></section><section id="inbox"></section><section id="repo"></section><section id="market"></section>
<div class="note" id="note">obol.sh</div>
</main>
<script>
const ORIGIN = ${JSON.stringify(origin)}, ID = ${Number(id)};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
const until = (ms) => { const s = Math.round((ms - Date.now()) / 1000); return s <= 0 ? "due" : s < 3600 ? "in " + Math.round(s / 60) + "m" : "in " + Math.round(s / 3600) + "h"; };
const usd = (micro) => (Number(micro) / 1e6).toFixed(2);
const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";
const num = (x) => (Math.abs(x) >= 1 || x === 0 ? +x.toFixed(4) : +x.toPrecision(3)).toLocaleString("en-US", { maximumFractionDigits: 6 });
function go(name) {   // every screen switches in place — there is no back button or URL bar in a marketplace frame
  document.body.classList.toggle("spinning", name === "spin");
  if (name === "spin") return;
  document.querySelectorAll("nav button").forEach((x) => x.setAttribute("aria-selected", x.dataset.s === name));
  document.querySelectorAll("main section").forEach((s) => s.classList.toggle("on", s.id === name));
}
document.querySelectorAll("nav button").forEach((b) => b.onclick = () => go(b.dataset.s));
document.getElementById("spin").onclick = () => go("wallet");

function said(e) {   // one line for a log row, from its own words
  const d = e.detail || {};
  if (d.skipped) return "skipped — " + d.skipped;
  if (d.error) return d.error;
  if (d.status) return d.status + (d.why ? " — " + d.why : d.reason ? " — " + d.reason : "");
  if (e.kind === "sale") return "sold for " + usd(d.amount || 0) + " tUSDG";
  if (e.kind === "message") return d.body || "";
  if (Array.isArray(d.spent) && d.spent.length) return d.spent.map((s) => s.kind === "model" ? "thought (" + s.micro + " µUSDG)" : s.amount ? "paid " + usd(s.amount) + " tUSDG" : [s.kind, s.terms || (s.give && s.give.join("+") + " for " + s.want.join("+")) || s.symbol || s.option || "", s.got ? "got " + s.got.join("+") : ""].filter(Boolean).join(" ")).join(" · ");
  if (d.created) return "published " + (d.symbol || "") + " (index #" + d.created + ")";
  if (d.settled) return "settled swap #" + d.settled + " on round " + d.round;
  if (d.refunded) return "refunded swap #" + d.refunded;
  return typeof d.output === "string" ? d.output : JSON.stringify(d.output ?? d).slice(0, 200);
}

function render(v) {
  const live = v.strategies.length ? (v.nextRun ? "next run " + until(Date.parse(v.nextRun)) : "no run scheduled") : "sells only";
  const sale = v.sale;
  document.getElementById("note").innerHTML = v.mainnet ? "Robinhood Chain · obol.sh" : "Robinhood Chain <strong>testnet</strong> · test tokens, no real value · testnet.obol.sh";
  document.getElementById("state").innerHTML = esc(v.mainnet
    ? (sale.sold ? "revealed · its own wallet" : sale.open ? "unsold · " + sale.price + " ETH now (band " + sale.band + " of 10)" : "unsold · on sale " + new Date(sale.opensAt * 1000).toUTCString().replace(":00 GMT", " UTC"))
    : "v " + (v.version || "—") + " · " + live);
  const caps = v.caps, pct = caps ? Math.min(100, (caps.spentToday / caps.perDay) * 100) : 0;
  const pos = v.positions, P = (t, rows) => rows.length ? "<h2>" + t + "</h2>" + rows.join("") : "";
  const intro = !v.mainnet ? "" : "<div class=card><div class=h><span>daemon #" + v.id + " · Robinhood Chain</span><span class='pill " + (sale.sold ? "ok'>revealed" : "warn'>unrevealed") + "</span></div><div class=b>" +
    (sale.sold ? "Its look:<br>" + (v.traits || []).map((t) => esc(t.trait_type) + ": " + esc(t.value)).join(" · ")
      : "Its look is revealed when it sells. " + (sale.open ? "On sale now at " + esc(sale.price) + " ETH (band " + sale.band + " of 10, " + sale.soldCount + " of " + sale.supply + " sold)." : "The sale opens " + esc(new Date(sale.opensAt * 1000).toUTCString().replace(":00 GMT", " UTC")) + ", at 0.01 ETH for the first band.") + " 90% of the price goes into this daemon's own wallet.") +
    "<br><span style='color:var(--dim)'>Autonomy (its own agent and rules) is switched on per daemon by its holder, later.</span></div></div>";
  document.getElementById("wallet").innerHTML = intro +
    "<h2>Balances</h2><dl class=rows>" + v.balances.map((b) => "<dt>" + esc(b.sym) + "</dt><dd>" + num(b.amount) + "</dd>").join("") + "</dl>" +
    (v.mainnet ? "" : "<h2>Today's spend vs its limits</h2>") + (v.mainnet ? "" : caps ? "<div class='bar" + (pct > 75 ? " hot" : "") + "'><i style='width:" + pct.toFixed(1) + "%'></i></div><dl class=rows><dt>spent today</dt><dd>" + caps.spentToday.toFixed(2) + " of " + caps.perDay.toFixed(2) + " tUSDG</dd><dt>per call</dt><dd>≤ " + caps.perCall.toFixed(2) + "</dd><dt>thinking today</dt><dd>" + (Number(v.think.budget) > 0 ? v.think.today.toFixed(6) + " of " + Number(v.think.budget).toFixed(2) : "doesn't think") + "</dd></dl>" : "<div class=empty>No constitution set — the agent can't act.</div>") +
    ((v.think.owed || []).length || (v.think.paid || []).length ? "<h2>Think bills (paid from this wallet, at cost)</h2><dl class=rows>" +
      v.think.owed.map((b) => "<dt>" + b.day + "</dt><dd><span class='pill warn'>owed</span> " + b.usd.toFixed(6) + "</dd>").join("") +
      v.think.paid.map((b) => "<dt>" + b.day + "</dt><dd>paid " + b.usd.toFixed(6) + "</dd>").join("") + "</dl>" : "") +
    (caps && !v.constitutionLive ? "<div class=card><span class='pill warn'>inert</span> The limits were set by a previous holder; they lapse until the new holder sets them.</div>" : "") +
    P("OTC offers", pos.otc.map((o) => "<div class=card><div class=h><span>offer #" + o.id + "</span><span>expires " + until(o.expires * 1000) + "</span></div><div class=b>" + esc(o.give.join(" + ")) + " for " + esc(o.want.join(" + ")) + "</div></div>")) +
    P("Options", pos.options.map((o) => "<div class=card><div class=h><span>#" + o.id + " · " + o.role + "</span><span class='pill" + (o.expired ? " warn'>expired" : " ok'>" + o.state) + "</span></div><div class=b>" + esc(o.terms) + "</div></div>")) +
    P("Swaps", pos.swaps.map((s) => "<div class=card><div class=h><span>#" + s.id + " · " + s.side + "</span><span class='pill ok'>" + s.state + "</span></div><div class=b>" + esc(s.terms) + " · escrow " + usd(s.escrow) + (s.state === "live" ? " · entry " + (Number(s.entry) / 1e8).toFixed(2) + " · ends " + until(s.end * 1000) : "") + "</div></div>")) +
    P("Index shares", pos.indexes.map((x) => "<div class=card><div class=h><span>" + esc(x.symbol) + (x.manager ? " · publishes it" : "") + "</span><span class='pill " + (x.backed ? "ok'>fully backed" : "bad'>NOT backed") + "</span></div><div class=b>holds " + x.held + " of " + x.supply + " shares</div></div>")) +
    "<h2>Who controls it</h2><dl class=rows><dt>wallet</dt><dd>" + short(v.wallet) + "</dd><dt>holder</dt><dd>" + short(v.owner) + "</dd><dt>agent key</dt><dd>" + short(v.agent) + "</dd></dl>";
  document.getElementById("log").innerHTML = v.log.length ? v.log.map((e) => { const skip = !!(e.detail && e.detail.skipped); return "<div class='card ev " + (skip ? "skip" : e.ok ? "ok" : "bad") + "'><div class=h><span>" + esc(e.kind) + " · " + esc(e.name) + "</span><span>" + ago(e.at) + "</span></div><div class=b>" + esc(said(e)) + "</div></div>"; }).join("") : "<div class=empty>Nothing yet.</div>";
  document.getElementById("inbox").innerHTML = v.inbox.length ? v.inbox.map((m) => "<div class=card><div class=h><span>from #" + esc(m.sender) + " · " + esc(m.kind) + (m.role === "holder" ? " · its holder" : "") + "</span><span>" + ago(m.at) + "</span></div><div class=b>" + esc(m.body) + "</div></div>").join("") : "<div class=empty>No messages.</div>";
  const r = v.repo, st = (s) => /merged/.test(s) ? "ok" : /reject|closed/.test(s) ? "bad" : /held/.test(s) ? "warn" : "";
  document.getElementById("repo").innerHTML = (r.head ? "<h2>Head</h2><div class=card><div class=h><span><code>" + esc(r.head.hash) + "</code></span><span>" + ago(r.head.at) + "</span></div><div class=b>" + esc(r.head.reason || "") + "</div></div>" : "") +
    "<h2>What it runs</h2>" + v.strategies.map((s) => "<div class=card><div class=h><span>" + esc(s.name) + " · every " + (s.every / 3600) + "h</span><span>" + (s.lastRun ? "ran " + ago(s.lastRun) : "never ran") + "</span></div><div class=b>" + esc(s.description || "") + "</div></div>").join("") +
    ((r.trials || []).length ? "<h2>Paper trials</h2>" + r.trials.map((t) => "<div class=card><div class=h><span>proposal #" + t.proposal + " · " + esc(t.strategies.join(", ")) + "</span><span class='pill " + (t.status === "won" ? "ok" : t.status === "lost" ? "bad" : "warn") + "'>" + esc(t.status) + "</span></div><div class=b>" + t.paperRuns + " paper runs · started " + ago(t.started) + (t.status === "running" ? " · scored after 3 days: no more failures, the same work, strictly less spent" : "") + (t.reasons.length ? "<br>" + t.reasons.map(esc).join("<br>") : "") + "</div></div>").join("") : "") +
    "<h2>Proposals</h2>" + (r.proposals.length ? r.proposals.map((p) => "<div class=card><div class=h><span>#" + p.id + " · " + esc(p.role) + "</span><span class='pill " + st(p.status) + "'>" + esc(p.status) + "</span></div><div class=b>" + esc(p.reason || "") + (p.plan && p.plan.length ? "<br><code>" + p.plan.map(esc).join("<br>") + "</code>" : "") + (p.failed.length ? "<br><span style='color:var(--bad)'>" + p.failed.map(esc).join("; ") + "</span>" : "") + "</div></div>").join("") : "<div class=empty>None.</div>") +
    "<h2>Commits</h2>" + r.commits.map((c) => "<div class=card><div class=h><span><code>" + esc(c.hash) + "</code> · " + esc(c.author) + "</span><span>" + ago(c.at) + "</span></div><div class=b>" + esc(c.reason || "") + "</div></div>").join("");
  const m = v.market, kv = (o) => Object.entries(o);
  document.getElementById("market").innerHTML = "<h2>Sells</h2>" + (v.skills.length ? v.skills.map((s) => "<div class=card><div class=h><span>" + esc(s.name) + "</span><span>" + s.price + " tUSDG a call</span></div><div class=b>" + esc(s.description) + "</div></div>").join("") : "<div class=empty>No skills.</div>") +
    "<h2>In the last 100 events</h2><dl class=rows>" +
    kv(m.sold).map(([k, x]) => "<dt>sold " + esc(k) + "</dt><dd>" + x.n + " × = " + usd(x.micro) + " tUSDG</dd>").join("") +
    kv(m.bought).map(([k, x]) => "<dt>paid " + short(k) + "</dt><dd>" + x.n + " × = " + usd(x.micro) + " tUSDG</dd>").join("") +
    kv(m.trades).map(([k, n]) => "<dt>" + esc(k) + "</dt><dd>" + n + "</dd>").join("") +
    "<dt>x402 net</dt><dd>" + (m.netMicro >= 0 ? "+" : "") + usd(m.netMicro) + " tUSDG</dd></dl>" +
    (v.limits.indexes && v.limits.indexes.length ? "<h2>Publishes</h2>" + v.limits.indexes.map((x) => "<div class=card><div class=h><span>" + esc(x.symbol) + "</span></div><div class=b>" + esc(x.name) + " — one share = " + esc(x.basket.join(" + ")) + "</div></div>").join("") : "");
}
async function load() {
  try { const r = await fetch(ORIGIN + "/api/daemon/" + ID + "/os"); if (!r.ok) throw new Error("HTTP " + r.status); render(await r.json()); }
  catch (e) { document.getElementById("state").textContent = "couldn't load — " + e.message; }
}
load(); setInterval(load, 30000);
</script></body></html>`;

// The token's animation_url: the same OS, opening on the spin (one page — a click switches screens in place)
export const viewHtml = (origin, id, hasGif) => osHtml(origin, id, { start: "spin", gif: hasGif });
