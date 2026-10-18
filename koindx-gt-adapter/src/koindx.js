import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode, getBytes, getString, getUint } from './protobuf.js';
import { base58Encode, IncompleteDataError, RpcError } from './koinos.js';
import { formatUnits } from './format.js';

export const DEX_KEY = 'koindx';
// KoinDX periphery getAmountOut: amountIn * 9975 / 10000, checked against the deployed periphery
export const FEE_BPS = 25;

// entry points, from koindx/v2-core, koindx/v2-periphery and the KCS-4 token standard
export const ENTRY = Object.freeze({
  pairGetTokens: 0x7d5b5ed7,
  tokenName: 0x82a3537f,
  tokenSymbol: 0xb76a7ca1,
  tokenDecimals: 0xee80fd2f,
  tokenTotalSupply: 0xb0da3934,
});

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// small JSON file for data that never changes: verified pairs and their creation block
class Store {
  constructor(dir) {
    this.file = dir ? join(dir, 'koindx-cache.json') : null;
    this.data = { pairs: {}, creations: {} };
    if (!this.file) return;
    try {
      const loaded = JSON.parse(readFileSync(this.file, 'utf8'));
      this.data = { pairs: loaded.pairs || {}, creations: loaded.creations || {} };
    } catch {
      // no cache yet
    }
  }

  save() {
    if (!this.file) return;
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }
}

export class KoindxRegistry {
  constructor(rpc, { pairCodeHashes, excludedCodeHashes = [], coinGeckoIds = {}, assetTtlMs = 600000, dataDir = null, accountHistory = true }) {
    this.rpc = rpc;
    this.excludedCodeHashes = new Set(excludedCodeHashes);
    this.accountHistory = accountHistory;
    this.pairCodeHashes = new Set(pairCodeHashes);
    // contracts that emit KoinDX event names but run other code: id -> code hash, shown on /health
    this.unknownCode = new Map();
    this.coinGeckoIds = coinGeckoIds;
    this.assetTtlMs = assetTtlMs;
    this.store = new Store(dataDir);
    // contracts with other code: id -> code hash. In memory only: after a restart they are checked again
    this.notPairs = new Map();
    this.assets = new Map();
    this.decimalsById = new Map();
    this.inflight = new Map();
  }

  once(key, fn) {
    if (!this.inflight.has(key)) {
      this.inflight.set(key, fn().finally(() => this.inflight.delete(key)));
    }
    return this.inflight.get(key);
  }

  knownPairs() {
    return Object.keys(this.store.data.pairs).length;
  }

  // { id, token0, token1 } for a KoinDX pair, null for anything else.
  // A pair is genuine when it runs the KoinDX pair bytecode: that code only lets its periphery swap, mint and
  // burn, and the event builder also checks that swaps and burns came from the KoinDX periphery.
  // The periphery's own get_pair registry cannot be used: on chain it answers empty for every live pair.
  // fromEvent: the id emitted a KoinDX event name. Then "no code" cannot be true and means the node lags (thrown),
  // and other code is remembered for /health.
  async resolvePair(id, { fromEvent = false } = {}) {
    const known = this.store.data.pairs[id];
    if (known) return { id, token0: known.token0, token1: known.token1 };
    if (this.notPairs.has(id)) {
      if (fromEvent) this.noteOtherCode(id, this.notPairs.get(id));
      return null;
    }
    // the lookup is shared by concurrent callers; what an answer means depends on the caller and is decided here
    const found = await this.once(`pair:${id}`, () => this.lookupPair(id));
    if (found.kind === 'pair') return found.pair;
    if (found.kind === 'noCode') {
      if (fromEvent) throw new IncompleteDataError(`${id} emitted KoinDX events but the node reports no code for it`);
      return null;
    }
    if (fromEvent) this.noteOtherCode(id, found.hash);
    return null;
  }

  // an event source that runs other code: known-excluded code is not reported as unknown
  noteOtherCode(id, hash) {
    if (this.excludedCodeHashes.has(hash)) return;
    // at most 100 entries, oldest out first (contracts are cheap to deploy)
    this.unknownCode.delete(id);
    this.unknownCode.set(id, hash);
    while (this.unknownCode.size > 100) this.unknownCode.delete(this.unknownCode.keys().next().value);
  }

  // code hash of an event source that is not a pair (other code), undefined otherwise
  otherCodeHash(id) {
    return this.notPairs.get(id);
  }

