// The score gate (milestone 14, SPEC §4): a daemon's own draft that changes only how a strategy RUNS — its schedule, a
// model prompt or cap — is paper-traded against the current version for 3 days, and merged on its own if it wins.
//
// Paper mode runs the draft through the SAME runtime functions with a `send` that records instead of submitting
// (same pickers, same books, same max_open), quotes x402 instead of paying, and never sends a message. Model calls are
// real (they are what's being judged) on a separate paper budget, so a trial can't starve the version it competes with.
//
// It WINS only if, over the window (≥ 3 days; ≥ 3 paper runs per strategy under trial):
//   1. uptime   — no more failed runs than the current version
//   2. coverage — every message that arrived early enough for its schedule was handled, and it acted at least as often
//   3. cost     — it spent strictly less (model + x402 + dollars out)
// Lost → closed, with the scorecard (rejected diffs stay public). Not enough evidence by day 7, or nothing happened on
// either side → inconclusive: the draft stays held for the holder, with the scorecard as evidence.
import { encodeFunctionData, decodeFunctionData, parseAbi } from "viem";
import { editable, applyChange } from "./reflect.mjs";
import { hashDoc } from "../../lang/check.mjs";
import { INSTRUMENTS } from "../../lang/otc.mjs";

export const TRIAL_MS = 3 * 86_400_000, TRIAL_MAX_MS = 7 * 86_400_000, MIN_RUNS = 3;
const ERC20 = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
const DOLLAR = INSTRUMENTS.tUSDG.address.toLowerCase();

/**
 * Which drafts can be paper-traded: ONLY strategy schedules and strategy model prompts/caps changed, nothing else.
 * → { eligible, strategies: [names], paths, why }
 */
export function trialScope(head, draft) {
  const a = editable(head), b = editable(draft);
  if (Object.keys(a).sort().join() !== Object.keys(b).sort().join()) return { eligible: false, why: "the draft adds or removes a block or step" };
  const paths = Object.keys(b).filter((p) => JSON.stringify(a[p]) !== JSON.stringify(b[p]));
  if (!paths.length) return { eligible: false, why: "nothing a trial could compare changed" };
  let doc = head;
  for (const p of paths) { const r = applyChange(doc, { path: p, value: b[p] }); if (r.error) return { eligible: false, why: r.error }; doc = r.doc; }
  if (hashDoc(doc) !== hashDoc(draft)) return { eligible: false, why: "the draft changes more than schedules, prompts and model caps" };
  const bad = paths.filter((p) => !/^strategy\.[^.]+\.(every|step\.[^.]+\.(prompt|max))$/.test(p));
  if (bad.length) return { eligible: false, why: `${bad.join(", ")} can't be paper-traded (a price or description meets real demand) — held for the holder` };
  return { eligible: true, strategies: [...new Set(paths.map((p) => p.split(".")[1]))], paths };
}

/** dollars that would leave in these calls: approvals of the dollar token (every dollar outflow approves first) */
export function dollarsOut(calls) {
  let micro = 0n;
  for (const [to, data] of calls) {
    if (to.toLowerCase() !== DOLLAR) continue;
    try { const d = decodeFunctionData({ abi: ERC20, data }); if (d.functionName === "approve") micro += d.args[1]; } catch {}
  }
  return Number(micro);
}

/** a `send` that records and never submits (paper), and one that counts dollars out around the real send (head) */
export const paperSend = (tally) => async (_env, _key, _wallet, calls) => { tally.calls.push(...calls); tally.dollarOut += dollarsOut(calls); return calls.map(() => ({ hash: "paper", logs: [] })); };
export const countingSend = (tally, real) => async (env, key, wallet, calls) => { const r = await real(env, key, wallet, calls); tally.dollarOut += dollarsOut(calls); return r; };

/** one run's spend in micro-USDG, either side: model + x402 + dollars out */
export const spendOf = (detail) => (detail?.spent ?? []).reduce((t, s) => t + (s.kind === "model" ? Number(s.micro ?? 0) : s.amount ? Number(s.amount) : 0), 0) + Number(detail?.dollarOut ?? 0);
/** did a run do its work — the agentfile's own skip_if_* rules say when there was nothing to do (same test both sides) */
export const actedOf = (row) => row.ok && !row.detail?.skipped;

