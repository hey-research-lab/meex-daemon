// One Durable Object per daemon (named by its token ID): its compiled agentfile, its schedule (one alarm), its log.
// Strategies run on the alarm; skills run when a paid request arrives. Every action, success or failure, goes to the
// daemon's own log and to the Floor.
import { DurableObject } from "cloudflare:workers";
import AGENTS from "./agents.json";
import { runSteps, think } from "./steps.mjs";
import { facts, reflectPrompt, parseAnswer, applyChange, scheduleEvidence } from "./reflect.mjs";
import { draftWaiting } from "./notify.mjs";
import { compileDoc } from "../../lang/check.mjs";
import { gates } from "./repo.mjs";
import { D, SALE, ACCOUNT, pub } from "./chain.mjs";

import { due, HOUR } from "./schedule.mjs";
import { ensureIndexes } from "./indexes.mjs";
import { settleDue } from "./swaps.mjs";
import { trialScope, scoreTrial, paperDue, paperSend, countingSend, windowStart } from "./paper.mjs";
import { viaWallet } from "./otc.mjs";
import { billsDue, overdue, dayOf, isoDay } from "./bill.mjs";
import { pay } from "./x402.mjs";
// viem's message embeds the whole request body; keep what explains the failure (short message, details, HTTP status)
const why = (e) => [e.shortMessage ?? e.message, e.details, e.status && `HTTP ${e.status}`].filter(Boolean).join(" · ").slice(0, 300);
const INBOX_PER_HOUR = 30; // per sender

