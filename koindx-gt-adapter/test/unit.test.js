import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode, encode, getBytes, getString, getUint } from '../src/protobuf.js';
import { alignReceipts, base58Decode, base58Encode, fromBase64, isAddress, KoinosRpc, toBase64, transactionMerkleRoot } from '../src/koinos.js';
import { formatBps, formatUnits, priceNative } from '../src/format.js';
import { buildEvents, candidateSources, newStats, UnrepresentableEventError } from '../src/events.js';
import { checkEvents } from './spec-check.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const PERIPHERY = '17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s';
const peripheries = new Set([PERIPHERY]);
const clone = (o) => JSON.parse(JSON.stringify(o));

test('protobuf: round trip and proto3 defaults', () => {
  const bytes = encode([[1, 'varint', 150n], [2, 'bytes', new Uint8Array([1, 2, 3])], [3, 'varint', 2n ** 64n - 1n]]);
  const f = decode(bytes);
  assert.equal(getUint(f, 1), 150n);
  assert.deepEqual([...getBytes(f, 2)], [1, 2, 3]);
  assert.equal(getUint(f, 3), 2n ** 64n - 1n);
  assert.equal(getUint(f, 9), 0n);
  assert.equal(getBytes(f, 9).length, 0);
  assert.equal(getString(decode(encode([[1, 'bytes', new TextEncoder().encode('KOIN')]])), 1), 'KOIN');
  assert.throws(() => decode(Uint8Array.from([0x08, 0x80])), /truncated/);
  assert.throws(() => decode(Uint8Array.from([0x12, 0x05, 0x01])), /truncated/);
  assert.throws(() => getUint(decode(encode([[1, 'bytes', new Uint8Array([1])]])), 1), /not a varint/);
});

test('base58 and address validation', () => {
  const id = '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK';
  const bytes = base58Decode(id);
  assert.equal(bytes.length, 25);
  assert.equal(base58Encode(bytes), id);
  assert.equal(isAddress(id), true);
  assert.equal(isAddress(PERIPHERY), true);
  assert.equal(isAddress('19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkL'), false, 'checksum');
  assert.equal(isAddress('0x19GYjDBVXU7keLbYvMLazsGQn3GTWHj'), false);
  assert.equal(isAddress('../../etc/passwd'), false);
  assert.equal(isAddress(null), false);
  assert.equal(toBase64(fromBase64('CN2XlLX-rgMQ09KJmZ0H')), 'CN2XlLX-rgMQ09KJmZ0H');
});

test('exact decimal formatting and prices', () => {
  assert.equal(formatUnits(0n, 8), '0');
  assert.equal(formatUnits(1n, 8), '0.00000001');
  assert.equal(formatUnits(123456789012n, 8), '1234.56789012');
  assert.equal(formatUnits(100000000n, 8), '1');
  assert.equal(formatUnits(5n, 0), '5');
  assert.throws(() => formatUnits(-1n, 8));
  // 1 KOIN (8 dp) for 0.01677 vUSDT (8 dp)
  assert.equal(priceNative(100000000n, 8, 1677000n, 8), '0.01677');
  // different decimals: 2 units of a 6-dp token for 1 unit of an 18-dp token
  assert.equal(priceNative(2000000n, 6, 10n ** 18n, 18), '0.5');
  assert.equal(priceNative(3n, 0, 1n, 0), '0.' + '3'.repeat(50));
  assert.equal(priceNative(0n, 8, 1n, 8), null);
  assert.equal(priceNative(10n ** 60n, 0, 1n, 0), null, 'below 1e-50 is no price');
  assert.equal(formatBps(10000n, 25, 8), '0.00000025');
  assert.equal(formatBps(621079605n, 25, 8), '0.015526990125');
});

