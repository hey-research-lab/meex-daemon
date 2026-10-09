// obol.sh — the Daemon collection's front page and its buy flow (mainnet, from 2026-10-08; the sale opens at `opensAt`).
// Minimal by design (operator, 2026-10-08: "lean into the minimal motif"): the art's warm grey ground, ink, mono labels,
// hairlines, and ONE accent — a muted phosphor green, used only for live signals (the dot, an available number, the
// clock). One theme on purpose: a GIF's ground can't follow a dark mode.
// Buying: an injected wallet (MetaMask, Zerion, Coinbase Wallet…) on Robinhood Chain sends buy(n) at the price read from
// the chain the moment before sending (a band can change between a page load and a transaction).
const FAVICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="4" width="26" height="21" rx="3" fill="#1a1a1d"/><rect x="6.5" y="7.5" width="19" height="14" rx="1.5" fill="#3b9a5c"/><rect x="12" y="26" width="8" height="3" fill="#1a1a1d"/></svg>');

export const homeHtml = (origin, M, { gsv = null } = {}) => {
  const opens = new Date(M.opensAt * 1000).toUTCString().replace(":00 GMT", " UTC");
  const bands = Array.from({ length: 10 }, (_, i) => 0.01 * 1.3 ** i);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daemon</title>
<meta name="description" content="10,048 agents on Robinhood Chain, each an NFT with its own wallet. 90% of every sale goes into the daemon's own wallet. Each look is revealed when it sells.">
<meta property="og:title" content="Daemon"><meta property="og:description" content="10,048 agents on Robinhood Chain, each with its own wallet. Sale opens ${opens}.">
<meta property="og:image" content="${origin}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Daemon — a figure with a CRT monitor for a head; 10,048 agents on Robinhood Chain">
<meta property="og:url" content="${origin}/"><meta property="og:type" content="website"><meta property="og:site_name" content="obol.sh"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${origin}/og.png">
${gsv ? `<meta name="google-site-verification" content="${gsv}">` : ""}<link rel="canonical" href="${origin}/"><link rel="icon" href="${FAVICON}"><meta name="theme-color" content="#ece9e2">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fragment+Mono&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--ground:#ece9e2;--hair:#d6d1c6;--ink:#1a1a1d;--soft:#4a4740;--dim:#8a8478;--live:#2f7d4a;--bad:#9b3a2c;
  --mono:"Fragment Mono",ui-monospace,Menlo,monospace;--sans:"Instrument Sans",system-ui,sans-serif}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
html,body{margin:0;background:var(--ground);color:var(--ink);font:400 16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
::selection{background:var(--ink);color:var(--ground)}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:3px}a:hover{text-decoration-color:var(--ink)}
:focus-visible{outline:1.5px solid var(--ink);outline-offset:3px;border-radius:2px}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.label{font:400 11px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.mono{font-family:var(--mono)}

/* top bar */
.bar{display:flex;justify-content:space-between;align-items:center;padding:18px 0;border-bottom:1px solid var(--hair)}
.bar .mark{font:500 14px var(--mono);letter-spacing:.02em}
.live{display:inline-flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--dim)}.dot.on{background:var(--live);box-shadow:0 0 0 3px #2f7d4a22}

/* hero */
.hero{display:grid;grid-template-columns:1.05fr 1fr;gap:48px;align-items:center;padding:40px 0 48px}
@media (max-width:820px){.hero{grid-template-columns:1fr;gap:12px;padding:20px 0 36px}}
.spin{width:100%;height:auto;max-width:520px;aspect-ratio:1;display:block;justify-self:center}
@media (max-width:820px){.spin{max-width:min(210px,52vw)}h1{margin-bottom:12px}.lede{font-size:17px;margin-bottom:20px}}
h1{font:600 clamp(52px,9vw,92px)/.9 var(--sans);letter-spacing:-.035em;margin:0 0 18px}
.lede{font-size:19px;line-height:1.5;color:var(--soft);max-width:30ch;margin:0 0 28px;text-wrap:balance}
.figs{display:grid;grid-template-columns:repeat(3,minmax(0,auto));gap:0;justify-content:start;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);margin-bottom:24px}
.figs div{padding:12px 28px 12px 0}.figs div+div{padding-left:28px;border-left:1px solid var(--hair)}
.figs b{display:block;font:500 24px/1.2 var(--mono);font-variant-numeric:tabular-nums;margin-top:4px}
.clock{font:500 15px var(--mono);font-variant-numeric:tabular-nums;color:var(--live)}

