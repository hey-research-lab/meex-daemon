// The testnet price mirror (milestone 12): Chainlink has no feeds on Robinhood Chain testnet, so a cron copies each
// mainnet feed's rounds into its MirrorFeed — EVERY round, in order (settling needs the round before the settling one).
// A trusted relay by one feeder key: testnet only. On mainnet DaemonSwaps reads Chainlink's proxy itself.
import { createPublicClient, http, parseAbi } from "viem";
import { pub, signer } from "./chain.mjs";
import { FEEDS } from "../../lang/swaps.mjs";

export const AGG = parseAbi([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function latestRound() view returns (uint80)",
  "function post(uint80 roundId,int256 answer,uint256 updatedAt)",
]);
const MAX_CATCHUP = 24;   // rounds per run; a fresh mirror starts at the source's latest

/** which source rounds to post: everything after the mirror's latest, in order, at most MAX_CATCHUP (pure) */
export function toPost(mirrorLatest, sourceLatest) {
  const m = BigInt(mirrorLatest), s = BigInt(sourceLatest);
  if (s <= m) return [];
  if (m === 0n || s >> 64n !== m >> 64n) return [s];   // first run, or a new phase (ids jump): start at the latest
  const from = s - m > BigInt(MAX_CATCHUP) ? s - BigInt(MAX_CATCHUP) + 1n : m + 1n;
  const out = []; for (let i = from; i <= s; i++) out.push(i); return out;
}

export async function mirrorFeeds(env, { src = null, dst = null, send = null } = {}) {
  if (!env.FEEDER_KEY || !env.MAINNET_RPC) return { skipped: "no FEEDER_KEY / MAINNET_RPC" };
  // the public RPCs answer 429 under load: back off and retry (5 tries from 1 s) rather than fail the run
  const patient = (url) => http(url, { retryCount: 5, retryDelay: 1000 });
  const main = src ?? createPublicClient({ transport: patient(env.MAINNET_RPC) }), test = dst ?? createPublicClient({ transport: patient(env.RPC) });
  const out = {};
  for (const [sym, f] of Object.entries(FEEDS)) {
    const [latest] = await main.readContract({ address: f.mainnet, abi: AGG, functionName: "latestRoundData" });
    const mine = await test.readContract({ address: f.address, abi: AGG, functionName: "latestRound" });
    const ids = toPost(mine, latest), posted = [];
    for (const id of ids) {
      const [, answer, , updatedAt] = await main.readContract({ address: f.mainnet, abi: AGG, functionName: "getRoundData", args: [id] });
      const hash = send ? await send(f.address, id, answer, updatedAt) : await (async () => {
        const { wallet } = signer(env, env.FEEDER_KEY);
        const h = await wallet.writeContract({ address: f.address, abi: AGG, functionName: "post", args: [id, answer, updatedAt] });
        const r = await test.waitForTransactionReceipt({ hash: h });
        if (r.status !== "success") throw new Error(`post ${sym} round ${id} reverted`);
        return h;
      })();
      posted.push({ round: String(id), answer: String(answer), updatedAt: Number(updatedAt), tx: hash });
    }
    out[sym] = { mirror: String(mine), source: String(latest), posted };
  }
  return out;
}