test('real multi-hop block: swaps match the REST decoder exactly', () => {
  const item = fixture('block-multihop-swap.json');
  const rest = fixture('rest-decoded.json');
  const pairs = new Map(Object.entries(fixture('pairs.json')));
  assert.equal(candidateSources([item]).size, 7);

  const stats = newStats();
  const events = buildEvents([item], pairs, { peripheries, stats });
  assert.deepEqual(checkEvents({ events }), []);
  assert.deepEqual(stats, newStats(), 'nothing skipped');

  const txId = item.block.transactions[0].id;
  const decoded = rest[txId];
  const swaps = decoded.filter((e) => e.name === 'core.swap_event' && pairs.has(e.source));
  assert.equal(swaps.length, 7);
  assert.equal(events.length, swaps.length);

  for (const ref of swaps) {
    const idx = decoded.indexOf(ref);
    const got = events.find((e) => e.eventIndex === idx);
    assert.ok(got, `event ${idx} missing`);
    const pair = pairs.get(ref.source);
    const d = ref.data;
    const n = (k) => BigInt(d[k] || '0');
    assert.equal(got.pairId, ref.source);
    assert.equal(got.txnId, txId);
    assert.equal(got.txnIndex, 0);
    assert.equal(got.maker, item.block.transactions[0].header.payee);
    assert.equal(got.block.blockNumber, Number(item.block_height));
    if (n('amount_in_a') > 0n) {
      assert.equal(got.asset0In, formatUnits(n('amount_in_a'), pair.decimals0));
      assert.equal(got.asset1Out, formatUnits(n('amount_out_b'), pair.decimals1));
      const expected = Number(n('amount_out_b')) / 10 ** pair.decimals1 / (Number(n('amount_in_a')) / 10 ** pair.decimals0);
      assert.ok(Math.abs(Number(got.priceNative) / expected - 1) < 1e-12);
    } else {
      assert.equal(got.asset1In, formatUnits(n('amount_in_b'), pair.decimals1));
      assert.equal(got.asset0Out, formatUnits(n('amount_out_a'), pair.decimals0));
      const expected = Number(n('amount_in_b')) / 10 ** pair.decimals1 / (Number(n('amount_out_a')) / 10 ** pair.decimals0);
      assert.ok(Math.abs(Number(got.priceNative) / expected - 1) < 1e-12);
    }
    // reserves: the sync_event of the same pair right before the swap
    const sync = decoded.slice(0, idx).reverse().find((e) => e.name === 'core.sync_event' && e.source === ref.source);
    assert.equal(got.reserves.asset0, formatUnits(BigInt(sync.data.reserve_a), pair.decimals0));
    assert.equal(got.reserves.asset1, formatUnits(BigInt(sync.data.reserve_b), pair.decimals1));
  }
});

// synthetic receipts to exercise the rules the real block does not hit
const addr = (s) => base58Decode(s);
const evt = (source, name, fields) => ({ source, name, data: toBase64(encode(fields)), impacted: [] });
const PAIR = '1E8AjPZxKLJGFouXtNNkPcYxAgsTh4AUTN';
const USER = '1N55NkbDiovpuZobzVa7ww6CtaWSjfdM8T';
const pairInfo = new Map([[PAIR, { id: PAIR, token0: 'a', token1: 'b', decimals0: 8, decimals1: 8 }]]);
const block = (events, extra = {}) => ({
  block_height: '100',
  block: { header: { height: '100', timestamp: '1790000000123' }, transactions: [{ id: '0xtx', header: { payer: USER } }] },
  receipt: { transaction_receipts: [{ id: '0xtx', events, ...extra }] },
});
const sync = (r0, r1) => evt(PAIR, 'core.sync_event', [[1, 'varint', r0], [2, 'varint', r1]]);

test('join and exit carry amounts and reserves; timestamps are seconds', () => {
  const events = buildEvents(
    [block([
      sync(1000n, 2000n),
      evt(PAIR, 'core.mint_event', [[1, 'bytes', addr(USER)], [2, 'varint', 100n], [3, 'varint', 200n]]),
      sync(900n, 1800n),
      evt(PAIR, 'core.burn_event', [[1, 'bytes', addr(USER)], [2, 'bytes', addr(PERIPHERY)], [3, 'varint', 100n], [4, 'varint', 200n]]),
    ])],
    pairInfo,
    { peripheries },
  );
  assert.deepEqual(checkEvents({ events }), []);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.eventType, e.amount0, e.amount1, e.reserves.asset0, e.eventIndex, e.block.blockTimestamp, e.maker]),
    [
      ['join', '0.000001', '0.000002', '0.00001', 1, 1790000000, USER],
      ['exit', '0.000001', '0.000002', '0.000009', 3, 1790000000, USER],
    ],
  );
});

