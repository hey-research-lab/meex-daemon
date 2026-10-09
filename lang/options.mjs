// Options steps (milestone 10, SPEC §9b "covered calls / cash-secured puts"): a daemon writes, buys and exercises
// physically settled, fully collateralised options with its siblings through DaemonOptions — TESTNET ONLY until counsel.
// Deterministic rules, no model deciding a trade. Pure: parsing and checks; obol/src/options.mjs acts.
//
//   step "w" { write_option { kind = "call"  stock = "3 tNVDA"  strike = "1.50 tUSDG"  premium = "0.10 tUSDG"  expires = "72h" } }
//   step "b" { buy_option   { kind = "call"  stock_at_least = "3 tNVDA"  strike_at_most = "1.60 tUSDG"  premium_at_most = "0.15 tUSDG" }  skip_if_none = true }
//   step "x" { exercise     { reference = "otc" } }
//   options { underlyings = ["tNVDA"]  max_open = 2  max_usd = "5" }        ← the holder's limits (constitution)
//
// `strike` is the TOTAL paid for the whole `stock` amount (as the contract holds it), not a per-share price.
// A call escrows the stock; a put escrows the strike. Exercise is in-the-money only, judged against the OTC book: a call
// when its strike per share is below the cheapest ask, a put when above the best bid; no reference → no exercise.
//
// 🔴 Worst-case dollars count toward the strategy's cost, so the wallet's daily cap bounds options too: a put escrows its
//    strike, a buy pays at most its premium, an exercise may pay up to max_open × max_usd of call strikes.
import { parseAmount, INSTRUMENTS } from "./otc.mjs";

export const DOLLAR_SYM = Object.keys(INSTRUMENTS).find((s) => INSTRUMENTS[s].dollar);
const one = (v) => (Array.isArray(v) ? v[0] : v);
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const KINDS = ["call", "put"];

/** the options{} block: { underlyings, maxOpen, maxUsd, errors } */
export function checkOptions(raw) {
  const errors = [], o = one(raw) ?? {};
  const underlyings = list(o.underlyings);
  for (const s of underlyings) {
    if (!INSTRUMENTS[s]) errors.push(`options: ${s} isn't a known instrument`);
    else if (INSTRUMENTS[s].dollar) errors.push(`options: ${s} is the dollar, not a stock`);
  }
  if (!underlyings.length) errors.push("options: underlyings = [...] required");
  const maxOpen = o.max_open;
  if (!(Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= 10)) errors.push("options: max_open must be 1–10");
  const maxUsd = Number(o.max_usd);
  if (!(/^\d+(\.\d{1,6})?$/.test(String(o.max_usd ?? "")) && maxUsd > 0 && maxUsd <= 1000)) errors.push('options: max_usd must be like "5" (> 0, ≤ 1000)');
  return { underlyings, maxOpen, maxUsd, errors };
}

