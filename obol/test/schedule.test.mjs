// The per-strategy schedule: a daily strategy doesn't ride an hourly sibling's alarm (the daily-cap gate assumes it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { due, HOUR, SLACK } from "../src/schedule.mjs";

const S = { reply: { every: 3600 }, sell: { every: 86400 }, calls: { every: 12 * 3600 } };
const T = 1_800_000_000_000;

test("each strategy runs at its own every, not its fastest sibling's", () => {
  const last = { reply: T - HOUR, sell: T - 2 * HOUR, calls: T - 2 * HOUR };
  assert.deepEqual(due(S, last, T).run, ["reply"]);
  assert.deepEqual(due(S, { ...last, sell: T - 24 * HOUR }, T).run, ["reply", "sell"]);
});

test("never run → due now; an alarm a little early or a slow log row still counts within the slack", () => {
  assert.deepEqual(due(S, {}, T).run, ["reply", "sell", "calls"]);
  assert.deepEqual(due(S, { reply: T - HOUR + SLACK, sell: T, calls: T }, T).run, ["reply"]);
  assert.deepEqual(due(S, { reply: T - HOUR + SLACK + 1, sell: T, calls: T }, T).run, []);
});

test("force: all, one by name, or nothing extra", () => {
  const fresh = { reply: T, sell: T, calls: T };
  assert.deepEqual(due(S, fresh, T, "*").run, ["reply", "sell", "calls"]);
  assert.deepEqual(due(S, fresh, T, "calls").run, ["calls"]);
  assert.deepEqual(due(S, fresh, T, "nope").run, []);
});

test("the next alarm: when the soonest is due again, never under an hour, never over a day", () => {
  assert.equal(due(S, { reply: T, sell: T, calls: T }, T).nextIn, HOUR);
  assert.equal(due({ sell: { every: 86400 }, calls: { every: 43200 } }, { sell: T - 20 * HOUR, calls: T - HOUR }, T).nextIn, 4 * HOUR, "sell is due in 4h, calls in 11h");
  assert.equal(due({ sell: { every: 86400 } }, { sell: T - 23.5 * HOUR }, T).nextIn, HOUR, "floored at an hour");
  assert.equal(due({ calls: { every: 43200 } }, {}, T).nextIn, 12 * HOUR, "it runs now; next in its every");
  assert.equal(due({ weekly: { every: 7 * 86400 } }, { weekly: T }, T).nextIn, 24 * HOUR, "a weekly strategy still wakes the daemon daily (reflect rides the alarm)");
});