test('what cannot be represented fails loudly, what is not KoinDX is left out', () => {
  const swap = (inA, inB, outA, outB, sender = PERIPHERY) =>
    evt(PAIR, 'core.swap_event', [[1, 'bytes', addr(USER)], [2, 'bytes', addr(sender)], [3, 'varint', inA], [4, 'varint', inB], [5, 'varint', outA], [6, 'varint', outB]]);
  const run = (events, extra) => {
    const stats = newStats();
    return { events: buildEvents([block(events, extra)], pairInfo, { peripheries, stats }), stats };
  };
  // GeckoTerminal reads every block once: these must fail the whole answer, not disappear
  assert.throws(() => run([swap(100n, 0n, 0n, 50n)]), UnrepresentableEventError, 'no sync before the swap');
  assert.throws(() => run([sync(1n, 1n), swap(100n, 5n, 0n, 0n)]), UnrepresentableEventError, 'nothing paid out');
  assert.throws(() => run([sync(1n, 1n), swap(100n, 0n, 7n, 60n)]), UnrepresentableEventError, 'paid out on both sides');
  assert.throws(() => run([sync(1n, 1n), swap(0n, 10n, 0n, 60n)]), UnrepresentableEventError, 'nothing came in of the other token');
  assert.throws(() => run([sync(1n, 1n), swap(0n, 0n, 0n, 0n)]), UnrepresentableEventError, 'nothing moved');
  // a transfer-tax token flowing back on the paid-out side is not part of the trade
  const taxed = run([sync(1n, 1n), swap(100n, 10n, 0n, 60n)]).events[0];
  assert.deepEqual([taxed.asset0In, taxed.asset1Out, 'asset1In' in taxed], ['0.000001', '0.0000006', false]);
  assert.throws(() => run([sync(1n, 1n), { ...swap(1n, 0n, 0n, 1n), data: '__' }]), UnrepresentableEventError, 'undecodable');
  // a sync belongs to one action only
  assert.throws(() => run([sync(1n, 1n), swap(100n, 0n, 0n, 50n), swap(100n, 0n, 0n, 50n)]), /no sync_event/);
  assert.equal(run([sync(1n, 1n), swap(100n, 0n, 0n, 50n), sync(2n, 2n), swap(100n, 0n, 0n, 50n)]).events.length, 2);
  // not KoinDX: left out, and counted where it is a pool of KoinDX code with another router
  const foreign = run([sync(1n, 1n), swap(100n, 0n, 0n, 50n, USER)]);
  assert.equal(foreign.events.length, 0);
  assert.equal(foreign.stats.foreignPeriphery, 1);
  assert.equal(run([sync(1n, 1n), swap(100n, 0n, 0n, 50n)], { reverted: true }).events.length, 0, 'reverted transaction');
  assert.equal(run([{ ...sync(1n, 1n), source: USER }, { ...swap(100n, 0n, 0n, 50n), source: USER }]).events.length, 0, 'unverified contract');
});