/* buy: one line */
.buy{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.field{display:flex;flex-direction:column;gap:6px}
.field input{font:500 26px/1 var(--mono);width:5.2ch;border:0;border-bottom:1.5px solid var(--ink);border-radius:0;background:transparent;color:var(--ink);padding:4px 0;font-variant-numeric:tabular-nums}
.field input::placeholder{color:var(--hair)}.field input:focus{outline:none;border-bottom-color:var(--live)}
.txt{font:400 14px var(--mono);background:none;border:0;color:var(--soft);cursor:pointer;padding:8px 2px;text-decoration:underline;text-decoration-color:var(--hair);text-underline-offset:4px}
.txt:hover{color:var(--ink);text-decoration-color:var(--ink)}
.go{font:600 15px var(--sans);background:var(--ink);color:var(--ground);border:0;border-radius:999px;padding:12px 26px;cursor:pointer;transition:transform .15s}
.go:hover:not(:disabled){transform:translateY(-1px)}.go:disabled{background:var(--hair);color:var(--dim);cursor:not-allowed}
@media (prefers-reduced-motion:reduce){.go{transition:none}.go:hover:not(:disabled){transform:none}}
#msg{font:400 13px/1.5 var(--mono);color:var(--soft);margin-top:10px;min-height:20px;overflow-wrap:anywhere}#msg.bad{color:var(--bad)}#msg.ok{color:var(--live)}
#avail{font:400 12px var(--mono);color:var(--dim);min-height:18px;margin-top:10px}#avail.ok{color:var(--live)}
#mine{display:none;margin-top:16px;gap:16px;align-items:center}#mine img{width:112px;height:112px}

/* the live sale feed */
.feed{border-top:1px solid var(--hair);padding:22px 0 26px}
.feed-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:18px 14px}
.tile{display:flex;flex-direction:column;gap:4px;text-decoration:none}.tile img{width:100%;aspect-ratio:1;display:block}
.tile b{font:500 14px var(--mono)}.tile span{font:400 11px/1.4 var(--mono);color:var(--dim)}
.tile.new b{color:var(--live)}
#feedempty{font:400 13px var(--mono);color:var(--dim)}

/* rows */
.rows{border-top:1px solid var(--hair)}
.row{display:grid;grid-template-columns:200px 1fr;gap:24px;padding:26px 0;border-bottom:1px solid var(--hair)}
@media (max-width:700px){.row{grid-template-columns:1fr;gap:8px;padding:22px 0}}
.row p{margin:0 0 10px;max-width:62ch;color:var(--soft)}.row p:last-child{margin-bottom:0}.row strong{color:var(--ink);font-weight:500}

/* the band ladder: ten bars to scale, ×1.3 each */
.ladder{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;align-items:end;height:120px;max-width:560px;margin:22px 0 8px}
.ladder i{display:block;border:1px solid var(--ink);border-bottom-width:1.5px;background:transparent;position:relative}
.ladder i.past{background:var(--hair);border-color:var(--hair)}.ladder i.now{background:var(--ink)}
.ladder i span{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);font:400 10px var(--mono);color:var(--dim);white-space:nowrap;font-style:normal}
.ladder-x{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;max-width:560px;font:400 10px var(--mono);color:var(--dim);text-align:center}

/* hashes and addresses */
.kv{display:grid;grid-template-columns:auto 1fr auto;gap:10px 16px;align-items:baseline;font:400 13px var(--mono)}
.kv .k{color:var(--dim)}.kv .v{overflow-wrap:anywhere;color:var(--ink)}
.copy{font:400 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;background:none;border:0;color:var(--dim);cursor:pointer;padding:2px 0}.copy:hover{color:var(--ink)}
@media (max-width:560px){.kv{grid-template-columns:1fr auto}.kv .k{grid-column:1 / -1;margin-top:6px}}

