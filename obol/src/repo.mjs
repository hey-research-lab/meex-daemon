// A daemon's repo: its agentfile's history, and proposals to change it. Pure functions here (signatures, the plan,
// the gates); the Daemon Durable Object stores commits and proposals and applies what passes.
//
// Who may propose (SPEC §3 evolve{}): the HOLDER (signed; merged when the gates pass) · the daemon ITSELF (drafted by
// its model — held for the holder until a scoring gate exists) · a SIBLING (signed by its holder or active agent;
// always held for the holder's review). The invariant: a daemon can change what it does, never what it may do.
import { keccak256, toBytes, recoverTypedDataAddress } from "viem";
import { compileDoc } from "../../lang/check.mjs";

export const MAX_SKEW = 300;
export const PTYPES = {
  Proposal: [
    { name: "daemon", type: "uint256" }, { name: "by", type: "uint256" }, { name: "base", type: "string" },
    { name: "docHash", type: "bytes32" }, { name: "reasonHash", type: "bytes32" }, { name: "sentAt", type: "uint64" },
  ],
  Approval: [{ name: "daemon", type: "uint256" }, { name: "proposal", type: "uint256" }, { name: "docHash", type: "bytes32" }, { name: "sentAt", type: "uint64" }],
  Rejection: [{ name: "daemon", type: "uint256" }, { name: "proposal", type: "uint256" }, { name: "docHash", type: "bytes32" }, { name: "reasonHash", type: "bytes32" }, { name: "sentAt", type: "uint64" }],
};
export const pdomain = (nft) => ({ name: "Daemon repo", version: "1", chainId: 46630, verifyingContract: nft });
export const docHash = (doc) => keccak256(toBytes(JSON.stringify(doc)));
const textHash = (s) => keccak256(toBytes(s ?? ""));
const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

/** Sign a proposal for daemon `daemon`. by = 0: as its holder; by = N: as daemon #N (its holder or active agent). */
export async function signProposal(account, nft, { daemon, by = 0, base, doc, reason, sentAt }) {
  const message = { daemon: BigInt(daemon), by: BigInt(by), base, docHash: docHash(doc), reasonHash: textHash(reason), sentAt: BigInt(sentAt ?? Math.floor(Date.now() / 1000)) };
  const signature = await account.signTypedData({ domain: pdomain(nft), types: PTYPES, primaryType: "Proposal", message });
  return { message: { ...message, daemon: String(message.daemon), by: String(message.by), sentAt: String(message.sentAt) }, doc, reason, signature };
}

export async function signApproval(account, nft, { daemon, proposal, doc, sentAt }) {
  const message = { daemon: BigInt(daemon), proposal: BigInt(proposal), docHash: docHash(doc), sentAt: BigInt(sentAt ?? Math.floor(Date.now() / 1000)) };
  const signature = await account.signTypedData({ domain: pdomain(nft), types: PTYPES, primaryType: "Approval", message });
  return { message: { daemon: String(message.daemon), proposal: String(message.proposal), docHash: message.docHash, sentAt: String(message.sentAt) }, signature };
}

/** The holder declines a held proposal — over its exact agentfile, with a reason (kept on the record). */
export async function signRejection(account, nft, { daemon, proposal, doc, reason, sentAt }) {
  const message = { daemon: BigInt(daemon), proposal: BigInt(proposal), docHash: docHash(doc), reasonHash: textHash(reason), sentAt: BigInt(sentAt ?? Math.floor(Date.now() / 1000)) };
  const signature = await account.signTypedData({ domain: pdomain(nft), types: PTYPES, primaryType: "Rejection", message });
  return { message: { daemon: String(message.daemon), proposal: String(message.proposal), docHash: message.docHash, reasonHash: message.reasonHash, sentAt: String(message.sentAt) }, reason, signature };
}

/** Who wrote this proposal? → { ok, role: "holder" | "sibling", by, signer } or { ok: false, reason }. */
export async function verifyProposal(p, daemonId, { nft, sender, now = Math.floor(Date.now() / 1000) }) {
  const no = (reason) => ({ ok: false, reason });
  if (!p?.message || !p.doc || typeof p.signature !== "string") return no("malformed");
  let m;
  try { m = { daemon: BigInt(p.message.daemon), by: BigInt(p.message.by), base: String(p.message.base), docHash: p.message.docHash, reasonHash: p.message.reasonHash, sentAt: BigInt(p.message.sentAt) }; }
  catch { return no("malformed"); }
  if (m.daemon !== BigInt(daemonId)) return no("for another daemon");
  if (m.by === m.daemon) return no("a daemon's own proposals come from inside, not over HTTP");
  if (docHash(p.doc) !== m.docHash) return no("agentfile doesn't match the signed hash");
  if (textHash(p.reason) !== m.reasonHash) return no("reason doesn't match the signed hash");
  if (Math.abs(now - Number(m.sentAt)) > MAX_SKEW) return no("stale or from the future");
  if (typeof p.reason !== "string" || !p.reason.trim() || p.reason.length > 500) return no("a reason is required (≤ 500 chars)");
  let signer;
  try { signer = await recoverTypedDataAddress({ domain: pdomain(nft), types: PTYPES, primaryType: "Proposal", message: m, signature: p.signature }); }
  catch { return no("bad signature"); }
  if (m.by === 0n) {
    const s = await sender(m.daemon);
    if (!s?.owner || !eq(signer, s.owner)) return no("by = 0 means the holder, and this isn't the holder's signature");
    return { ok: true, role: "holder", by: 0, signer, base: m.base };
  }
  const s = await sender(m.by);
  if (!s?.owner) return no("no such sibling");
  if (eq(signer, s.owner) || (eq(signer, s.agent) && eq(s.configuredBy, s.owner))) return { ok: true, role: "sibling", by: Number(m.by), signer, base: m.base };
  return no("signer is neither the sibling's holder nor its active agent");
}

