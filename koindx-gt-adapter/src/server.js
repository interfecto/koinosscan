import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { isAddress, KoinosRpc } from './koinos.js';
import { DEX_KEY, FEE_BPS, KoindxRegistry, NotFoundError } from './koindx.js';
import { buildEvents, candidateSources, newStats, UnrepresentableEventError } from './events.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Runs the tasks with at most `limit` at once and returns their results in task order. After the first failure no
// new task starts, and the error is only thrown once every running task has finished: nothing keeps running
// after the request has been answered.
export async function pool(tasks, limit, isCancelled = () => false) {
  const results = new Array(tasks.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < tasks.length && !failure) {
      if (isCancelled()) {
        failure = new Error('request cancelled');
        return;
      }
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        failure = failure || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failure) throw failure;
  return results;
}

// at most `max` running and `maxQueue` waiting; beyond that the request is refused with 503.
// A waiter whose client has gone away neither counts against the queue nor starts its work.
class Gate {
  constructor(max, maxQueue) {
    this.max = max;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  release() {
    for (;;) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      if (waiter.isCancelled()) {
        waiter.reject(new Error('request cancelled'));
        continue;
      }
      this.active++;
      waiter.resolve();
      return;
    }
  }

  async run(fn, isCancelled = () => false) {
    if (this.active >= this.max) {
      this.queue = this.queue.filter((w) => {
        if (!w.isCancelled()) return true;
        w.reject(new Error('request cancelled'));
        return false;
      });
      if (this.queue.length >= this.maxQueue) throw new HttpError(503, 'busy, retry later');
      // the slot is handed over by release(): active is counted there
      await new Promise((resolve, reject) => this.queue.push({ resolve, reject, isCancelled }));
    } else {
      this.active++;
    }
    try {
      if (isCancelled()) throw new Error('request cancelled');
      return await fn();
    } finally {
      this.active--;
      this.release();
    }
  }
}

const intParam = (url, name) => {
  const v = url.searchParams.get(name);
  if (v === null || !/^\d{1,15}$/.test(v)) throw new HttpError(400, `${name} must be a non-negative integer`);
  return Number(v);
};

const idParam = (url) => {
  const id = url.searchParams.get('id');
  if (!isAddress(id)) throw new HttpError(400, 'id must be a Koinos address');
  return id;
};

