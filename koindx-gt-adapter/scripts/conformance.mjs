// Live conformance run against a running adapter:
//  1. every endpoint answers in the GeckoTerminal Integration API schema (test/spec-check.js)
//  2. /events over the last N days, walked the way GeckoTerminal does (latest-block, then ranges up to it)
//  3. cross-check: every swap / join / exit of one pair in that window is compared, transaction by transaction,
//     with the pair's account history as decoded by the public Koinos REST API (an independent decoder)
// Usage: node scripts/conformance.mjs [adapterUrl] [days] [pairId]
//   defaults: http://127.0.0.1:3900, 3 days, KOIN/vUSDT 1E8AjPZxKLJGFouXtNNkPcYxAgsTh4AUTN
import { checkAsset, checkEvents, checkLatestBlock, checkPair } from '../test/spec-check.js';
import { KoinosRpc } from '../src/koinos.js';
import { formatUnits } from '../src/format.js';

const [base = 'http://127.0.0.1:3900', daysArg = '3', PAIR = '1E8AjPZxKLJGFouXtNNkPcYxAgsTh4AUTN'] = process.argv.slice(2);
const days = Number(daysArg);
const REST = process.env.KOINOS_REST || 'https://api.koinos.io';
const rpc = new KoinosRpc({ url: process.env.KOINOS_RPC || 'https://api.koinos.io' });
const TOKENS = {
  KOIN: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK',
  vUSDT: '12VoHz41a4HtfiyhTWbg9RXqGMRbYk6pXh',
  vUSDC: '1N8iYrYEJdCVK1rhbqv3qZUzHcpoeKmFnj',
  VHP: '12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq',
};
const PAIRS = ['1E8AjPZxKLJGFouXtNNkPcYxAgsTh4AUTN', '19ygpmxRiM9zU7yiVc9wnbtHEK4Aa6s2gL', '1NqLghiFRwkXZR7NBFHHiCJkF5gLHyJap1'];

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rest = async (path) => {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(REST + path, { headers: { 'user-agent': 'koindx-gt-adapter/0.1' } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`rest ${path}`);
};

// 1. endpoints
const latest = await get('/latest-block');
check('/latest-block schema', latest.status === 200 && checkLatestBlock(latest.body).length === 0, JSON.stringify(latest.body));
const head = await rpc.headInfo();
const L = latest.body.block.blockNumber;
check('/latest-block is irreversible (<= chain LIB) and current', L <= head.lib && L >= head.lib - 200, `adapter ${L}, chain lib ${head.lib}`);
const [lb] = await rpc.blocksByHeight(head.headId, L, 1, { receipts: false });
check('/latest-block timestamp = block header (seconds)', Math.floor(Number(lb.block.header.timestamp) / 1000) === latest.body.block.blockTimestamp);

for (const [sym, id] of Object.entries(TOKENS)) {
  const a = await get(`/asset?id=${id}`);
  const problems = checkAsset(a.body);
  check(`/asset ${sym}`, a.status === 200 && !problems.length && a.body.asset.decimals === 8, JSON.stringify(a.body.asset) + (problems.length ? ' ' + problems : ''));
}
const pairInfo = {};
for (const id of PAIRS) {
  const p = await get(`/pair?id=${id}`);
  const problems = checkPair(p.body);
  pairInfo[id] = p.body?.pair;
  check(`/pair ${id.slice(0, 8)}`, p.status === 200 && !problems.length && p.body.pair.feeBps === 25, JSON.stringify(p.body.pair) + (problems.length ? ' ' + problems : ''));
}
check('/pair of a token is 404', (await get(`/pair?id=${TOKENS.KOIN}`)).status === 404);
check('/pair of garbage is 400', (await get('/pair?id=not-an-address')).status === 400);
check('/events beyond latest-block is refused', (await get(`/events?fromBlock=${L}&toBlock=${L + 50}`)).status === 503);

// 2. walk /events like the GeckoTerminal indexer: ranges up to the latest block
const from = L - Math.round(days * 86400 / 3);
const step = 10000;
const events = [];
const t0 = Date.now();
for (let s = from; s <= L; s += step) {
  const e = Math.min(L, s + step - 1);
  const r = await get(`/events?fromBlock=${s}&toBlock=${e}`);
  const problems = r.status === 200 ? checkEvents(r.body, s, e) : [`http ${r.status} ${JSON.stringify(r.body)}`];
  if (problems.length) check(`/events ${s}..${e}`, false, problems.slice(0, 3).join('; '));
  else events.push(...r.body.events);
}
check(`/events ${from}..${L} (${L - from + 1} blocks) in spec`, failures === 0, `${events.length} events in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
check('/events whole window in chain order', checkEvents({ events }, from, L).length === 0);

// 3. cross-check one pair with the REST account history
const mine = events.filter((e) => e.pairId === PAIR);
const byTx = new Map();
for (const e of mine) {
  if (!byTx.has(e.txnId)) byTx.set(e.txnId, []);
  byTx.get(e.txnId).push(e);
}
const oldest = mine.length ? mine[0].block.blockNumber : null;
const info = pairInfo[PAIR];
const d0 = (await get(`/asset?id=${info.asset0Id}`)).body.asset.decimals;
const d1 = (await get(`/asset?id=${info.asset1Id}`)).body.asset.decimals;
const expected = [];
let seq = null;
let done = false;
while (!done) {
  const page = await rest(`/v1/account/${PAIR}/history?limit=100&ascending=false&decode_operations=false&decode_events=true${seq !== null ? `&sequence_number=${seq}` : ''}`);
  if (!page.length) break;
  for (const rec of page) {
    const trx = rec.trx;
    if (!trx) continue;
    const txId = trx.transaction.id;
    const where = await rpc.transactionBlock(txId, head.headId);
    if (where.height > L) continue;
    if (where.height < from) {
      done = true;
      break;
    }
    if (trx.receipt.reverted) continue;
    const evs = trx.receipt.events || [];
    evs.forEach((ev, idx) => {
      if (ev.source !== PAIR || !['core.swap_event', 'core.mint_event', 'core.burn_event'].includes(ev.name)) return;
      expected.push({ txId, idx, name: ev.name, data: ev.data, sync: evs.slice(0, idx).reverse().find((x) => x.source === PAIR && x.name === 'core.sync_event')?.data, height: where.height, txIndex: where.txIndex });
    });
  }
  const last = page[page.length - 1].seq_num;
  if (last === undefined || Number(last) <= 1) break;
  seq = Number(last) - 1;
}
check(`cross-check ${PAIR.slice(0, 8)}: same number of events as the REST history`, expected.length === mine.length, `adapter ${mine.length}, REST ${expected.length}${oldest ? `, oldest adapter block ${oldest}` : ''}`);
let mismatches = 0;
for (const x of expected) {
  const got = (byTx.get(x.txId) || []).find((e) => e.eventIndex === x.idx);
  const f = (v, d) => formatUnits(BigInt(v || '0'), d);
  const want =
    x.name === 'core.swap_event'
      ? BigInt(x.data.amount_out_b || '0') > 0n
        ? { eventType: 'swap', asset0In: f(x.data.amount_in_a, d0), asset1Out: f(x.data.amount_out_b, d1) }
        : { eventType: 'swap', asset1In: f(x.data.amount_in_b, d1), asset0Out: f(x.data.amount_out_a, d0) }
      : { eventType: x.name === 'core.mint_event' ? 'join' : 'exit', amount0: f(x.data.amount_a, d0), amount1: f(x.data.amount_b, d1) };
  want.reserves = { asset0: f(x.sync?.reserve_a, d0), asset1: f(x.sync?.reserve_b, d1) };
  const ok =
    got &&
    got.block.blockNumber === x.height &&
    got.txnIndex === x.txIndex &&
    Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));
  if (!ok) {
    mismatches++;
    if (mismatches <= 3) console.log('  mismatch', x.txId, JSON.stringify(want), '->', JSON.stringify(got));
  }
}
check(`cross-check ${PAIR.slice(0, 8)}: every event identical (amounts, reserves, block, txnIndex)`, mismatches === 0 && expected.length > 0, `${expected.length - mismatches}/${expected.length} identical`);

// summary
const types = {};
const perPair = {};
for (const e of events) {
  types[e.eventType] = (types[e.eventType] || 0) + 1;
  perPair[e.pairId] = (perPair[e.pairId] || 0) + 1;
}
console.log(`\nwindow ${from}..${L}: ${JSON.stringify(types)} across ${Object.keys(perPair).length} pairs`);
const health = await get('/health');
console.log('health:', JSON.stringify(health.body));
check('no events were skipped', Object.values(health.body.skipped).every((v) => v === 0), JSON.stringify(health.body.skipped));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
