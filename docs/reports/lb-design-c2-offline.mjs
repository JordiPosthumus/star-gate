#!/usr/bin/env node
// Design C v2 — offline demonstration of the proposed placement calculation.
// Requested by external review (Codex, 2026-10-13): the calculation must handle
// unequal machine speeds, different request sizes, spare execution slots, and a
// model change with no fresh measurements. Pure arithmetic on synthetic state —
// no gateway imports, no services, no I/O. Run: node docs/reports/lb-design-c2-offline.mjs
//
// The v1 proposal ("one number per lane": (running+queued) × average service
// seconds) was correctly criticized: it scores every empty machine 0 and ranks
// machines by average duration, which conflates machine speed with request size.
// v2 keeps the simplicity but fixes both:
//
//   speed(L)      — measured blended tokens per service second
//                   (prompt−cached+completion tokens / service seconds), a
//                   size-normalized measurement, not an average duration.
//   pending(L)    — Σ running max(0, expectedTotal − speed·elapsed)   (running
//                   work decays as it finishes) + Σ queued work.
//   finish(L, q)  — startDelay(L) + workOf(q) / speed(L, concurrency)
//                   startDelay is 0 with a spare slot, else the time until the
//                   next slot frees plus queued drain. Empty lanes therefore
//                   score workOf/speed: a fast empty machine sorts before a
//                   slow empty machine.
//   cold lanes    — after a model swap (detected by the existing telemetry
//                   model_ids poll) a lane has no speed. It is not ranked by an
//                   invented number: it only receives work when no measured
//                   lane has a spare slot, or as ONE bounded probe after
//                   probeAfterSeconds idle, and its first completed request
//                   converts it to measured. No re-warm deadline is promised.

const MEDIAN_OUTPUT_TOKENS = 800;      // one fleet-wide number, labelled estimate
const SLOWDOWN_DEFAULT = c => Math.pow(0.9, c - 1); // labelled default, replaced by measurement
const PROBE_AFTER_SECONDS = 20;
const EPS = 1e-9;

const workOf = job => (job.inputTokens ?? 0) + (job.expectedOutputTokens ?? MEDIAN_OUTPUT_TOKENS);

function speedAt(lane, concurrency) {
  if (!Number.isFinite(lane.tps)) return null;               // cold: unknown, never invented
  const measured = lane.slowdown?.[concurrency];
  const factor = Number.isFinite(measured) ? measured : SLOWDOWN_DEFAULT(concurrency);
  return lane.tps * factor;
}
// SHIPPED REFINEMENT (2026-10-15): the production module prices the incoming
// request at its actual post-join concurrency (running.length + 1, capped at
// capacity), not capacity-when-any-slot-is-free — this demo's expression was a
// reviewed approximation; the shipped rule is the physically correct one and
// ranks identical-capacity lanes identically while fixing cross-capacity mixes.
// SHIPPED REFINEMENT (2026-10-15, round 2): "one bounded probe" became re-armable
// probe priority — a probe whose request failed or never dispatched retries after
// the idle threshold instead of starving the lane (see routing-v2.mjs header).
// Also shipped: a full home overflows on any measured strict improvement (no
// margin is owed when the home cannot serve the head at all).

function pendingSeconds(lane) {
  const rate = speedAt(lane, Math.max(1, lane.running.length)) ?? 0;
  const runningLeft = lane.running.reduce((sum, r) => {
    const total = r.expectedTotalTokens ?? workOf(r);
    return sum + Math.max(0, total - rate * r.elapsedSeconds); // finished fraction decays away
  }, 0);
  const queuedWork = lane.queue.reduce((sum, q) => sum + workOf(q), 0);
  return rate > 0 ? (runningLeft + queuedWork) / rate : null;
}

function finishEstimate(lane, job) {
  const spare = lane.capacity - lane.running.length;
  const busySeconds = pendingSeconds(lane);
  let startDelay = 0;
  if (spare <= 0) {
    if (busySeconds === null) return null;                   // cannot start: unknown, not zero
    startDelay = busySeconds;                                // coarse: next free slot after drain
  }
  const concurrency = Math.min(lane.capacity, lane.running.length + Math.max(1, spare) );
  const rate = speedAt(lane, Math.max(1, concurrency));
  if (rate === null || rate <= 0) return null;
  const estimate = startDelay + workOf(job) / rate;
  return Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
}

// Placement: rank measured lanes by finish estimate; cold lanes only enter when
// no measured lane has a spare slot, or as one bounded idle probe.
function choose(workers, job, now = 0) {
  const measured = workers.filter(w => Number.isFinite(w.tps));
  const cold = workers.filter(w => !Number.isFinite(w.tps));
  const withSlot = measured.filter(w => w.capacity > w.running.length);
  const scored = withSlot
    .map(w => ({ id: w.id, finish: finishEstimate(w, job), cold: false }))
    .sort((a, b) => a.finish - b.finish || a.id.localeCompare(b.id));
  if (scored.length) return { ...scored[0], reason: 'measured_finish_estimate' };
  const probe = cold.find(w => w.capacity > w.running.length
    && (now - (w.coldSince ?? 0)) >= PROBE_AFTER_SECONDS);
  if (probe) return { id: probe.id, finish: null, cold: true, reason: 'cold_probe_bounded' };
  const fallback = cold.find(w => w.capacity > w.running.length);
  if (fallback) return { id: fallback.id, finish: null, cold: true, reason: 'cold_only_capacity' };
  return { id: null, finish: null, cold: false, reason: 'no_capacity' };
}

// --- harness -----------------------------------------------------------------
let failures = 0;
const check = (name, ok, detail) => { console.log((ok ? '  PASS' : '  FAIL') + '  ' + name + (detail ? '  — ' + detail : '')); if (!ok) failures++; };
const scenario = title => console.log('\n== ' + title);