export class Daemon extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS log (at INTEGER, kind TEXT, name TEXT, ok INTEGER, detail TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS think (at INTEGER, micro INTEGER, detail TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bills (day INTEGER PRIMARY KEY, micro INTEGER, tx TEXT, payer TEXT, at INTEGER)`);   // paid think bills (milestone 15)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS commits (hash TEXT PRIMARY KEY, parent TEXT, at INTEGER, author TEXT, reason TEXT, doc TEXT)`);
    // the score gate (milestone 14): one paper trial per eligible self-draft, and the draft's paper runs
    this.sql.exec(`CREATE TABLE IF NOT EXISTS trials (id INTEGER PRIMARY KEY AUTOINCREMENT, proposal INTEGER, started INTEGER, status TEXT, strategies TEXT, score TEXT, ended INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS paper (at INTEGER, trial INTEGER, name TEXT, ok INTEGER, detail TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, author TEXT, role TEXT, base TEXT, doc TEXT, reason TEXT, status TEXT, gates TEXT, plan TEXT, decided_at INTEGER)`);
    try { this.sql.exec(`ALTER TABLE proposals ADD COLUMN evidence TEXT`); } catch {}   // milestone 08: replay evidence (exists after the first run)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS inbox (at INTEGER, sender INTEGER, nonce TEXT, kind TEXT, body TEXT, signer TEXT, role TEXT, UNIQUE(sender, nonce))`);
  }

  id() { return this.sql.exec(`SELECT v FROM meta WHERE k='id'`).toArray()[0]?.v; }
  // ── the repo: the head commit IS the agentfile that runs (genesis = what the build bundled) ─────────────────────
  head() {
    let h = this.sql.exec(`SELECT * FROM commits ORDER BY at DESC, rowid DESC LIMIT 1`).toArray()[0];
    const g = AGENTS[this.id()];
    if (!h && g?.doc) {
      const c = compileDoc(g.doc);
      this.sql.exec(`INSERT OR IGNORE INTO commits VALUES (?,?,?,?,?,?)`, c.hash, null, Date.now(), "build", "genesis: the agentfile the build bundled", JSON.stringify(g.doc));
      h = this.sql.exec(`SELECT * FROM commits ORDER BY at DESC, rowid DESC LIMIT 1`).toArray()[0];
    }
    return h ? { ...h, doc: JSON.parse(h.doc) } : null;
  }
  agentfile() {
    if (!this.id()) return { skills: {}, strategies: {} };
    const h = this.head();
    if (!h) return { skills: {}, strategies: {} };
    if (this._compiled?.version !== h.hash) {
      const c = compileDoc(h.doc);
      this._compiled = { version: h.hash, thinkBudget: c.thinkBudget, otc: c.otc, options: c.options, indexes: c.indexes, swaps: c.swaps, skills: Object.fromEntries(c.skills.map((x) => [x.name, x])), strategies: Object.fromEntries(c.strategies.map((x) => [x.name, x])) };
    }
    return this._compiled;
  }
  skill(name) { return this.agentfile().skills[name] ?? null; }

  /** the wallet's caps, read live: what any version of this daemon may do */
  async walletCaps() {
    const client = pub(this.env);
    const w = await client.readContract({ address: D.sale, abi: SALE, functionName: "walletOf", args: [BigInt(this.id())] });
    const [, , maxPerCall, maxPerDay] = await client.readContract({ address: w, abi: ACCOUNT, functionName: "constitution" });
    return { maxPerCall: Number(maxPerCall), maxPerDay: Number(maxPerDay) };
  }

  /** a verified proposal (repo.mjs checked who wrote it). Holder → gates now; sibling and self → held for the holder. */
  async propose({ doc, reason, role, by, signer, base, evidence = null }) {
    if (!this.id()) return { ok: false, reason: "this daemon isn't booted" };
    const author = role === "holder" ? `holder ${signer}` : role === "sibling" ? `daemon #${by} (${signer})` : "self";
    this.sql.exec(`INSERT INTO proposals (at, author, role, base, doc, reason, status) VALUES (?,?,?,?,?,?,?)`, Date.now(), author, role, base, JSON.stringify(doc), reason, "open");
    const id = this.sql.exec(`SELECT last_insert_rowid() AS id`).toArray()[0].id;
    if (role === "holder") return this.decide(id, "holder");
    const h = this.head();
    const preview = gates({ head: h.doc, headHash: h.hash, doc, base, role, wallet: await this.walletCaps() });
    this.sql.exec(`UPDATE proposals SET status = 'held', gates = ?, plan = ?, evidence = ? WHERE id = ?`, JSON.stringify(preview.gates), JSON.stringify(preview.plan), evidence ? JSON.stringify(evidence) : null, id);
    await this.record("repo", `proposal #${id}`, true, { status: "held for the holder", author, reason, plan: preview.plan, gatesWouldPass: preview.ok });
    // a self-draft that passes every gate and changes only how strategies run → a 3-day paper trial (the score gate)
    let trial = null;
    if (role === "self" && preview.ok) {
      const scope = trialScope(h.doc, doc);
      if (scope.eligible) trial = await this.startTrial(id, scope.strategies);
      else await this.record("trial", `proposal #${id}`, true, { status: "no trial — held for the holder", why: scope.why });
    }
    return { ok: true, id, status: "held", plan: preview.plan, gates: preview.gates, trial };
  }

  /** the holder approved a held proposal (signature checked by the Worker) */
  async approve(id) {
    const p = this.sql.exec(`SELECT * FROM proposals WHERE id = ?`, id).toArray()[0];
    if (!p) return { ok: false, reason: "no such proposal" };
    if (p.status !== "held") return { ok: false, reason: `proposal is ${p.status}, not held` };
    return this.decide(id, "holder");
  }
  /** the holder declined a held proposal (signature checked by the Worker) — closed, reason kept, head untouched */
  async reject(id, reason) {
    const p = this.sql.exec(`SELECT * FROM proposals WHERE id = ?`, id).toArray()[0];
    if (!p) return { ok: false, reason: "no such proposal" };
    if (p.status !== "held") return { ok: false, reason: `proposal is ${p.status}, not held` };
    this.sql.exec(`UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ?`, Date.now(), id);
    await this.record("repo", `proposal #${id}`, false, { status: "rejected by the holder", author: p.author, reason: p.reason, why: reason });
    return { ok: true, id, status: "rejected", why: reason };
  }
  async startTrial(proposal, strategies) {
    this.sql.exec(`INSERT INTO trials (proposal, started, status, strategies) VALUES (?,?,?,?)`, proposal, Date.now(), "running", JSON.stringify(strategies));
    const id = this.sql.exec(`SELECT last_insert_rowid() AS id`).toArray()[0].id;
    await this.record("trial", `proposal #${proposal}`, true, { status: "paper trial started", trial: id, strategies, until: new Date(Date.now() + 3 * 86_400_000).toISOString(), rule: "wins if no more failures, the same work, and strictly less spent — then it merges itself" });
    const a = await this.ctx.storage.getAlarm();
    if (!a || a > Date.now() + 60_000) await this.ctx.storage.setAlarm(Date.now() + 30_000);   // the first paper run soon
    return { id, strategies };
  }

  /** run the active trial's due paper runs; score it; merge, close or leave it held — returns ms until it's next due */
  async runTrials() {
    const t = this.sql.exec(`SELECT * FROM trials WHERE status = 'running' ORDER BY id DESC LIMIT 1`).toArray()[0];
    if (!t) return null;
    const p = this.proposal(t.proposal), h = this.head();
    const end = (status, extra = {}) => { this.sql.exec(`UPDATE trials SET status = ?, ended = ?, score = ? WHERE id = ?`, status, Date.now(), JSON.stringify(extra), t.id); };
    if (!p || p.status !== "held") { end("ended", { why: `the proposal was ${p?.status ?? "removed"} before the trial finished` }); await this.record("trial", `proposal #${t.proposal}`, true, { status: "trial ended", why: `decided first: ${p?.status}` }); return null; }
    if (h.hash !== p.base) { end("ended", { why: "the head moved — the draft no longer applies to what runs" }); await this.record("trial", `proposal #${t.proposal}`, false, { status: "trial ended", why: "the head moved" }); return null; }
    const draft = compileDoc(p.doc), names = JSON.parse(t.strategies);
    const strategies = names.map((n) => ({ name: n, every: draft.strategies.find((x) => x.name === n).every, inboxDriven: draft.strategies.find((x) => x.name === n).steps.some((x) => x.inbox) }));
    const lastPaper = Object.fromEntries(this.sql.exec(`SELECT name, MAX(at) AS at FROM paper WHERE trial = ? GROUP BY name`, t.id).toArray().map((x) => [x.name, x.at]));
    for (const name of paperDue(strategies, lastPaper, Date.now())) {
      const def = draft.strategies.find((x) => x.name === name), tally = { calls: [], dollarOut: 0, would: 0 };
      const key = `paper_cursor:${t.id}:${name}`, from = Number(this.meta(key) ?? t.started);
      const rows = this.sql.exec(`SELECT at, sender, kind, body, role FROM inbox WHERE at > ? ORDER BY at ASC LIMIT 20`, from).toArray();
      let row;
      try {
        const r = await runSteps(this.env, def, { daemonId: +this.id(), agentKey: this.agentKey(), selfFetch: (q, i) => this.env.SELF.fetch(`${this.env.PUBLIC_ORIGIN}${q}`, i),
          inbox: async () => rows.map((m) => ({ from: m.sender, role: m.role, kind: m.kind, body: m.body })), meter: this.meter("paper"), otc: draft.otc, options: draft.options, swaps: draft.swaps, send: paperSend(tally), paper: tally });
        if (rows.length) this.meta(key, rows.at(-1).at);
        row = { ok: 1, detail: { ...(r.skipped ? { skipped: r.output?.skipped } : {}), spent: r.spent, dollarOut: tally.dollarOut, would: tally.would + tally.calls.length, consumed: r.skipped ? [] : rows.map((m) => m.at) } };
      } catch (e) { row = { ok: 0, detail: { error: why(e) } }; }
      this.sql.exec(`INSERT INTO paper VALUES (?,?,?,?,?)`, Date.now(), t.id, name, row.ok, JSON.stringify(row.detail));
    }
    const head = this.sql.exec(`SELECT at, name, ok, detail FROM log WHERE kind = 'strategy' AND at >= ?`, t.started).toArray().filter((x) => names.includes(x.name)).map((x) => ({ ...x, ok: !!x.ok, detail: JSON.parse(x.detail) }));
    const paper = this.sql.exec(`SELECT at, name, ok, detail FROM paper WHERE trial = ?`, t.id).toArray().map((x) => ({ ...x, ok: !!x.ok, detail: JSON.parse(x.detail) }));
    const arrivals = this.sql.exec(`SELECT at FROM inbox WHERE at >= ?`, t.started).toArray().map((x) => x.at);
    // compare from the draft's FIRST paper run: before it, the current version may be answering a backlog that predates
    // the trial (the draft's inbox cursor starts at the trial), which would count against the draft for nothing it did
    const from = windowStart(paper, t.started);
    const score = scoreTrial({ strategies, head, paper, arrivals, start: from, end: Date.now(), now: Date.now() });
    if (score.outcome === "running") return Math.min(...strategies.map((s) => (lastPaper[s.name] ?? Date.now()) + s.every * 1000 - Date.now()).map((x) => Math.max(x, HOUR)));
    this.sql.exec(`UPDATE proposals SET evidence = ? WHERE id = ?`, JSON.stringify({ kind: "paper trial", ...score }), p.id);
    end(score.outcome, score);
    if (score.outcome === "won") {
      const d = await this.decide(p.id, "self");   // every gate runs again on the way in
      await this.record("trial", `proposal #${p.id}`, d.ok, { status: d.ok ? "won its paper trial — merged" : "won its paper trial, but the gates refused the merge", reasons: score.reasons, totals: score.totals, head: d.head });
    } else if (score.outcome === "lost") {
      this.sql.exec(`UPDATE proposals SET status = 'closed', decided_at = ? WHERE id = ?`, Date.now(), p.id);
      await this.record("trial", `proposal #${p.id}`, false, { status: "lost its paper trial — closed", reasons: score.reasons, totals: score.totals });
    } else {
      await this.record("trial", `proposal #${p.id}`, true, { status: "inconclusive — still held for the holder", reasons: score.reasons, totals: score.totals });
    }
    return null;
  }

  proposal(id) { const p = this.sql.exec(`SELECT * FROM proposals WHERE id = ?`, id).toArray()[0]; return p ? { ...p, doc: JSON.parse(p.doc) } : null; }

  /** run the gates; merge (a new head) or reject — with every gate's reason kept */
  async decide(id, authority) {
    const p = this.proposal(id);
    const h = this.head();
    const r = gates({ head: h.doc, headHash: h.hash, doc: p.doc, base: p.base, role: authority, wallet: await this.walletCaps() });
    const status = r.ok ? "merged" : "rejected";
    this.sql.exec(`UPDATE proposals SET status = ?, gates = ?, plan = ?, decided_at = ? WHERE id = ?`, status, JSON.stringify(r.gates), JSON.stringify(r.plan), Date.now(), id);
    if (r.ok) {
      this.sql.exec(`INSERT INTO commits VALUES (?,?,?,?,?,?)`, r.compiled.hash, h.hash, Date.now(), p.author, p.reason, JSON.stringify(p.doc));
      this._compiled = null;
      // a new schedule takes effect at once: arm if it now has strategies and nothing is scheduled
      if ((Object.keys(this.agentfile().strategies).length || compileDoc(p.doc).reflect) && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
    await this.record("repo", `proposal #${id}`, r.ok, r.ok ? { status, author: p.author, reason: p.reason, plan: r.plan, head: r.compiled.hash } : { status, author: p.author, reason: p.reason, error: r.gates.filter((g) => !g.ok).map((g) => `${g.gate}: ${g.detail}`).join(" · ") });
    return { ok: r.ok, id, status, head: r.ok ? r.compiled.hash : h.hash, plan: r.plan, gates: r.gates };
  }

  repo() {
    const h = this.head();
    return {
      head: h ? { hash: h.hash, at: h.at, author: h.author, reason: h.reason, doc: h.doc } : null,
      commits: this.sql.exec(`SELECT hash, parent, at, author, reason FROM commits ORDER BY at DESC LIMIT 50`).toArray(),
      trials: this.sql.exec(`SELECT id, proposal, started, status, strategies, score, ended FROM trials ORDER BY id DESC LIMIT 10`).toArray().map((t) => ({ ...t, strategies: JSON.parse(t.strategies), score: t.score ? JSON.parse(t.score) : null,
        paperRuns: this.sql.exec(`SELECT COUNT(*) AS n FROM paper WHERE trial = ?`, t.id).toArray()[0].n,
        recent: this.sql.exec(`SELECT at, name, ok, detail FROM paper WHERE trial = ? ORDER BY at DESC LIMIT 5`, t.id).toArray().map((x) => ({ ...x, ok: !!x.ok, detail: JSON.parse(x.detail) })) })),
      proposals: this.sql.exec(`SELECT id, at, author, role, base, reason, status, gates, plan, evidence, decided_at FROM proposals ORDER BY id DESC LIMIT 50`).toArray()
        .map((p) => ({ ...p, gates: p.gates ? JSON.parse(p.gates) : null, plan: p.plan ? JSON.parse(p.plan) : null, evidence: p.evidence ? JSON.parse(p.evidence) : null })),
    };
  }
  agentKey() { return this.env[`AGENT_KEY_${this.id()}`]; }

  async record(kind, name, ok, detail) {
    const at = Date.now();
    this.sql.exec(`INSERT INTO log VALUES (?,?,?,?,?)`, at, kind, name, ok ? 1 : 0, JSON.stringify(detail));
    this.sql.exec(`DELETE FROM log WHERE rowid IN (SELECT rowid FROM log ORDER BY at DESC LIMIT -1 OFFSET 500)`);
    await this.env.FLOOR.get(this.env.FLOOR.idFromName("floor")).append({ at, daemon: +this.id(), kind, name, ok, detail });
  }

  /** set the token ID once, then (re)arm the schedule if this daemon has strategies */
  async boot(id) {
    this.sql.exec(`INSERT OR IGNORE INTO meta VALUES ('id', ?)`, String(id));
    const strategies = Object.values(this.agentfile().strategies);
    if (!strategies.length && !compileDoc(this.head()?.doc ?? {}).reflect) return { id, armed: false };
    const next = Date.now() + 30_000; // first run shortly after boot, then every `every`
    await this.ctx.storage.setAlarm(next);
    return { id, armed: true, next: new Date(next).toISOString(), version: this.agentfile().version };
  }

  meta(k, v) {
    if (v === undefined) return this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]?.v;
    this.sql.exec(`INSERT INTO meta VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
  }

  /** the daily think budget (USDG, from the agentfile): reserve a call's worst case first, settle the actual after */
  meter(kind = "think") {   // "paper": a trial's own budget (same size), so a trial can't starve the version it competes with
    const budget = Math.round((this.agentfile().thinkBudget ?? 0) * 1e6);
    const today = String(Math.floor(Date.now() / 86_400_000));
    const spent = () => (this.meta(`${kind}_day`) === today ? Number(this.meta(`${kind}_spent`) ?? 0) : 0);
    const set = (x) => { this.meta(`${kind}_day`, today); this.meta(`${kind}_spent`, x); };
    return {
      reserve: async (worst) => {
        const owed = this.billsOwed();
        if (overdue(owed, dayOf(Date.now()))) throw new Error(`think bill overdue: ${owed.map((b) => `${isoDay(b.day)} ${(b.micro / 1e6).toFixed(6)}`).join(", ")} USDG unpaid — it thinks again once it pays`);
        if (spent() + worst > budget) throw new Error(`think budget: ${(spent() / 1e6).toFixed(6)} of ${(budget / 1e6).toFixed(2)} USDG spent today, a call may cost up to ${(worst / 1e6).toFixed(6)}`);
        set(spent() + worst);
      },
      settle: async (worst, micro, detail) => {
        set(Math.max(0, spent() - worst + micro));
        if (detail) this.sql.exec(`INSERT INTO think VALUES (?,?,?)`, Date.now(), micro, JSON.stringify({ ...detail, ...(kind !== "think" ? { budget: kind } : {}) }));
      },
      today: () => spent(),
    };
  }

  /** think bills (milestone 15): what it owes for closed days, one bill, and marking one paid (by the Worker, after settle) */
  billsOwed() {
    const paid = new Set(this.sql.exec(`SELECT day FROM bills`).toArray().map((b) => b.day));
    return billsDue(this.sql.exec(`SELECT at, micro FROM think`).toArray(), paid, dayOf(Date.now()));
  }
  bill(day) {
    const paid = this.sql.exec(`SELECT * FROM bills WHERE day = ?`, day).toArray()[0];
    if (paid) return { day, micro: paid.micro, paid: true, tx: paid.tx };
    if (day >= dayOf(Date.now())) return { day, micro: 0, paid: false, open: true };   // today isn't closed yet
    const micro = this.sql.exec(`SELECT COALESCE(SUM(micro), 0) AS m FROM think WHERE at >= ? AND at < ?`, day * 86_400_000, (day + 1) * 86_400_000).toArray()[0].m;
    return { day, micro: Number(micro), paid: false };
  }
  async billPaid(day, micro, s) {
    if (!s.success) { await this.record("think-bill", isoDay(day), false, { error: "settlement failed", ...s }); return; }
    this.sql.exec(`INSERT OR IGNORE INTO bills VALUES (?,?,?,?,?)`, day, micro, s.transaction, s.payer, Date.now());
    await this.record("think-bill", isoDay(day), true, { paid: (micro / 1e6).toFixed(6), tx: s.transaction, payer: s.payer });
  }
  /** pay every unpaid closed day, oldest first, through the wallet (x402 to the treasury) */
  async payBills() {
    for (const b of this.billsOwed()) {
      const url = `${this.env.PUBLIC_ORIGIN}/think-bill/${this.id()}/${isoDay(b.day)}`;
      const r = await pay(this.env, { daemonId: +this.id(), agentKey: this.agentKey(), url, max: (b.micro / 1e6).toFixed(6), fetcher: (u, i) => this.env.SELF.fetch(u, i) });
      if (!r.ok) { await this.record("think-bill", isoDay(b.day), false, { owed: (b.micro / 1e6).toFixed(6), error: r.error ?? `HTTP ${r.status}` }); break; }
    }
  }

  /** messages that arrived since this strategy last ran successfully (oldest first, ≤ 20); `commit` advances the cursor */
  inboxSince(strategy) {
    const key = `inbox_cursor:${strategy}`;
    const rows = this.sql.exec(`SELECT at, sender, kind, body, role FROM inbox WHERE at > ? ORDER BY at ASC LIMIT 20`, Number(this.meta(key) ?? 0)).toArray();
    return { rows, commit: () => rows.length && this.meta(key, rows.at(-1).at) };
  }

  /**
   * Reflect (milestone 08): draft ONE change to this daemon's own agentfile from its own record, and propose it as
   * "self" — held for the holder. Facts are computed here (no message bodies); the model names one allow-listed path
   * and a value (reflect.mjs); code applies it, lints it, proposes it. `force` skips the schedule (admin; proofs).
   */
  async reflect({ force = false, model = null } = {}) {
    const f = this.agentfile(), h = this.head();
    const cfg = h ? compileDoc(h.doc).reflect : null;
    if (!cfg || !cfg.every) return { ok: false, skipped: "this agentfile has no reflect block" };
    const last = Number(this.meta("reflect_at") ?? 0);
    if (!force && Date.now() - last < cfg.every * 1000) return { ok: false, skipped: "not due" };
    if (this.sql.exec(`SELECT 1 FROM proposals WHERE role = 'self' AND status = 'held'`).toArray().length)
      return this.reflected({ status: "skipped", why: "a self-proposal is already waiting for the holder" });
    this.meta("reflect_at", Date.now());
    const since = Date.now() - 7 * 86_400_000;
    const rows = {
      log: this.sql.exec(`SELECT at, kind, name, ok, detail FROM log WHERE at > ? AND kind IN ('strategy', 'sale')`, since).toArray(),
      think: this.sql.exec(`SELECT at, micro FROM think WHERE at > ?`, since).toArray(),
      inbox: this.sql.exec(`SELECT at, sender FROM inbox WHERE at > ?`, since).toArray(),   // who and when — never the body
      proposals: this.sql.exec(`SELECT at, role, status FROM proposals ORDER BY id DESC LIMIT 5`).toArray(),
    };
    const fx = facts(rows, { now: Date.now(), budgetMicro: Math.round((f.thinkBudget ?? 0) * 1e6) });
    let text;
    try {
      // `model` (tests only, admin-authenticated) stands in for the model's answer; otherwise one metered Qwen call
      text = model ?? (await think(this.env, { id: "reflect", model: "qwen", max: cfg.max, prompt: reflectPrompt(h.doc, fx) }, { input: {}, steps: {} }, { daemonId: +this.id(), meter: this.meter() })).text;
    } catch (e) { return this.reflected({ status: "failed", why: why(e) }); }
    const a = parseAnswer(text);
    if (!a.change) return this.reflected({ status: "no change", why: a.reason, facts: fx });
    const applied = applyChange(h.doc, a.change);
    if (applied.error) return this.reflected({ status: "refused", why: applied.error, change: a.change.path, facts: fx });
    const lint = compileDoc(applied.doc);
    const errors = [...lint.skills, ...lint.strategies].flatMap((x) => x.errors).concat(lint.reflectErrors ?? []);
    if (errors.length) return this.reflected({ status: "refused", why: `the draft doesn't compile: ${errors.join("; ").slice(0, 280)}`, change: a.change.path });
    // the evidence a holder can weigh: for a schedule change on an inbox-driven strategy, a replay of the real record
    let evidence = null;
    const m = a.change.path.match(/^strategy\.([^.]+)\.every$/);
    const st = m && f.strategies[m[1]];
    if (st && st.steps.some((x) => x.inbox && x.skip_if_empty)) {
      const think = rows.think, avgCallMicro = think.length ? think.reduce((x, t) => x + Number(t.micro), 0) / think.length : 0;
      const hours = (v) => Number(String(v).replace(/h$/, "")) * 3600;
      evidence = { kind: "schedule replay", ...scheduleEvidence(rows.inbox.map((r) => r.at), { oldEvery: st.every, newEvery: hours(a.change.value), from: since, to: Date.now(), avgCallMicro }) };
    }
    const p = await this.propose({ doc: applied.doc, reason: `self: ${a.reason}`, role: "self", base: h.hash, evidence });
    if (!model) await draftWaiting(this.env, { daemon: +this.id(), proposal: p.id, reason: `self: ${a.reason}`, plan: p.plan, gates: p.gates, evidence }).catch(() => false);   // stand-in answers (proofs) don't email
    return this.reflected({ status: "proposed", proposal: p.id, change: a.change.path, why: a.reason, gatesWouldPass: p.gates?.every((g) => g.ok) ?? null, evidence });
  }
  async reflected(r) { await this.record("reflect", "reflect", ["proposed", "no change", "skipped"].includes(r.status), r); return { ok: true, ...r }; }

  /** run this daemon's strategies in a few seconds (admin; testing) — its regular schedule resumes after */
  async runSoon(strategy = "*") {
    if (!this.id()) return { ok: false };
    if (strategy !== "*" && !this.agentfile().strategies[strategy]) return { ok: false, error: `no strategy "${strategy}"` };
    await this.ctx.storage.put("force", strategy);
    await this.ctx.storage.setAlarm(Date.now() + 3000);
    return { ok: true, strategy };
  }

  /** when each strategy last ran (ok, failed or skipped — any row) */
  lastRuns() {
    return Object.fromEntries(this.sql.exec(`SELECT name, MAX(at) AS at FROM log WHERE kind = 'strategy' GROUP BY name`).toArray().map((r) => [r.name, r.at]));
  }

  async alarm() {
    const f = this.agentfile();
    const force = (await this.ctx.storage.get("force")) ?? null;
    await this.ctx.storage.delete("force");
    const { run, nextIn } = due(f.strategies, this.lastRuns(), Date.now(), force);
    // think bills: pay yesterday's (and any older unpaid) model calls before thinking again
    if (this.agentKey()) { try { await this.payBills(); } catch (e) { await this.record("think-bill", "pay", false, { error: why(e) }); } }
    // swaps it's party to: settle the ended ones on their first price round at/after expiry, refund past the grace period
    if (f.swaps && this.agentKey()) {
      try { for (const r of await settleDue(this.env, { daemonId: +this.id(), agentKey: this.agentKey() })) if (!r.waiting) await this.record("swap", `#${r.settled ?? r.refunded}`, true, r); }
      catch (e) { await this.record("swap", "settle", false, { error: why(e) }); }
    }
    // publish: create any index block not yet on chain (before strategies, so a mint can follow on the same run)
    if (f.indexes?.indexes?.length && this.agentKey()) {
      try { for (const r of await ensureIndexes(this.env, { daemonId: +this.id(), agentKey: this.agentKey(), declared: f.indexes.indexes })) await this.record("index", r.symbol, !r.error, r); }
      catch (e) { await this.record("index", "publish", false, { error: why(e) }); }
    }
    for (const name of run) {
      const st = f.strategies[name];
      if (!this.agentKey()) { await this.record("strategy", name, false, { error: "no agent key set for this daemon" }); continue; }
      try {
        const box = this.inboxSince(name), tally = { dollarOut: 0 };
        const r = await runSteps(this.env, st, { daemonId: +this.id(), agentKey: this.agentKey(), selfFetch: (p, i) => this.env.SELF.fetch(`${this.env.PUBLIC_ORIGIN}${p}`, i),
          inbox: async () => box.rows.map((m) => ({ from: m.sender, role: m.role, kind: m.kind, body: m.body })), meter: this.meter(), otc: f.otc, options: f.options, swaps: f.swaps,
          send: countingSend(tally, viaWallet) });   // dollars out, measured the way a paper trial measures them
        box.commit(); // only after success: a failed run sees the same messages next time
        if (r.skipped && !r.spent.length) { this.sql.exec(`INSERT INTO log VALUES (?,?,?,?,?)`, Date.now(), "strategy", name, 1, JSON.stringify({ skipped: r.output.skipped })); continue; } // quiet: not on the Floor
        await this.record("strategy", name, true, { output: r.output, spent: r.spent, ...(tally.dollarOut ? { dollarOut: tally.dollarOut } : {}) });   // a run that moved anything is always on the Floor
      } catch (e) {
        await this.record("strategy", name, false, { error: why(e) });
      }
    }
    try { await this.reflect(); } catch (e) { await this.record("reflect", "reflect", false, { status: "failed", why: why(e) }); }
    let trialIn = null;
    try { trialIn = await this.runTrials(); } catch (e) { await this.record("trial", "paper", false, { error: why(e) }); }
    // a forced run asked for while this one ran must not be pushed out by the regular schedule
    const pending = await this.ctx.storage.get("force");
    await this.ctx.storage.setAlarm(Date.now() + (pending ? 3000 : Math.min(nextIn, trialIn ?? Infinity))); // each strategy at its own every; never more often than hourly
  }

  /** a skill this daemon sells — called by the Worker after the payment verified */
  async runSkill(name, input) {
    const sk = this.agentfile().skills[name];
    if (!sk) return { error: "no such skill" };
    const r = await runSteps(this.env, sk, { daemonId: +this.id(), agentKey: this.agentKey(), input, selfFetch: (p, i) => this.env.SELF.fetch(`${this.env.PUBLIC_ORIGIN}${p}`, i), meter: this.meter() });
    return { output: r.output };
  }

  /** a verified message (messages.mjs did the signature + chain checks); here: replays and floods */
  async receive(v, body) {
    if (!this.id()) return { ok: false, reason: "this daemon isn't booted" };
    const refuse = async (reason) => { await this.record("message", `from #${v.from}`, false, { from: v.from, error: reason }); return { ok: false, reason }; };
    const hour = this.sql.exec(`SELECT COUNT(*) AS n FROM inbox WHERE sender = ? AND at > ?`, v.from, Date.now() - HOUR).toArray()[0].n;
    if (hour >= INBOX_PER_HOUR) return refuse(`over ${INBOX_PER_HOUR} messages an hour from #${v.from}`);
    const dup = this.sql.exec(`SELECT 1 FROM inbox WHERE sender = ? AND nonce = ?`, v.from, v.nonce).toArray().length;
    if (dup) return refuse("replayed (this nonce was already delivered)");
    this.sql.exec(`INSERT INTO inbox VALUES (?,?,?,?,?,?,?)`, Date.now(), v.from, v.nonce, v.kind, body, v.signer, v.role);
    this.sql.exec(`DELETE FROM inbox WHERE rowid IN (SELECT rowid FROM inbox ORDER BY at DESC LIMIT -1 OFFSET 500)`);
    await this.record("message", `from #${v.from}`, true, { from: v.from, kind: v.kind, role: v.role, body: body.slice(0, 280) });
    return { ok: true };
  }

  /** a refusal decided before the inbox (bad signature, stale…) still belongs on this daemon's log and the Floor */
  async refused(from, reason) { await this.record("message", `from #${from ?? "?"}`, false, { from, error: reason }); }

  inbox(n = 50) { return this.sql.exec(`SELECT at, sender, kind, body, role, signer FROM inbox ORDER BY at DESC LIMIT ?`, n).toArray(); }

  async recordSale(name, settlement) { await this.record("sale", name, settlement.success, settlement); }

  /** everything the daemon's own screen (the OS, /d/<id>/os) shows that lives in this Durable Object */
  async osData() {
    const f = this.agentfile(), last = this.lastRuns(), next = await this.ctx.storage.getAlarm(), r = this.repo();
    const parse = (rows) => rows.map((x) => ({ ...x, ok: !!x.ok, detail: JSON.parse(x.detail) }));
    return {
      id: +this.id(), version: f.version ?? null, nextRun: next ? new Date(next).toISOString() : null,
      think: { budget: f.thinkBudget ?? 0, today: this.meter().today() / 1e6,
        owed: this.billsOwed().map((b) => ({ day: isoDay(b.day), usd: b.micro / 1e6 })),
        paid: this.sql.exec(`SELECT day, micro, tx FROM bills ORDER BY day DESC LIMIT 7`).toArray().map((b) => ({ day: isoDay(b.day), usd: b.micro / 1e6, tx: b.tx })) },
      skills: Object.values(f.skills).map((x) => ({ name: x.name, price: x.price, description: x.description })),
      strategies: Object.values(f.strategies).map((x) => ({ name: x.name, every: x.every, description: x.description, lastRun: last[x.name] ?? null, nextDue: last[x.name] ? last[x.name] + x.every * 1000 : null })),
      limits: { otc: f.otc ? { instruments: f.otc.instruments, maxOpen: f.otc.maxOpen, maxUsd: f.otc.maxUsd } : null, options: f.options ? { underlyings: f.options.underlyings, maxOpen: f.options.maxOpen, maxUsd: f.options.maxUsd } : null,
        swaps: f.swaps ? { underlyings: f.swaps.underlyings, maxOpen: f.swaps.maxOpen, maxUsd: f.swaps.maxUsd } : null, indexes: f.indexes ? f.indexes.indexes.map((x) => ({ symbol: x.symbol, name: x.name, basket: x.basket.map((l) => `${l.amount} ${l.sym}`) })) : null },
      log: parse(this.sql.exec(`SELECT * FROM log ORDER BY at DESC LIMIT 100`).toArray()),   // skips included: the OS shows every skip with its reason
      inbox: this.sql.exec(`SELECT at, sender, kind, body, role FROM inbox ORDER BY at DESC LIMIT 30`).toArray(),
      repo: { head: r.head ? { hash: r.head.hash, at: r.head.at, author: r.head.author, reason: r.head.reason } : null, commits: r.commits.slice(0, 15),
        trials: r.trials.map((t) => ({ id: t.id, proposal: t.proposal, started: t.started, status: t.status, strategies: t.strategies, paperRuns: t.paperRuns, reasons: t.score?.reasons ?? [], totals: t.score?.totals ?? null })),
        proposals: r.proposals.slice(0, 15).map((p) => ({ id: p.id, at: p.at, author: p.author, role: p.role, reason: p.reason, status: p.status, plan: p.plan, failed: (p.gates ?? []).filter((g) => !g.ok).map((g) => `${g.gate}: ${g.detail}`) })) },
    };
  }

  async status() {
    const next = await this.ctx.storage.getAlarm();
    const f = this.agentfile();
    return {
      id: +this.id(), version: f.version ?? null, thinkBudget: f.thinkBudget ?? 0, thinkSpentToday: this.meter().today() / 1e6, skills: Object.keys(f.skills), strategies: Object.keys(f.strategies),
      nextRun: next ? new Date(next).toISOString() : null,
      log: this.sql.exec(`SELECT * FROM log ORDER BY at DESC LIMIT 20`).toArray().map((r) => ({ ...r, ok: !!r.ok, detail: JSON.parse(r.detail) })),
    };
  }
}

/** The Floor's feed: every daemon's events, newest first (the last 1,000). */
export class Floor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ev (at INTEGER, daemon INTEGER, kind TEXT, name TEXT, ok INTEGER, detail TEXT)`);
  }
  async append(e) {
    this.sql.exec(`INSERT INTO ev VALUES (?,?,?,?,?,?)`, e.at, e.daemon, e.kind, e.name, e.ok ? 1 : 0, JSON.stringify(e.detail));
    this.sql.exec(`DELETE FROM ev WHERE rowid IN (SELECT rowid FROM ev ORDER BY at DESC LIMIT -1 OFFSET 1000)`);
  }
  async recent(n = 50) {
    return this.sql.exec(`SELECT * FROM ev ORDER BY at DESC LIMIT ?`, n).toArray().map((r) => ({ ...r, ok: !!r.ok, detail: JSON.parse(r.detail) }));
  }
}
