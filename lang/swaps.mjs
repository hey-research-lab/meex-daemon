// Bounded swaps (milestone 12, SPEC §9b item 4): long or short a stock against a sibling for a fixed term, the move
// capped, both sides escrowing their max loss — settled on Chainlink's price at expiry. TESTNET ONLY until counsel.
// Pure: parsing and checks; obol/src/swaps.mjs acts.
//
//   swaps { underlyings = ["NVDA"]  max_open = 2  max_usd = "3" }      ← the holder's limits; max_usd = max loss a swap
//   step "o" { swap_offer { underlying = "NVDA"  side = "long"  notional = "10 tUSDG"  cap = "20%"  term = "24h"  max_stale = "2h"  expires = "24h" } }
//   step "t" { swap_take  { underlying = "NVDA"  side = "short" notional_at_most = "10 tUSDG"  cap_at_most = "20%"  term_at_most = "48h" }  skip_if_none = true }
//
// Each side escrows notional × cap (its max loss) — that is the step's dollar cost, and it can't exceed swaps.max_usd.
// Settling (the first feed round at or after expiry) and refunds (no price within 7 days) happen on their own runs.
import { parseAmount } from "./otc.mjs";

// testnet: MirrorFeed copies of Chainlink's RHC-mainnet feeds (see deployments/rhc-testnet.json "feeds")
export const FEEDS = { NVDA: { address: "0x5f7aDC6E114c7a5beAd0f6cfc05517b6c974fC49", decimals: 8, mainnet: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15" } };
const one = (v) => (Array.isArray(v) ? v[0] : v);
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const pct = (s) => { const m = String(s ?? "").match(/^(\d{1,2}(?:\.\d{1,2})?)%$/); return m ? Math.round(Number(m[1]) * 100) : null; };   // "20%" → 2000 bps
const hours = (s, lo, hi) => { const m = String(s ?? "").match(/^(\d+)h$/); return m && +m[1] >= lo && +m[1] <= hi ? +m[1] : null; };
export const parsePct = pct;

/** the swaps{} block: { underlyings, maxOpen, maxUsd, errors } */
export function checkSwaps(raw) {
  const errors = [], o = one(raw) ?? {};
  const underlyings = list(o.underlyings);
  for (const u of underlyings) if (!FEEDS[u]) errors.push(`swaps: ${u} has no price feed (${Object.keys(FEEDS).join(", ")})`);
  if (!underlyings.length) errors.push("swaps: underlyings = [...] required");
  const maxOpen = o.max_open;
  if (!(Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= 10)) errors.push("swaps: max_open must be 1–10");
  const maxUsd = Number(o.max_usd);
  if (!(/^\d+(\.\d{1,6})?$/.test(String(o.max_usd ?? "")) && maxUsd > 0 && maxUsd <= 1000)) errors.push('swaps: max_usd must be like "3" (> 0, ≤ 1000) — the most one swap may lose');
  return { underlyings, maxOpen, maxUsd, errors };
}

/** a swap_offer / swap_take step → { errors, dollarOut } (dollarOut = the escrow: notional × cap) */
export function checkSwapStep(st, lim) {
  const errors = [], at = `step "${st.id}"`;
  if (!lim) return { errors: [`${at}: swap steps need a swaps { … } block (the holder's limits)`], dollarOut: 0 };
  const isOffer = !!st.swap_offer, s = one(isOffer ? st.swap_offer : st.swap_take) ?? {};
  if (!lim.underlyings.includes(s.underlying)) errors.push(`${at}: ${s.underlying} isn't in swaps.underlyings`);
  if (!["long", "short"].includes(s.side)) errors.push(`${at}: side must be "long" or "short"`);
  let notional = null;
  try { const a = parseAmount(isOffer ? s.notional : s.notional_at_most); if (!a.dollar) errors.push(`${at}: the notional must be in dollars`); else notional = Number(a.amount); }
  catch (e) { errors.push(`${at}: ${isOffer ? "notional" : "notional_at_most"} ${e.message}`); }
  const cap = pct(isOffer ? s.cap : s.cap_at_most);
  if (cap == null || cap < 1 || cap > 5000) errors.push(`${at}: ${isOffer ? "cap" : "cap_at_most"} must be like "20%" (0.01%–50%)`);
  if (isOffer) {
    if (hours(s.term, 1, 720) == null) errors.push(`${at}: term must be like "24h" (1h–720h)`);
    if (hours(s.max_stale, 1, 72) == null) errors.push(`${at}: max_stale must be like "2h" (1h–72h) — how old the entry price may be`);
    if (hours(s.expires, 1, 168) == null) errors.push(`${at}: expires must be like "24h" (1h–168h)`);
  } else {
    if (hours(s.term_at_most, 1, 720) == null) errors.push(`${at}: term_at_most must be like "48h" (1h–720h)`);
    if (st.skip_if_none != null && typeof st.skip_if_none !== "boolean") errors.push(`${at}: skip_if_none must be true or false`);
  }
  const escrow = notional != null && cap != null ? Math.floor(notional * cap * 1e6 / 10_000) / 1e6 : 0;   // the contract rounds down too
  if (escrow > lim.maxUsd) errors.push(`${at}: escrow ${escrow} (notional × cap) over swaps.max_usd ${lim.maxUsd}`);
  return { errors, dollarOut: escrow };
}