footer{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:24px 0 44px;font:400 12px var(--mono);color:var(--dim)}
footer nav{display:flex;gap:18px;flex-wrap:wrap}footer a{text-decoration:none}footer a:hover{color:var(--ink)}
</style></head><body>
<div class="wrap">
<div class="bar"><span class="mark">obol.sh <a href="/docs" style="margin-left:14px;color:var(--dim);text-decoration:none;font-weight:400">docs</a></span><span class="label live"><i class="dot" id="dot"></i><span id="livetxt">Robinhood Chain</span></span></div>

<section class="hero">
  <img class="spin" src="${origin}/unrevealed.gif" alt="An unrevealed daemon turning: a figure in a hoodie with a CRT monitor for a head" width="520" height="520">
  <div>
    <h1>Daemon</h1>
    <p class="lede">10,048 agents on Robinhood Chain. Each one an NFT with its own wallet — and 90% of what you pay goes into it.</p>
    <div class="figs">
      <div><span class="label">Price · ETH</span><b id="price">0.01</b></div>
      <div><span class="label">Band</span><b id="band">1/10</b></div>
      <div><span class="label">Sold</span><b id="sold">0</b></div>
    </div>
    <div class="buy">
      <label class="field"><span class="label">Daemon №</span><input id="n" inputmode="numeric" maxlength="5" placeholder="212" autocomplete="off" aria-describedby="avail msg"></label>
      <button class="txt" id="any" type="button">any unsold</button>
      <button class="go" id="go" type="button">Buy</button>
    </div>
    <div id="avail" aria-live="polite"></div>
    <div id="msg" role="status">loading…</div>
    <div id="mine"><img id="mineimg" alt="Your daemon"><div id="minetxt" class="mono"></div></div>
  </div>
</section>

<section class="feed" aria-live="polite"><div class="feed-head"><span class="label">Sold · live</span><span class="label" id="feedcount"></span></div>
  <div class="tiles" id="tiles"></div><div id="feedempty">Nothing sold yet.</div></section>

<div class="rows">
  <div class="row"><span class="label">The daemon</span><div>
    <p><strong>Its own wallet.</strong> Every daemon has an on-chain wallet (ERC-6551) that follows the NFT. 90% of the price is paid into it in the same transaction; 10% to SHYGUY LLC. The sale contract holds nothing between purchases.</p>
    <p><strong>Its look, revealed when it sells.</strong> Top, colours, shoes, casing, phosphor, face, hat — fixed and committed before the mint. Until a number sells it shows the same unrevealed spin, so nobody can pick the rare ones.</p>
    <p><strong>Its screen.</strong> Wallet, log, inbox, repo, market — live. Autonomy, its own agent and rules, is switched on per daemon by its holder, later.</p>
  </div></div>
  <div class="row"><span class="label">Price</span><div>
    <div class="ladder" id="ladder" role="img" aria-label="Ten price bands, each 1.3 times the one before, from 0.01 to 0.106 ETH">${bands.map((p, i) => `<i data-b="${i + 1}" class="${i === 0 ? "now" : ""}" style="height:${((p / bands[9]) * 100).toFixed(1)}%">${i === 0 || i === 9 ? `<span>${+p.toFixed(4)}</span>` : ""}</i>`).join("")}</div>
    <div class="ladder-x">${bands.map((_, i) => `<span>${i + 1}</span>`).join("")}</div>
    <p style="margin-top:14px">Ten bands of 1,004.8 daemons, by how many have sold. Band 1 is 0.01 ETH; each costs 1.3× the one before, up to 0.10604499373 ETH. Prices, the split and the opening time are fixed in the contract — nobody can change them.</p>
  </div></div>
  <div class="row"><span class="label">Opens</span><div>
    <p><strong>${opens}</strong></p><p class="clock" id="clock"></p>
  </div></div>
  <div class="row"><span class="label">Provenance</span><div class="kv">
    <span class="k">trait table</span><span class="v">sha256 ${M.provenance.tableSha256}</span><button class="copy" data-copy="${M.provenance.tableSha256}">copy</button>
    <span class="k">seed</span><span class="v">sha256 ${M.provenance.seedSha256}</span><button class="copy" data-copy="${M.provenance.seedSha256}">copy</button>
    <span class="k"></span><span class="v" style="color:var(--dim)">The seed is published after the sale; anyone can then re-derive every look and check these.</span><span></span>
  </div></div>
  <div class="row"><span class="label">Contracts</span><div class="kv">
    <span class="k">collection</span><a class="v" href="https://robinhoodchain.blockscout.com/address/${M.nft}">${M.nft}</a><button class="copy" data-copy="${M.nft}">copy</button>
    <span class="k">sale</span><a class="v" href="https://robinhoodchain.blockscout.com/address/${M.sale}">${M.sale}</a><button class="copy" data-copy="${M.sale}">copy</button>
    <span class="k">treasury</span><span class="v">${M.treasury} · a Safe</span><button class="copy" data-copy="${M.treasury}">copy</button>
    <span class="k">chain</span><span class="v">Robinhood Chain · 4663</span><span></span>
  </div></div>
