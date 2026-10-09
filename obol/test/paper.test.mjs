// The score gate (milestone 14): which drafts get a paper trial, how paper runs count, and how a trial is scored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { trialScope, dollarsOut, paperSend, countingSend, spendOf, actedOf, scoreTrial, paperDue, windowStart, TRIAL_MS, TRIAL_MAX_MS } from "../src/paper.mjs";
import { applyChange } from "../src/reflect.mjs";
import { runSteps } from "../src/steps.mjs";
import { INSTRUMENTS } from "../../lang/otc.mjs";

const DOC = {
  skill: { top_movers: [{ description: "The two movers.", price: "0.02", timeout: "60s", input: [{}], step: { movers: [{ mob: "top_movers" }] }, output: "${steps.movers.body}" }] },
  think_budget: "0.05",
  strategy: { reply: [{ description: "Hourly reply.", every: "2h", input: [{}], step: {
    read: [{ inbox: "new", skip_if_empty: true }],
    think: [{ model: "qwen", max: "0.001", prompt: "Messages: ${steps.read.body} Reply briefly." }],
    answer: [{ message: 2, body: "${steps.think.body}" }],
  } }] },
};
const change = (path, value) => applyChange(DOC, { path, value }).doc;

test("trial scope: schedules and model prompts/caps get a trial; prices, descriptions and anything else don't", () => {
  assert.deepEqual(trialScope(DOC, change("strategy.reply.every", "4h")), { eligible: true, strategies: ["reply"], paths: ["strategy.reply.every"] });
  assert.equal(trialScope(DOC, change("strategy.reply.step.think.prompt", "Messages: ${steps.read.body} One line.")).eligible, true);
  assert.equal(trialScope(DOC, change("strategy.reply.step.think.max", "0.0008")).eligible, true);
  assert.match(trialScope(DOC, change("skill.top_movers.price", "0.03")).why, /can't be paper-traded/);
  assert.match(trialScope(DOC, change("skill.top_movers.description", "Two movers.")).why, /can't be paper-traded/);
  const sneaky = change("strategy.reply.every", "4h"); sneaky.strategy.reply[0].step.answer[0].message = 3;   // plus a non-editable change
  assert.match(trialScope(DOC, sneaky).why, /more than schedules/);
  const added = structuredClone(DOC); added.strategy.reply[0].step.extra = [{ model: "qwen", max: "0.001", prompt: "x" }];
  assert.match(trialScope(DOC, added).why, /adds or removes/);
  assert.match(trialScope(DOC, structuredClone(DOC)).why, /nothing/);
});

const ERC20 = parseAbi(["function approve(address spender,uint256 amount) returns (bool)", "function transfer(address to,uint256 amount) returns (bool)"]);
const USDG = INSTRUMENTS.tUSDG.address, NVDA = INSTRUMENTS.tNVDA.address, X = "0x00000000000000000000000000000000000000a1";
const approve = (token, amt) => [token, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [X, amt] })];

test("dollars out = approvals of the dollar token, nothing else; paper records and never sends; head counts the same way", async () => {
  const calls = [approve(USDG, 1_800_000n), approve(NVDA, 3n * 10n ** 18n), [X, "0xdeadbeef"], approve(USDG.toLowerCase(), 200_000n), [USDG, encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [X, 9n] })]];
  assert.equal(dollarsOut(calls), 2_000_000);
  const t = { calls: [], dollarOut: 0 };
  const r = await paperSend(t)({}, "k", "w", calls);
  assert.deepEqual([t.calls.length, t.dollarOut, r.every((x) => x.hash === "paper" && x.logs.length === 0)], [5, 2_000_000, true]);
  const h = { dollarOut: 0 }; let sent = 0;
  await countingSend(h, async (_e, _k, _w, c) => { sent += c.length; return c.map(() => ({ hash: "0x1", logs: [] })); })({}, "k", "w", calls);
  assert.deepEqual([sent, h.dollarOut], [5, 2_000_000]);
});

test("spend and acted: model + x402 (paid or quoted) + dollars out; a skipped run did no work", () => {
  assert.equal(spendOf({ spent: [{ kind: "model", micro: 300 }, { amount: "20000", to: X }, { kind: "x402-quote", amount: "20000", to: X }, { kind: "otc-take" }], dollarOut: 1_800_000 }), 300 + 20000 + 20000 + 1_800_000);
  assert.equal(actedOf({ ok: true, detail: { spent: [] } }), true);
  assert.equal(actedOf({ ok: true, detail: { skipped: "no new messages" } }), false);
  assert.equal(actedOf({ ok: false, detail: { error: "x" } }), false);
});

