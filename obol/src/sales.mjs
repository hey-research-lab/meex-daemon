// The live sale feed (2026-10-09): every Bought event of the mainnet sale, indexed by a Durable Object whose own alarm
// reads new blocks every 15 s (cron triggers don't fire on this account), so page views never touch the RPC.
import { DurableObject } from "cloudflare:workers";
import { parseAbiItem } from "viem";
import { client, M } from "./mainnet.mjs";
import { readSales } from "./sales-read.mjs";
export { readSales };

export const BOUGHT = parseAbiItem("event Bought(uint256 indexed tokenId, address indexed buyer, uint256 band, uint256 price, address wallet, uint256 toWallet, uint256 toTreasury)");
export const DEPLOY_BLOCK = 83657594n;   // DaemonSale's deployment block (contracts/broadcast/DeployMainnet.s.sol)
const EVERY = 15_000, CHUNK = 500_000n;

export class SaleFeed extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sales (token INTEGER PRIMARY KEY, buyer TEXT, band INTEGER, price TEXT, wallet TEXT, block INTEGER, tx TEXT, log INTEGER, at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  }
  meta(k, v) { if (v === undefined) return this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]?.v; this.sql.exec(`INSERT INTO meta VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v)); }
  async kick() { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000); return { ok: true }; }
  async alarm() {
    try {
      const c = client(this.env), latest = await c.getBlockNumber();
      const from = BigInt(this.meta("last") ?? String(DEPLOY_BLOCK - 1n)) + 1n;
      if (from <= latest) {
        const { rows, last } = await readSales((a, b) => c.getLogs({ address: M.sale, event: BOUGHT, fromBlock: a, toBlock: b }), from, latest);
        const times = new Map();
        for (const r of rows) {
          if (!times.has(r.block)) times.set(r.block, Number((await c.getBlock({ blockNumber: BigInt(r.block) })).timestamp) * 1000);
          this.sql.exec(`INSERT OR IGNORE INTO sales VALUES (?,?,?,?,?,?,?,?,?)`, r.token, r.buyer, r.band, r.price, r.wallet, r.block, r.tx, r.logIndex, times.get(r.block));
        }
        this.meta("last", String(last));
      }
      this.meta("ok_at", Date.now()); this.meta("error", "");
    } catch (e) { this.meta("error", (e.shortMessage ?? e.message ?? "").slice(0, 200)); }
    await this.ctx.storage.setAlarm(Date.now() + EVERY);
  }
  recent(n = 24) {
    return {
      sold: this.sql.exec(`SELECT COUNT(*) AS n FROM sales`).toArray()[0].n,
      sales: this.sql.exec(`SELECT * FROM sales ORDER BY block DESC, log DESC LIMIT ?`, n).toArray(),
      indexedTo: Number(this.meta("last") ?? 0), okAt: Number(this.meta("ok_at") ?? 0), error: this.meta("error") || null,
    };
  }
}
