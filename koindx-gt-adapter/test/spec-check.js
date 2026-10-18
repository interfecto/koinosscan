// Checks responses against the GeckoTerminal Integration API Standards v0.1 (used by the tests and by
// scripts/conformance.mjs). Returns a list of problems, empty when the response conforms.

const isInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isDecimal = (v) => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const positive = (v) => isDecimal(v) && Number(v) > 0;

export function checkBlock(block, where) {
  const p = [];
  if (!block || typeof block !== 'object') return [`${where}: block missing`];
  if (!isInt(block.blockNumber)) p.push(`${where}: blockNumber must be a non-negative integer`);
  // seconds, not milliseconds
  if (!isInt(block.blockTimestamp) || block.blockTimestamp > 1e11) p.push(`${where}: blockTimestamp must be UNIX seconds`);
  return p;
}

export function checkLatestBlock(body) {
  return checkBlock(body?.block, 'latest-block');
}

export function checkAsset(body) {
  const a = body?.asset;
  const p = [];
  if (!a) return ['asset missing'];
  for (const k of ['id', 'name', 'symbol']) if (typeof a[k] !== 'string' || !a[k]) p.push(`asset.${k} must be a non-empty string`);
  if (!isInt(a.decimals)) p.push('asset.decimals must be an integer');
  for (const k of ['totalSupply', 'circulatingSupply']) if (k in a && !isDecimal(a[k])) p.push(`asset.${k} must be a decimal`);
  if ('coinGeckoId' in a && (typeof a.coinGeckoId !== 'string' || !a.coinGeckoId)) p.push('asset.coinGeckoId must be a non-empty string');
  return p;
}

export function checkPair(body) {
  const x = body?.pair;
  const p = [];
  if (!x) return ['pair missing'];
  for (const k of ['id', 'dexKey', 'asset0Id', 'asset1Id']) if (typeof x[k] !== 'string' || !x[k]) p.push(`pair.${k} must be a non-empty string`);
  if (x.asset0Id === x.asset1Id) p.push('pair assets must differ');
  for (const k of ['createdAtBlockNumber', 'createdAtBlockTimestamp', 'feeBps']) if (k in x && !isInt(x[k])) p.push(`pair.${k} must be an integer`);
  if ('createdAtBlockTimestamp' in x && x.createdAtBlockTimestamp > 1e11) p.push('pair.createdAtBlockTimestamp must be UNIX seconds');
  if ('createdAtTxnId' in x && (typeof x.createdAtTxnId !== 'string' || !x.createdAtTxnId)) p.push('pair.createdAtTxnId must be a string');
  return p;
}

export function checkEvents(body, fromBlock, toBlock) {
  const p = [];
  if (!body || !Array.isArray(body.events)) return ['events must be an array'];
  const seen = new Set();
  let previous = null;
  body.events.forEach((e, i) => {
    const w = `events[${i}]`;
    p.push(...checkBlock(e.block, w));
    const n = e.block?.blockNumber;
    if (fromBlock !== undefined && (n < fromBlock || n > toBlock)) p.push(`${w}: block ${n} outside ${fromBlock}..${toBlock}`);
    for (const k of ['txnId', 'maker', 'pairId']) if (typeof e[k] !== 'string' || !e[k]) p.push(`${w}: ${k} must be a non-empty string`);
    if (!isInt(e.txnIndex) || !isInt(e.eventIndex)) p.push(`${w}: txnIndex/eventIndex must be integers`);
    const key = `${n}:${e.txnIndex}:${e.eventIndex}`;
    if (seen.has(key)) p.push(`${w}: txnIndex+eventIndex not unique in block ${n}`);
    seen.add(key);
    const order = [n, e.txnIndex, e.eventIndex];
    if (previous && order.some((v, j) => v !== previous[j]) && order.findIndex((v, j) => v !== previous[j]) >= 0) {
      const j = order.findIndex((v, k) => v !== previous[k]);
      if (order[j] < previous[j]) p.push(`${w}: events are not in chain order`);
    }
    previous = order;
    if (!e.reserves || !isDecimal(e.reserves.asset0) || !isDecimal(e.reserves.asset1)) p.push(`${w}: reserves must be decimals`);
    if (e.eventType === 'swap') {
      const in0 = 'asset0In' in e;
      const in1 = 'asset1In' in e;
      const out0 = 'asset0Out' in e;
      const out1 = 'asset1Out' in e;
      const oneWay = (in0 && out1 && !in1 && !out0) || (in1 && out0 && !in0 && !out1);
      if (!oneWay) p.push(`${w}: swap must be asset0In+asset1Out or asset1In+asset0Out`);
      for (const k of ['asset0In', 'asset1In', 'asset0Out', 'asset1Out']) if (k in e && !positive(e[k])) p.push(`${w}: ${k} must be > 0`);
      if (!positive(e.priceNative)) p.push(`${w}: priceNative must be > 0`);
      if (e.metadata) for (const [k, v] of Object.entries(e.metadata)) if (!isDecimal(v)) p.push(`${w}: metadata.${k} must be a decimal`);
    } else if (e.eventType === 'join' || e.eventType === 'exit') {
      if (!isDecimal(e.amount0) || !isDecimal(e.amount1)) p.push(`${w}: amount0/amount1 must be decimals`);
    } else {
      p.push(`${w}: unknown eventType ${e.eventType}`);
    }
  });
  return p;
}