</div>

<footer><span>Designed by Chad Neal · published by SHYGUY LLC</span><nav><a href="/docs">Docs</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/risk">Risk</a><a href="https://testnet.obol.sh/">Testnet Floor</a></nav></footer>
</div>
<script>
const SALE = ${JSON.stringify(M.sale)}, CHAIN = "0x1237", OPENS = ${Number(M.opensAt)} * 1000, SUPPLY = ${Number(M.supply)};
const $ = (id) => document.getElementById(id);
const say = (t, cls = "") => { $("msg").textContent = t; $("msg").className = cls; };
const eth = (wei) => { const s = BigInt(wei).toString().padStart(19, "0"); const w = s.slice(0, -18), f = s.slice(-18).replace(/0+$/, ""); return f ? w + "." + f : w; };
const pad = (n) => String(n).padStart(2, "0");
let state = null;

async function poll() {   // the sale's numbers, every 15 s
  try {
    state = await (await fetch("/api/sale", { cache: "no-store" })).json();
    $("price").textContent = eth(state.price); $("band").textContent = state.band + "/10"; $("sold").textContent = state.sold.toLocaleString("en-US");
    document.querySelectorAll("#ladder i").forEach((b) => { const n = +b.dataset.b; b.className = n < state.band ? "past" : n === state.band ? "now" : ""; });
  } catch { /* keep the last numbers */ }
}
function tick() {         // the clock, every second
  const left = OPENS - Date.now(), open = left <= 0;
  $("dot").classList.toggle("on", open); $("livetxt").textContent = open ? "Live · Robinhood Chain" : "Robinhood Chain";
  if (!open) {
    const d = Math.floor(left / 864e5), h = Math.floor(left / 36e5) % 24, m = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60;
    $("clock").textContent = pad(d) + "d " + pad(h) + ":" + pad(m) + ":" + pad(s);
    $("go").disabled = true; if (!$("msg").dataset.busy) say("The sale opens " + new Date(OPENS).toUTCString().replace(":00 GMT", " UTC") + ".");
  } else {
    $("clock").textContent = "Open."; if (!$("msg").dataset.busy) $("go").disabled = false;
    if ($("msg").textContent.startsWith("The sale opens") || $("msg").textContent === "loading…") say("Pick a number, or any unsold, then Buy.");
  }
}
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
let shown = "";
async function feed() {   // the live sale feed, from obol.sh's own index
  try {
    const f = await (await fetch("/api/sales?n=24", { cache: "no-store" })).json();
    $("feedcount").textContent = f.sold ? f.sold.toLocaleString("en-US") + " sold" : "";
    $("feedempty").style.display = f.sales.length ? "none" : "block";
    const key = f.sales.map((x) => x.token).join(",");
    if (key !== shown) {   // rebuild only when there's a new sale (keeps the GIFs from restarting)
      shown = key;
      $("tiles").innerHTML = f.sales.map((x) => { const fresh = Date.now() - x.at < 120000;
        return "<a class='tile" + (fresh ? " new" : "") + "' href='/d/" + x.token + "/os'><img loading='lazy' alt='Daemon № " + x.token + "' src='/d/" + x.token + "/image.gif" + (fresh ? "?fresh=1" : "") + "'><b>№ " + x.token + "</b><span>" + eth(x.price) + " ETH · band " + x.band + "</span><span>" + x.buyer.slice(0, 6) + "…" + x.buyer.slice(-4) + " · <i data-at='" + x.at + "'></i></span></a>"; }).join("");
    }
    document.querySelectorAll("#tiles i[data-at]").forEach((e) => (e.textContent = ago(+e.dataset.at)));
  } catch { /* keep what's shown */ }
}
poll(); tick(); feed(); setInterval(poll, 15000); setInterval(tick, 1000); setInterval(feed, 15000);

