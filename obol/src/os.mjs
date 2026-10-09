// The OS (milestone 13, SPEC §6b): one daemon's own screen — Wallet, Log, Inbox, Repo, Market — served as its NFT's
// animation_url (/d/<id>/os), with ERC-721 metadata at /d/<id> and a generated image. Data: the chain (balances, caps,
// positions in every market contract) + the daemon's Durable Object (log incl. skips, inbox, repo). Pure helpers first.
import { parseAbi } from "viem";
import { D, pub, SALE, NFT, ACCOUNT } from "./chain.mjs";
import { INSTRUMENTS } from "../../lang/otc.mjs";
import { book } from "./otc.mjs";
import { optionBook } from "./options.mjs";
import { indexList } from "./indexes.mjs";
import { swapBook } from "./swaps.mjs";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

/** what it sold and bought, from its own log (pure): skills sold over x402, x402 paid, and trading by kind */
export function marketOf(log) {
  const sold = {}, bought = {}, trades = {};
  for (const e of log) {
    if (e.kind === "sale" && e.ok) { const s = (sold[e.name] ??= { n: 0, micro: 0 }); s.n++; s.micro += Number(e.detail?.amount ?? 0); }
    if (e.kind === "strategy" && e.ok) for (const sp of e.detail?.spent ?? []) {
      if (sp.amount && sp.to) { const b = (bought[sp.to] ??= { n: 0, micro: 0 }); b.n++; b.micro += Number(sp.amount); }
      else if (sp.kind && sp.kind !== "model") trades[sp.kind] = (trades[sp.kind] ?? 0) + 1;
    }
  }
  const sum = (o) => Object.values(o).reduce((t, x) => t + x.micro, 0);
  return { sold, bought, trades, netMicro: sum(sold) - sum(bought) };
}

/** this wallet's open positions across the four market contracts (pure, over the books) */
export function positionsOf(wallet, { offers = [], options = [], indexes = [], swaps = [], shares = {} }) {
  return {
    otc: offers.filter((o) => eq(o.maker, wallet)).map((o) => ({ id: o.id, give: o.give.map((l) => `${l.amount} ${l.sym ?? l.token}`), want: o.want.map((l) => `${l.amount} ${l.sym ?? l.token}`), expires: o.expires })),
    options: options.filter((o) => (eq(o.writer, wallet) || eq(o.buyer, wallet)) && (o.state === "listed" || o.state === "bought"))
      .map((o) => ({ id: o.id, role: eq(o.writer, wallet) ? "writer" : "holder", state: o.state, terms: o.terms, expires: o.expires, expired: o.expired })),
    indexes: indexes.filter((x) => (shares[x.share.toLowerCase()] ?? 0) > 0 || eq(x.manager, wallet))
      .map((x) => ({ id: x.id, symbol: x.symbol, held: shares[x.share.toLowerCase()] ?? 0, manager: eq(x.manager, wallet), supply: x.supply, backed: x.backed })),
    swaps: swaps.filter((s) => (eq(s.maker, wallet) && (s.state === "offered" || s.state === "live")) || (eq(s.taker, wallet) && s.state === "live"))
      .map((s) => ({ id: s.id, side: eq(s.maker, wallet) ? s.makerSide : s.makerSide === "long" ? "short" : "long", state: s.state, terms: s.terms, escrow: s.escrow, entry: s.entry, end: s.end })),
  };
}

/** everything /d/<id>/os shows */
export async function osView(env, id, { doData }) {
  const client = pub(env);
  const wallet = await client.readContract({ address: D.sale, abi: SALE, functionName: "walletOf", args: [BigInt(id)] });
  const tokens = Object.entries(INSTRUMENTS);
  const [owner, eth, spent, constitution, bal, offers, options, indexes, swaps, data] = await Promise.all([
    client.readContract({ address: D.nft, abi: NFT, functionName: "ownerOf", args: [BigInt(id)] }).catch(() => null),
    client.getBalance({ address: wallet }),
    client.readContract({ address: wallet, abi: ACCOUNT, functionName: "spentToday" }).catch(() => 0n),
    client.readContract({ address: wallet, abi: ACCOUNT, functionName: "constitution" }).catch(() => null),
    Promise.all(tokens.map(([, t]) => client.readContract({ address: t.address, abi: ERC20, functionName: "balanceOf", args: [wallet] }).catch(() => 0n))),
    book(env).catch(() => []), optionBook(env).catch(() => []), indexList(env).catch(() => []), swapBook(env).catch(() => []), doData,
  ]);
  const balances = tokens.map(([sym, t], i) => ({ sym, amount: Number(bal[i]) / 10 ** t.decimals, index: !!t.index })).concat([{ sym: "ETH (gas)", amount: Number(eth) / 1e18 }]);
  const shares = Object.fromEntries(tokens.filter(([, t]) => t.index).map(([, t], i) => [t.address.toLowerCase(), Number(bal[tokens.findIndex(([, x]) => x === t)])]));
  const [configuredBy, agent, maxPerCall, maxPerDay] = constitution ?? [];
  return {
    id, network: "Robinhood Chain testnet (46630)", wallet, owner, agent: agent ?? null, constitutionLive: !!configuredBy && eq(configuredBy, owner),
    caps: constitution ? { perCall: Number(maxPerCall) / 1e6, perDay: Number(maxPerDay) / 1e6, spentToday: Number(spent) / 1e6 } : null,
    balances, positions: positionsOf(wallet, { offers, options, indexes, swaps, shares }), market: marketOf(data.log), ...data,
  };
}

