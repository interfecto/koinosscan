// Builds the offline test fixtures for a block that is already in test/fixtures/block-multihop-swap.json:
//  - rest-decoded.json: the same transactions decoded by the public Koinos REST API (an independent decoder that
//    uses the on-chain ABI), the reference the unit tests compare against
//  - pairs.json: tokens and decimals of every KoinDX pair in the block, read from chain with the adapter's registry
// Usage: node scripts/make-fixtures.mjs   (KOINOS_RPC / KOINOS_REST to override the endpoints)
import { readFileSync, writeFileSync } from 'node:fs';
import { KoinosRpc } from '../src/koinos.js';
import { KoindxRegistry } from '../src/koindx.js';
import { candidateSources } from '../src/events.js';
import { config } from '../src/config.js';

const dir = new URL('../test/fixtures/', import.meta.url).pathname;
const rpcUrl = process.env.KOINOS_RPC || 'https://api.koinos.io';
const restUrl = process.env.KOINOS_REST || 'https://api.koinos.io';
const item = JSON.parse(readFileSync(`${dir}block-multihop-swap.json`, 'utf8'));

const rest = async (path) => {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(restUrl + path, { headers: { 'user-agent': 'koindx-gt-adapter/0.1' } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`rest ${path} failed`);
};

const decoded = {};
for (const tx of item.block.transactions) {
  const r = await rest(`/v1/transaction/${tx.id}?decode_operations=false&decode_events=true`);
  decoded[tx.id] = r.transaction?.receipt?.events || r.receipt?.events || r.events;
  if (!decoded[tx.id]) throw new Error(`no decoded events for ${tx.id}: ${JSON.stringify(r).slice(0, 200)}`);
}
writeFileSync(`${dir}rest-decoded.json`, JSON.stringify(decoded, null, 1));

const rpc = new KoinosRpc({ url: rpcUrl });
const registry = new KoindxRegistry(rpc, { pairCodeHashes: config.koindxPairCodeHashes });
const pairs = {};
for (const source of candidateSources([item])) {
  const p = await registry.resolvePair(source);
  if (!p) continue;
  pairs[source] = { ...p, decimals0: await registry.decimals(p.token0), decimals1: await registry.decimals(p.token1) };
}
writeFileSync(`${dir}pairs.json`, JSON.stringify(pairs, null, 1));
console.log(`fixtures: ${Object.keys(decoded).length} decoded transaction(s), ${Object.keys(pairs).length} pair(s)`);
