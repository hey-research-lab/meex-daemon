// Signed messages between daemons (and from holders to their daemons). EIP-712, so any wallet can sign and anyone
// can check one. A message is accepted only if, at the moment it arrives:
//   · it is addressed to this inbox, small, fresh, and its body matches the signed hash;
//   · the signer is the sending daemon's HOLDER (ownerOf), or its ACTIVE AGENT — the constitution's agent, and only
//     while the constitution was set by the current holder (after a sale the old agent's messages are refused, the
//     same rule the wallet enforces on chain).
// Replays (same sender + nonce) and floods are refused by the recipient's inbox (the Daemon Durable Object).
import { keccak256, toBytes, recoverTypedDataAddress } from "viem";

export const MAX_BODY = 2000;          // bytes
export const MAX_SKEW = 300;           // seconds either side of now
export const KINDS = ["note", "propose"];
export const TYPES = {
  Message: [
    { name: "from", type: "uint256" }, { name: "to", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "sentAt", type: "uint64" }, { name: "kind", type: "string" }, { name: "bodyHash", type: "bytes32" },
  ],
};
export const domain = (nft) => ({ name: "Daemon", version: "1", chainId: 46630, verifyingContract: nft });
export const bodyHash = (body) => keccak256(toBytes(body));

/** Build and sign a message. `account` is a viem local account (the agent's or the holder's key). */
export async function signMessage(account, nft, { from, to, kind = "note", body, nonce, sentAt }) {
  const message = {
    from: BigInt(from), to: BigInt(to), kind, bodyHash: bodyHash(body),
    nonce: nonce ?? BigInt("0x" + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")),
    sentAt: BigInt(sentAt ?? Math.floor(Date.now() / 1000)),
  };
  const signature = await account.signTypedData({ domain: domain(nft), types: TYPES, primaryType: "Message", message });
  return { message: wire(message), body, signature };
}

const wire = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

/**
 * Check a message for inbox `toId`. `sender(fromId)` reads the chain: { owner, agent, configuredBy } for that daemon
 * (owner = ownerOf; agent/configuredBy = its wallet's constitution). Returns { ok, reason?, signer?, role? }.
 */
export async function verifyMessage({ message, body, signature }, toId, { nft, sender, now = Math.floor(Date.now() / 1000) }) {
  const no = (reason) => ({ ok: false, reason });
  if (!message || typeof body !== "string" || typeof signature !== "string") return no("malformed");
  let m;
  try {
    m = { from: BigInt(message.from), to: BigInt(message.to), nonce: BigInt(message.nonce), sentAt: BigInt(message.sentAt), kind: String(message.kind), bodyHash: message.bodyHash };
  } catch { return no("malformed"); }
  if (m.to !== BigInt(toId)) return no("addressed to another daemon");
  if (m.from === m.to) return no("a daemon can't message itself");
  if (!KINDS.includes(m.kind)) return no(`kind must be one of ${KINDS.join(", ")}`);
  if (new TextEncoder().encode(body).length > MAX_BODY) return no(`body over ${MAX_BODY} bytes`);
  if (bodyHash(body) !== m.bodyHash) return no("body doesn't match the signed hash");
  if (Math.abs(now - Number(m.sentAt)) > MAX_SKEW) return no("stale or from the future");
  let signer;
  try { signer = await recoverTypedDataAddress({ domain: domain(nft), types: TYPES, primaryType: "Message", message: m, signature }); }
  catch { return no("bad signature"); }
  const s = await sender(m.from);
  if (!s?.owner) return no("no such sender");
  const eq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  if (eq(signer, s.owner)) return { ok: true, signer, role: "holder", from: Number(m.from), nonce: m.nonce.toString(), kind: m.kind };
  if (eq(signer, s.agent) && eq(s.configuredBy, s.owner)) return { ok: true, signer, role: "agent", from: Number(m.from), nonce: m.nonce.toString(), kind: m.kind };
  return no("signer is neither the sender's holder nor its active agent");
}
