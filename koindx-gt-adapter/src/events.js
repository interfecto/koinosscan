// Turns Koinos blocks (with receipts) into GeckoTerminal swap / join / exit events for KoinDX pairs.
import { decode, getBytes, getUint } from './protobuf.js';
import { alignReceipts, base58Encode, fromBase64 } from './koinos.js';
import { formatBps, formatUnits, priceNative } from './format.js';
import { FEE_BPS } from './koindx.js';

export const SYNC = 'core.sync_event';
export const SWAP = 'core.swap_event';
export const MINT = 'core.mint_event';
export const BURN = 'core.burn_event';
export const EVENT_NAMES = new Set([SYNC, SWAP, MINT, BURN]);

// A KoinDX event that cannot be turned into a correct GeckoTerminal event. GeckoTerminal reads every block once,
// so such an event must not be dropped quietly: the whole /events answer fails (503) and the error is logged and
// shown on /health until the code is fixed.
export class UnrepresentableEventError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnrepresentableEventError';
  }
}

export const newStats = () => ({ foreignPeriphery: 0 });

// report maps (unknown code, suspects) keep at most `max` entries, oldest out first: contracts are cheap to deploy
export function boundedSet(map, key, value, max = 100) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// contracts that emitted a KoinDX event name in a transaction that was not reverted
export function candidateSources(items) {
  const sources = new Set();
  for (const item of items) {
    for (const receipt of item.receipt.transaction_receipts || []) {
      if (receipt.reverted) continue;
      for (const ev of receipt.events || []) if (EVENT_NAMES.has(ev.name)) sources.add(ev.source);
    }
  }
  return sources;
}