const H = 3_600_000, T0 = 1_800_000_000_000;
const rows = (name, n, every, mk) => Array.from({ length: n }, (_, i) => ({ at: T0 + (i + 1) * every, name, ...mk(i) }));
const run = (micro) => () => ({ ok: true, detail: { spent: [{ kind: "model", micro }] } });
const S = [{ name: "reply", every: 4 * 3600, inboxDriven: true }];

test("score: the same work for less wins", () => {
  const arrivals = [T0 + 1 * H, T0 + 10 * H, T0 + 30 * H, T0 + 50 * H];
  const head = rows("reply", 4, 18 * H, run(400));
  const paper = rows("reply", 4, 18 * H, (i) => ({ ok: true, detail: { spent: [{ kind: "model", micro: 300 }], consumed: arrivals } }));
  const s = scoreTrial({ strategies: S, head, paper, arrivals, start: T0, end: T0 + TRIAL_MS });
  assert.equal(s.outcome, "won", s.reasons.join("; "));
  assert.deepEqual(s.totals.spend, { head: 1600, paper: 1200 });
});

test("score: it loses on cost, uptime, coverage or doing less — each on its own", () => {
  const arrivals = [T0 + H];
  const head = rows("reply", 4, 18 * H, run(400));
  const good = (i) => ({ ok: true, detail: { spent: [{ kind: "model", micro: 300 }], consumed: arrivals } });
  const sc = (paper) => scoreTrial({ strategies: S, head, paper, arrivals, start: T0, end: T0 + TRIAL_MS });
  const equal = sc(rows("reply", 4, 18 * H, () => ({ ok: true, detail: { spent: [{ kind: "model", micro: 400 }], consumed: arrivals } })));
  assert.deepEqual([equal.outcome, equal.reasons.length], ["lost", 1], "the same work at the same cost isn't a win — and cost is the only reason");
  assert.match(equal.reasons[0], /not less/);
  assert.match(sc(rows("reply", 4, 18 * H, (i) => (i === 0 ? { ok: false, detail: { error: "x" } } : good(i)))).reasons.join(), /failed runs/);
  assert.match(sc(rows("reply", 4, 18 * H, (i) => ({ ...good(i), detail: { ...good(i).detail, consumed: [] } }))).reasons.join(), /handled 0 of 1 messages/);
  assert.match(sc(rows("reply", 4, 18 * H, (i) => (i < 2 ? { ok: true, detail: { skipped: "no new messages", consumed: arrivals } } : good(i)))).reasons.join(), /acted 2 times vs 4/);
  for (const p of [rows("reply", 4, 18 * H, (i) => (i === 0 ? { ok: false, detail: { error: "x" } } : good(i)))]) assert.equal(sc(p).outcome, "lost");
});

test("score: a message that arrived too late for the draft's schedule isn't held against it", () => {
  const late = T0 + TRIAL_MS - 2 * H;   // the draft runs every 4h: this one wasn't due yet
  const head = rows("reply", 4, 18 * H, run(400));
  const paper = rows("reply", 4, 18 * H, () => ({ ok: true, detail: { spent: [{ kind: "model", micro: 300 }], consumed: [T0 + H] } }));
  assert.equal(scoreTrial({ strategies: S, head, paper, arrivals: [T0 + H, late], start: T0, end: T0 + TRIAL_MS }).outcome, "won");
});