test('transaction merkle root: real block matches, a missing transaction does not', () => {
  const item = fixture('block-multihop-swap.json');
  const root = Buffer.from(fromBase64(item.block.header.transaction_merkle_root));
  assert.ok(transactionMerkleRoot(item.block.transactions).equals(root));
  assert.ok(!transactionMerkleRoot([]).equals(root));
  // sha256 of nothing for an empty block
  assert.equal(transactionMerkleRoot([]).toString('hex'), '1220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('rpc: an incomplete block answer is never returned', async () => {
  const EMPTY_ROOT = toBase64(transactionMerkleRoot([]));
  const answer = (items) => async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { block_items: items } }) });
  const item = (h) => ({
    block_id: `b${h}`,
    block_height: String(h),
    block: { header: { height: String(h), timestamp: '1790000000000', transaction_merkle_root: EMPTY_ROOT }, transactions: [] },
    receipt: { id: `b${h}`, height: String(h), transaction_receipts: [] },
  });
  const rpcWith = (items) => new KoinosRpc({ url: 'x', retries: 0, fetchImpl: answer(items) });
  assert.equal((await rpcWith([item(5), item(6)]).blocksByHeight('h', 5, 2)).length, 2);
  await assert.rejects(rpcWith([item(5)]).blocksByHeight('h', 5, 2), /expected 2 blocks/);
  await assert.rejects(rpcWith([item(5), item(7)]).blocksByHeight('h', 5, 2), /missing or out of order/);
  const noReceipt = clone(item(5));
  delete noReceipt.receipt;
  await assert.rejects(rpcWith([noReceipt]).blocksByHeight('h', 5, 1), /no receipt/);
  const noTimestamp = clone(item(5));
  delete noTimestamp.block.header.timestamp;
  await assert.rejects(rpcWith([noTimestamp]).blocksByHeight('h', 5, 1), /no timestamp/);
  // the real block, with its transaction (and receipt) removed: the header's merkle root gives it away
  const real = fixture('block-multihop-swap.json');
  assert.equal((await rpcWith([real]).blocksByHeight('h', Number(real.block_height), 1)).length, 1);
  const stripped = clone(real);
  stripped.block.transactions = [];
  stripped.receipt.transaction_receipts = [];
  await assert.rejects(rpcWith([stripped]).blocksByHeight('h', Number(real.block_height), 1), /merkle root/);
  const mismatch = clone(real);
  mismatch.receipt.transaction_receipts = [];
  await assert.rejects(rpcWith([mismatch]).blocksByHeight('h', Number(real.block_height), 1), /do not match/);
  const otherBlock = clone(item(5));
  otherBlock.receipt.id = 'b4';
  await assert.rejects(rpcWith([otherBlock]).blocksByHeight('h', 5, 1), /another block/);
  // a governance proposal applied in the block: its receipt has no transaction in the block, on every node
  const gov = fixture('block-governance-proposal.json');
  assert.equal((await rpcWith([gov]).blocksByHeight('h', Number(gov.block_height), 1)).length, 1);
  const govAndReal = clone(real);
  govAndReal.receipt.transaction_receipts.push(clone(gov.receipt.transaction_receipts[0]));
  assert.equal((await rpcWith([govAndReal]).blocksByHeight('h', Number(real.block_height), 1)).length, 1);
  // a node that answers after a failed first attempt
  let calls = 0;
  const flaky = async (...args) => (++calls === 1 ? { ok: false, status: 502 } : answer([item(5)])(...args));
  assert.equal((await new KoinosRpc({ url: 'x', retries: 1, fetchImpl: flaky }).blocksByHeight('h', 5, 1)).length, 1);
});

test('pool: stops after a failure and returns only when every running task is done', async () => {
  const { pool } = await import('../src/server.js');
  const started = [];
  let running = 0;
  const task = (i, ms, fail) => async () => {
    started.push(i);
    running++;
    await new Promise((r) => setTimeout(r, ms));
    running--;
    if (fail) throw new Error(`task ${i} failed`);
    return i;
  };
  await assert.rejects(pool([task(0, 5, true), task(1, 40), task(2, 5), task(3, 5)], 2), /task 0 failed/);
  assert.equal(running, 0, 'nothing still running after the rejection');
  assert.deepEqual(started, [0, 1], 'no new task after the failure');
  assert.deepEqual(await pool([task(0, 10), task(1, 1), task(2, 5)], 2), [0, 1, 2]);
});

