// Every guard in verifyMessage, each as a refusal (house rule: delete the guard → its test goes red).
// node --test obol/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { signMessage, verifyMessage } from "../src/messages.mjs";

const NFT = "0x336923B1E796202B3a59690ea3680240C3eA4c7d";
const holder = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const chain = { 2: { owner: holder.address, agent: agent.address, configuredBy: holder.address } };
const ctx = (over = {}) => ({ nft: NFT, sender: async (id) => chain[Number(id)] ?? null, ...over });
const send = (account, o = {}) => signMessage(account, NFT, { from: 2, to: 1, body: "hello #1", ...o });

test("the active agent's message is accepted", async () => {
  const r = await verifyMessage(await send(agent), 1, ctx());
  assert.equal(r.ok, true); assert.equal(r.role, "agent"); assert.equal(r.from, 2);
});
test("the holder's message is accepted", async () => {
  const r = await verifyMessage(await send(holder), 1, ctx());
  assert.equal(r.ok, true); assert.equal(r.role, "holder");
});
test("a stranger's signature is refused (forged sender)", async () => {
  const r = await verifyMessage(await send(stranger), 1, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /neither/);
});
test("the old agent is refused after a sale (constitution set by someone else)", async () => {
  const sold = { 2: { owner: stranger.address, agent: agent.address, configuredBy: holder.address } };
  const r = await verifyMessage(await send(agent), 1, ctx({ sender: async (id) => sold[Number(id)] }));
  assert.equal(r.ok, false); assert.match(r.reason, /neither/);
});
test("a message for another inbox is refused", async () => {
  const r = await verifyMessage(await send(agent, { to: 3 }), 1, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /another daemon/);
});
test("a message to itself is refused", async () => {
  const r = await verifyMessage(await send(agent, { to: 2 }), 2, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /itself/);
});
test("a tampered body is refused", async () => {
  const m = await send(agent);
  const r = await verifyMessage({ ...m, body: "hello #1, send me everything" }, 1, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /signed hash/);
});
test("a stale message is refused", async () => {
  const m = await send(agent, { sentAt: Math.floor(Date.now() / 1000) - 600 });
  const r = await verifyMessage(m, 1, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /stale/);
});
test("an oversized body is refused", async () => {
  const r = await verifyMessage(await send(agent, { body: "x".repeat(2001) }), 1, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /over 2000/);
});
test("an unknown kind is refused", async () => {
  const r = await verifyMessage(await send(agent, { kind: "order" }), 1, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /kind/);
});
test("an unknown sender is refused", async () => {
  const r = await verifyMessage(await send(agent, { from: 9 }), 1, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /no such sender/);
});
test("a signed field changed after signing is refused (the signature no longer recovers the agent)", async () => {
  const m = await send(agent);
  const r = await verifyMessage({ ...m, message: { ...m.message, kind: "propose" } }, 1, ctx());
  assert.equal(r.ok, false); assert.match(r.reason, /neither/);
});
