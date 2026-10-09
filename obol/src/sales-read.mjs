// The sale feed's reader, pure (no Workers runtime): chunked getLogs over a block range.
const CHUNK = 500_000n;

/** read Bought logs from `from` to `to` in chunks (halving a chunk the RPC refuses); → { rows, last } (pure over `getLogs`) */
export async function readSales(getLogs, from, to, chunk = CHUNK) {
  const rows = [];
  let a = from, size = chunk;
  while (a <= to) {
    const b = a + size - 1n > to ? to : a + size - 1n;
    let logs;
    try { logs = await getLogs(a, b); }
    catch (e) { if (size > 1000n) { size /= 2n; continue; } throw e; }
    for (const l of logs) rows.push({ token: Number(l.args.tokenId), buyer: l.args.buyer, band: Number(l.args.band) + 1, price: String(l.args.price), wallet: l.args.wallet,
      block: Number(l.blockNumber), tx: l.transactionHash, logIndex: Number(l.logIndex) });
    a = b + 1n;
  }
  return { rows, last: to };
}