/** a write_option / buy_option / exercise step against the options{} limits → { errors, dollarOut } */
export function checkOptionStep(st, opts) {
  const errors = [], at = `step "${st.id}"`;
  if (!opts) return { errors: [`${at}: options steps need an options { … } block (the holder's limits)`], dollarOut: 0 };
  const stock = (s, where) => { try { const a = parseAmount(s); if (a.dollar) errors.push(`${at}: ${where} must be a stock, not ${a.sym}`); else if (!opts.underlyings.includes(a.sym)) errors.push(`${at}: ${a.sym} isn't in options.underlyings`); return a; } catch (e) { errors.push(`${at}: ${where} ${e.message}`); return null; } };
  const usd = (s, where, { zero = false } = {}) => {
    if (zero && /^0+(\.0+)?\s/.test(String(s ?? ""))) return { amount: "0", raw: 0n };
    try { const a = parseAmount(s); if (!a.dollar) errors.push(`${at}: ${where} must be in ${DOLLAR_SYM}`); else if (Number(a.amount) > opts.maxUsd) errors.push(`${at}: ${where} ${a.amount} over options.max_usd ${opts.maxUsd}`); return a; } catch (e) { errors.push(`${at}: ${where} ${e.message}`); return null; }
  };
  if (st.write_option) {
    const w = one(st.write_option) ?? {};
    if (!KINDS.includes(w.kind)) errors.push(`${at}: kind must be "call" or "put"`);
    stock(w.stock, "stock");
    const strike = usd(w.strike, "strike");
    usd(w.premium, "premium", { zero: true });
    const m = String(w.expires ?? "").match(/^(\d+)h$/);
    if (!m || +m[1] < 1 || +m[1] > 720) errors.push(`${at}: expires must be like "72h" (1h–720h)`);
    return { errors, dollarOut: w.kind === "put" && strike ? Number(strike.amount) : 0 };   // a put escrows its strike
  }
  if (st.buy_option) {
    if (st.skip_if_none != null && typeof st.skip_if_none !== "boolean") errors.push(`${at}: skip_if_none must be true or false`);
    const b = one(st.buy_option) ?? {};
    if (!KINDS.includes(b.kind)) errors.push(`${at}: kind must be "call" or "put"`);
    stock(b.stock_at_least, "stock_at_least");
    // a call buyer wants a LOW strike, a put buyer a HIGH one
    const bound = b.kind === "put" ? "strike_at_least" : "strike_at_most";
    const other = b.kind === "put" ? "strike_at_most" : "strike_at_least";
    if (b[other] != null) errors.push(`${at}: a ${b.kind} buyer names ${bound}, not ${other}`);
    usd(b[bound], bound);
    const prem = usd(b.premium_at_most, "premium_at_most", { zero: true });
    return { errors, dollarOut: prem ? Number(prem.amount) : 0 };
  }
  const x = one(st.exercise) ?? {};
  if (x.reference !== "otc") errors.push(`${at}: exercise needs reference = "otc" (in the money against the sibling book)`);
  return { errors, dollarOut: opts.maxOpen * opts.maxUsd };   // worst case: every call it holds, at the largest strike
}

/** per-share comparison, exact: a/b < c/d without division */
const lt = (a, b, c, d) => a * d < c * b;

/**
 * Is a held option in the money against the OTC book? Pure. Offers are book() rows (single-leg only count).
 * call: strike/amount < the cheapest ask (an offer giving the stock for dollars), per share
 * put:  strike/amount > the best bid (an offer giving dollars for the stock), per share
 * → { itm, ref } where ref = { id, give, want } of the offer compared against, or null when there is none
 */
export function inTheMoney(opt, offers) {
  const s = opt.underlying.toLowerCase(), q = opt.quote.toLowerCase();
  const single = offers.filter((o) => o.give.length === 1 && o.want.length === 1);
  if (opt.kind === "call") {
    const asks = single.filter((o) => o.give[0].token.toLowerCase() === s && o.want[0].token.toLowerCase() === q)
      .sort((a, b) => (lt(BigInt(a.want[0].raw), BigInt(a.give[0].raw), BigInt(b.want[0].raw), BigInt(b.give[0].raw)) ? -1 : 1));
    const ask = asks[0];
    if (!ask) return { itm: false, ref: null };
    return { itm: lt(BigInt(opt.strike), BigInt(opt.amount), BigInt(ask.want[0].raw), BigInt(ask.give[0].raw)), ref: { id: ask.id, give: ask.give[0].raw, want: ask.want[0].raw } };
  }
  const bids = single.filter((o) => o.give[0].token.toLowerCase() === q && o.want[0].token.toLowerCase() === s)
    .sort((a, b) => (lt(BigInt(b.give[0].raw), BigInt(b.want[0].raw), BigInt(a.give[0].raw), BigInt(a.want[0].raw)) ? -1 : 1));
  const bid = bids[0];
  if (!bid) return { itm: false, ref: null };
  return { itm: lt(BigInt(bid.give[0].raw), BigInt(bid.want[0].raw), BigInt(opt.strike), BigInt(opt.amount)), ref: { id: bid.id, give: bid.give[0].raw, want: bid.want[0].raw } };
}
