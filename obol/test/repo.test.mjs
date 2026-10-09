// The repo: proposal signatures (holder / sibling / approval) and every gate, each as a refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { signProposal, signApproval, verifyProposal, verifyApproval, signRejection, verifyRejection, gates, plan } from "../src/repo.mjs";
import { hashDoc } from "../../lang/check.mjs";

const NFT = "0x336923B1E796202B3a59690ea3680240C3eA4c7d";
const holder = privateKeyToAccount(generatePrivateKey());
const agent3 = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const chain = { 1: { owner: holder.address, agent: stranger.address, configuredBy: stranger.address }, 3: { owner: holder.address, agent: agent3.address, configuredBy: holder.address } };
const ctx = { nft: NFT, sender: async (id) => chain[Number(id)] ?? null };

const strat = (max = "0.02", every = "1h", extra = {}) => ({
  strategy: { s: [{ every, input: [{}], step: { buy: [{ x402: "https://obol.sh/d/1/top_movers", max }] }, ...extra }] },
});
const HEAD = strat();
const H = hashDoc(HEAD);
const wallet = { maxPerCall: 25_000_000, maxPerDay: 40_000_000 };

test("the holder's proposal verifies as holder", async () => {
  const p = await signProposal(holder, NFT, { daemon: 1, base: H, doc: strat("0.03"), reason: "pay a bit more" });
  const v = await verifyProposal(p, 1, ctx);
  assert.equal(v.ok, true); assert.equal(v.role, "holder");
});
test("a sibling's active agent proposes as a sibling", async () => {
  const p = await signProposal(agent3, NFT, { daemon: 1, by: 3, base: H, doc: strat("0.03"), reason: "try this" });
  const v = await verifyProposal(p, 1, ctx);
  assert.equal(v.ok, true); assert.equal(v.role, "sibling"); assert.equal(v.by, 3);
});
for (const [name, mk, re] of [
  ["a stranger claiming to be the holder", () => signProposal(stranger, NFT, { daemon: 1, base: H, doc: HEAD, reason: "r" }), /isn't the holder/],
  ["a stranger claiming to be sibling #3", () => signProposal(stranger, NFT, { daemon: 1, by: 3, base: H, doc: HEAD, reason: "r" }), /neither/],
  ["#1's own agent over HTTP (self comes from inside)", () => signProposal(stranger, NFT, { daemon: 1, by: 1, base: H, doc: HEAD, reason: "r" }), /from inside/],
  ["for another daemon", () => signProposal(holder, NFT, { daemon: 2, base: H, doc: HEAD, reason: "r" }), /another daemon/],
  ["stale", () => signProposal(holder, NFT, { daemon: 1, base: H, doc: HEAD, reason: "r", sentAt: Math.floor(Date.now() / 1000) - 900 }), /stale/],
  ["no reason", () => signProposal(holder, NFT, { daemon: 1, base: H, doc: HEAD, reason: "  " }), /reason is required/],
  ["unknown sibling", () => signProposal(agent3, NFT, { daemon: 1, by: 9, base: H, doc: HEAD, reason: "r" }), /no such sibling/],
]) test(`refused: ${name}`, async () => {
  const v = await verifyProposal(await mk(), 1, ctx);
  assert.equal(v.ok, false); assert.match(v.reason, re);
});
test("refused: the agentfile swapped after signing", async () => {
  const p = await signProposal(holder, NFT, { daemon: 1, base: H, doc: strat("0.03"), reason: "r" });
  const v = await verifyProposal({ ...p, doc: strat("20") }, 1, ctx);
  assert.equal(v.ok, false); assert.match(v.reason, /signed hash/);
});
test("refused: the reason swapped after signing", async () => {
  const p = await signProposal(holder, NFT, { daemon: 1, base: H, doc: strat("0.03"), reason: "r" });
  const v = await verifyProposal({ ...p, reason: "something else" }, 1, ctx);
  assert.equal(v.ok, false); assert.match(v.reason, /reason doesn't match/);
});

test("approval: only the holder, only for that proposal's agentfile", async () => {
  const prop = { id: 7, doc: strat("0.03") };
  assert.equal((await verifyApproval(await signApproval(holder, NFT, { daemon: 1, proposal: 7, doc: prop.doc }), 1, prop, ctx)).ok, true);
  assert.match((await verifyApproval(await signApproval(stranger, NFT, { daemon: 1, proposal: 7, doc: prop.doc }), 1, prop, ctx)).reason, /only the holder/);
  assert.match((await verifyApproval(await signApproval(holder, NFT, { daemon: 1, proposal: 7, doc: strat("9") }), 1, prop, ctx)).reason, /different agentfile/);
  assert.match((await verifyApproval(await signApproval(holder, NFT, { daemon: 1, proposal: 8, doc: prop.doc }), 1, prop, ctx)).reason, /another proposal/);
});

const run = (doc, over = {}) => gates({ head: HEAD, headHash: H, doc, base: H, role: "holder", wallet, ...over });
const failed = (r) => r.gates.filter((g) => !g.ok).map((g) => g.gate);

test("gates: a sound change passes, with a plan", () => {
  const r = run(strat("0.03"));
  assert.equal(r.ok, true, JSON.stringify(r.gates));
  assert.deepEqual(r.plan, ['~ strategy "s": step "buy" changed']);
});
test("gate change: a no-op is refused", () => assert.deepEqual(failed(run(HEAD)), ["change"]));
test("gate base: a proposal on an old head is refused", () => assert.deepEqual(failed(run(strat("0.03"), { base: "000000000000" })), ["base"]));
test("gate lint: a doc that doesn't compile is refused", () => assert.deepEqual(failed(run(strat("0.03", "30m"))), ["lint"]));
test("gate within(wallet): a step over the per-call cap is refused", () => {
  const r = run(strat("0.03"), { wallet: { maxPerCall: 20_000, maxPerDay: 40_000_000 } });
  assert.deepEqual(failed(r), ["within(wallet)"]); assert.match(r.gates.find((g) => !g.ok).detail, /per-call cap/);
});
test("gate within(wallet): a strategy whose day could exceed the daily cap is refused", () => {
  const r = run(strat("0.03"), { wallet: { maxPerCall: 25_000_000, maxPerDay: 500_000 } }); // 0.03 × 24 = 0.72 > 0.50
  assert.deepEqual(failed(r), ["within(wallet)"]); assert.match(r.gates.find((g) => !g.ok).detail, /daily cap/);
});
test("gate constitution: only the holder changes think_budget", () => {
  const doc = { ...strat("0.03"), think_budget: "1" };
  assert.equal(run(doc).ok, true);
  assert.deepEqual(failed(run(doc, { role: "self" })), ["constitution"]);
  assert.deepEqual(failed(run(doc, { role: "sibling" })), ["constitution"]);
});
test("plan lists added and removed blocks and steps", () => {
  const doc = { strategy: { t: [{ every: "1h", input: [{}], step: { a: [{ mob: "top_movers" }] } }] } };
  assert.deepEqual(plan(HEAD, doc).sort(), ['+ strategy "t"', '- strategy "s"'].sort());
});

test("rejection: only the holder, only that proposal's agentfile, with the reason it signed", async () => {
  const prop = { id: 7, doc: strat("0.03") };
  const R = (acct, o = {}) => signRejection(acct, NFT, { daemon: 1, proposal: 7, doc: prop.doc, reason: "no", ...o });
  const ok = await verifyRejection(await R(holder), 1, prop, ctx);
  assert.deepEqual([ok.ok, ok.reason], [true, "no"]);
  assert.match((await verifyRejection(await R(stranger), 1, prop, ctx)).reason, /only the holder/);
  assert.match((await verifyRejection(await R(holder, { doc: strat("9") }), 1, prop, ctx)).reason, /different agentfile/);
  assert.match((await verifyRejection(await R(holder, { proposal: 8 }), 1, prop, ctx)).reason, /another proposal/);
  assert.match((await verifyRejection({ ...(await R(holder)), reason: "a different reason" }, 1, prop, ctx)).reason, /reason doesn't match/);
  assert.match((await verifyRejection({ ...(await R(holder)), reason: "" }, 1, prop, ctx)).reason, /reason is required/);
  assert.match((await verifyRejection(await R(holder, { sentAt: 1 }), 1, prop, ctx)).reason, /stale/);
  const appr = await signApproval(holder, NFT, { daemon: 1, proposal: 7, doc: prop.doc });
  assert.equal((await verifyRejection({ ...appr, reason: "no" }, 1, prop, ctx)).ok, false, "an approval can't be replayed as a rejection");
});
