// The agentfile checks, on the PARSED form (JSON) — no parser here, so the obol Worker can run them on proposals.
// lang/compile.mjs parses HCL (Go/wasm, Mac-side) and calls compileDoc; the Worker calls compileDoc on stored docs.
// A doc's steps run in the order its `step` object lists them (JS keeps string-key insertion order).
import { createHash } from "node:crypto";
export const RHC = {
  network: "eip155:4663",
  asset: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG (Paxos Global Dollar) on Robinhood Chain; EIP-3009 present
  decimals: 6,
  name: "Global Dollar",
};
const STEP_KINDS = new Set(["x402", "fetch", "model", "mob", "pick", "message", "inbox", "offer", "take", "write_option", "buy_option", "exercise", "mint_index", "redeem_index", "swap_offer", "swap_take"]);
import { checkOtc, checkOtcStep } from "./otc.mjs";
import { checkOptions, checkOptionStep } from "./options.mjs";
import { checkIndexes, checkIndexStep } from "./indexes.mjs";
import { checkSwaps, checkSwapStep } from "./swaps.mjs";
import { MODELS, worstCost } from "./models.mjs";
export { MODELS, worstCost };
const FETCH_ALLOW = [/^https:\/\/obol\.sh\/d\//, /^https:\/\/(www\.)?retcg\.xyz\//, /^https:\/\/slabbasis\.xyz\//, /^https:\/\/mob\.markets\/api\//, /^https:\/\/revere\.fi\/api\//, /^https:\/\/clawg\.network\/v1\//];
const REF = /\$\{(input|steps)\.([a-zA-Z_][\w.]*)\}/g; // the only expressions allowed: references, no calls

const usd = (s) => { const m = String(s).trim().match(/^(\d+(?:\.\d{1,6})?)$/); if (!m) throw new Error(`bad amount "${s}" (plain decimal, USDG)`); return Number(m[1]); };
const atomic = (x) => String(Math.round(x * 10 ** RHC.decimals));
const secs = (s) => { const m = String(s).match(/^(\d+)(s|m)$/); if (!m) throw new Error(`bad duration "${s}"`); return +m[1] * (m[2] === "m" ? 60 : 1); };
const one = (v) => (Array.isArray(v) ? v[0] : v);

function refsIn(v, out = []) {
  if (typeof v === "string") for (const m of v.matchAll(REF)) out.push(`${m[1]}.${m[2]}`);
  else if (v && typeof v === "object") for (const x of Object.values(v)) refsIn(x, out);
  return out;
}
function noCalls(v, where) {
  if (typeof v === "string" && /\$\{/.test(v) && v.replace(REF, "").includes("${")) throw new Error(`${where}: only \${input.x} / \${steps.y.z} references are allowed, not expressions`);
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) noCalls(x, `${where}.${k}`);
}

export function checkSkill(name, raw, { maxPerStep = 1, otc = null, options = null, indexes = null, swaps = null, strategy = false } = {}) {
  const s = one(raw);
  const errors = [];
  const tryit = (f) => { try { return f(); } catch (e) { errors.push(e.message); } };
  const price = tryit(() => usd(s.price));
  const timeout = tryit(() => secs(s.timeout ?? "30s"));
  if (!s.description || s.description.length > 500) errors.push("description: required, ≤500 chars (Coinbase's facilitator rejects longer)");
  const inputs = Object.keys(one(s.input) ?? {});
  const steps = Object.entries(s.step ?? {}).map(([id, v]) => ({ id, ...one(v) }));
  if (!steps.length) errors.push("at least one step");
  let maxCost = 0, usesModel = false;
  const seen = new Set();
  for (const st of steps) {
    const kinds = Object.keys(st).filter((k) => STEP_KINDS.has(k));
    if (kinds.length !== 1) { errors.push(`step "${st.id}": exactly one of ${[...STEP_KINDS].join("/")}`); continue; }
    const kind = kinds[0];
    tryit(() => noCalls(st, `step "${st.id}"`));
    for (const r of refsIn(st)) {
      const [scope, key] = r.split(".");
      if (scope === "input" && !inputs.includes(key)) errors.push(`step "${st.id}": unknown input "${key}"`);
      if (scope === "steps" && !seen.has(key)) errors.push(`step "${st.id}": "${key}" isn't an earlier step`);
    }
    if (kind === "mob" && !/^(top_movers|gap:[A-Z.]{1,10}|price:[A-Z.]{1,10})$/.test(st.mob)) errors.push(`step "${st.id}": mob query must be top_movers, gap:SYM or price:SYM`);
    if (kind === "x402" || kind === "fetch") {
      // text another party controls (a sibling's answer, a message, model output) never decides where a request goes
      for (const r of refsIn(st[kind])) if (r.startsWith("steps.")) errors.push(`step "${st.id}": a URL can't contain a step's output (${r}) — only \${input.x}, as one path segment`);
    }
    if (kind === "model") {
      const m = MODELS[st.model];
      if (!m) errors.push(`step "${st.id}": model must be one of ${Object.keys(MODELS).join(", ")}`);
      if (typeof st.prompt !== "string" || !st.prompt.length || st.prompt.length > 4000) errors.push(`step "${st.id}": prompt required, ≤ 4000 chars`);
      const mx = Number(st.max);
      if (m && Number.isFinite(mx) && mx < worstCost(m)) errors.push(`step "${st.id}": max ${mx} is below this model's worst-case call ${worstCost(m).toFixed(6)}`);
      usesModel = true;
    }
    if (kind === "inbox" && st.inbox !== "new") errors.push(`step "${st.id}": inbox must be "new" (messages since the last successful run)`);
    if (kind === "inbox" && st.skip_if_empty != null && typeof st.skip_if_empty !== "boolean") errors.push(`step "${st.id}": skip_if_empty must be true or false`);
    if (kind === "message") {
      // a signed note to a sibling's inbox: free, but bounded — a known recipient, a short body, a known kind
      if (!(Number.isInteger(st.message) && st.message >= 1 && st.message <= 10048)) errors.push(`step "${st.id}": message must be a daemon number 1–10048`);
      if (typeof st.body !== "string" || !st.body.length || st.body.length > 1000) errors.push(`step "${st.id}": body required, ≤ 1000 chars`);
      if (st.kind != null && !["note", "propose"].includes(st.kind)) errors.push(`step "${st.id}": kind must be note or propose`);
    }
    if (kind === "x402" || kind === "fetch") {
      const url = st[kind];
      if (!FETCH_ALLOW.some((re) => re.test(url))) errors.push(`step "${st.id}": ${url} isn't on the allowlist`);
    }
    if (kind === "offer" || kind === "take") {
      // a trade through DaemonOTC: strategies only (a skill someone pays for never trades the daemon's own funds)
      if (!strategy) errors.push(`step "${st.id}": offer and take run in strategies, not skills`);
      const r = checkOtcStep(st, otc);
      errors.push(...r.errors);
      maxCost += r.dollarOut;   // the dollars it escrows or pays count against the wallet's caps
    }
    if (kind === "write_option" || kind === "buy_option" || kind === "exercise") {
      // options through DaemonOptions (testnet only): strategies only, the holder's options{} limits, worst case counted
      if (!strategy) errors.push(`step "${st.id}": options steps run in strategies, not skills`);
      const r = checkOptionStep(st, options);
      errors.push(...r.errors);
      maxCost += r.dollarOut;
    }
    if (kind === "mint_index" || kind === "redeem_index") {
      // index shares through DaemonIndexes: strategies only; a mint's dollar legs count against the wallet's caps
      if (!strategy) errors.push(`step "${st.id}": index steps run in strategies, not skills`);
      const r = checkIndexStep(st, indexes);
      errors.push(...r.errors);
      maxCost += r.dollarOut;
    }
    if (kind === "swap_offer" || kind === "swap_take") {
      // a bounded swap through DaemonSwaps (testnet): strategies only; its escrow (notional × cap) is its dollar cost
      if (!strategy) errors.push(`step "${st.id}": swap steps run in strategies, not skills`);
      const r = checkSwapStep(st, swaps);
      errors.push(...r.errors);
      maxCost += r.dollarOut;
    }
    if (kind === "x402" || kind === "model") {
      const m = tryit(() => usd(st.max ?? "x"));
      if (m != null) { if (m > maxPerStep) errors.push(`step "${st.id}": max ${m} over the per-step cap ${maxPerStep}`); maxCost += m; }
    }
    seen.add(st.id);
  }
  // the costs are decimal dollars summed as floats (0.1 + 0.2 = 0.30000000000000004): settle the sum on USDG's own
  // precision so a price equal to the worst case is not refused
  maxCost = Math.round(maxCost * 10 ** RHC.decimals) / 10 ** RHC.decimals;
  if (price != null && price < maxCost) errors.push(`price ${price} is below the worst-case cost ${maxCost.toFixed(6)} — it could sell at a loss`);
  for (const r of refsIn(s.output ?? "")) if (r.startsWith("steps.") && !seen.has(r.split(".")[1])) errors.push(`output: "${r}" isn't a step`);
  return { name, ok: !errors.length, errors, price, maxCost, timeout, inputs, steps, description: s.description, output: s.output, usesModel };
}

/** x402 v2 PaymentRequirements for one daemon's skill, payable in USDG on Robinhood Chain to the daemon's own TBA. */
export function requirements(skill, { daemonId, tba }) {
  return {
    scheme: "exact",
    network: RHC.network,
    asset: RHC.asset,
    amount: atomic(skill.price),
    payTo: tba,
    maxTimeoutSeconds: skill.timeout,
    extra: { name: RHC.name },
    resource: { url: `https://obol.sh/d/${daemonId}/${skill.name}`, description: skill.description, mimeType: "application/json" },
    discovery: { bodyType: "json", inputSchema: { properties: Object.fromEntries(skill.inputs.map((k) => [k, { type: "string" }])), required: skill.inputs } },
  };
}

/** A strategy runs on a schedule and spends (never sells): same closed steps, an `every` interval ≥ 1h on testnet. */
export function checkStrategy(name, raw, opts = {}) {
  const s = one(raw);
  const r = checkSkill(name, { ...s, price: "1000000", description: s.description ?? name }, { ...opts, strategy: true });
  const m = String(s.every ?? "").match(/^(\d+)h$/);
  if (!m || +m[1] < 1) r.errors.push(`strategy "${name}": every must be like "1h" (≥ 1h)`);
  r.every = m ? +m[1] * 3600 : null;
  r.ok = !r.errors.length;
  delete r.price;
  return r;
}


/** Check a parsed agentfile. Returns the per-block results, the think budget and a content hash that covers step order. */
export function compileDoc(doc) {
  const otc = doc.otc != null ? checkOtc(doc.otc) : null;   // the holder's trading limits (constitution gate)
  const options = doc.options != null ? checkOptions(doc.options) : null;   // its options limits (constitution gate)
  const indexes = doc.index != null ? checkIndexes(doc.index) : null;   // the indexes it publishes (constitution gate)
  const swaps = doc.swaps != null ? checkSwaps(doc.swaps) : null;       // its swap limits (constitution gate)
  const skills = Object.entries(doc.skill ?? {}).map(([n, v]) => checkSkill(n, v, { otc, options, indexes, swaps }));
  const strategies = Object.entries(doc.strategy ?? {}).map(([n, v]) => checkStrategy(n, v, { otc, options, indexes, swaps }));
  // a daemon that thinks must say how much thinking a day it may pay for (USDG); model steps are refused without it
  let thinkBudget = null;
  if (doc.think_budget != null) { try { thinkBudget = usd(one(doc.think_budget)); } catch (e) { thinkBudget = NaN; } }
  for (const x of [...skills, ...strategies]) {
    if (!x.usesModel) continue;
    if (thinkBudget == null) x.errors.push(`${x.name}: uses a model, so the agentfile needs think_budget = "<USDG a day>"`);
    else if (!(thinkBudget > 0 && thinkBudget <= 5)) x.errors.push(`${x.name}: think_budget must be > 0 and ≤ 5 USDG a day`);
    x.ok = !x.errors.length;
  }
  // reflect { every, max }: the daemon drafts one change to itself on this schedule (obol/src/reflect.mjs) — a model call,
  // so it needs a think budget; its own setting changes only with the holder's authority (the constitution gate)
  let reflect = null, reflectErrors = [];
  if (doc.reflect != null) {
    const r = one(doc.reflect) ?? {};
    const m = String(r.every ?? "").match(/^(\d+)h$/);
    if (!m || +m[1] < 6 || +m[1] > 168) reflectErrors.push(`reflect: every must be like "24h" (6h–168h)`);
    let max = null; try { max = usd(r.max); } catch (e) { reflectErrors.push(`reflect: max — ${e.message}`); }
    if (max != null && !(max > 0 && max <= 0.05)) reflectErrors.push("reflect: max must be > 0 and ≤ 0.05 USDG a call");
    if (max != null && max * 1e6 < Math.ceil(worstCost(MODELS.qwen) * 1e6)) reflectErrors.push(`reflect: max ${r.max} is below one model call's worst case`);
    if (thinkBudget == null) reflectErrors.push('reflect: needs think_budget = "<USDG a day>"');
    reflect = { every: m ? +m[1] * 3600 : null, max: r.max };
  }
  if (otc) reflectErrors.push(...otc.errors);   // reported with the agentfile's other top-level errors
  if (options) reflectErrors.push(...options.errors);
  if (indexes) reflectErrors.push(...indexes.errors);
  if (swaps) reflectErrors.push(...swaps.errors);
  return { skills, strategies, thinkBudget, reflect, reflectErrors, otc, options, indexes, swaps, hash: hashDoc(doc) };
}

// keys sorted at EVERY level (a replacer array only covers the top level, so a changed URL left the hash the same) —
// and the step order alongside, because sorting keys would otherwise erase it
const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);
export const stepOrders = (doc) => ["skill", "strategy"].flatMap((k) => Object.entries(doc[k] ?? {}).map(([n, v]) => [k, n, Object.keys(one(v).step ?? {})]));
export const hashDoc = (doc) => createHash("sha256").update(JSON.stringify([sortDeep(doc), stepOrders(doc)])).digest("hex").slice(0, 12);