test('registry: a failing code-hash lookup is thrown and not cached as "not a pair"', async () => {
  const { KoindxRegistry } = await import('../src/koindx.js');
  const { RpcError } = await import('../src/koinos.js');
  let fail = true;
  const rpc = {
    contractCodeHash: async () => {
      if (fail) throw new RpcError('backend hiccup', -32603);
      return '1220a3ca71ad5ca801080265aeec7842a1d51c1d220e6461c72a98344f49b8e5a532';
    },
    readContract: async () => encode([[1, 'bytes', base58Decode('19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK')], [2, 'bytes', base58Decode('12VoHz41a4HtfiyhTWbg9RXqGMRbYk6pXh')]]),
  };
  const registry = new KoindxRegistry(rpc, { pairCodeHashes: ['1220a3ca71ad5ca801080265aeec7842a1d51c1d220e6461c72a98344f49b8e5a532'] });
  await assert.rejects(registry.resolvePair(PAIR, { fromEvent: true }), /hiccup/);
  fail = false;
  assert.deepEqual(await registry.resolvePair(PAIR, { fromEvent: true }), {
    id: PAIR,
    token0: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK',
    token1: '12VoHz41a4HtfiyhTWbg9RXqGMRbYk6pXh',
  });
  // no code: for an event source the node must be lagging (thrown), for a plain lookup it is simply not a pair
  const noCode = new KoindxRegistry({ contractCodeHash: async () => '' }, { pairCodeHashes: ['bb'] });
  await assert.rejects(noCode.resolvePair(PAIR, { fromEvent: true }), /no code/);
  assert.equal(await noCode.resolvePair(PAIR), null);
  assert.equal(noCode.notPairs.size, 0, 'not cached');
  // other code: not a pair, remembered for /health only when it came from an event
  const other = new KoindxRegistry({ contractCodeHash: async () => 'aa' }, { pairCodeHashes: ['bb'] });
  assert.equal(await other.resolvePair(PAIR), null);
  assert.equal(other.unknownCode.size, 0);
  const other2 = new KoindxRegistry({ contractCodeHash: async () => 'aa' }, { pairCodeHashes: ['bb'] });
  assert.equal(await other2.resolvePair(PAIR, { fromEvent: true }), null);
  assert.equal(other2.unknownCode.get(PAIR), 'aa');
});

test('real transfer-tax swap: amounts are what the pool received and paid out by the curve', () => {
  const item = fixture('block-transfer-tax-swap.json');
  const pairs = new Map(Object.entries(fixture('pairs-transfer-tax.json')));
  const events = buildEvents([item], pairs, { peripheries });
  assert.deepEqual(checkEvents({ events }), []);
  const e = events.find((x) => x.pairId === '1DbXhuRd31m5RBrafkMoK6cuZnS3ohLsfu');
  const p = pairs.get(e.pairId);
  // on chain: amount_in_a 927774603319, amount_in_b 86525689 (tax flowing back), amount_out_b 26375249695;
  // the recipient got 25056487211 after the token's 5 % tax, the pool paid 26375249695 by the curve
  assert.equal(e.asset0In, formatUnits(927774603319n, p.decimals0));
  assert.equal(e.asset1Out, formatUnits(26375249695n, p.decimals1));
  assert.ok(!('asset1In' in e) && !('asset0Out' in e));
  assert.equal(e.reserves.asset0, formatUnits(1212681187631751n, p.decimals0));
  assert.equal(e.reserves.asset1, formatUnits(34534767388066n, p.decimals1));
});

test('registry: a shared lookup is interpreted per caller; a creation not found yet is not cached', async () => {
  const { KoindxRegistry } = await import('../src/koindx.js');
  let calls = 0;
  const rpc = {
    contractCodeHash: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return '';
    },
  };
  const registry = new KoindxRegistry(rpc, { pairCodeHashes: ['bb'] });
  // /pair and /events ask at the same time: one node call, two different meanings
  const [plain, fromEvent] = await Promise.allSettled([registry.resolvePair(PAIR), registry.resolvePair(PAIR, { fromEvent: true })]);
  assert.equal(calls, 1);
  assert.equal(plain.value, null);
  assert.match(fromEvent.reason.message, /no code/);

  let history = [];
  const r2 = new KoindxRegistry(
    {
      call: async () => ({ values: history }),
      transactionBlock: async () => ({ height: 10, timestamp: 1700000000, txIndex: 0 }),
    },
    { pairCodeHashes: ['bb'] },
  );
  assert.equal(await r2.getPairCreation(PAIR, 'head'), null, 'not irreversible yet');
  history = [{ trx: { transaction: { id: '0xc', operations: [{ upload_contract: { contract_id: PAIR } }] }, receipt: { events: [] } } }];
  assert.deepEqual(await r2.getPairCreation(PAIR, 'head'), { blockNumber: 10, blockTimestamp: 1700000000, txnId: '0xc' });
  // a record that neither uploads the pair nor initializes it is not its creation
  const r3 = new KoindxRegistry({ call: async () => ({ values: [{ trx: { transaction: { id: '0xfund', operations: [] }, receipt: { events: [] } } }] }) }, { pairCodeHashes: ['bb'] });
  assert.equal(await r3.getPairCreation(PAIR, 'head'), null);
});

