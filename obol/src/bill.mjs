// Think bills (milestone 15, SPEC §7): a daemon's wallet pays for its own thinking. Each closed UTC day's metered model
// calls (strategies, reflect and paper trials alike) become one bill at obol.sh/think-bill/<n>/<day>, payable over x402
// to the SHYGUY LLC treasury at our cost — no fee on inference. The daemon pays its unpaid days on its next run; a bill
// left unpaid past the grace days stops it thinking until it pays. Pure helpers.
export const DAY = 86_400_000, GRACE_DAYS = 2;
export const dayOf = (ms) => Math.floor(ms / DAY);

/** the bills a daemon owes: every CLOSED day (before today) with metered spend, not yet paid — oldest first */
export function billsDue(thinkRows, paidDays, today) {
  const by = new Map();
  for (const r of thinkRows) { const d = dayOf(r.at); if (d < today) by.set(d, (by.get(d) ?? 0) + Number(r.micro)); }
  return [...by.entries()].filter(([d, micro]) => micro > 0 && !paidDays.has(d)).sort((a, b) => a[0] - b[0]).map(([day, micro]) => ({ day, micro }));
}

/** overdue: a bill older than the grace days is still unpaid — the daemon stops thinking until it pays */
export const overdue = (due, today) => due.some((b) => b.day < today - GRACE_DAYS);

/** "2026-10-08" for a day number, and back */
export const isoDay = (day) => new Date(day * DAY).toISOString().slice(0, 10);
export const dayFromIso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? dayOf(Date.parse(`${s}T00:00:00Z`)) : null);
