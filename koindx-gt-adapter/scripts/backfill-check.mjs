// Dry run of a GeckoTerminal backfill: walks /events from fromBlock to toBlock (default: /latest-block at start)
// in ranges of STEP blocks, exactly as the indexer would, and checks every answer against the spec.
// Stops at the first answer that stays 503 because of an event the adapter cannot represent (lastError on
// /health), so such a case is found here and not by GeckoTerminal. Resumable: progress is kept in PROGRESS.
// Usage: node scripts/backfill-check.mjs <adapterUrl> <fromBlock> [toBlock]
//   env: STEP (default 10000), PROGRESS (default ./backfill-progress.json),
//        RESUME=1 continues a run that stopped (after the cause was fixed), from where it stopped
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { checkEvents } from '../test/spec-check.js';

const [base, fromArg, toArg] = process.argv.slice(2);
if (!base || !fromArg) {
  console.error('usage: node scripts/backfill-check.mjs <adapterUrl> <fromBlock> [toBlock]');
  process.exit(2);
}
const STEP = Number(process.env.STEP || 10000);
const PROGRESS = process.env.PROGRESS || './backfill-progress.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (path) => {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(180000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let p = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : null;
// a progress file belongs to one adapter and one start block: never report another run's result as this one
if (p && (p.base !== base || p.from !== Number(fromArg) || (toArg && p.to !== Number(toArg)))) {
  console.error(`${PROGRESS} belongs to another run (${p.base} from ${p.from} to ${p.to}); remove it or use another PROGRESS`);
  process.exit(2);
}
if (p && p.status === 'stopped') {
  if (process.env.RESUME !== '1') {
    console.error(`the run stopped at ${p.next}: ${JSON.stringify(p.problem)}; fix the cause, then RESUME=1`);
    process.exit(1);
  }
  p.status = 'running';
  p.problem = null;
}
if (!p) {
  const latest = await get('/latest-block');
  p = {
    base,
    from: Number(fromArg),
    to: toArg ? Number(toArg) : latest.body.block.blockNumber,
    next: Number(fromArg),
    startedAt: new Date().toISOString(),
    events: { swap: 0, join: 0, exit: 0 },
    pairs: {},
    firstEventBlock: null,
    slowestMs: 0,
    retries503: 0,
    status: 'running',
    problem: null,
  };
}
const save = () => {
  p.updatedAt = new Date().toISOString();
  writeFileSync(`${PROGRESS}.tmp`, JSON.stringify(p, null, 1));
  renameSync(`${PROGRESS}.tmp`, PROGRESS);
};

const t0 = Date.now();
const startBlock = p.next;
let ranges = 0;
while (p.next <= p.to && p.status === 'running') {
  const s = p.next;
  const e = Math.min(p.to, s + STEP - 1);
  let r;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      r = await get(`/events?fromBlock=${s}&toBlock=${e}`);
    } catch (err) {
      r = { status: 0, body: { error: err.message } };
    }
    p.slowestMs = Math.max(p.slowestMs, Date.now() - started);
    if (r.status === 200) break;
    const health = (await get('/health').catch(() => ({ body: {} }))).body || {};
    if (health.lastError && r.status === 503) {
      p.status = 'stopped';
      p.problem = { range: [s, e], lastError: health.lastError };
      break;
    }
    p.retries503++;
    if (attempt >= 20) {
      p.status = 'stopped';
      p.problem = { range: [s, e], http: r.status, body: r.body };
      break;
    }
    await sleep(Math.min(2000 * (attempt + 1), 30000));
  }
  if (p.status !== 'running') break;
  const problems = checkEvents(r.body, s, e);
  if (problems.length) {
    p.status = 'stopped';
    p.problem = { range: [s, e], spec: problems.slice(0, 5) };
    break;
  }
  for (const ev of r.body.events) {
    p.events[ev.eventType] = (p.events[ev.eventType] || 0) + 1;
    p.pairs[ev.pairId] = (p.pairs[ev.pairId] || 0) + 1;
    if (p.firstEventBlock === null) p.firstEventBlock = ev.block.blockNumber;
  }
  p.next = e + 1;
  ranges++;
  if (ranges % 20 === 0) {
    const rate = (p.next - startBlock) / ((Date.now() - t0) / 1000);
    p.blocksPerSecond = Math.round(rate);
    p.etaMinutes = Math.round((p.to - p.next) / rate / 60);
    save();
    console.log(`${new Date().toISOString()} at ${p.next} of ${p.to} | ${JSON.stringify(p.events)} | ${Object.keys(p.pairs).length} pairs | ${p.blocksPerSecond} blocks/s | eta ${p.etaMinutes} min`);
  }
}
if (p.status === 'running') p.status = 'done';
p.finishedAt = new Date().toISOString();
save();
console.log(JSON.stringify({ status: p.status, from: p.from, to: p.to, next: p.next, events: p.events, pairs: Object.keys(p.pairs).length, firstEventBlock: p.firstEventBlock, slowestMs: p.slowestMs, retries503: p.retries503, problem: p.problem }, null, 1));
process.exit(p.status === 'done' ? 0 : 1);
