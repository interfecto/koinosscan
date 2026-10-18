import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { NotFoundError } from '../src/koindx.js';
import { checkAsset, checkEvents, checkLatestBlock, checkPair } from './spec-check.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const item = fixture('block-multihop-swap.json');
const pairs = fixture('pairs.json');
const HEIGHT = Number(item.block_height);
const LIB = HEIGHT + 10;
const KOIN = '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK';
const PAIR = '1E8AjPZxKLJGFouXtNNkPcYxAgsTh4AUTN';

const emptyBlock = (h) => ({
  block_id: `id${h}`,
  block_height: String(h),
  block: { header: { height: String(h), timestamp: String(1790000000000 + h * 3000) }, transactions: [] },
  receipt: { transaction_receipts: [] },
});

function stubs({ failBlocks = false, failTokens = false } = {}) {
  const calls = [];
  const rpc = {
    headInfo: async () => ({ headId: 'head', headHeight: LIB + 60, lib: LIB }),
    blocksByHeight: async (headId, start, count) => {
      calls.push([start, count]);
      if (failBlocks) throw new Error('node down');
      return Array.from({ length: count }, (_, i) => (start + i === HEIGHT ? item : emptyBlock(start + i)));
    },
  };
  const registry = {
    knownPairs: () => Object.keys(pairs).length,
    unknownCode: new Map(),
    resolvePair: async (id) => pairs[id] || null,
    decimals: async () => {
      if (failTokens) throw new NotFoundError('token read failed');
      return 8;
    },
    getAsset: async (id) => {
      if (id !== KOIN) throw new NotFoundError(`${id} is not a token`);
      return { id, name: 'Koin', symbol: 'KOIN', decimals: 8, totalSupply: '65197748.1' };
    },
    getPairCreation: async () => ({ blockNumber: 1000, blockTimestamp: 1700000000, txnId: '0xcreate' }),
  };
  const cfg = {
    chunkSize: 1000,
    rpcConcurrency: 3,
    maxBlockRange: 10000,
    maxConcurrentEvents: 2,
    maxQueuedEvents: 4,
    maxConcurrentLight: 4,
    maxQueuedLight: 8,
    koindxPeripheries: ['17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s'],
  };
  return { app: createApp(cfg, { rpc, registry, log: () => {} }), calls };
}

async function withServer(app, fn) {
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(async (path, init) => {
      const res = await fetch(base + path, init);
      return { status: res.status, body: await res.json().catch(() => null) };
    });
  } finally {
    server.close();
  }
}