/**
 * Score a trial (pure). strategies: [{ name, every (draft, s), inboxDriven }]; head/paper rows: { at, name, ok, detail };
 * paper rows carry detail.consumed = [message at…]; arrivals = message times in the window.
 * → { outcome: "won" | "lost" | "inconclusive", per: {name: metrics}, reasons: [..] }
 */
export function scoreTrial({ strategies, head, paper, arrivals, start, end, now = end }) {
  const per = {}, reasons = [];
  let enough = now - start >= TRIAL_MS, any = false, lost = false;
  const tot = { headSpend: 0, paperSpend: 0 };
  for (const s of strategies) {
    const h = head.filter((r) => r.name === s.name && r.at >= start && r.at <= end), p = paper.filter((r) => r.name === s.name && r.at >= start && r.at <= end);
    const m = {
      runs: { head: h.length, paper: p.length },
      failed: { head: h.filter((r) => !r.ok).length, paper: p.filter((r) => !r.ok).length },
      acted: { head: h.filter(actedOf).length, paper: p.filter(actedOf).length },
      spend: { head: h.reduce((t, r) => t + spendOf(r.detail), 0), paper: p.reduce((t, r) => t + spendOf(r.detail), 0) },
    };
    if (s.inboxDriven) {
      const consumed = new Set(p.flatMap((r) => r.detail?.consumed ?? []));
      const due = arrivals.filter((a) => a >= start && a <= end - s.every * 1000);
      m.messages = { due: due.length, handled: due.filter((a) => consumed.has(a)).length };
    }
    per[s.name] = m;
    tot.headSpend += m.spend.head; tot.paperSpend += m.spend.paper;
    if (m.acted.head + m.acted.paper > 0) any = true;
    if (p.length < MIN_RUNS) enough = false;
    if (m.failed.paper > m.failed.head) { lost = true; reasons.push(`${s.name}: ${m.failed.paper} failed runs vs ${m.failed.head}`); }
    if (m.messages && m.messages.handled < m.messages.due) { lost = true; reasons.push(`${s.name}: handled ${m.messages.handled} of ${m.messages.due} messages`); }
    if (m.acted.paper < m.acted.head) { lost = true; reasons.push(`${s.name}: acted ${m.acted.paper} times vs ${m.acted.head}`); }
  }
  if (!(tot.paperSpend < tot.headSpend)) reasons.push(`spent ${(tot.paperSpend / 1e6).toFixed(6)} vs ${(tot.headSpend / 1e6).toFixed(6)} USDG — not less`);
  const totals = { spend: { head: tot.headSpend, paper: tot.paperSpend } };
  const timedOut = now - start >= TRIAL_MAX_MS;
  if (!enough && !timedOut) return { outcome: "running", per, totals, reasons };
  if (!enough || !any) return { outcome: "inconclusive", per, totals, reasons: [!any ? "neither version did anything in the window" : `fewer than ${MIN_RUNS} paper runs per strategy by day 7`, ...reasons] };
  if (lost || !(tot.paperSpend < tot.headSpend)) return { outcome: "lost", per, totals, reasons };
  return { outcome: "won", per, totals, reasons: [`same work for less: ${(tot.paperSpend / 1e6).toFixed(6)} vs ${(tot.headSpend / 1e6).toFixed(6)} USDG`] };
}

/** when each trial strategy is next due on the DRAFT's schedule (pure) */
export const paperDue = (strategies, lastPaper, now) => strategies.filter((s) => now - (lastPaper[s.name] ?? 0) >= s.every * 1000 - 5 * 60_000).map((s) => s.name);

/** the trial's comparison window opens at the draft's FIRST paper run (both caught up), not at the trial's start (pure) */
export const windowStart = (paperRows, started) => (paperRows.length ? Math.min(...paperRows.map((x) => x.at)) : started);
