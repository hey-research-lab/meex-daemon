// Index steps (milestone 11, SPEC §9b "indexes"): a daemon publishes a fixed basket through DaemonIndexes, mints shares
// of it by depositing the basket, and any daemon redeems shares for it in kind. Shares are ordinary ERC-20s (whole
// shares, 0 decimals) that trade through DaemonOTC once they're on the instrument list. Pure: parsing and checks;
// obol/src/indexes.mjs acts.
//
//   index "tNVX" { name = "NVDA + cash (testnet)"  basket = ["1 tNVDA", "0.40 tUSDG"] }   ← per share; holder-only
//   step "m" { mint_index   { index = "tNVX"  shares = 1 } }          ← its own index only
//   step "r" { redeem_index { index = "tNVX"  shares = "all" } }      ← any index it holds
//
// 🔴 The basket is fixed on chain at creation (the Corpus rule): changing an index block's basket can't change the
//    index — the daemon refuses to create a second basket under a symbol it already published.
import { parseAmount, INSTRUMENTS } from "./otc.mjs";

const one = (v) => (Array.isArray(v) ? v[0] : v);
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const SYM = /^[A-Za-z][A-Za-z0-9]{1,10}$/;

/** the index "<SYM>" { … } blocks → { indexes: [{ symbol, name, basket: [parsed legs], dollarsPerShare }], errors } */
export function checkIndexes(raw) {
  const errors = [], indexes = [];
  const entries = Object.entries(raw ?? {});
  if (entries.length > 3) errors.push("index: at most 3 per daemon");
  for (const [symbol, v] of entries) {
    const b = one(v) ?? {}, at = `index "${symbol}"`;
    if (!SYM.test(symbol)) errors.push(`${at}: the symbol must be 2–11 letters or digits, starting with a letter`);
    if (INSTRUMENTS[symbol] && !INSTRUMENTS[symbol].index) errors.push(`${at}: ${symbol} is already an instrument`);
    if (typeof b.name !== "string" || !b.name.length || b.name.length > 60) errors.push(`${at}: name required, ≤ 60 chars`);
    const basket = [];
    for (const s of list(b.basket)) {
      try {
        const a = parseAmount(s);
        if (INSTRUMENTS[a.sym].index) errors.push(`${at}: ${a.sym} is an index — no indexes of indexes`);
        else if (basket.some((x) => x.sym === a.sym)) errors.push(`${at}: ${a.sym} twice`);
        else basket.push({ ...a, raw: String(a.raw) });   // JSON-safe: the compiled doc is stored and served
      } catch (e) { errors.push(`${at}: basket ${e.message}`); }
    }
    if (!list(b.basket).length) errors.push(`${at}: basket = [...] required (what ONE share holds)`);
    if (list(b.basket).length > 8) errors.push(`${at}: at most 8 legs`);
    indexes.push({ symbol, name: b.name, basket, dollarsPerShare: basket.filter((l) => l.dollar).reduce((t, l) => t + Number(l.amount), 0) });
  }
  return { indexes, errors };
}

/** a mint_index / redeem_index step → { errors, dollarOut } */
export function checkIndexStep(st, own) {
  const errors = [], at = `step "${st.id}"`;
  if (st.mint_index) {
    const m = one(st.mint_index) ?? {};
    const ix = (own?.indexes ?? []).find((x) => x.symbol === m.index);
    if (!ix) errors.push(`${at}: mint_index mints this daemon's own index — "${m.index}" isn't an index block here`);
    if (!(Number.isInteger(m.shares) && m.shares >= 1 && m.shares <= 100)) errors.push(`${at}: shares must be a whole number 1–100`);
    return { errors, dollarOut: ix && Number.isInteger(m.shares) ? ix.dollarsPerShare * m.shares : 0 };   // its dollar legs leave the wallet
  }
  const r = one(st.redeem_index) ?? {};
  const known = (own?.indexes ?? []).some((x) => x.symbol === r.index) || INSTRUMENTS[r.index]?.index;
  if (!known) errors.push(`${at}: "${r.index}" isn't an index this daemon publishes or a listed index instrument`);
  if (!(r.shares === "all" || (Number.isInteger(r.shares) && r.shares >= 1 && r.shares <= 100))) errors.push(`${at}: shares must be "all" or a whole number 1–100`);
  return { errors, dollarOut: 0 };   // redeeming only brings things in
}
