const env = process.env;

const int = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid integer config value: ${value}`);
  return n;
};

const json = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`invalid JSON config value: ${value}`);
  }
};

export const config = Object.freeze({
  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 3900, { min: 1, max: 65535 }),
  // a node of our own in production: the public endpoint is load balanced over nodes that are not always complete
  rpcUrl: env.KOINOS_RPC || 'https://api.koinos.io',
  rpcTimeoutMs: int(env.RPC_TIMEOUT_MS, 30000, { min: 1000 }),
  rpcRetries: int(env.RPC_RETRIES, 5, { min: 0, max: 20 }),
  // the node answers at most 1000 blocks per get_blocks_by_height call
  chunkSize: int(env.CHUNK_SIZE, 1000, { min: 1, max: 1000 }),
  rpcConcurrency: int(env.RPC_CONCURRENCY, 3, { min: 1, max: 16 }),
  // largest fromBlock..toBlock range one /events request may ask for
  maxBlockRange: int(env.MAX_BLOCK_RANGE, 10000, { min: 1 }),
  // /events requests served at the same time and waiting; beyond that 503 "busy"
  maxConcurrentEvents: int(env.MAX_CONCURRENT_EVENTS, 2, { min: 1 }),
  maxQueuedEvents: int(env.MAX_QUEUED_EVENTS, 8, { min: 0 }),
  // the same for /latest-block, /asset and /pair
  maxConcurrentLight: int(env.MAX_CONCURRENT_LIGHT, 8, { min: 1 }),
  maxQueuedLight: int(env.MAX_QUEUED_LIGHT, 32, { min: 0 }),
  // the node has account_history: pairs get their creation block (errors then give 503); "off" leaves it out
  accountHistory: (env.ACCOUNT_HISTORY || 'on') !== 'off',
  assetTtlMs: int(env.ASSET_TTL_MS, 10 * 60 * 1000, { min: 0 }),
  dataDir: env.DATA_DIR || new URL('../data/', import.meta.url).pathname,
  // KoinDX periphery (router): the only caller a KoinDX pair accepts for swap, mint and burn
  koindxPeripheries: (env.KOINDX_PERIPHERIES || '17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s').split(',').map((s) => s.trim()).filter(Boolean),
  // sha256 multihash of the KoinDX pair (core) bytecode, read on chain from the live pairs
  koindxPairCodeHashes: (env.KOINDX_PAIR_CODE_HASHES || '1220a3ca71ad5ca801080265aeec7842a1d51c1d220e6461c72a98344f49b8e5a532')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // pair code that is deliberately NOT listed: 122009c6… is the older KoinDX pair code behind a second router
  // (14WeQjBk7F4C58xUquRGLK1KiqRjwj5Y4J): 11 pools on the deprecated KOIN contract, unused since 2023-11-24
  koindxExcludedCodeHashes: (env.KOINDX_EXCLUDED_CODE_HASHES ?? '122009c684b19b06752e430fa7ee6ac06bd3ee4932dc608cb0d608ba4245e6a554e8')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // optional map of asset id -> CoinGecko coin id, see README before setting it
  coinGeckoIds: json(env.COINGECKO_IDS, {}),
});