  // what the chain says about id: { kind: 'pair', pair } | { kind: 'noCode' } | { kind: 'otherCode', hash }.
  // Node errors are thrown and nothing is cached for them.
  async lookupPair(id) {
    const hash = await this.rpc.contractCodeHash(id);
    // no code is not cached: the pair may be deployed later, or the node may lag
    if (!hash) return { kind: 'noCode' };
    if (!this.pairCodeHashes.has(hash)) {
      // other code is a definitive answer
      this.notPairs.set(id, hash);
      return { kind: 'otherCode', hash };
    }
    const f = decode(await this.rpc.readContract(id, ENTRY.pairGetTokens));
    const tokenA = getBytes(f, 1);
    const tokenB = getBytes(f, 2);
    if (tokenA.length !== 25 || tokenB.length !== 25) throw new Error(`${id}: get_tokens returned no tokens`);
    // asset0/asset1 follow the on-chain token_a/token_b order and never change
    const pair = { id, token0: base58Encode(tokenA), token1: base58Encode(tokenB) };
    this.store.data.pairs[id] = { token0: pair.token0, token1: pair.token1 };
    this.store.save();
    return { kind: 'pair', pair };
  }

  async readString(id, entryPoint) {
    try {
      return getString(decode(await this.rpc.readContract(id, entryPoint)), 1);
    } catch (e) {
      if (e instanceof RpcError) return '';
      throw e;
    }
  }

  getAsset(id) {
    const cached = this.assets.get(id);
    if (cached && Date.now() - cached.at < this.assetTtlMs) return Promise.resolve(cached.value);
    return this.once(`asset:${id}`, async () => {
      let decimals;
      try {
        decimals = getUint(decode(await this.rpc.readContract(id, ENTRY.tokenDecimals)), 1);
      } catch (e) {
        if (e instanceof RpcError) throw new NotFoundError(`${id} is not a token`);
        throw e;
      }
      if (decimals > 30n) throw new NotFoundError(`${id}: unexpected decimals ${decimals}`);
      const d = Number(decimals);
      const [name, symbol] = await Promise.all([this.readString(id, ENTRY.tokenName), this.readString(id, ENTRY.tokenSymbol)]);
      let totalSupply;
      try {
        totalSupply = formatUnits(getUint(decode(await this.rpc.readContract(id, ENTRY.tokenTotalSupply)), 1), d);
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
      }
      const value = {
        id,
        // GeckoTerminal halts on empty strings
        name: name || symbol || id,
        symbol: symbol || name || id,
        decimals: d,
        ...(totalSupply !== undefined && { totalSupply }),
        ...(this.coinGeckoIds[id] && { coinGeckoId: this.coinGeckoIds[id] }),
      };
      this.assets.set(id, { at: Date.now(), value });
      this.decimalsById.set(id, d);
      return value;
    });
  }

  async decimals(id) {
    if (this.decimalsById.has(id)) return this.decimalsById.get(id);
    return (await this.getAsset(id)).decimals;
  }

  // block and transaction that created the pair: the first account-history record that uploads the pair's code or
  // carries its initialize_event. null when account history is switched off or no such irreversible record exists.
  // Pair data is immutable for GeckoTerminal, so node errors are thrown (503) instead of answering without it.
  getPairCreation(id, headId) {
    if (!this.accountHistory) return Promise.resolve(null);
    const known = this.store.data.creations[id];
    if (known) return Promise.resolve(known);
    return this.once(`creation:${id}`, async () => {
      const r = await this.rpc.call('account_history.get_account_history', {
        address: id,
        limit: 10,
        ascending: true,
        irreversible: true,
      });
      const creates = (trx) =>
        (trx?.transaction?.operations || []).some((op) => op.upload_contract?.contract_id === id) ||
        (trx?.receipt?.events || []).some((ev) => ev.source === id && ev.name === 'core.initialize_event');
      const record = (r.values || []).find((v) => creates(v.trx));
      // not found (yet): not cached, the creation may simply not be irreversible yet
      if (!record) return null;
      const txId = record.trx.transaction.id;
      const block = await this.rpc.transactionBlock(txId, headId);
      const creation = { blockNumber: block.height, blockTimestamp: block.timestamp, txnId: txId };
      this.store.data.creations[id] = creation;
      this.store.save();
      return creation;
    });
  }
}

