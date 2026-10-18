// Read-only check: do the engines behind DSG report the cache reads they actually get?
//
// DSG records `usage.prompt_tokens_details.cached_tokens` from each upstream response.
// When an engine caches prefixes but omits that field, every request is recorded as a
// full prompt re-read: the client shows 0% cache hits and the v2 lane-speed estimate
// counts cached tokens as compute, so placement is priced from a cache-mix artefact.
//
// This script compares what the gateway recorded against each engine's own
// `vllm:prefix_cache_hits_total` counters. It never sends inference traffic.
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const logPath = option('log', 'runtime/gateway.log');
const statePath = option('state', 'runtime/affinity.json');
const hours = Number(option('hours', '6'));
const minRequests = Number(option('min-requests', '20'));
if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be positive');
if (!Number.isSafeInteger(minRequests) || minRequests < 1) throw new Error('--min-requests must be a positive integer');

const cutoff = Date.now() - hours * 3600_000;
const workers = (() => {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return Array.isArray(state.workers) ? state.workers : [];
})();
const byId = new Map(workers.map(worker => [worker.id, worker]));
const stats = new Map();
const row = node => {
  if (!stats.has(node)) stats.set(node, { requests: 0, prompt: 0, cached: 0, missing: 0, last: 0 });
  return stats.get(node);
};

const lines = readline.createInterface({ input: fs.createReadStream(logPath), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.includes('"event":"request_finished"')) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (!event.time || Date.parse(event.time) < cutoff) continue;
  if (!event.usage || !Number.isSafeInteger(event.usage.prompt_tokens)) continue;
  const r = row(event.node ?? 'unknown');
  r.requests++;
  r.last = Math.max(r.last, Date.parse(event.time));
  r.prompt += event.usage.prompt_tokens;
  if (Number.isSafeInteger(event.usage.cached_tokens)) r.cached += event.usage.cached_tokens;
  else r.missing++;
}

async function engineRatio(worker) {
  if (!worker?.url) return null;
  let origin;
  try { origin = new URL(worker.url).origin; } catch { return null; }
  try {
    const response = await fetch(`${origin}/metrics`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const text = await response.text();
    let hits = 0, queries = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('#')) continue;
      const [series, value] = line.trim().split(/\s+/);
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      if (series?.startsWith('vllm:prefix_cache_hits_total')) hits += n;
      else if (series?.startsWith('vllm:prefix_cache_queries_total')) queries += n;
    }
    return queries > 0 ? hits / queries : null;
  } catch {
    return null;
  }
}

const results = [];
for (const [node, r] of [...stats].sort(([a], [b]) => a.localeCompare(b))) {
  const reported = r.prompt > 0 ? r.cached / r.prompt : null;
  const engine = await engineRatio(byId.get(node));
  const stale = r.last > 0 && Date.now() - r.last > 10 * 60_000;
  let verdict = 'ok';
  if (stale) verdict = 'stale';
  else if (r.requests < minRequests) verdict = 'insufficient';
  else if (engine !== null && engine >= 0.5 && (reported ?? 0) < 0.02) verdict = 'MISREPORTED';
  else if (engine === null && r.missing === r.requests && r.prompt > 1000) verdict = 'NO_CACHE_FIELD';
  results.push({ node, ...r, reported, engine, verdict });
}

const pct = value => value === null ? '    ?' : `${(value * 100).toFixed(1)}%`.padStart(6);
console.log(`cache telemetry: last ${hours}h, ${logPath}`);
console.log('node                 requests  reported  engine  verdict');
for (const r of results) {
  console.log(`${r.node.padEnd(20)} ${String(r.requests).padStart(8)}  ${pct(r.reported)}  ${pct(r.engine)}  ${r.verdict}`);
}

const stale = results.filter(r => r.verdict === 'stale');
if (stale.length) console.log(`\nstale (idle >10m, skipped): ${stale.map(r => r.node).join(', ')}`);

const bad = results.filter(r => r.verdict === 'MISREPORTED');
if (bad.length) {
  console.error('\nMISREPORTED: the engine caches prefixes but the gateway recorded no cached tokens.');
  for (const r of bad) console.error(`  ${r.node}: engine ${pct(r.engine)} vs reported ${pct(r.reported)}`);
  console.error('Fix: add --enable-prompt-tokens-details to that engine\'s serve args and restart it.');
  console.error('See docs/cache-telemetry.md.');
  process.exit(1);
}
const warn = results.filter(r => r.verdict === 'NO_CACHE_FIELD');
if (warn.length) {
  console.error('\nNO_CACHE_FIELD: every recent response from these nodes omitted cached_tokens and no');
  console.error('vLLM prefix-cache metrics were reachable. If the engine caches, it must report the field.');
  console.error(`  ${warn.map(r => r.node).join(', ')}`);
} else {
  console.log('\nNo misreported cache telemetry detected.');
}
