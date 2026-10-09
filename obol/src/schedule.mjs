// Which strategies run on this alarm (pure). Each strategy keeps its OWN `every` — the plan-time daily-cap gate
// (repo.mjs, within(wallet)) assumes exactly that, so a daily strategy must not ride an hourly sibling's alarm.
// A run that failed or skipped still counts as a run (a failing trade isn't retried every hour).
export const SLACK = 5 * 60_000;   // an alarm lands a little after its time, and a run's log row a little after it starts
export const HOUR = 3600_000;

/**
 * @param strategies { name: { every (s) } }   @param last { name: ms of its last run }   @param force "*" | name | null
 * → { run: [names, in agentfile order], nextIn: ms until the next one is due (≥ 1 h) }
 */
export function due(strategies, last, now, force = null) {
  const run = [];
  let nextIn = 24 * HOUR;
  for (const [name, st] of Object.entries(strategies)) {
    const every = st.every * 1000, at = last[name] ?? 0;
    const isDue = force === "*" || force === name || now - at >= every - SLACK;
    if (isDue) run.push(name);
    nextIn = Math.min(nextIn, isDue ? every : at + every - now);
  }
  return { run, nextIn: Math.max(nextIn, HOUR) };   // never more often than hourly (testnet gas budget)
}