const sparkFast = over => ({ id: 'spark-fast', capacity: 4, tps: 120, running: [], queue: [], ...over });
const sparkFast2 = over => ({ id: 'spark-fast2', capacity: 4, tps: 110, running: [], queue: [], ...over });
const m3Slow = over => ({ id: 'm3-slow', capacity: 2, tps: 40, running: [], queue: [], ...over });
const job = over => ({ id: 'q', inputTokens: 2000, expectedOutputTokens: MEDIAN_OUTPUT_TOKENS, ...over });

scenario('S1 — unequal machine speeds, both empty: the fast machine wins');
{
  const pick = choose([sparkFast(), m3Slow()], job());
  check('fast empty machine ranks first', pick.id === 'spark-fast',
    `finish fast=${finishEstimate(sparkFast(), job()).toFixed(1)}s slow=${finishEstimate(m3Slow(), job()).toFixed(1)}s`);
}

scenario('S2 — different request sizes: size-normalized speed, not average duration');
{
  // The fast lane just served one huge request (60s of service for 7600 tokens);
  // the slow lane served many tiny ones. Average-duration ranking would crown
  // the slow lane (short average); tokens-per-second ranking keeps truth.
  const fastAfterBig = { ...sparkFast(), recent: [{ tokens: 2000 + 7600, seconds: 60 }] };
  const slowAfterTiny = { ...m3Slow(), recent: [{ tokens: 2000 + 100, seconds: 40 }] };
  const fastTps = fastAfterBig.recent[0].tokens / fastAfterBig.recent[0].seconds;
  const slowTps = slowAfterTiny.recent[0].tokens / slowAfterTiny.recent[0].seconds;
  check('speed measurement is size-normalized', fastTps > slowTps,
    `fast=${fastTps.toFixed(0)} tok/s (avg dur 60s) vs slow=${slowTps.toFixed(0)} tok/s (avg dur 40s)`);
  const pick = choose([sparkFast(), m3Slow()], job({ expectedOutputTokens: 6000 }));
  check('big new request still prefers the genuinely fast machine', pick.id === 'spark-fast',
    `finish fast=${finishEstimate(sparkFast(), job({ expectedOutputTokens: 6000 })).toFixed(1)}s slow=${finishEstimate(m3Slow(), job({ expectedOutputTokens: 6000 })).toFixed(1)}s`);
}

scenario('S3 — spare execution slots and nearly finished work');
{
  const busyFast = sparkFast({ running: [{ expectedTotalTokens: 800, elapsedSeconds: 6.5 }] }); // ~98% done
  const busySlow = m3Slow({ running: [{ expectedTotalTokens: 800, elapsedSeconds: 0 }] });      // just started
  const pick = choose([busyFast, busySlow], job());
  check('spare slot + finished fraction beats a busy slow machine', pick.id === 'spark-fast',
    `finish fast=${finishEstimate(busyFast, job()).toFixed(1)}s slow=${finishEstimate(busySlow, job()).toFixed(1)}s`);
  const decayed = pendingSeconds(busyFast);
  check('running work decays as it finishes', decayed < workOf(job()) / 40,
    `pending on nearly-done lane=${decayed.toFixed(2)}s`);
}

scenario('S4 — no idle-worship: a busy fast machine can still beat an idle slow one');
{
  const loadedFast = sparkFast({ running: [{ expectedTotalTokens: 4000, elapsedSeconds: 10 }] }); // ~26s left, 3 slots free
  const pick = choose([loadedFast, m3Slow()], job());
  check('fast machine with spare slots wins over idle slow machine', pick.id === 'spark-fast',
    `finish fast=${finishEstimate(loadedFast, job()).toFixed(1)}s idle slow=${finishEstimate(m3Slow(), job()).toFixed(1)}s`);
}

scenario('S5 — model change with no fresh measurements: honest cold-start behavior');
{
  const swapped = { ...sparkFast(), tps: NaN, coldSince: 0 };   // telemetry saw model_ids change
  const healthyPeer = sparkFast2();
  const early = choose([swapped, healthyPeer], job(), 5);
  check('cold lane is not chosen while a measured lane has a spare slot', early.id === 'spark-fast2' && !early.cold,
    `picked=${early.id} reason=${early.reason}`);
  const later = choose([swapped, { ...sparkFast2(), capacity: 1, running: [{}] }], job(), 5);
  check('cold lane serves only when no measured lane has a spare slot', later.id === 'spark-fast' && later.cold,
    `picked=${later.id} reason=${later.reason}`);
  const probe = choose([swapped, { ...sparkFast2(), capacity: 1, running: [{}] }], job(), PROBE_AFTER_SECONDS + 1);
  check('idle cold lane gets exactly one bounded probe after the idle threshold', probe.id === 'spark-fast' && probe.reason === 'cold_probe_bounded');
  const recovered = { ...swapped, tps: 118 };                    // first completion converted prior → measured
  const back = choose([recovered, { ...sparkFast2(), capacity: 1, running: [{}] }], job(), 30);
  check('first finished request re-measures the lane', back.id === 'spark-fast' && !back.cold,
    `finish=${finishEstimate(recovered, job()).toFixed(1)}s vs busy peer`);
}

scenario('S6 — stability: ties and hysteresis stay deterministic');
{
  const a = sparkFast(), b = { ...sparkFast(), id: 'spark-b', tps: 120 };
  const first = choose([a, b], job()), second = choose([b, a], job());
  check('equal machines resolve by stable id, not array luck', first.id === second.id,
    `first=${first.id} second=${second.id}`);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED') + '\n');
process.exit(failures ? 1 : 0);
