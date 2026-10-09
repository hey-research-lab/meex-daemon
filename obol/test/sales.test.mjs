// The sale feed's reader: chunked getLogs, halving a refused chunk, every Bought decoded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSales } from "../src/sales-read.mjs";

const log = (token, block, i = 0) => ({ args: { tokenId: BigInt(token), buyer: "0xb0", band: 2n, price: 16900000000000000n, wallet: "0xw" }, blockNumber: BigInt(block), transactionHash: "0xt" + token, logIndex: i });

test("reads every chunk to the tip, decodes band 1-based and the price as a string", async () => {
  const seen = [];
  const r = await readSales(async (a, b) => { seen.push([a, b]); return a <= 150n && 150n <= b ? [log(212, 150)] : []; }, 100n, 1099n, 400n);
  assert.deepEqual(seen, [[100n, 499n], [500n, 899n], [900n, 1099n]]);
  assert.equal(r.last, 1099n);
  assert.deepEqual(r.rows, [{ token: 212, buyer: "0xb0", band: 3, price: "16900000000000000", wallet: "0xw", block: 150, tx: "0xt212", logIndex: 0 }]);
});

test("a refused chunk is halved and retried, never skipped", async () => {
  const seen = [];
  const r = await readSales(async (a, b) => { seen.push(b - a + 1n); if (b - a + 1n > 250_000n) throw new Error("range too large"); return a <= 7n && 7n <= b ? [log(7, 7)] : []; }, 0n, 600_000n, 1_000_000n);
  assert.equal(r.rows.length, 1);
  assert.ok(seen.slice(0, 3).join() === "600001,500000,250000", seen.join());
  assert.equal(r.last, 600_000n);
});

test("nothing new is nothing read", async () => {
  assert.deepEqual(await readSales(async () => { throw new Error("must not read"); }, 10n, 9n), { rows: [], last: 9n });
});
