// Think bills (milestone 15): which closed days are owed, when a daemon stops thinking, and day naming.
import { test } from "node:test";
import assert from "node:assert/strict";
import { billsDue, overdue, dayOf, isoDay, dayFromIso, DAY, GRACE_DAYS } from "../src/bill.mjs";

const D0 = dayOf(Date.parse("2026-10-08T00:00:00Z"));
const at = (d, h = 12) => (D0 + d) * DAY + h * 3_600_000;

test("bills: one per CLOSED day with metered spend, summed, oldest first; today and paid days aren't billed", () => {
  const rows = [{ at: at(-2), micro: 300 }, { at: at(-2, 23), micro: 200 }, { at: at(-1), micro: 35 }, { at: at(0), micro: 999 }, { at: at(-3), micro: 0 }];
  assert.deepEqual(billsDue(rows, new Set(), D0), [{ day: D0 - 2, micro: 500 }, { day: D0 - 1, micro: 35 }]);
  assert.deepEqual(billsDue(rows, new Set([D0 - 2]), D0), [{ day: D0 - 1, micro: 35 }]);
  assert.deepEqual(billsDue([{ at: (D0 - 1) * DAY + DAY - 1, micro: 7 }, { at: D0 * DAY, micro: 9 }], new Set(), D0), [{ day: D0 - 1, micro: 7 }], "the last ms of a day is that day; midnight is the next");
  assert.deepEqual(billsDue([], new Set(), D0), []);
  assert.deepEqual(billsDue([{ at: at(-1), micro: 5 }, { at: at(-4), micro: 6 }], new Set(), D0).map((b) => b.day), [D0 - 4, D0 - 1], "oldest first, whatever order the rows come in (payBills stops at the first failure)");
});

test("overdue: unpaid for more than the grace days stops thinking; within them it doesn't", () => {
  assert.equal(GRACE_DAYS, 2);
  assert.equal(overdue([{ day: D0 - 1, micro: 1 }, { day: D0 - 2, micro: 1 }], D0), false);
  assert.equal(overdue([{ day: D0 - 3, micro: 1 }], D0), true);
  assert.equal(overdue([], D0), false);
});

test("day names round-trip; junk isn't a day", () => {
  assert.equal(isoDay(D0), "2026-10-08");
  assert.equal(dayFromIso("2026-10-08"), D0);
  for (const bad of ["2026-10-8", "yesterday", "2026-10-08T00", ""]) assert.equal(dayFromIso(bad), null, bad);
});