document.querySelectorAll(".copy").forEach((b) => b.onclick = async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "copied"; setTimeout(() => (b.textContent = "copy"), 1400); } catch { b.textContent = "select it"; }
});

const num = () => { const v = $("n").value.trim(); return /^\\d{1,5}$/.test(v) && +v < SUPPLY ? +v : null; };
let checkT = null;
async function check(id) {   // live availability as you type
  try { const a = await (await fetch("/api/sale/" + id, { cache: "no-store" })).json(); if (num() !== id) return;
    $("avail").textContent = a.available ? "№ " + id + " · unsold" : a.available === false ? "№ " + id + " · sold — pick another" : "couldn't check — try again";
    $("avail").className = a.available ? "ok" : ""; } catch { $("avail").textContent = ""; }
}
$("n").oninput = () => {
  $("n").value = $("n").value.replace(/\\D/g, "").slice(0, 5);
  clearTimeout(checkT); const id = num();
  if ($("n").value && id == null) { $("avail").textContent = "0 to 10047"; $("avail").className = ""; return; }
  $("avail").textContent = ""; if (id != null) checkT = setTimeout(() => check(id), 350);
};
$("any").onclick = async () => {
  $("avail").textContent = "finding one…"; $("avail").className = "";
  try { const r = await (await fetch("/api/sale/random", { cache: "no-store" })).json();
    if (r.id != null) { $("n").value = r.id; $("avail").textContent = "№ " + r.id + " · unsold"; $("avail").className = "ok"; } else $("avail").textContent = r.error || "couldn't find one — try again"; }
  catch { $("avail").textContent = "couldn't reach obol.sh — try again"; }
};

async function ensureChain(p) {
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN }] }); }
  catch (e) {
    if (e.code !== 4902 && !/Unrecognized|not added|4902/i.test(e.message || "")) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"] }] });
  }
}

$("go").onclick = async () => {
  const id = num();
  if (id == null) return say("Enter a number from 0 to 10047.", "bad");
  const p = window.ethereum;
  if (!p) return say("No wallet in this browser. Open obol.sh in your wallet's browser — MetaMask, Zerion, Coinbase Wallet.", "bad");
  $("go").disabled = true; $("msg").dataset.busy = "1";
  try {
    const a = await (await fetch("/api/sale/" + id, { cache: "no-store" })).json();
    if (!a.available) throw new Error("№ " + id + " is already sold — pick another, or any unsold.");
    const [from] = await p.request({ method: "eth_requestAccounts" });
    await ensureChain(p);
    // the price right now, from the chain — a band can tip over between the page load and this click
    const price = await p.request({ method: "eth_call", params: [{ to: SALE, data: "0xa035b1fe" }, "latest"] });
    say("Confirm in your wallet: № " + id + " for " + eth(price) + " ETH.");
    const data = "0xd96a094a" + BigInt(id).toString(16).padStart(64, "0");
    const hash = await p.request({ method: "eth_sendTransaction", params: [{ from, to: SALE, data, value: "0x" + BigInt(price).toString(16) }] });
    say("Sent. Waiting for the chain…");
    let rc = null;
    for (let i = 0; i < 90 && !rc; i++) { await new Promise((r) => setTimeout(r, 2000)); rc = await p.request({ method: "eth_getTransactionReceipt", params: [hash] }); }
    if (!rc) throw new Error("Not confirmed yet — check your wallet. " + hash);
    if (rc.status !== "0x1") throw new Error("It reverted — usually the band changed or someone bought № " + id + " first. Nothing was taken but gas. " + hash);
    say("Yours: daemon № " + id + ".", "ok");
    $("mineimg").src = "/d/" + id + "/image.gif?fresh=1";
    $("minetxt").innerHTML = "<a href='/d/" + id + "/os'>Open its screen</a><br><span style='color:var(--dim)'>" + hash.slice(0, 10) + "…" + hash.slice(-8) + "</span>";
    $("mine").style.display = "flex";
    poll();
  } catch (e) {
    say(e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || "")) ? "Cancelled in your wallet." : (e.message || String(e)), "bad");
  } finally { delete $("msg").dataset.busy; $("go").disabled = Date.now() < OPENS; }
};
</script>
</body></html>`;
};
