// obol.sh legal set: /terms, /privacy, /risk — written from the contracts' and the site's own facts (2026-10-08).
// SHYGUY LLC (Idaho SOS 5292055). Never "earn", never "invest", no return, no price prediction.
const page = (title, body, M) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Daemon</title><link rel="canonical" href="https://obol.sh/${title.toLowerCase()}">
<meta property="og:title" content="${title} · Daemon"><meta property="og:image" content="https://obol.sh/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">
<link href="https://fonts.googleapis.com/css2?family=Fragment+Mono&family=Instrument+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--ground:#ece9e2;--line:#d4cfc4;--ink:#1a1a1d;--dim:#6b665c;--accent:#3a5a3f}
*{box-sizing:border-box}html,body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.6 "Instrument Sans",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 48px}h1{font-size:34px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}
.meta{font:13px "Fragment Mono",ui-monospace,monospace;color:var(--dim);margin-bottom:20px}code{font:13px "Fragment Mono",ui-monospace,monospace;overflow-wrap:anywhere}
a{color:var(--accent)}nav{display:flex;gap:16px;font:13px "Fragment Mono",ui-monospace,monospace;border-top:1px solid var(--line);margin-top:36px;padding-top:16px;flex-wrap:wrap}
</style></head><body><main>
<h1>${title}</h1><div class="meta">Daemon · obol.sh · last updated 2026-10-08</div>
${body}
<nav><a href="/">Daemon</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/risk">Risk</a><span>SHYGUY LLC · daemon@meex.work</span></nav>
</main></body></html>`;

export const termsHtml = (M) => page("Terms", `
<p>These terms cover the Daemon collection and obol.sh. Daemon is published by <strong>SHYGUY LLC</strong>, an Idaho limited liability company ("we"). By buying or holding a daemon, or using obol.sh, you agree to them.</p>
<h2>What a daemon is</h2>
<p>A daemon is an ERC-721 token in the collection at <code>${M.nft}</code> on Robinhood Chain (chain 4663). There are exactly ${M.supply.toLocaleString("en-US")}; all were minted to the sale contract <code>${M.sale}</code> when it was deployed, and no more can ever be made. Each daemon has its own on-chain account (an ERC-6551 token-bound account) controlled by whoever holds the daemon at the time.</p>
<h2>The sale</h2>
<p>The sale opens at ${new Date(M.opensAt * 1000).toUTCString().replace(":00 GMT", " UTC")}. You choose a number and pay its band's price: ten bands by how many daemons have sold, starting at 0.01 ETH and each 1.3× the one before. Of each price, 90% is paid into that daemon's own account and 10% to our treasury, in the same transaction. Prices, the split, the opening time and the treasury are fixed in the contracts; we cannot change them, pause the sale or reverse a purchase. Purchases are final — there are no refunds. You pay the network's gas.</p>
<h2>The look</h2>
<p>Every daemon's look was fixed before the mint and committed as a hash (shown on obol.sh). A daemon's look is shown once it has sold. We host the art and each daemon's page on obol.sh; if obol.sh is unavailable the tokens and accounts still exist on chain.</p>
<h2>Your rights to the art</h2>
<p>While you hold a daemon, we grant you a worldwide, royalty-free licence to use, copy and display that daemon's art (its images and animation as we publish them) for personal, non-commercial purposes, including showing it as your profile picture and selling or transferring the daemon itself. The licence passes with the daemon and ends when you no longer hold it. It covers the finished art only — not the 3D models, rigs, textures or tools used to make it, which belong to us or to their licensors and are not distributed. All other rights are reserved. Designed by Chad Neal; published by SHYGUY LLC.</p>
<h2>A daemon's account and autonomy</h2>
<p>At launch a daemon is its look and its account; it does not act on its own. Autonomy — an agent acting under rules and limits its holder sets — may be offered later, per daemon, only if its holder turns it on. Whatever is in a daemon's account goes with the daemon when it changes hands.</p>
<h2>What we don't do</h2>
<p>A daemon is a collectible and a tool, not a share of anything. It gives no claim on SHYGUY LLC, its revenue or its treasury. We make no promise about its price, demand or future features. Nothing on obol.sh is financial, investment, legal or tax advice. Options, swaps and other markets shown on our test network are not offered on Robinhood Chain mainnet.</p>
<h2>Using obol.sh</h2>
<p>Don't attack, overload or try to break obol.sh, and don't use it for anything unlawful. You're responsible for your wallet, its keys and the transactions you sign. Robinhood Chain, the ERC-6551 registry, wallets and marketplaces are run by others; we don't control them.</p>
<h2>Liability</h2>
<p>obol.sh and the art are provided as is. To the extent the law allows, we are not liable for indirect or consequential losses, or for losses from the chain, your wallet, third-party services or smart-contract behaviour, and our total liability to you for anything connected with Daemon is limited to US$100.</p>
<h2>Law</h2>
<p>These terms are governed by the laws of the State of Idaho; disputes go to the state or federal courts in Ada County, Idaho. If we change these terms we'll update the date above; the contracts themselves can't change.</p>
<h2>Contact</h2><p>daemon@meex.work · security reports: security@meex.work</p>`, M);

export const privacyHtml = (M) => page("Privacy", `
<p>obol.sh is run by SHYGUY LLC. This is everything it collects about you.</p>
<h2>What we collect</h2>
<p><strong>Nothing personal.</strong> obol.sh has no accounts, no sign-up, no email capture, no cookies and no analytics. Buying happens between your wallet and the contracts: the page asks your wallet to send a transaction, and your browser — not our server — talks to your wallet.</p>
<h2>What's public anyway</h2>
<p>Purchases, transfers and every daemon's account are recorded on Robinhood Chain, which is public and permanent. obol.sh reads the chain to show who holds a daemon and what its account holds; it doesn't add to that.</p>
<h2>Requests</h2>
<p>obol.sh runs on Cloudflare, which processes requests (including your IP address) to deliver and protect the site, under its own privacy policy. We don't keep request logs of our own beyond Cloudflare's standard short-lived error logs.</p>
<h2>Third parties</h2>
<p>The page loads fonts from Google Fonts. Your wallet, Robinhood Chain RPC providers, block explorers and marketplaces have their own policies.</p>
<h2>Contact</h2><p>daemon@meex.work</p>`, M);

export const riskHtml = (M) => page("Risk", `
<p>Read this before you buy. Daemon is new, and everything below can go wrong.</p>
<h2>It's not an investment</h2>
<p>A daemon may be worth less than you paid, or nothing. Nobody — including us — can promise demand, a price, a return or future features. Don't spend what you can't afford to lose.</p>
<h2>Purchases are final</h2>
<p>Transactions on Robinhood Chain can't be reversed. A purchase can fail (for example if someone buys the same number first or the band changes) — then it reverts and you lose only gas. A purchase that succeeds can't be undone or refunded.</p>
<h2>Smart contracts</h2>
<p>The contracts have no owner and no admin: nobody can pause them, fix a bug in them or recover funds sent wrongly. They were tested (on a fork of Robinhood Chain, with every guard checked) but have not had an independent audit. Code can have bugs.</p>
<h2>A daemon's account</h2>
<p>90% of the price goes into the daemon's own account. That account belongs to whoever holds the daemon — if you sell or lose the daemon, its account and everything in it go with it. If you lose access to your wallet, you lose the daemon and its account.</p>
<h2>The network and services</h2>
<p>Robinhood Chain, its RPCs, wallets, marketplaces and obol.sh are run by different parties and can be slow, down or changed. If obol.sh goes away, your daemon and its account still exist on chain, but the art and the daemon's screen are served by obol.sh.</p>
<h2>Autonomy, later</h2>
<p>If a holder later turns on a daemon's autonomy, an agent will act under limits the holder sets. Agents can make poor decisions within those limits; the limits are the protection, so set them low.</p>
<h2>Law and tax</h2>
<p>Rules for digital assets differ by country and change. Whether you may buy one, and how it's taxed, is your responsibility.</p>`, M);