export function createApp(cfg = config, deps = {}) {
  const rpc = deps.rpc || new KoinosRpc({ url: cfg.rpcUrl, timeoutMs: cfg.rpcTimeoutMs, retries: cfg.rpcRetries });
  const registry =
    deps.registry ||
    new KoindxRegistry(rpc, {
      pairCodeHashes: cfg.koindxPairCodeHashes,
      excludedCodeHashes: cfg.koindxExcludedCodeHashes || [],
      coinGeckoIds: cfg.coinGeckoIds,
      assetTtlMs: cfg.assetTtlMs,
      dataDir: cfg.dataDir,
      accountHistory: cfg.accountHistory,
    });
  const stats = newStats();
  const log = deps.log || ((msg) => console.log(`${new Date().toISOString()} ${msg}`));
  const peripheries = new Set(cfg.koindxPeripheries);
  const eventsGate = new Gate(cfg.maxConcurrentEvents, cfg.maxQueuedEvents);
  const lightGate = new Gate(cfg.maxConcurrentLight, cfg.maxQueuedLight);
  let lastError = null;
  // contracts with unknown code that name the KoinDX periphery as caller: maybe new KoinDX pair code (see events.js)
  const suspects = new Map();

  let headCache = { at: 0, value: null };
  const head = async () => {
    if (headCache.value && Date.now() - headCache.at < 1000) return headCache.value;
    const value = await rpc.headInfo();
    headCache = { at: Date.now(), value };
    return value;
  };

  const timestamps = new Map();
  const blockTimestamp = async (headId, height) => {
    if (timestamps.has(height)) return timestamps.get(height);
    const [item] = await rpc.blocksByHeight(headId, height, 1, { receipts: false });
    const ts = Math.floor(Number(item.block.header.timestamp) / 1000);
    if (timestamps.size > 1000) timestamps.clear();
    timestamps.set(height, ts);
    return ts;
  };

  // only irreversible blocks: GeckoTerminal reads each block once, a block that can still change is never offered
  const latestBlock = (url, isCancelled) =>
    lightGate.run(async () => {
      const h = await head();
      return { block: { blockNumber: h.lib, blockTimestamp: await blockTimestamp(h.headId, h.lib) } };
    }, isCancelled);

  const asset = (url, isCancelled) => {
    const id = idParam(url);
    return lightGate.run(async () => ({ asset: await registry.getAsset(id) }), isCancelled);
  };

  const pair = (url, isCancelled) => {
    const id = idParam(url);
    return lightGate.run(async () => {
      const p = await registry.resolvePair(id);
      if (!p) throw new NotFoundError(`${id} is not a KoinDX pair`);
      const creation = await registry.getPairCreation(id, (await head()).headId);
      return {
        pair: {
          id,
          dexKey: DEX_KEY,
          asset0Id: p.token0,
          asset1Id: p.token1,
          ...(creation && {
            createdAtBlockNumber: creation.blockNumber,
            createdAtBlockTimestamp: creation.blockTimestamp,
            createdAtTxnId: creation.txnId,
          }),
          feeBps: FEE_BPS,
        },
      };
    }, isCancelled);
  };

  // one chunk of blocks -> its events; the blocks themselves are not kept
  const chunkEvents = async (headId, start, count, isCancelled) => {
    const items = await rpc.blocksByHeight(headId, start, count);
    const pairs = new Map();
    const foreign = new Map();
    await pool(
      [...candidateSources(items)].map((source) => async () => {
        const p = await registry.resolvePair(source, { fromEvent: true });
        if (!p) {
          const hash = registry.otherCodeHash?.(source);
          if (hash) foreign.set(source, hash);
          return;
        }
        let decimals;
        try {
          decimals = await Promise.all([registry.decimals(p.token0), registry.decimals(p.token1)]);
        } catch (e) {
          // a token of a verified pair must be readable: fail the answer (503), never answer without the pair
          throw new Error(`pair ${source}: token metadata unavailable: ${e.message}`);
        }
        pairs.set(source, { ...p, decimals0: decimals[0], decimals1: decimals[1] });
      }),
      cfg.rpcConcurrency,
      isCancelled,
    );
    return buildEvents(items, pairs, { peripheries, foreign, suspects, stats, log });
  };

  const events = (url, isCancelled) => {
    const fromBlock = intParam(url, 'fromBlock');
    const toBlock = intParam(url, 'toBlock');
    if (fromBlock > toBlock) throw new HttpError(400, 'fromBlock must not be greater than toBlock');
    if (toBlock - fromBlock + 1 > cfg.maxBlockRange) throw new HttpError(400, `at most ${cfg.maxBlockRange} blocks per request`);
    return eventsGate.run(async () => {
      const h = await head();
      if (toBlock > h.lib) throw new HttpError(503, `block ${toBlock} is not irreversible yet, latest is ${h.lib}`);
      const tasks = [];
      for (let start = fromBlock; start <= toBlock; start += cfg.chunkSize) {
        const count = Math.min(cfg.chunkSize, toBlock - start + 1);
        tasks.push(() => chunkEvents(h.headId, start, count, isCancelled));
      }
      return { events: (await pool(tasks, cfg.rpcConcurrency, isCancelled)).flat() };
    }, isCancelled);
  };

  const health = async () => {
    const h = await head();
    return {
      ok: !lastError,
      headHeight: h.headHeight,
      lastIrreversibleBlock: h.lib,
      knownPairs: registry.knownPairs(),
      // swaps/burns of pools built from KoinDX code but called by another router
      skipped: stats,
      // contracts emitting KoinDX event names with unknown bytecode: add the hash to KOINDX_PAIR_CODE_HASHES if genuine
      unknownCode: Object.fromEntries(registry.unknownCode),
      // the last event that could not be represented: /events keeps answering 503 for its block until fixed
      lastError,
      // unknown code that names the KoinDX periphery as caller: check, and add its hash if it is really KoinDX
      suspectedKoindxPools: Object.fromEntries(suspects),
    };
  };

  // the base URL documents itself: GeckoTerminal's form asks for the adapter's documentation URL
  const index = async () => ({
    name: 'KoinDX on Koinos: GeckoTerminal Integration API',
    specification: 'GeckoTerminal Integration API Standards v0.1 (Nov 2024)',
    endpoints: {
      latestBlock: 'GET /latest-block',
      asset: 'GET /asset?id=<token contract id>',
      pair: 'GET /pair?id=<KoinDX pair contract id>',
      events: 'GET /events?fromBlock=<n>&toBlock=<n>',
    },
    limits: { maxBlocksPerEventsRequest: cfg.maxBlockRange, methods: ['GET', 'HEAD'] },
    network: {
      name: 'Koinos',
      chainId: 'EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==',
      blockTime: '3 s',
      nativeToken: { symbol: 'KOIN', id: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK', decimals: 8 },
      website: 'https://koinos.io',
      explorers: ['https://koinosblocks.com', 'https://koinosscan.com'],
    },
    dex: {
      name: 'KoinDX',
      website: 'https://koindx.com',
      type: 'constant-product AMM (Uniswap V2 style), one contract per pair',
      router: [...peripheries],
      feeBps: FEE_BPS,
      dollarPool: { pair: '1E8AjPZxKLJGFouXtNNkPcYxAgsTh4AUTN', assets: ['KOIN', 'vUSDT (USDT bridged by Vortex)'] },
    },
    data: [
      'Blocks are served up to the last irreversible block only (/latest-block).',
      'Ids are Koinos base58 addresses and transaction ids as shown on koinosblocks.com; amounts are decimalized strings.',
      'asset0/asset1 follow the on-chain token_a/token_b order of each pair.',
      'An /events answer is never partial: an incomplete node answer or an event that cannot be represented exactly gives 503 (retry).',
    ],
  });

  const routes = { '/': index, '/latest-block': latestBlock, '/asset': asset, '/pair': pair, '/events': events, '/health': health };

  return async function handler(req, res) {
    const started = Date.now();
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const isCancelled = () => closed;
    let status = 200;
    let body;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      const url = new URL(req.url, 'http://localhost');
      const route = routes[url.pathname];
      if (!route) throw new HttpError(404, 'not found');
      body = await route(url, isCancelled);
    } catch (e) {
      if (e instanceof HttpError) status = e.status;
      else if (e instanceof NotFoundError) status = 404;
      else {
        // node unreachable or incomplete, or an event that cannot be represented: GeckoTerminal retries later,
        // it never gets partial data
        status = 503;
        if (e instanceof UnrepresentableEventError) lastError = { at: new Date().toISOString(), message: e.message };
        log(`error ${req.url}: ${e.message}`);
      }
      body = { error: status === 503 && !(e instanceof HttpError) ? 'upstream data unavailable, retry later' : e.message };
    }
    if (closed) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(req.method === 'HEAD' ? undefined : payload);
    if (status !== 200 || Date.now() - started > 5000) log(`${status} ${req.url} ${Date.now() - started}ms`);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer(createApp());
  server.requestTimeout = 120000;
  server.listen(config.port, config.host, () => {
    console.log(`koindx-gt-adapter on http://${config.host}:${config.port} using ${config.rpcUrl}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
