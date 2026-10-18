import { createHash } from 'node:crypto';
import { decode, encode, getBytes } from './protobuf.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = bytes.length ? BigInt('0x' + Buffer.from(bytes).toString('hex')) : 0n;
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = ALPHABET_MAP.get(c);
    if (v === undefined) throw new Error('invalid base58 character');
    n = n * 58n + v;
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...Buffer.from(hex, 'hex')]);
}

export const fromBase64 = (s) => new Uint8Array(Buffer.from(s || '', 'base64url'));
export const toBase64 = (bytes) => Buffer.from(bytes).toString('base64url');

const sha256 = (b) => createHash('sha256').update(b).digest();
const multihash = (digest) => Buffer.concat([Buffer.from([0x12, 0x20]), digest]);

// Transaction merkle root as koinos-chain checks it (system_calls.cpp apply_block, koinos-crypto merkle_tree):
// leaves are, per transaction, its id (sha256 multihash of the header) and the sha256 multihash of its concatenated
// signatures; a parent is sha256(left digest || right digest); an odd last node moves up unchanged;
// no transactions gives sha256 of nothing.
export function transactionMerkleRoot(transactions) {
  let nodes = [];
  for (const tx of transactions) {
    if (typeof tx.id !== 'string' || !/^0x1220[0-9a-f]{64}$/.test(tx.id)) throw new Error('transaction without a sha256 id');
    nodes.push(Buffer.from(tx.id.slice(2), 'hex'));
    nodes.push(multihash(sha256(Buffer.concat((tx.signatures || []).map((sig) => Buffer.from(fromBase64(sig)))))));
  }
  if (!nodes.length) return multihash(sha256(Buffer.alloc(0)));
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      next.push(i + 1 < nodes.length ? multihash(sha256(Buffer.concat([nodes[i].subarray(2), nodes[i + 1].subarray(2)]))) : nodes[i]);
    }
    nodes = next;
  }
  return nodes[0];
}

// a Koinos address: base58 of version 0x00 + 20 byte hash + 4 byte double-sha256 checksum
export function isAddress(str) {
  if (typeof str !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(str)) return false;
  let bytes;
  try {
    bytes = base58Decode(str);
  } catch {
    return false;
  }
  if (bytes.length !== 25 || bytes[0] !== 0) return false;
  const check = sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4);
  return Buffer.compare(check, Buffer.from(bytes.subarray(21))) === 0 && base58Encode(bytes) === str;
}


// an answer of the node itself (JSON-RPC error), not a transport problem
export class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

// the node answered, but not with complete data (the public endpoint is load balanced over nodes that can lag)
export class IncompleteDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompleteDataError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The receipt of a block holds one transaction receipt per transaction of the block, in block order. A governance
// proposal that takes effect in a block runs as a transaction that is not part of the block itself, and its receipt
// comes on top of them (block 11,862,812 has no transaction and one such receipt, identical on every node).
// Returns the receipts in block order (aligned[i] belongs to transactions[i]) and the extra ones, or null when a
// transaction of the block has no receipt.
export function alignReceipts(item) {
  const txs = item.block.transactions || [];
  const aligned = [];
  const extra = [];
  for (const r of item.receipt?.transaction_receipts || []) {
    if (aligned.length < txs.length && r.id === txs[aligned.length].id) aligned.push(r);
    else extra.push(r);
  }
  return aligned.length === txs.length ? { aligned, extra } : null;
}

