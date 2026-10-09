// The Clock (milestone 12): a Durable Object whose own alarm runs the testnet price mirror every 10 minutes. Cron
// triggers on this account have not fired (Playset's ccsales hit the same thing), so the alarm is the schedule; the
// cron and POST /admin/mirror only kick it. The last result is kept for GET /api/mirror.
import { DurableObject } from "cloudflare:workers";
import { mirrorFeeds } from "./mirror.mjs";

const EVERY = 10 * 60_000;

export class Clock extends DurableObject {
  async kick(now = false) {
    if (now || !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { ok: true, next: await this.ctx.storage.getAlarm(), last: (await this.ctx.storage.get("last")) ?? null };
  }
  async alarm() {
    let last;
    try { last = { at: Date.now(), ok: true, result: await mirrorFeeds(this.env) }; }
    catch (e) { last = { at: Date.now(), ok: false, error: [e.shortMessage ?? e.message, e.details, (e.url ?? e.cause?.url) && `url ${e.url ?? e.cause?.url}`].filter(Boolean).join(" · ").slice(0, 400) }; }
    await this.ctx.storage.put("last", JSON.parse(JSON.stringify(last, (_k, v) => (typeof v === "bigint" ? String(v) : v))));
    await this.ctx.storage.setAlarm(Date.now() + EVERY);   // re-arm first thing after the run, whatever happened
  }
  async status() { return { next: await this.ctx.storage.getAlarm(), last: (await this.ctx.storage.get("last")) ?? null }; }
}