export async function verifyApproval(a, daemonId, proposal, { nft, sender, now = Math.floor(Date.now() / 1000) }) {
  const no = (reason) => ({ ok: false, reason });
  if (!a?.message || typeof a.signature !== "string") return no("malformed");
  let m;
  try { m = { daemon: BigInt(a.message.daemon), proposal: BigInt(a.message.proposal), docHash: a.message.docHash, sentAt: BigInt(a.message.sentAt) }; } catch { return no("malformed"); }
  if (m.daemon !== BigInt(daemonId) || m.proposal !== BigInt(proposal.id)) return no("for another proposal");
  if (m.docHash !== docHash(proposal.doc)) return no("approves a different agentfile");
  if (Math.abs(now - Number(m.sentAt)) > MAX_SKEW) return no("stale or from the future");
  const signer = await recoverTypedDataAddress({ domain: pdomain(nft), types: PTYPES, primaryType: "Approval", message: m, signature: a.signature }).catch(() => null);
  const s = await sender(m.daemon);
  if (!signer || !s?.owner || !eq(signer, s.owner)) return no("only the holder approves");
  return { ok: true, signer };
}

export async function verifyRejection(a, daemonId, proposal, { nft, sender, now = Math.floor(Date.now() / 1000) }) {
  const no = (reason) => ({ ok: false, reason });
  if (!a?.message || typeof a.signature !== "string") return no("malformed");
  if (typeof a.reason !== "string" || !a.reason.trim() || a.reason.length > 280) return no("a reason is required (≤ 280 chars)");
  let m;
  try { m = { daemon: BigInt(a.message.daemon), proposal: BigInt(a.message.proposal), docHash: a.message.docHash, reasonHash: a.message.reasonHash, sentAt: BigInt(a.message.sentAt) }; } catch { return no("malformed"); }
  if (m.daemon !== BigInt(daemonId) || m.proposal !== BigInt(proposal.id)) return no("for another proposal");
  if (m.docHash !== docHash(proposal.doc)) return no("rejects a different agentfile");
  if (m.reasonHash !== textHash(a.reason)) return no("reason doesn't match the signed hash");
  if (Math.abs(now - Number(m.sentAt)) > MAX_SKEW) return no("stale or from the future");
  const signer = await recoverTypedDataAddress({ domain: pdomain(nft), types: PTYPES, primaryType: "Rejection", message: m, signature: a.signature }).catch(() => null);
  const s = await sender(m.daemon);
  if (!signer || !s?.owner || !eq(signer, s.owner)) return no("only the holder rejects");
  return { ok: true, signer, reason: a.reason.trim() };
}

const one = (v) => (Array.isArray(v) ? v[0] : v);
const blocks = (doc) => Object.fromEntries(["skill", "strategy"].flatMap((k) => Object.entries(doc?.[k] ?? {}).map(([n, v]) => [`${k} "${n}"`, one(v)])));