/** ERC-721 metadata for /d/<id> — the OS is its animation_url */
/** a token's eight art traits from the shipped table (art/tools/export_traits.py) — null for an id outside it */
export const traitsOf = (table, id) => {
  const row = table.tokens[id];
  return row ? table.order.map((k, i) => ({ trait_type: k, value: table.values[k][row[i]] })) : null;
};

export const metadataOf = (origin, v, { art = null, gif = false } = {}) => ({
  name: `Daemon #${v.id}`,
  description: `An agent with its own wallet on Robinhood Chain (testnet). It runs the rules in its agentfile, sells ${v.skills.length} skill${v.skills.length === 1 ? "" : "s"} over x402 and runs ${v.strategies.length} strategies; it can draft changes to itself, never to what it may do. Its live screen is the animation.`,
  image: gif ? `${origin}/d/${v.id}/image.gif` : `${origin}/d/${v.id}/image.svg`,   // the spin, once its GIF is uploaded
  animation_url: `${origin}/d/${v.id}/view`,   // the spin, full-bleed; a click opens the OS
  external_url: `${origin}/d/${v.id}/os`,
  attributes: [
    ...(art ?? []),
    { trait_type: "Network", value: "Robinhood Chain testnet" },
    { trait_type: "Skills", value: v.skills.length, display_type: "number" },
    { trait_type: "Strategies", value: v.strategies.length, display_type: "number" },
    { trait_type: "Version", value: v.version ?? "none" },
    ...(v.limits.otc ? [{ trait_type: "Trades OTC", value: "yes" }] : []),
    ...(v.limits.options ? [{ trait_type: "Options", value: "yes" }] : []),
    ...(v.limits.swaps ? [{ trait_type: "Swaps", value: "yes" }] : []),
    ...(v.limits.indexes?.length ? [{ trait_type: "Publishes an index", value: v.limits.indexes.map((x) => x.symbol).join(", ") }] : []),
  ],
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** the token image: typographic, generated (the art is parked — this is a placeholder that says what it is) */
export const imageSvg = (id, v) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
<rect width="600" height="600" fill="#0d0c0a"/><rect x="24" y="24" width="552" height="552" rx="18" fill="#16140f" stroke="#2a261d" stroke-width="2"/>
<text x="56" y="110" fill="#968d78" font-family="Menlo,monospace" font-size="22" letter-spacing="4">DAEMON</text>
<text x="52" y="300" fill="#c9a24a" font-family="Menlo,monospace" font-size="${String(id).length > 3 ? 150 : 190}" font-weight="700">#${esc(id)}</text>
<text x="56" y="400" fill="#ece6d6" font-family="Menlo,monospace" font-size="22">${esc(v ? `${v.skills} skill${v.skills === 1 ? "" : "s"} · ${v.strategies} strategies` : "an agent with its own wallet")}</text>
<text x="56" y="436" fill="#968d78" font-family="Menlo,monospace" font-size="18">${esc(v?.version ? `version ${v.version}` : "")}</text>
<text x="56" y="536" fill="#968d78" font-family="Menlo,monospace" font-size="16">obol.sh · Robinhood Chain testnet</text>
</svg>`;

/**
 * Reveal on sale (operator, 2026-10-08): a mainnet token's own art and traits are served only once it has SOLD — its
 * owner is no longer the sale contract. Before that every token shows the same unrevealed spin and no traits, so nobody
 * can pick the rare ones by number. The full table is committed (provenance hash) before the mint. Pure.
 */
export function revealOf(id, { owner, sale, supply = 10048 }) {
  if (!Number.isInteger(id) || id < 0 || id >= supply) return { exists: false };
  if (!owner) return { exists: false };   // not minted (all are minted to the sale up front, so this is a wrong id/chain)
  const sold = owner.toLowerCase() !== sale.toLowerCase();
  return { exists: true, sold, image: sold ? `mainnet/gif/${id}.gif` : "mainnet/unrevealed.gif" };
}

/** mainnet metadata: the token's art + traits when revealed; the shared unrevealed spin, with no traits, before */
export const mainnetMetadata = (origin, id, r, traits) => ({
  name: `Daemon #${id}`,
  description: r.sold
    ? "An agent with its own wallet on Robinhood Chain. Its live screen is the animation."
    : "An unsold daemon on Robinhood Chain. Its look is revealed when it sells — every token's look was fixed and committed (a provenance hash) before the mint.",
  image: `${origin}/d/${id}/image.gif`,
  animation_url: `${origin}/d/${id}/view`,
  external_url: `${origin}/d/${id}/os`,
  attributes: r.sold ? [...(traits ?? []), { trait_type: "Status", value: "Revealed" }] : [{ trait_type: "Status", value: "Unrevealed" }],
});