test('endpoints answer in the GeckoTerminal schema', async () => {
  const { app, calls } = stubs();
  await withServer(app, async (get) => {
    const latest = await get('/latest-block');
    assert.equal(latest.status, 200);
    assert.deepEqual(checkLatestBlock(latest.body), []);
    assert.equal(latest.body.block.blockNumber, LIB, 'only irreversible blocks');

    const asset = await get(`/asset?id=${KOIN}`);
    assert.equal(asset.status, 200);
    assert.deepEqual(checkAsset(asset.body), []);

    const pair = await get(`/pair?id=${PAIR}`);
    assert.equal(pair.status, 200);
    assert.deepEqual(checkPair(pair.body), []);
    assert.deepEqual(
      [pair.body.pair.dexKey, pair.body.pair.asset0Id, pair.body.pair.asset1Id, pair.body.pair.feeBps],
      ['koindx', pairs[PAIR].token0, pairs[PAIR].token1, 25],
    );

    // fromBlock and toBlock are inclusive, chunks of at most 1000 blocks
    const from = HEIGHT - 1500;
    calls.length = 0;
    const events = await get(`/events?fromBlock=${from}&toBlock=${HEIGHT}`);
    assert.equal(events.status, 200);
    assert.deepEqual(checkEvents(events.body, from, HEIGHT), []);
    assert.equal(events.body.events.length, 7);
    assert.deepEqual(calls, [[from, 1000], [from + 1000, 501]]);

    const single = await get(`/events?fromBlock=${HEIGHT}&toBlock=${HEIGHT}`);
    assert.equal(single.body.events.length, 7);
    const none = await get(`/events?fromBlock=${HEIGHT + 1}&toBlock=${HEIGHT + 5}`);
    assert.deepEqual(none.body, { events: [] });

    const health = await get('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.lastIrreversibleBlock, LIB);

    // the base URL is the documentation GeckoTerminal's form asks for
    const doc = await get('/');
    assert.equal(doc.status, 200);
    assert.equal(doc.body.specification, 'GeckoTerminal Integration API Standards v0.1 (Nov 2024)');
    assert.deepEqual(Object.keys(doc.body.endpoints), ['latestBlock', 'asset', 'pair', 'events']);
    assert.deepEqual(doc.body.dex.router, ['17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s']);
  });
});

test('bad input, unknown ids and a failing node', async () => {
  const { app } = stubs();
  await withServer(app, async (get) => {
    for (const path of [
      '/events',
      '/events?fromBlock=1',
      '/events?fromBlock=-1&toBlock=5',
      '/events?fromBlock=1.5&toBlock=5',
      '/events?fromBlock=abc&toBlock=5',
      '/events?fromBlock=10&toBlock=5',
      '/events?fromBlock=0&toBlock=10000',
      '/asset',
      '/asset?id=0xdeadbeef',
      `/pair?id=${KOIN}x`,
    ]) {
      assert.equal((await get(path)).status, 400, path);
    }
    assert.equal((await get(`/events?fromBlock=${LIB}&toBlock=${LIB + 1}`)).status, 503, 'not irreversible yet');
    assert.equal((await get(`/pair?id=${KOIN}`)).status, 404, 'a token is not a pair');
    assert.equal((await get(`/asset?id=${PAIR}`)).status, 404, 'not a token (stub)');
    assert.equal((await get('/nope')).status, 404);
    assert.equal((await get('/events?fromBlock=1&toBlock=2', { method: 'POST' })).status, 405);
  });
  await withServer(stubs({ failTokens: true }).app, async (get) => {
    const r = await get(`/events?fromBlock=${HEIGHT}&toBlock=${HEIGHT}`);
    assert.equal(r.status, 503, 'a pair whose tokens cannot be read fails the answer instead of being left out');
  });
  await withServer(stubs({ failBlocks: true }).app, async (get) => {
    const r = await get(`/events?fromBlock=${HEIGHT}&toBlock=${HEIGHT}`);
    assert.equal(r.status, 503, 'never partial data');
    assert.deepEqual(r.body, { error: 'upstream data unavailable, retry later' });
  });
});

test('an unrepresentable event fails the answer and shows on /health; overload is refused', async () => {
  // the real block with the sync_event in front of the KOIN/vUSDT swap removed
  const broken = JSON.parse(JSON.stringify(item));
  const evs = broken.receipt.transaction_receipts[0].events;
  const i = evs.findIndex((e) => e.source === PAIR && e.name === 'core.sync_event');
  evs.splice(i, 1);
  const rpcBroken = {
    headInfo: async () => ({ headId: 'head', headHeight: LIB + 60, lib: LIB }),
    blocksByHeight: async (headId, start, count) =>
      Array.from({ length: count }, (_, k) => (start + k === HEIGHT ? broken : emptyBlock(start + k))),
  };
  const registry = {
    knownPairs: () => 0,
    unknownCode: new Map(),
    resolvePair: async (id) => pairs[id] || null,
    decimals: async () => 8,
  };
  const cfg = { chunkSize: 1000, rpcConcurrency: 3, maxBlockRange: 10000, maxConcurrentEvents: 1, maxQueuedEvents: 0, maxConcurrentLight: 4, maxQueuedLight: 8, koindxPeripheries: ['17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s'] };
  await withServer(createApp(cfg, { rpc: rpcBroken, registry, log: () => {} }), async (get) => {
    const r = await get(`/events?fromBlock=${HEIGHT}&toBlock=${HEIGHT}`);
    assert.equal(r.status, 503);
    const h = await get('/health');
    assert.equal(h.body.ok, false);
    assert.match(h.body.lastError.message, /no sync_event/);
  });
  // one /events at a time and no queue: a second request while the first runs is refused
  let release;
  const slowRpc = {
    headInfo: async () => ({ headId: 'head', headHeight: LIB + 60, lib: LIB }),
    blocksByHeight: async (headId, start, count) => {
      await new Promise((r) => (release = r));
      return Array.from({ length: count }, (_, k) => emptyBlock(start + k));
    },
  };
  await withServer(createApp(cfg, { rpc: slowRpc, registry, log: () => {} }), async (get) => {
    const first = get(`/events?fromBlock=${HEIGHT}&toBlock=${HEIGHT}`);
    await new Promise((r) => setTimeout(r, 50));
    const second = await get(`/events?fromBlock=${HEIGHT}&toBlock=${HEIGHT}`);
    assert.equal(second.status, 503);
    assert.deepEqual(second.body, { error: 'busy, retry later' });
    release();
    assert.equal((await first).status, 200);
  });
});

test('a client that gives up while queued frees its slot', async () => {
  let release;
  const slowRpc = {
    headInfo: async () => ({ headId: 'head', headHeight: LIB + 60, lib: LIB }),
    blocksByHeight: async (headId, start, count) => {
      await new Promise((r) => (release = r));
      return Array.from({ length: count }, (_, k) => emptyBlock(start + k));
    },
  };
  const registry = { knownPairs: () => 0, unknownCode: new Map(), resolvePair: async () => null, decimals: async () => 8 };
  const cfg = { chunkSize: 1000, rpcConcurrency: 3, maxBlockRange: 10000, maxConcurrentEvents: 1, maxQueuedEvents: 1, maxConcurrentLight: 4, maxQueuedLight: 8, koindxPeripheries: [] };
  await withServer(createApp(cfg, { rpc: slowRpc, registry, log: () => {} }), async (get) => {
    const path = `/events?fromBlock=${HEIGHT}&toBlock=${HEIGHT}`;
    const first = get(path);
    await new Promise((r) => setTimeout(r, 50));
    const gaveUp = new AbortController();
    const queued = get(path, { signal: gaveUp.signal }).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 50));
    gaveUp.abort();
    assert.equal(await queued, 'aborted');
    await new Promise((r) => setTimeout(r, 50));
    // the queue has one place; the client that left must not hold it
    const third = get(path);
    await new Promise((r) => setTimeout(r, 50));
    release();
    assert.equal((await first).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    release();
    assert.equal((await third).status, 200);
  });
});