/** What would change: a short, human list (the `daemon plan` of the spec). */
export function plan(head, doc) {
  const a = blocks(head), b = blocks(doc), out = [];
  for (const k of Object.keys(b)) if (!(k in a)) out.push(`+ ${k}`);
  for (const k of Object.keys(a)) if (!(k in b)) out.push(`- ${k}`);
  for (const k of Object.keys(b)) {
    if (!(k in a)) continue;
    const sa = a[k].step ?? {}, sb = b[k].step ?? {};
    for (const id of Object.keys(sb)) if (!(id in sa)) out.push(`~ ${k}: + step "${id}"`);
    for (const id of Object.keys(sa)) if (!(id in sb)) out.push(`~ ${k}: - step "${id}"`);
    for (const id of Object.keys(sb)) if (id in sa && JSON.stringify(sa[id]) !== JSON.stringify(sb[id])) out.push(`~ ${k}: step "${id}" changed`);
    if (Object.keys(sa).join() !== Object.keys(sb).join() && Object.keys(sa).length === Object.keys(sb).length) out.push(`~ ${k}: steps reordered`);
    for (const f of ["every", "price", "description", "output", "timeout"]) if (JSON.stringify(a[k][f]) !== JSON.stringify(b[k][f])) out.push(`~ ${k}: ${f} changed`);
  }
  if (JSON.stringify(head?.think_budget) !== JSON.stringify(doc?.think_budget)) out.push(`~ think_budget: ${one(head?.think_budget) ?? "none"} → ${one(doc?.think_budget) ?? "none"}`);
  if (JSON.stringify(head?.otc) !== JSON.stringify(doc?.otc)) out.push(`~ otc: ${head?.otc ? JSON.stringify(one(head.otc)) : "none"} → ${doc?.otc ? JSON.stringify(one(doc.otc)) : "none"}`);
  if (JSON.stringify(head?.index) !== JSON.stringify(doc?.index)) out.push(`~ index: ${head?.index ? Object.keys(head.index).join(", ") : "none"} → ${doc?.index ? Object.keys(doc.index).map((k) => `${k} [${(one(doc.index[k]).basket ?? []).join(", ")}]`).join(", ") : "none"}`);
  if (JSON.stringify(head?.swaps) !== JSON.stringify(doc?.swaps)) out.push(`~ swaps: ${head?.swaps ? JSON.stringify(one(head.swaps)) : "none"} → ${doc?.swaps ? JSON.stringify(one(doc.swaps)) : "none"}`);
  if (JSON.stringify(head?.options) !== JSON.stringify(doc?.options)) out.push(`~ options: ${head?.options ? JSON.stringify(one(head.options)) : "none"} → ${doc?.options ? JSON.stringify(one(doc.options)) : "none"}`);
  if (JSON.stringify(head?.reflect) !== JSON.stringify(doc?.reflect)) out.push(`~ reflect: ${head?.reflect ? JSON.stringify(one(head.reflect)) : "none"} → ${doc?.reflect ? JSON.stringify(one(doc.reflect)) : "none"}`);
  return out;
}

const usdMicro = (s) => Math.round(Number(s) * 1e6);
const perDay = (every) => Math.ceil(86400 / every);

/**
 * The gates, in order; every one runs so the reasons are complete. `wallet` = { maxPerCall, maxPerDay } in micro-USDG
 * from the daemon's on-chain constitution. Returns { ok, gates: [{ gate, ok, detail }], plan, compiled }.
 */
export function gates({ head, headHash, doc, base, role, wallet }) {
  const g = [];
  const add = (gate, ok, detail) => g.push({ gate, ok, detail });
  const c = compileDoc(doc);
  const changes = plan(head, doc);
  add("change", changes.length > 0 && c.hash !== headHash, changes.length ? `${changes.length} change(s)` : "no change");
  add("base", base === headHash, base === headHash ? `on head ${headHash}` : `based on ${base}, head is ${headHash} — rebase`);
  const lint = [...c.skills, ...c.strategies].flatMap((x) => x.errors.map((e) => `${x.name}: ${e}`)).concat(c.reflectErrors ?? []);
  add("lint", lint.length === 0, lint.length ? lint.join("; ") : "compiles");
  // within(wallet): nothing it does may need more than the wallet allows
  const over = [];
  for (const x of [...c.skills, ...c.strategies]) for (const st of x.steps ?? []) {
    if ((st.x402 || st.model) && usdMicro(st.max) > wallet.maxPerCall) over.push(`${x.name}/${st.id}: max ${st.max} > per-call cap ${(wallet.maxPerCall / 1e6).toFixed(2)}`);
  }
  for (const x of c.strategies) {
    if (!x.every) continue;
    const day = Math.round(x.maxCost * 1e6) * perDay(x.every);
    if (day > wallet.maxPerDay) over.push(`${x.name}: up to ${(day / 1e6).toFixed(2)} a day > daily cap ${(wallet.maxPerDay / 1e6).toFixed(2)}`);
  }
  add("within(wallet)", over.length === 0, over.length ? over.join("; ") : "inside the wallet's caps");
  // what it may do: only the holder changes how much it may spend on thinking
  const tbChanged = JSON.stringify(one(head?.think_budget)) !== JSON.stringify(one(doc?.think_budget));
  // …and how (and whether) it reflects on itself: a daemon can't widen its own self-editing
  const rfChanged = JSON.stringify(one(head?.reflect)) !== JSON.stringify(one(doc?.reflect));
  const otcChanged = JSON.stringify(one(head?.otc)) !== JSON.stringify(one(doc?.otc));   // its trading limits, too
  const optChanged = JSON.stringify(one(head?.options)) !== JSON.stringify(one(doc?.options));   // and its options limits
  const swChanged = JSON.stringify(one(head?.swaps)) !== JSON.stringify(one(doc?.swaps));   // and its swap limits
  const ixChanged = JSON.stringify(head?.index ?? null) !== JSON.stringify(doc?.index ?? null);   // and what it publishes
  const held = [tbChanged && "think_budget", rfChanged && "reflect", otcChanged && "otc", optChanged && "options", ixChanged && "index", swChanged && "swaps"].filter(Boolean);
  add("constitution", !(held.length && role !== "holder"), held.length ? (role === "holder" ? `${held.join(" and ")} changed by the holder` : `only the holder can change ${held.join(" and ")}`) : "unchanged");
  return { ok: g.every((x) => x.ok), gates: g, plan: changes, compiled: c };
}