test('a pool with unknown code that names the KoinDX periphery is reported, never fatal (the field can be forged)', async () => {
  const OTHER = '1AGXLwL6HRyrNpz4n381Yz3suma1uDdErj';
  const ROUTER2 = '14WeQjBk7F4C58xUquRGLK1KiqRjwj5Y4J';
  const swapBy = (sender) =>
    evt(OTHER, 'core.swap_event', [[1, 'bytes', addr(USER)], [2, 'bytes', addr(sender)], [3, 'varint', 100n], [5, 'varint', 0n], [6, 'varint', 50n]]);
  const foreign = new Map([[OTHER, 'deadbeef']]);
  const suspects = new Map();
  assert.equal(buildEvents([block([swapBy(PERIPHERY)])], pairInfo, { peripheries, foreign, suspects }).length, 0);
  assert.deepEqual(suspects.get(OTHER), { codeHash: 'deadbeef', lastBlock: 100 });
  const none = new Map();
  assert.equal(buildEvents([block([swapBy(ROUTER2)])], pairInfo, { peripheries, foreign, suspects: none }).length, 0);
  assert.equal(none.size, 0, 'another router: not a suspect');
  const { boundedSet } = await import('../src/events.js');
  const capped = new Map();
  for (let i = 0; i < 250; i++) boundedSet(capped, `c${i}`, i, 100);
  assert.equal(capped.size, 100);
  assert.deepEqual([capped.keys().next().value, [...capped.keys()].pop()], ['c150', 'c249'], 'oldest out first');

  const { KoindxRegistry } = await import('../src/koindx.js');
  const r = new KoindxRegistry({ contractCodeHash: async () => 'aa' }, { pairCodeHashes: ['bb'], excludedCodeHashes: ['aa'] });
  assert.equal(await r.resolvePair(OTHER, { fromEvent: true }), null);
  assert.equal(r.otherCodeHash(OTHER), 'aa');
  assert.equal(r.unknownCode.size, 0, 'excluded code is not reported as unknown');
  // a plain /pair lookup first, then the same contract as an event source: still known as foreign code
  const r2 = new KoindxRegistry({ contractCodeHash: async () => 'cc' }, { pairCodeHashes: ['bb'] });
  await r2.resolvePair(OTHER);
  await r2.resolvePair(OTHER, { fromEvent: true });
  assert.equal(r2.unknownCode.get(OTHER), 'cc');
});

test('governance: a transaction applied outside the block is aligned away; KoinDX events in one fail loudly', () => {
  const gov = fixture('block-governance-proposal.json');
  assert.equal(gov.block.transactions, undefined);
  const { aligned, extra } = alignReceipts(gov);
  assert.equal(aligned.length, 0);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].reverted, true);
  assert.deepEqual(buildEvents([gov], pairInfo, { peripheries: new Set([USER]) }), []);
  // the extra receipt first, then the block's own transaction: txnIndex stays the block position
  const swapTx = block([
    sync(900n, 1100n),
    evt(PAIR, 'core.swap_event', [[1, 'bytes', addr(USER)], [2, 'bytes', addr(USER)], [3, 'varint', 100n], [6, 'varint', 90n]]),
  ]);
  const both = clone(swapTx);
  both.receipt.transaction_receipts.unshift({ id: '0xgov', events: [], reverted: false });
  const evs = buildEvents([both], pairInfo, { peripheries: new Set([USER]) });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].txnIndex, 0);
  assert.equal(evs[0].txnId, '0xtx');
  // a KoinDX event inside a governance transaction has no txnIndex: never guessed
  const inGov = clone(swapTx);
  inGov.receipt.transaction_receipts.push({ id: '0xgov', events: [sync(1n, 1n)], reverted: false });
  assert.throws(() => buildEvents([inGov], pairInfo, { peripheries: new Set([USER]) }), UnrepresentableEventError);
  // a transaction of the block without its receipt is not complete data
  const missing = clone(swapTx);
  missing.receipt.transaction_receipts = [{ id: '0xgov', events: [] }];
  assert.equal(alignReceipts(missing), null);
});