test("score: still running before day 3 or before 3 paper runs; inconclusive by day 7 or when nothing happened", () => {
  const head = rows("reply", 4, 18 * H, run(400)), paper = rows("reply", 4, 18 * H, run(300));
  assert.equal(scoreTrial({ strategies: S, head, paper, arrivals: [], start: T0, end: T0 + TRIAL_MS - 1 }).outcome, "running");
  assert.equal(scoreTrial({ strategies: S, head, paper: paper.slice(0, 2), arrivals: [], start: T0, end: T0 + TRIAL_MS }).outcome, "running", "too few paper runs: keep going");
  assert.match(scoreTrial({ strategies: S, head, paper: paper.slice(0, 2), arrivals: [], start: T0, end: T0 + TRIAL_MAX_MS }).reasons[0], /fewer than 3 paper runs/);
  const idle = rows("reply", 4, 18 * H, () => ({ ok: true, detail: { skipped: "no new messages" } }));
  const s = scoreTrial({ strategies: S, head: idle, paper: idle, arrivals: [], start: T0, end: T0 + TRIAL_MS });
  assert.deepEqual([s.outcome, s.reasons[0]], ["inconclusive", "neither version did anything in the window"]);
  assert.equal(scoreTrial({ strategies: S, head, paper, arrivals: [], start: T0, end: T0 + TRIAL_MS + 1, now: T0 + TRIAL_MS + 1 }).outcome, "won");
});

test("score: only rows in the window, only the strategies under trial", () => {
  const head = [...rows("reply", 4, 18 * H, run(400)), { at: T0 - H, name: "reply", ok: false, detail: { error: "before" } }, { at: T0 + H, name: "other", ok: false, detail: { error: "x" } }];
  const paper = rows("reply", 4, 18 * H, run(300));
  const s = scoreTrial({ strategies: S, head, paper, arrivals: [], start: T0, end: T0 + TRIAL_MS });
  assert.deepEqual(s.per.reply.failed, { head: 0, paper: 0 });
  assert.equal(s.outcome, "won");
});

test("paper runs on the DRAFT's schedule", () => {
  const st = [{ name: "a", every: 3600 }, { name: "b", every: 4 * 3600 }];
  assert.deepEqual(paperDue(st, {}, T0), ["a", "b"]);
  assert.deepEqual(paperDue(st, { a: T0 - H, b: T0 - H }, T0), ["a"]);
});

test("paper mode in the step runner: x402 is quoted, not paid; a message isn't sent", async () => {
  const def = { steps: [{ id: "buy", x402: "https://obol.sh/d/1/top_movers", max: "0.02" }, { id: "tell", message: 1, body: "got ${steps.buy.body}" }] };
  const req = btoa(JSON.stringify({ accepts: [{ scheme: "exact", network: "eip155:46630", amount: "20000", payTo: X }] }));
  const fetched = [];
  const selfFetch = async (path, init) => { fetched.push([path, init?.method ?? "GET"]); return new Response("{}", { status: 402, headers: { "payment-required": req } }); };
  const tally = { calls: [], dollarOut: 0, would: 0 };
  const r = await runSteps({ PUBLIC_ORIGIN: "https://obol.sh" }, def, { daemonId: 2, agentKey: "0x1", selfFetch, paper: tally, send: paperSend(tally) });
  assert.deepEqual(r.spent, [{ kind: "x402-quote", amount: "20000", to: X }]);
  assert.deepEqual(fetched, [["/d/1/top_movers", "GET"]], "one unpaid GET for the quote; no payment, no inbox POST");
  assert.equal(tally.would, 2);
  assert.deepEqual(r.output, { wouldSend: true, to: 1 });
});

test("the window opens at the first paper run: the current version's pre-trial backlog doesn't count against the draft", () => {
  assert.equal(windowStart([], T0), T0);
  assert.equal(windowStart([{ at: T0 + 5 * H }, { at: T0 + 2 * H }], T0), T0 + 2 * H);
  // the current version answered a backlog in the same alarm, just before the first paper run (which found nothing new)
  const p0 = T0 + 1000, head = [{ at: T0 + 500, name: "reply", ok: true, detail: { spent: [{ kind: "model", micro: 400 }] } }, ...rows("reply", 4, 18 * H, run(400))];
  const paper = [{ at: p0, name: "reply", ok: true, detail: { skipped: "no new messages" } }, ...rows("reply", 4, 18 * H, () => ({ ok: true, detail: { spent: [{ kind: "model", micro: 300 }], consumed: [] } }))];
  assert.match(scoreTrial({ strategies: S, head, paper, arrivals: [], start: T0, end: T0 + TRIAL_MS }).reasons.join(), /acted 4 times vs 5/, "from the trial's start it would lose");
  assert.equal(scoreTrial({ strategies: S, head, paper, arrivals: [], start: windowStart(paper, T0), end: p0 + TRIAL_MS }).outcome, "won", "three full days from the first paper run");
});