export class KoinosRpc {
  constructor({ url, timeoutMs = 30000, retries = 5, fetchImpl = fetch }) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.fetch = fetchImpl;
    this.id = 0;
  }

  async callOnce(method, params) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'koindx-gt-adapter/0.1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`rpc ${method}: http ${res.status}`);
    const body = await res.json();
    if (body.error) throw new RpcError(`rpc ${method}: ${body.error.message || 'error'}`, body.error.code);
    if (!('result' in body)) throw new Error(`rpc ${method}: no result`);
    return body.result;
  }

  // runs fn until it succeeds; transport errors, node errors and incomplete answers are all retried,
  // the last error is thrown after the retries
  async withRetry(fn) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
        if (attempt < this.retries) await sleep(Math.min(250 * 2 ** attempt, 4000));
      }
    }
    throw lastError;
  }

  call(method, params) {
    return this.withRetry(() => this.callOnce(method, params));
  }

  async headInfo() {
    const r = await this.call('chain.get_head_info', {});
    const head = r.head_topology || {};
    const lib = Number(r.last_irreversible_block);
    const headHeight = Number(head.height);
    if (!head.id || !Number.isSafeInteger(lib) || !Number.isSafeInteger(headHeight) || lib > headHeight) {
      throw new IncompleteDataError('chain.get_head_info: unexpected answer');
    }
    return { headId: head.id, headHeight, lib };
  }

  // exactly `count` blocks from `start`, each with block (and receipt), contiguous, as seen from headId.
  // Anything less is retried and finally thrown: an /events answer must never miss a block.
  blocksByHeight(headId, start, count, { receipts = true } = {}) {
    return this.withRetry(async () => {
      const r = await this.callOnce('block_store.get_blocks_by_height', {
        head_block_id: headId,
        ancestor_start_height: start,
        num_blocks: count,
        return_block: true,
        return_receipt: receipts,
      });
      const items = r.block_items || [];
      if (items.length !== count) throw new IncompleteDataError(`expected ${count} blocks from ${start}, got ${items.length}`);
      items.forEach((item, i) => {
        const height = Number(item.block_height);
        if (height !== start + i) throw new IncompleteDataError(`block ${start + i} missing or out of order`);
        const header = item.block?.header;
        if (!header || Number(header.height) !== height) throw new IncompleteDataError(`block ${height} has no header`);
        if (!/^\d{10,16}$/.test(String(header.timestamp))) throw new IncompleteDataError(`block ${height} has no timestamp`);
        // the header commits to the full transaction list: a block with missing transactions is caught here
        let root;
        try {
          root = transactionMerkleRoot(item.block.transactions || []);
        } catch (e) {
          throw new IncompleteDataError(`block ${height}: ${e.message}`);
        }
        if (!root.equals(Buffer.from(fromBase64(header.transaction_merkle_root)))) {
          throw new IncompleteDataError(`block ${height}: transactions do not match the header's merkle root`);
        }
        if (receipts) {
          if (!item.receipt) throw new IncompleteDataError(`block ${height} has no receipt`);
          if (item.receipt.id !== item.block_id || Number(item.receipt.height) !== height) {
            throw new IncompleteDataError(`block ${height}: the receipt belongs to another block`);
          }
          if (!alignReceipts(item)) throw new IncompleteDataError(`block ${height}: transactions and receipts do not match`);
        }
      });
      return items;
    });
  }

  async readContract(contractId, entryPoint, args = new Uint8Array(0)) {
    const r = await this.call('chain.read_contract', {
      contract_id: contractId,
      entry_point: entryPoint,
      args: toBase64(args),
    });
    return fromBase64(r.result);
  }

  // sha256 multihash (hex) of the bytecode a contract runs now
  async contractCodeHash(contractId) {
    const r = await this.call('chain.invoke_system_call', {
      name: 'get_contract_metadata',
      args: toBase64(encode([[1, 'bytes', base58Decode(contractId)]])),
    });
    const metadata = getBytes(decode(fromBase64(r.value)), 1);
    return Buffer.from(getBytes(decode(metadata), 1)).toString('hex');
  }

  // height, timestamp and index of a transaction in its block on the chain as seen from headId
  async transactionBlock(txId, headId) {
    const r = await this.call('transaction_store.get_transactions_by_id', { transaction_ids: [txId] });
    const blockIds = r.transactions?.[0]?.containing_blocks || [];
    if (!blockIds.length) throw new IncompleteDataError(`transaction ${txId} not found`);
    const found = await this.call('block_store.get_blocks_by_id', {
      block_ids: blockIds,
      return_block: true,
      return_receipt: false,
    });
    // a transaction can sit in several blocks (forks): take the one that is on our chain
    for (const item of found.block_items || []) {
      if (!item.block) continue;
      const height = Number(item.block_height);
      const [canonical] = await this.blocksByHeight(headId, height, 1, { receipts: false });
      if (canonical.block_id !== item.block_id) continue;
      const txIndex = (item.block.transactions || []).findIndex((t) => t.id === txId);
      if (txIndex < 0) continue;
      return { height, timestamp: Math.floor(Number(item.block.header.timestamp) / 1000), txIndex };
    }
    throw new IncompleteDataError(`transaction ${txId}: no containing block on the main chain`);
  }
}
