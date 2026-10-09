// The Daemon collection on Robinhood Chain MAINNET (deployed 2026-10-08; sale opens 2026-10-10 18:00Z). obol.sh/d/<n>
// is the mainnet token's metadata, art and OS; the testnet daemons answer on testnet.obol.sh. Phased launch: a mainnet
// daemon has its own wallet and its look — no agent, no strategies yet — and its look is revealed only once it sells.
import { createPublicClient, http, fallback, parseAbi } from "viem";
import M from "./deployment-mainnet.json";
import TRAITS from "./art-traits-mainnet.json";
import { revealOf, mainnetMetadata, traitsOf } from "./os.mjs";

export { M };
const NFT = parseAbi(["function ownerOf(uint256) view returns (address)"]);
const SALE = parseAbi(["function walletOf(uint256) view returns (address)", "function price() view returns (uint256)", "function sold() view returns (uint256)", "function currentBand() view returns (uint256)"]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
// the public RPCs throttle Cloudflare's egress (429s): fall back across several, and cache what only a sale changes
const RPCS = ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org", "https://4663.rpc.thirdweb.com"];
export const client = (env) => createPublicClient({ transport: fallback([env.MAINNET_RPC, ...RPCS].map((u) => http(u, { retryCount: 1, retryDelay: 300, timeout: 8000 })), { rank: false }) });

/** a token's owner, cached 60 s at the edge (only a sale changes it) */
async function ownerOf(env, id, fresh = false) {
  const key = new Request(`https://cache.obol.internal/owner/${M.nft}/${id}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const hit = !fresh && cache && (await cache.match(key));
  if (hit) return hit.text();
  const owner = await client(env).readContract({ address: M.nft, abi: NFT, functionName: "ownerOf", args: [BigInt(id)] });
  if (cache) await cache.put(key, new Response(owner, { headers: { "cache-control": "public, max-age=60" } }));
  return owner;
}

export async function reveal(env, id, { fresh = false } = {}) {
  if (!Number.isInteger(id) || id < 0 || id >= M.supply) return { exists: false };
  // 🔴 an RPC failure is NOT "no such token": a marketplace would cache that 404. Say "try again" (503) instead.
  let owner;
  try { owner = await ownerOf(env, id, fresh); }
  catch (e) { return { exists: true, unavailable: (e.shortMessage ?? e.message ?? "rpc").slice(0, 160) }; }
  return { ...revealOf(id, { owner, sale: M.sale, supply: M.supply }), owner };
}

export const metadata = (origin, id, r) => mainnetMetadata(origin, id, r, r.sold ? traitsOf(TRAITS, id) : null);

/** the mainnet OS's data, in the shape the OS page renders: its wallet and its sale state; no agent yet (phased) */
export async function osData(env, id, r) {
  const c = client(env);
  const [wallet, price, sold, band] = await Promise.all([
    c.readContract({ address: M.sale, abi: SALE, functionName: "walletOf", args: [BigInt(id)] }),
    c.readContract({ address: M.sale, abi: SALE, functionName: "price" }),
    c.readContract({ address: M.sale, abi: SALE, functionName: "sold" }),
    c.readContract({ address: M.sale, abi: SALE, functionName: "currentBand" }),
  ]);
  const [eth, usd] = await Promise.all([c.getBalance({ address: wallet }), c.readContract({ address: M.dollar, abi: ERC20, functionName: "balanceOf", args: [wallet] }).catch(() => 0n)]);
  const opens = M.opensAt * 1000;
  return {
    id, mainnet: true, network: "Robinhood Chain (4663)", wallet, owner: r.owner, agent: null, constitutionLive: false, caps: null,
    sale: { sold: r.sold, opensAt: M.opensAt, open: Date.now() >= opens, price: (Number(price) / 1e18).toString(), band: Number(band) + 1, soldCount: Number(sold), supply: M.supply },
    traits: r.sold ? traitsOf(TRAITS, id) : null,
    balances: [{ sym: "ETH", amount: Number(eth) / 1e18 }, { sym: "USDG", amount: Number(usd) / 1e6 }],
    positions: { otc: [], options: [], indexes: [], swaps: [] },
    version: null, nextRun: null, think: { budget: 0, today: 0, owed: [], paid: [] }, skills: [], strategies: [], limits: {},
    log: [], inbox: [], repo: { head: null, commits: [], proposals: [], trials: [] }, market: { sold: {}, bought: {}, trades: {}, netMicro: 0 },
  };
}

/** ERC-7572 contractURI: the collection page marketplaces show */
export const collection = (origin) => ({
  name: "Daemon",
  description: "10,048 agents on Robinhood Chain, each an NFT with its own wallet. 90% of every sale goes straight into the daemon's own wallet. Each one's look is revealed when it sells; every look was fixed and committed (a provenance hash) before the mint. Designed by Chad Neal; published by SHYGUY LLC.",
  image: `${origin}/unrevealed.gif`,
  banner_image: `${origin}/banner.png`,
  featured_image: `${origin}/og.png`,
  external_link: origin,
  collaborators: [M.treasury],
});

/** the sale right now (the page polls it): price in wei, band 1–10, sold, whether it's open */
export async function saleState(env) {
  const c = client(env);
  const [price, sold, band] = await Promise.all([
    c.readContract({ address: M.sale, abi: SALE, functionName: "price" }),
    c.readContract({ address: M.sale, abi: SALE, functionName: "sold" }),
    c.readContract({ address: M.sale, abi: SALE, functionName: "currentBand" }),
  ]);
  return { chainId: M.chainId, sale: M.sale, nft: M.nft, supply: M.supply, opensAt: M.opensAt, open: Date.now() >= M.opensAt * 1000,
    price: price.toString(), band: Number(band) + 1, sold: Number(sold) };
}

/** is this number unsold? (always read fresh — it's asked right before a purchase) */
export async function available(env, id) {
  const r = await reveal(env, id, { fresh: true });
  if (!r.exists) return { id, available: false, error: "no such daemon" };
  if (r.unavailable) return { id, available: null, error: "the chain didn't answer — try again" };
  return { id, available: !r.sold };
}

/** any unsold number: random draws, each checked on chain */
export async function randomUnsold(env) {
  for (let i = 0; i < 12; i++) {
    const id = Math.floor(Math.random() * M.supply), a = await available(env, id);
    if (a.available) return { id };
  }
  return { id: null, error: "couldn't find an unsold number just now — try again" };
}