// pairs: Map pairId -> { token0, token1, decimals0, decimals1 }, verified KoinDX pairs only.
// peripheries: Set of KoinDX periphery ids; swaps and burns name their caller, which must be one of them.
// foreign: Map sourceId -> code hash of event sources that run other code. A swap/burn of such a contract that
// names the KoinDX periphery as caller may be new KoinDX pair code, so it is reported (suspects -> /health, log).
// It does not fail the answer: event data is written by the contract itself, so the caller field can be forged,
// and failing on it would let any contract stop the indexer.
// KoinDX emits the pool's sync_event (reserves after the change) right before each swap, mint and burn event,
// so each of those takes, and consumes, the last sync_event of the same pair in the same transaction.
export function buildEvents(items, pairs, { peripheries, foreign = new Map(), suspects = new Map(), stats = newStats(), log = () => {} }) {
  const events = [];
  for (const item of items) {
    const block = {
      blockNumber: Number(item.block_height),
      blockTimestamp: Math.floor(Number(item.block.header.timestamp) / 1000),
    };
    const transactions = item.block.transactions || [];
    const receipts = alignReceipts(item);
    if (!receipts) throw new UnrepresentableEventError(`block ${block.blockNumber}: transactions and receipts do not match`);
    // a transaction applied by governance has no place in the block, so no txnIndex; KoinDX events in one are
    // not expected and must not be dropped or given a made-up index
    for (const receipt of receipts.extra) {
      if (receipt.reverted) continue;
      const ev = (receipt.events || []).find((e) => EVENT_NAMES.has(e.name) && pairs.has(e.source));
      if (ev) {
        throw new UnrepresentableEventError(`block ${block.blockNumber}: ${ev.name} of ${ev.source} in transaction ${receipt.id}, which is not part of the block (governance)`);
      }
    }
    receipts.aligned.forEach((receipt, txnIndex) => {
      if (receipt.reverted) return;
      const header = transactions[txnIndex].header || {};
      // payee is the account that signed; payer can be a mana sponsor
      const maker = header.payee || header.payer;
      const txnId = transactions[txnIndex].id;
      const where = `block ${block.blockNumber} tx ${txnId}`;
      const lastSync = new Map();
      (receipt.events || []).forEach((ev, eventIndex) => {
        if (!EVENT_NAMES.has(ev.name)) return;
        const pair = pairs.get(ev.source);
        if (!pair) {
          if ((ev.name === SWAP || ev.name === BURN) && foreign.has(ev.source)) {
            let caller = null;
            try {
              caller = base58Encode(getBytes(decode(fromBase64(ev.data)), 2));
            } catch {
              // not KoinDX's format: not ours
            }
            if (caller && peripheries.has(caller)) {
              if (!suspects.has(ev.source)) {
                log(`${where}: ${ev.source} names the KoinDX periphery as caller but runs code ${foreign.get(ev.source)}; check it and add the hash to KOINDX_PAIR_CODE_HASHES if it is a KoinDX pair`);
              }
              boundedSet(suspects, ev.source, { codeHash: foreign.get(ev.source), lastBlock: block.blockNumber });
            }
          }
          return;
        }
        let f;
        try {
          f = decode(fromBase64(ev.data));
        } catch (e) {
          throw new UnrepresentableEventError(`${where}: cannot decode ${ev.name} of ${ev.source}: ${e.message}`);
        }
        if (ev.name === SYNC) {
          lastSync.set(ev.source, { reserve0: getUint(f, 1), reserve1: getUint(f, 2) });
          return;
        }
        // swap_event.sender and burn_event.sender (field 2) are the pair's caller. The pair code only accepts its
        // own periphery, so another caller means a pool built from KoinDX code but not run by KoinDX: not ours.
        if (ev.name !== MINT && !peripheries.has(base58Encode(getBytes(f, 2)))) {
          stats.foreignPeriphery++;
          log(`${where}: ${ev.name} of ${ev.source} not called by the KoinDX periphery, not a KoinDX trade`);
          return;
        }
        const sync = lastSync.get(ev.source);
        if (!sync) throw new UnrepresentableEventError(`${where}: ${ev.name} of ${ev.source} has no sync_event before it`);
        lastSync.delete(ev.source);
        const { decimals0: d0, decimals1: d1 } = pair;
        const base = { block, txnId, txnIndex, eventIndex, maker, pairId: ev.source };
        const reserves = { asset0: formatUnits(sync.reserve0, d0), asset1: formatUnits(sync.reserve1, d1) };

        if (ev.name === SWAP) {
          const inA = getUint(f, 3);
          const inB = getUint(f, 4);
          const outA = getUint(f, 5);
          const outB = getUint(f, 6);
          // The direction comes from what the pool paid out (the periphery asks for exactly one side). assetOut is
          // that amount ("what goes out of the pool as a product of the math curve"), assetIn is what the pool
          // received of the other token. Tokens with a transfer tax can also flow back into the pool on the paid-out
          // side during the swap; that is not part of the trade and already shows in the reserves.
          // Anything else is reported, not guessed.
          if (outB > 0n && outA === 0n && inA > 0n) {
            const price = priceNative(inA, d0, outB, d1);
            if (price === null) throw new UnrepresentableEventError(`${where}: swap of ${ev.source} has no price`);
            events.push({
              ...base,
              eventType: 'swap',
              asset0In: formatUnits(inA, d0),
              asset1Out: formatUnits(outB, d1),
              priceNative: price,
              reserves,
              metadata: { fees0In: formatBps(inA, FEE_BPS, d0) },
            });
            return;
          }
          if (outA > 0n && outB === 0n && inB > 0n) {
            const price = priceNative(outA, d0, inB, d1);
            if (price === null) throw new UnrepresentableEventError(`${where}: swap of ${ev.source} has no price`);
            events.push({
              ...base,
              eventType: 'swap',
              asset1In: formatUnits(inB, d1),
              asset0Out: formatUnits(outA, d0),
              priceNative: price,
              reserves,
              metadata: { fees1In: formatBps(inB, FEE_BPS, d1) },
            });
            return;
          }
          throw new UnrepresentableEventError(
            `${where}: swap of ${ev.source} has no single direction (in ${inA}/${inB}, out ${outA}/${outB})`,
          );
        }

        // mint_event: sender=1 amount_a=2 amount_b=3, burn_event: to=1 sender=2 amount_a=3 amount_b=4
        const [fa, fb] = ev.name === MINT ? [2, 3] : [3, 4];
        events.push({
          ...base,
          eventType: ev.name === MINT ? 'join' : 'exit',
          amount0: formatUnits(getUint(f, fa), d0),
          amount1: formatUnits(getUint(f, fb), d1),
          reserves,
        });
      });
    });
  }
  return events;
}
