// obol.sh's crawler files (2026-10-08): robots, sitemap, llms.txt, security.txt — and testnet.obol.sh is noindex (the
// testnet copy must never compete with the real collection in search). The IndexNow key file is served from a secret.
const PAGES = ["/", "/docs", "/terms", "/privacy", "/risk"];

export const robots = (origin, testnet) => testnet
  ? "# the testnet daemons: not for search — the collection is https://obol.sh/\nUser-agent: *\nDisallow: /\n"
  : `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\n\nSitemap: ${origin}/sitemap.xml\n`;

export const sitemap = (origin, lastmod) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => `  <url><loc>${origin}${p}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;

export const llms = (origin, M) => `# Daemon

> 10,048 agents on Robinhood Chain. Each daemon is an NFT (ERC-721) with its own on-chain wallet (an ERC-6551 account) that follows the token; 90% of every sale is paid into that daemon's own wallet and 10% to SHYGUY LLC, in the same transaction. Each daemon's look was fixed and committed (a provenance hash) before the mint and is revealed when it sells.

Published by SHYGUY LLC (Idaho). Designed by Chad Neal. Site: ${origin}

## Facts
- Chain: Robinhood Chain mainnet (chain id 4663).
- Collection: ${M.nft} — exactly ${M.supply.toLocaleString("en-US")}, all minted to the sale at deployment; no more can be made.
- Sale: ${M.sale} — opens ${new Date(M.opensAt * 1000).toISOString()}. Buyers pick a number (0–${M.supply - 1}). Ten price bands by how many have sold: band 1 is 0.01 ETH, each band 1.3× the one before (band 10: 0.10604499373 ETH). Prices, split, opening time and treasury are fixed in the contract; no owner, no admin, no refunds.
- Treasury: ${M.treasury} (a Safe).
- Provenance: trait table sha256 ${M.provenance.tableSha256}; seed sha256 ${M.provenance.seedSha256} (the seed is published after the sale).
- Each token's metadata: ${origin}/d/<n> — art and traits appear once that token has sold.
- A daemon's live screen (its "OS"): ${origin}/d/<n>/os.

## What a daemon is not
- Not an investment and not a share of anything; it gives no claim on SHYGUY LLC or its revenue. No promise of price, demand or features.
- At launch a mainnet daemon does not act on its own; autonomy (an agent running an "agentfile" under limits its holder sets) is switched on per daemon later. Options and bounded swaps run only on the test network (https://testnet.obol.sh/).

## Pages
- [Docs](${origin}/docs): getting started, the agentfile (HCL) guide, the full reference.
- [Terms](${origin}/terms) · [Privacy](${origin}/privacy) · [Risk](${origin}/risk)

## Contact
daemon@meex.work · security: security@meex.work
`;

export const securityTxt = (origin) => `Contact: mailto:security@meex.work
Expires: 2027-10-01T00:00:00.000Z
Policy: ${origin}/terms
Preferred-Languages: en
Canonical: ${origin}/.well-known/security.txt
`;
