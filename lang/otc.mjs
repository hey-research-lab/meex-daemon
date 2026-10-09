// OTC steps (milestone 09, SPEC §9b "bundles"): a daemon posts a bundle offer or takes a sibling's, through DaemonOTC
// on Robinhood Chain — deterministic rules, no model deciding a trade. Pure: parsing and checks; obol/src/otc.mjs acts.
//
//   step "post" { offer { give = ["3 tNVDA"]  want = ["1.80 tUSDG"]  expires = "24h" } }
//   step "buy"  { take  { give_at_least = "3 tNVDA"  for_at_most = "2.00 tUSDG" } }
//   otc { instruments = ["tUSDG", "tNVDA"]  max_open = 3  max_usd = "5" }        ← the holder's limits (constitution)
//
// 🔴 Every amount names an instrument on the allowlist below AND in the agentfile's otc{}; a trade's dollar side can't
//    exceed otc.max_usd; the dollars an offer escrows or a take pays count toward the step's worst-case cost, so the
//    wallet's on-chain caps bound them twice (the gates at plan time, the wallet contract at run time).
export const INSTRUMENTS = {
  tUSDG: { address: "0x2Ce7B2d37DF6fFb1EB30b7Ebc86E033f1628B914", decimals: 6, dollar: true },
  tNVDA: { address: "0xb3691574f47F2d2b0e526DB8E7074D03336C1db2", decimals: 18 },
  // index shares (milestone 11): whole shares, each backed in DaemonIndexes by exactly its basket; listed once created
  tNVX: { address: "0xe7c139925257e1e9857dd65EaAD30f0D1d0ee512", decimals: 0, index: true },   // daemon #2: 1 tNVDA + 0.40 tUSDG
};
const one = (v) => (Array.isArray(v) ? v[0] : v);
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** "3 tNVDA" → { sym, amount: "3", raw: 3n * 10n**18n } (or throws) */
export function parseAmount(s) {
  const m = String(s ?? "").trim().match(/^(\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z0-9.]{0,11})$/);
  if (!m) throw new Error(`"${s}" must be like "3 tNVDA"`);
  const ins = INSTRUMENTS[m[2]];
  if (!ins) throw new Error(`${m[2]} isn't a known instrument (${Object.keys(INSTRUMENTS).join(", ")})`);
  const [i, f = ""] = m[1].split(".");
  if (f.length > ins.decimals) throw new Error(`${m[2]} has ${ins.decimals} decimals; "${m[1]}" has more`);
  const raw = BigInt(i) * 10n ** BigInt(ins.decimals) + BigInt((f + "0".repeat(ins.decimals)).slice(0, ins.decimals) || "0");
  if (raw <= 0n) throw new Error(`"${s}": the amount must be more than zero`);
  return { sym: m[2], amount: m[1], raw, token: ins.address, decimals: ins.decimals, dollar: !!ins.dollar };
}
const dollars = (legs) => legs.filter((l) => l.dollar).reduce((a, l) => a + Number(l.amount), 0);

/** the otc{} block: { instruments, maxOpen, maxUsd, errors } */
export function checkOtc(raw) {
  const errors = [], o = one(raw) ?? {};
  const instruments = list(o.instruments);
  for (const s of instruments) if (!INSTRUMENTS[s]) errors.push(`otc: ${s} isn't a known instrument`);
  if (!instruments.length) errors.push("otc: instruments = [...] required");
  const maxOpen = o.max_open;
  if (!(Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= 10)) errors.push("otc: max_open must be 1–10");
  const maxUsd = Number(o.max_usd);
  if (!(/^\d+(\.\d{1,6})?$/.test(String(o.max_usd ?? "")) && maxUsd > 0 && maxUsd <= 1000)) errors.push('otc: max_usd must be like "5" (> 0, ≤ 1000)');
  return { instruments, maxOpen, maxUsd, errors };
}

/** an offer or take step against the otc{} limits → { errors, dollarOut } (dollarOut = worst-case dollars leaving) */
export function checkOtcStep(st, otc) {
  const errors = [], at = `step "${st.id}"`;
  if (!otc) return { errors: [`${at}: an offer or take needs an otc { … } block (the holder's limits)`], dollarOut: 0 };
  const parse = (s, where) => { try { const a = parseAmount(s); if (!otc.instruments.includes(a.sym)) errors.push(`${at}: ${a.sym} isn't in otc.instruments`); return a; } catch (e) { errors.push(`${at}: ${where} ${e.message}`); return null; } };
  if (st.offer) {
    const o = one(st.offer) ?? {};
    const give = list(o.give).map((s) => parse(s, "give")).filter(Boolean), want = list(o.want).map((s) => parse(s, "want")).filter(Boolean);
    if (!give.length || !want.length) errors.push(`${at}: an offer needs give = [...] and want = [...]`);
    if (give.length + want.length > 6) errors.push(`${at}: at most 6 legs`);
    const m = String(o.expires ?? "").match(/^(\d+)h$/);
    if (!m || +m[1] < 1 || +m[1] > 168) errors.push(`${at}: expires must be like "24h" (1h–168h)`);
    for (const g of give) if (want.some((w) => w.sym === g.sym)) errors.push(`${at}: ${g.sym} on both sides`);
    const usd = Math.max(dollars(give), dollars(want));
    if (usd > otc.maxUsd) errors.push(`${at}: ${usd} tUSDG over otc.max_usd ${otc.maxUsd}`);
    return { errors, dollarOut: dollars(give) };
  }
  if (st.skip_if_none != null && typeof st.skip_if_none !== "boolean") errors.push(`${at}: skip_if_none must be true or false`);
  const t = one(st.take) ?? {};
  const get = parse(t.give_at_least, "give_at_least"), pay = parse(t.for_at_most, "for_at_most");
  if (get && pay && get.sym === pay.sym) errors.push(`${at}: give_at_least and for_at_most are the same instrument`);
  if (pay && pay.dollar && Number(pay.amount) > otc.maxUsd) errors.push(`${at}: ${pay.amount} tUSDG over otc.max_usd ${otc.maxUsd}`);
  return { errors, dollarOut: pay?.dollar ? Number(pay.amount) : 0 };
}
