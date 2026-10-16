// Routing v2 tests: the six reviewed offline scenarios (docs/reports/lb-design-c2-offline.mjs)
// re-run against the production module, plus measurement, persistence and
// never-blind properties. Pure arithmetic and temp files only — no gateway.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {LaneSpeeds, workOf} from './routing-v2.mjs';

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-v2-')), 'lane-speeds.json');
const median = 800;
const job = over => ({id: 'q', inputTokens: 2000, expectedOutputTokens: median, ...over});
const worker = (id, over = {}) => ({id, capacity: 4, running: [], queue: [], ...over});
const speeds = (over = {}) => new LaneSpeeds(null, {now: () => 0, wallNow: () => 0, ...over});
const always = () => ({eligible: true, reason: null});

test('S1 — unequal machine speeds, both empty: the fast machine wins', () => {
  const lb = speeds();
  lb.record({worker: {id: 'fast', identity: 'i'}, tokens: 120000, seconds: 1000, concurrency: 1});   // 120 tok/s solo
  lb.record({worker: {id: 'slow', identity: 'i'}, tokens: 40000, seconds: 1000, concurrency: 1});    // 40 tok/s solo
  const pick = lb.evaluate({job: job(), workers: [worker('fast'), worker('slow', {capacity: 2})], eligibility: always});
  assert.equal(pick.workerId, 'fast');
  assert.equal(pick.reason, 'measured_finish_estimate');
});

test('S2 — size-normalized speed: a big finished request does not crown a slow machine', () => {
  const lb = speeds();
  lb.record({worker: {id: 'fast', identity: 'i'}, tokens: 9600, seconds: 60, concurrency: 1});   // 160 tok/s
  lb.record({worker: {id: 'slow', identity: 'i'}, tokens: 2100, seconds: 40, concurrency: 1});   // 52.5 tok/s
  const pick = lb.evaluate({job: job({expectedOutputTokens: 6000}), workers: [worker('fast'), worker('slow')], eligibility: always});
  assert.equal(pick.workerId, 'fast');
});

test('S3 — spare slot plus nearly finished work beats a just-started slow machine', () => {
  const lb = speeds();
  lb.record({worker: {id: 'fast', identity: 'i'}, tokens: 120000, seconds: 1000, concurrency: 1});
  lb.record({worker: {id: 'slow', identity: 'i'}, tokens: 40000, seconds: 1000, concurrency: 1});
  const pick = lb.evaluate({job: job(), workers: [
    worker('fast', {running: [{id: 'a', expectedTotalTokens: 800, elapsedSeconds: 6.5}]}),
    worker('slow', {capacity: 2, running: [{id: 'b', expectedTotalTokens: 800, elapsedSeconds: 0}]})], eligibility: always});
  assert.equal(pick.workerId, 'fast');
});

test('S4 — no idle-worship: a busy fast machine with spare slots beats an idle slow one', () => {
  const lb = speeds();
  lb.record({worker: {id: 'fast', identity: 'i'}, tokens: 120000, seconds: 1000, concurrency: 1});
  lb.record({worker: {id: 'slow', identity: 'i'}, tokens: 40000, seconds: 1000, concurrency: 1});
  const pick = lb.evaluate({job: job(), workers: [
    worker('fast', {running: [{id: 'a', expectedTotalTokens: 4000, elapsedSeconds: 10}]}),
    worker('slow', {capacity: 2})], eligibility: always});
  assert.equal(pick.workerId, 'fast');
});

test('S5 — cold-start honesty: unmeasured lanes are never ranked by invented numbers', () => {
  const lb = speeds();
  lb.record({worker: {id: 'peer', identity: 'i'}, tokens: 110000, seconds: 1000, concurrency: 1});
  // Early: a measured lane with a spare slot beats the cold lane.
  const early = lb.evaluate({job: job(), workers: [worker('cold'), worker('peer')], eligibility: always, at: 5});
  assert.equal(early.workerId, 'peer');
  assert.equal(early.candidates.find(row => row.workerId === 'cold').reason, 'lane_unmeasured');
  // A fully busy fleet gives the cold lane capacity work — it must not sit idle.
  // The first pick is the probe priority; the committing caller latches it.
  const busy = lb.evaluate({job: job(), workers: [worker('cold'), worker('peer', {capacity: 1, running: [{id: 'r', expectedTotalTokens: 5000, elapsedSeconds: 0}]})], eligibility: always, at: 5});
  assert.equal(busy.workerId, 'cold');
  assert.equal(busy.reason, 'cold_probe_bounded');
  lb.markProbed('cold', 0);
  // After the latch, further picks are plain capacity order.
  const again = lb.evaluate({job: job(), workers: [worker('cold'), worker('peer', {capacity: 1, running: [{id: 'r', expectedTotalTokens: 5000, elapsedSeconds: 0}]})], eligibility: always, at: 6});
  assert.equal(again.workerId, 'cold');
  assert.equal(again.reason, 'cold_only_capacity');
  // First completed request converts the lane to measured.
  lb.record({worker: {id: 'cold', identity: 'i'}, tokens: 118000, seconds: 1000, concurrency: 1});
  const converted = lb.evaluate({job: job(), workers: [worker('cold'), worker('peer', {capacity: 1, running: [{id: 'r', expectedTotalTokens: 5000, elapsedSeconds: 0}]})], eligibility: always, at: 30});
  assert.equal(converted.workerId, 'cold');
  assert.equal(converted.reason, 'measured_finish_estimate');
});

test('S6 — ties resolve deterministically by id, not array order', () => {
  const lb = speeds();
  for (const id of ['b', 'a']) lb.record({worker: {id, identity: 'i'}, tokens: 120000, seconds: 1000, concurrency: 1});
  const first = lb.evaluate({job: job(), workers: [worker('a'), worker('b')], eligibility: always});
  const second = lb.evaluate({job: job(), workers: [worker('b'), worker('a')], eligibility: always});
  assert.equal(first.workerId, second.workerId);
});

test('hysteresis — the warm home wins small deltas and loses to a materially better peer', () => {
  const lb = speeds({hysteresisSeconds: 10});
  lb.record({worker: {id: 'home', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});  // 100 tok/s
  lb.record({worker: {id: 'peer', identity: 'i'}, tokens: 105000, seconds: 1000, concurrency: 1});  // 105 tok/s (5% better)
  const stay = lb.evaluate({job: job(), workers: [worker('home'), worker('peer')], currentWorkerId: 'home', homeIsWarmCache: true, eligibility: always});
  assert.equal(stay.action, 'stay');
  assert.equal(stay.reason, 'cache_affinity_keep_home');
  // A 3x faster peer with a free slot must take the queued head.
  lb.record({worker: {id: 'fast', identity: 'i'}, tokens: 300000, seconds: 1000, concurrency: 1});
  const move = lb.evaluate({job: job(), workers: [worker('home'), worker('fast')], currentWorkerId: 'home', homeIsWarmCache: true, eligibility: always});
  assert.equal(move.action, 'reassign');
  assert.equal(move.workerId, 'fast');
  assert.equal(move.reason, 'saving_exceeds_hysteresis');
  assert.ok(move.savingSeconds > 0);
});

test('crowded home spread — idle twin takes big work; tiny work may honestly stay', () => {
  const lb = speeds({hysteresisSeconds: 10});
  lb.record({worker: {id: 'ring1', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  lb.record({worker: {id: 'ring2', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  // The live complaint: home 3/4 decoding long jobs, identical twin 0/4. A
  // substantial request belongs on the idle twin.
  const busy = {id: 'ring1', capacity: 4, queue: [], running: [1, 2, 3].map(n => ({id: `r${n}`, expectedTotalTokens: 80000, elapsedSeconds: 0}))};
  const spread = lb.evaluate({job: job({expectedOutputTokens: 80000}), workers: [busy, worker('ring2')], currentWorkerId: 'ring1', homeIsWarmCache: true, eligibility: always});
  assert.equal(spread.workerId, 'ring2');
  // A tiny request saves less than the one-time re-home cost of its own input:
  // staying is the honest answer and the receipt says so.
  const tiny = lb.evaluate({job: job(), workers: [busy, worker('ring2')], currentWorkerId: 'ring1', homeIsWarmCache: true, eligibility: always});
  assert.equal(tiny.action, 'stay');
  // A full home whose work is about to drain still overflows by capacity.
  const full = {id: 'ring1', capacity: 4, queue: [], running: [1, 2, 3, 4].map(n => ({id: `r${n}`, expectedTotalTokens: 80000, elapsedSeconds: 1100}))};
  const overflow = lb.evaluate({job: job(), workers: [full, worker('ring2')], currentWorkerId: 'ring1', homeIsWarmCache: true, eligibility: always});
  assert.equal(overflow.workerId, 'ring2');
  assert.equal(overflow.reason, 'available_capacity_fallback');
  // A lightly loaded, nearly finished home keeps its work.
  const light = {id: 'ring1', capacity: 4, queue: [], running: [{id: 'r1', expectedTotalTokens: 2800, elapsedSeconds: 30}]};
  const keep = lb.evaluate({job: job(), workers: [light, worker('ring2')], currentWorkerId: 'ring1', homeIsWarmCache: true, eligibility: always});
  assert.equal(keep.action, 'stay');
});

test('never blind — unknown input sizes and missing progress cannot null the comparison', () => {
  const lb = speeds();
  lb.record({worker: {id: 'a', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  lb.record({worker: {id: 'b', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  // No inputTokens, no requestBytes, no usage: work falls back to the labelled median.
  const ghost = {id: 'ghost', capacity: 4, queue: [], running: [{id: 'g1', elapsedSeconds: 5}, {id: 'g2', elapsedSeconds: 5}]};
  const pick = lb.evaluate({job: {id: 'q'}, workers: [worker('a'), ghost], currentWorkerId: 'ghost', eligibility: always});
  assert.ok(Number.isFinite(pick.candidates.find(row => row.workerId === 'a').completionSeconds));
  assert.equal(pick.candidates.find(row => row.workerId === 'ghost').completionSeconds, null, 'cold lane stays null instead of an invented number');
  // Cold home with a free slot keeps its own warm conversation (2026-10-16
  // starvation fix): staying MEASURES the lane at zero cache cost instead of
  // dragging yet another conversation onto the single measured lane.
  assert.equal(pick.action, 'stay');
  assert.equal(pick.workerId, 'ghost');
  assert.equal(pick.reason, 'cold_probe_bounded');
  // The drag exists only where it belongs: a FULL cold home cannot serve the
  // job, so the measured peer takes it.
  const fullGhost = {id: 'ghost', capacity: 4, queue: [], running: [
    {id: 'g1', elapsedSeconds: 5}, {id: 'g2', elapsedSeconds: 5}, {id: 'g3', elapsedSeconds: 5}, {id: 'g4', elapsedSeconds: 5}]};
  const dragged = lb.evaluate({job: {id: 'q'}, workers: [worker('a'), fullGhost], currentWorkerId: 'ghost', eligibility: always});
  assert.equal(dragged.action, 'reassign');
  assert.equal(dragged.workerId, 'a');
  assert.equal(dragged.reason, 'measured_finish_estimate');
});

test('measurement is passive and cheap: one finish is one EWMA update, and concurrency is normalized', () => {
  const lb = speeds();
  const before = lb.state.records;
  lb.record({worker: {id: 'x', identity: 'i'}, tokens: 1000, seconds: 10, concurrency: 1});   // 100 solo
  lb.record({worker: {id: 'x', identity: 'i'}, tokens: 1800, seconds: 10, concurrency: 2});   // 180 at c=2 → 1.8x default 0.9
  assert.equal(lb.state.records - before, 2);
  const solo = lb.speedAt('x', 1);
  const two = lb.speedAt('x', 2);
  assert.equal(solo.evidence, 'measured', 'concurrency-1 is the directly measured solo rate');
  assert.ok(two.tokensPerSecond > solo.tokensPerSecond, 'measured concurrency-2 rate exceeds solo');
  assert.equal(two.evidence, 'measured_slowdown');
  assert.equal(lb.speedAt('x', 4).evidence, 'default_curve', 'unmeasured level uses the labelled default curve');
});

test('identity change resets the lane to honest cold; the first finish re-measures it', () => {
  const file = tempFile();
  const lb = new LaneSpeeds(file, {now: () => 0, wallNow: () => 0});
  lb.record({worker: {id: 'x', identity: 'old'}, tokens: 100000, seconds: 1000, concurrency: 1});
  assert.ok(lb.speedAt('x', 1).tokensPerSecond !== null);
  lb.record({worker: {id: 'x', identity: 'new'}, tokens: 100000, seconds: 1000, concurrency: 1});
  assert.equal(lb.lanes.get('x').samples, 1, 'identity swap wiped prior samples');
  assert.ok(lb.speedAt('x', 1).tokensPerSecond !== null);
});

test('persistence round-trips; a corrupt file is preserved and starts cold, never blocks', async () => {
  const file = tempFile();
  const first = new LaneSpeeds(file, {now: () => 0, wallNow: () => 1000});
  first.record({worker: {id: 'x', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  first.record({worker: {id: 'x', identity: 'i'}, tokens: 180000, seconds: 1000, concurrency: 2, outputTokens: 5000});
  await first.flush();
  const second = new LaneSpeeds(file, {now: () => 0, wallNow: () => 1000});
  assert.ok(second.speedAt('x', 1).tokensPerSecond !== null);
  assert.equal(second.speedAt('x', 2).evidence, 'measured_slowdown');
  assert.equal(second.medianOutput('x'), 5000, 'per-lane output median survives restart');
  fs.writeFileSync(file, '{not json');
  const third = new LaneSpeeds(file, {now: () => 0, wallNow: () => 1000});
  assert.equal(third.speedAt('x', 1).evidence, 'cold');
  assert.ok(third.state.notice.includes('preserved'));
  assert.ok(fs.readdirSync(path.dirname(file)).some(name => name.includes('.corrupt-')));
});

test('persistence keeps writing across coalesced cycles — no write-once freeze (review P0-1)', async () => {
  const file = tempFile();
  const lb = new LaneSpeeds(file, {now: () => 0, wallNow: () => 1000});
  lb.record({worker: {id: 'x', identity: 'i'}, tokens: 50000, seconds: 1000, concurrency: 1}); // 50 tok/s
  await lb.flush();
  lb.record({worker: {id: 'x', identity: 'i'}, tokens: 200000, seconds: 1000, concurrency: 1}); // EWMA → 95 tok/s
  await lb.flush();
  const reloaded = new LaneSpeeds(file, {now: () => 0, wallNow: () => 1000});
  assert.ok(reloaded.speedAt('x', 1).tokensPerSecond > 90, 'the SECOND write cycle must reach disk');
  assert.equal(reloaded.state.storageError, null);
});

test('running decay works from real gateway shapes: dispatchedMono is milliseconds (review P1-2)', () => {
  const lb = speeds();
  lb.record({worker: {id: 'x', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1}); // 100 tok/s
  const at = 1000; // seconds, performance epoch
  const busy = {id: 'x', capacity: 4, queue: [], running: [{id: 'r', dispatchedMono: (at - 100) * 1000}]}; // 100 s ago, ms
  // A ghost entry (no sizes): total = median output only — decayed by 100 s of work.
  const pending = lb.pendingSeconds(busy, at);
  assert.ok(pending < median / 100, `decayed pending ${pending} must be far below the undecayed ${median / 100}`);
  assert.ok(pending >= 0);
});

test('eligibility and lifecycle are respected, and receipts keep the legacy shape', () => {
  const lb = speeds();
  lb.record({worker: {id: 'a', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  const onlyA = (_job, candidate) => candidate.id === 'a' ? {eligible: true, reason: null} : {eligible: false, reason: 'drained'};
  const decision = lb.evaluate({job: job(), workers: [worker('a'), worker('b')], eligibility: onlyA});
  assert.equal(decision.workerId, 'a');
  assert.ok(Array.isArray(decision.candidates) && decision.candidates.length === 2);
  assert.equal(decision.candidates.find(row => row.workerId === 'b').reason, 'drained');
  assert.equal(decision.planner, 'v2');
  assert.ok(Number.isFinite(decision.marginSeconds));
  const running = lb.evaluate({job: {...job(), dispatched: true}, workers: [worker('a')], eligibility: always});
  assert.equal(running.action, 'unchanged');
  const nothing = lb.evaluate({job: job(), workers: [worker('a')], eligibility: () => ({eligible: false, reason: 'drained'})});
  assert.equal(nothing.reason, 'no_eligible_worker');
});

test('evaluate is side-effect-free: probe choices are reported, never latched (review P1-5)', () => {
  const lb = speeds({probeAfterSeconds: 20});
  lb.record({worker: {id: 'peer', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  const cold = worker('cold');
  const first = lb.evaluate({job: job(), workers: [cold, worker('peer', {capacity: 1, running: [{id: 'r', expectedTotalTokens: 5000, elapsedSeconds: 0}]})], eligibility: always, at: 5});
  assert.equal(first.reason, 'cold_probe_bounded');
  assert.equal(lb.lanes.get('cold'), undefined, 'evaluate must not create lane state');
  // Committing path latches; the probe then yields to plain capacity order.
  lb.markProbed('cold', 5);
  const second = lb.evaluate({job: job(), workers: [cold, worker('peer', {capacity: 1, running: [{id: 'r', expectedTotalTokens: 5000, elapsedSeconds: 0}]})], eligibility: always, at: 6});
  assert.equal(second.reason, 'cold_only_capacity');
});

test('a failed probe re-arms after the idle threshold instead of starving the lane (review P2-8)', () => {
  let wall = 5;
  const lb = new LaneSpeeds(null, {now: () => 0, wallNow: () => wall, probeAfterSeconds: 20});
  lb.record({worker: {id: 'peer', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  const cold = worker('cold');
  const first = lb.evaluate({job: job(), workers: [cold, worker('peer', {capacity: 1, running: [{id: 'r', expectedTotalTokens: 5000, elapsedSeconds: 0}]})], eligibility: always, at: 5});
  assert.equal(first.reason, 'cold_probe_bounded');
  lb.markProbed('cold', 5); // the probe request then fails or never dispatches
  wall = 6;
  const soon = lb.evaluate({job: job(), workers: [cold, worker('peer', {capacity: 1, running: [{id: 'r', expectedTotalTokens: 5000, elapsedSeconds: 0}]})], eligibility: always, at: 6});
  assert.equal(soon.reason, 'cold_only_capacity', 'within the idle window the probe stays consumed');
  wall = 30;
  const later = lb.evaluate({job: job(), workers: [cold, worker('peer', {capacity: 1, running: [{id: 'r', expectedTotalTokens: 5000, elapsedSeconds: 0}]})], eligibility: always, at: 6});
  assert.equal(later.reason, 'cold_probe_bounded', 'after the idle threshold probe priority returns');
});

test('stale measurements read as cold after the staleness horizon (review P1-6)', () => {
  let wall = 1000;
  const lb = new LaneSpeeds(null, {now: () => 0, wallNow: () => wall, sampleTtlSeconds: 3600});
  lb.record({worker: {id: 'x', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  assert.equal(lb.speedAt('x', 1).evidence, 'measured');
  wall += 3601;
  assert.equal(lb.speedAt('x', 1).evidence, 'stale');
  assert.equal(lb.speedAt('x', 1).tokensPerSecond, null, 'stale is cold, never an invented number');
  const status = lb.status(['x']);
  assert.deepEqual(status.unmeasured_lanes, ['x']);
});

test('a full home does not double-count the evaluated job sitting in its queue (review P2-7)', () => {
  const lb = speeds();
  lb.record({worker: {id: 'x', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  const at = 0;
  const full = {id: 'x', capacity: 1, queue: [{id: 'q', inputTokens: 2000, expectedOutputTokens: median}], running: [{id: 'r', expectedTotalTokens: median, elapsedSeconds: 0}]};
  const withDouble = lb.pendingSeconds(full, at);
  const excluded = lb.pendingSeconds(full, at, 'q');
  assert.ok(excluded < withDouble, 'excluding the evaluated job must reduce pending work');
  assert.equal(excluded, median / 100);
});

test('status names unmeasured lanes so blindness is visible', () => {
  const lb = speeds();
  lb.record({worker: {id: 'known', identity: 'i'}, tokens: 1000, seconds: 1, concurrency: 1});
  const status = lb.status(['known', 'silent', 'absent']);
  assert.deepEqual(status.unmeasured_lanes, ['silent', 'absent']);
  assert.equal(status.lanes.find(lane => lane.workerId === 'known').measured, true);
});

test('workOf: unknown size degrades to the labelled median, never null; image bytes are never tokens', () => {
  assert.equal(workOf({}), median);
  assert.equal(workOf({inputTokens: 100}), 100 + median);
  assert.equal(workOf({inputTokens: 5, expectedOutputTokens: 7}), 12);
  // The gateway's routing metadata is authoritative: a text route's estimate is used,
  // a multimodal abstention (null) is honoured as unknown — never bytes/4 of a payload.
  assert.equal(workOf({routingInput: {inputTokens: 4000}}), 4000 + median);
  assert.equal(workOf({routingInput: {inputTokens: null}, requestBytes: 5_000_000}), median);
  assert.equal(workOf({requestBytes: 5_000_000}), median);
});

test('a measured-but-unestimable lane is excluded, never ranked as instantly done (round-2 P2-1)', () => {
  // A value-corrupted persistence file can hold a subnormal solo: positive, so
  // the lane reads "measured", but workOf/rate overflows to a null estimate.
  // Null would coerce to 0 in the peers sort and win placement — forbidden.
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({version: 1, fleetOutputs: [], lanes: {
    good: {solo: {value: 100, samples: 3}, samples: 3, lastAt: 0},
    bad: {solo: {value: 5e-324, samples: 3}, samples: 3, lastAt: 0}}}));
  const lb = new LaneSpeeds(file, {now: () => 0, wallNow: () => 0});
  const pick = lb.evaluate({job: job(), workers: [worker('good'), worker('bad')], eligibility: always});
  assert.equal(pick.workerId, 'good');
  // And with only the broken lane eligible, it falls to the honest cold rule
  // (capacity/id order) instead of a fabricated "finishes in 0 seconds".
  const only = lb.evaluate({job: job(), workers: [worker('bad')], eligibility: always});
  assert.equal(only.workerId, 'bad');
  assert.equal(['cold_only_capacity', 'cold_probe_bounded'].includes(only.reason), true);
});

test('close() during an in-flight write still lands the pending batch (round-2 persistence)', async () => {
  const file = tempFile();
  const lb = new LaneSpeeds(file, {now: () => 0, wallNow: () => 0});
  lb.record({worker: {id: 'x', identity: 'i'}, tokens: 1000, seconds: 10, concurrency: 1});
  await lb.close(); // close() raced the write cycle: the batch must survive
  const fresh = new LaneSpeeds(file, {now: () => 0, wallNow: () => 0});
  assert.equal(fresh.status(['x']).lanes.find(lane => lane.workerId === 'x').samples, 1);
});

test('the fleet output window survives a restart at its full 64 depth (round-2 P2)', async () => {
  const file = tempFile();
  const lb = new LaneSpeeds(file, {now: () => 0, wallNow: () => 0});
  for (let i = 0; i < 40; i++) lb.record({worker: {id: 'x', identity: 'i'}, tokens: 1000, seconds: 10, concurrency: 1, outputTokens: 1000 + i});
  await lb.flush();
  const fresh = new LaneSpeeds(file, {now: () => 0, wallNow: () => 0});
  assert.equal(fresh.fleetOutputs.length, 40); // the old restore trimmed to 32
});

test('a solo-less probe latch survives a restart and keeps spacing probes (round-2)', () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({version: 1, fleetOutputs: [], lanes: {
    a: {lastProbeAt: 123}, z: {}}}));
  // Huge probe window: a lane latched at wall 123 must NOT be probe-eligible
  // at wall 1000; the fresh lane 'z' wins instead. Losing the latch would
  // silently re-probe 'a' first (id order).
  const lb = new LaneSpeeds(file, {now: () => 0, wallNow: () => 1000, probeAfterSeconds: 10000});
  const pick = lb.evaluate({job: job(), workers: [worker('a'), worker('z')], eligibility: always});
  assert.equal(pick.workerId, 'z');
  assert.equal(pick.reason, 'cold_probe_bounded');
  // The solo-less lane is still honestly cold, and recording into it works.
  assert.equal(lb.speedAt('a', 1).tokensPerSecond, null);
  lb.record({worker: {id: 'a', identity: 'i'}, tokens: 1000, seconds: 10, concurrency: 1});
  assert.equal(lb.speedAt('a', 1).tokensPerSecond, 100);
});

// --- 2026-10-16 fleet observation: the single measured lane starved the cold twin ---

const busy = n => Array.from({length: n}, (_, i) => ({id: 'r' + i, expectedTotalTokens: 800, elapsedSeconds: 5}));

test('an armed cold twin is probed when the measured home is busy (starvation fix)', () => {
  const lb = speeds({wallNow: () => 1000});
  lb.record({worker: {id: 'ring1', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1}); // measured 100 tok/s
  // ring2 cold, never probed; ring1 3/4 busy. Pre-fix this stayed forever.
  const pick = lb.evaluate({job: job(), workers: [worker('ring1', {running: busy(3)}), worker('ring2')],
    currentWorkerId: 'ring1', homeIsWarmCache: true, eligibility: always});
  assert.equal(pick.workerId, 'ring2');
  assert.equal(pick.reason, 'cold_probe_bounded');
});

test('the probe is bounded: a recently probed twin is not piled on', () => {
  const lb = speeds({wallNow: () => 1000});
  lb.record({worker: {id: 'ring1', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  lb.markProbed('ring2', 999); // probed 1s ago; re-arms at 1020
  const pick = lb.evaluate({job: job(), workers: [worker('ring1', {running: busy(3)}), worker('ring2')],
    currentWorkerId: 'ring1', homeIsWarmCache: true, eligibility: always});
  assert.equal(pick.workerId, 'ring1');
  assert.equal(pick.reason, 'cache_affinity_keep_home');
});

test('an idle measured home keeps work even when a cold twin is armed', () => {
  const lb = speeds({wallNow: () => 1000});
  lb.record({worker: {id: 'ring1', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  const pick = lb.evaluate({job: job(), workers: [worker('ring1'), worker('ring2')],
    currentWorkerId: 'ring1', homeIsWarmCache: true, eligibility: always});
  assert.equal(pick.workerId, 'ring1');
  assert.equal(pick.reason, 'cache_affinity_keep_home');
});

test('a full measured home overflows to an armed cold twin instead of dead-ending', () => {
  const lb = speeds({wallNow: () => 1000});
  lb.record({worker: {id: 'ring1', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  const pick = lb.evaluate({job: job(), workers: [worker('ring1', {running: busy(4)}), worker('ring2')],
    currentWorkerId: 'ring1', eligibility: always});
  assert.equal(pick.workerId, 'ring2');
  assert.equal(pick.reason, 'cold_probe_bounded');
});

test('the probe fires under light traffic: home busy at 1/4 with an armed cold twin', () => {
  const lb = speeds({wallNow: () => 1000});
  lb.record({worker: {id: 'ring1', identity: 'i'}, tokens: 100000, seconds: 1000, concurrency: 1});
  // Only ONE request running on ring1 — the old crowding gate would stay here forever.
  const pick = lb.evaluate({job: job(), workers: [worker('ring1', {running: busy(1)}), worker('ring2')],
    currentWorkerId: 'ring1', homeIsWarmCache: true, eligibility: always});
  assert.equal(pick.workerId, 'ring2');
  assert.equal(pick.reason, 'cold_probe_bounded');
});

// --- 2026-10-16: the twin lie — blended rates crowned one identical machine 2.2x over the other ---

test('two-phase rates: prefill-heavy history inflates prefill, not decode (twin-lie fix)', () => {
  const lb = speeds({wallNow: () => 1000});
  const rec = (id, I, O, s) => lb.record({worker: {id, identity: 'i'}, tokens: I + O, outputTokens: O, seconds: s, concurrency: 1});
  // True hardware: decode 100 tok/s on both twins. 'a' also served cold-prefill
  // monsters (prefill ~2000), 'b' modest ones (prefill ~1000). Three samples per
  // class per lane (the trust threshold); each sample updates only its dominant phase.
  for (const [I, O, s] of [[200000, 1000, 100.5], [190000, 2000, 96.5], [195000, 1500, 98.3]]) rec('a', I, O, s);
  for (const [I, O, s] of [[1000, 100000, 1005], [2000, 200000, 2020], [1500, 150000, 1512]]) rec('a', I, O, s);
  for (const [I, O, s] of [[100000, 1000, 100.5], [95000, 2000, 96.5], [97500, 1500, 98.3]]) rec('b', I, O, s);
  for (const [I, O, s] of [[1000, 100000, 1005], [2000, 200000, 2020], [1500, 150000, 1512]]) rec('b', I, O, s);
  const lanes = lb.status(['a', 'b']).lanes;
  const A = lanes.find(l => l.workerId === 'a'), B = lanes.find(l => l.workerId === 'b');
  assert.ok(Math.abs(A.decodeTokensPerSecond - 100) < 5, `a decode ${A.decodeTokensPerSecond}`);
  assert.ok(Math.abs(B.decodeTokensPerSecond - 100) < 5, `b decode ${B.decodeTokensPerSecond}`);
  assert.ok(A.prefillTokensPerSecond > 1.5 * B.prefillTokensPerSecond, 'prefill rates differ as measured');
  // A decode-heavy job now prices the twins nearly equally — the blended rate
  // would have called 'a' ~2x faster and funnelled everything there.
  const pick = lb.evaluate({job: job({inputTokens: 2000, expectedOutputTokens: 60000}), workers: [worker('a'), worker('b')], eligibility: always});
  const ca = pick.candidates.find(r => r.workerId === 'a'), cb = pick.candidates.find(r => r.workerId === 'b');
  assert.ok(Number.isFinite(ca.completionSeconds) && Number.isFinite(cb.completionSeconds));
  assert.ok(Math.abs(ca.completionSeconds - cb.completionSeconds) / cb.completionSeconds < 0.05,
    `estimates should agree: a=${ca.completionSeconds} b=${cb.completionSeconds}`);
});

test('degenerate sample mixes fall back to the blended rate instead of a bogus fit', () => {
  const lb = speeds({wallNow: () => 1000});
  const rec = (id, I, s) => lb.record({worker: {id, identity: 'i'}, tokens: I, seconds: s, concurrency: 1});
  rec('c', 50000, 500); rec('c', 60000, 600); rec('c', 55000, 550); // pure prefill: decode never sampled
  const lane = lb.status(['c']).lanes[0];
  assert.equal(lane.decodeTokensPerSecond, null);
  assert.ok(lane.prefillTokensPerSecond > 0, 'prefill measured from dominant samples');
  const pick = lb.evaluate({job: job(), workers: [worker('c'), worker('d')], eligibility: always});
  assert.ok(Number.isFinite(pick.candidates.find(r => r.workerId === 'c').completionSeconds), 'blended fallback still estimates');
});

// --- 2026-10-16: phase samples are level-1 only — concurrent samples normalized by the
// default curve understated decode 2-6x (measured c3/c4 = 0.12-0.55 vs 0.73-0.81), and the
// measured curve feeds back through the solo EWMA (measured c2 > 1 observed). Post-fix
// decode-certain samples implied 33-51 tok/s on hardware whose true decode is ~138-166.

test('phase classes ignore concurrent samples; the same samples at level 1 count', () => {
  const lb = speeds({wallNow: () => 1000});
  // Decode-dominant samples while the lane juggles 3 jobs: must NOT touch decode
  // even though the trust threshold (>=3 per class) is met by count.
  for (const s of [400, 800, 600]) {
    lb.record({worker: {id: 'r', identity: 'i'}, tokens: 1000 + 40000, outputTokens: 40000, seconds: s, concurrency: 3});
  }
  let lane = lb.status(['r']).lanes[0];
  assert.equal(lane.decodeTokensPerSecond, null, 'concurrent samples must not feed phase classes');
  assert.ok(lane.soloTokensPerSecond > 0, 'solo EWMA still learns from them');
  // Same shapes at level 1: decode measures the honest solo rate.
  for (const s of [400, 400, 400]) {
    lb.record({worker: {id: 'r', identity: 'i'}, tokens: 1000 + 40000, outputTokens: 40000, seconds: s, concurrency: 1});
  }
  lane = lb.status(['r']).lanes[0];
  assert.ok(Math.abs(lane.decodeTokensPerSecond - 102.5) < 3, `decode ${lane.decodeTokensPerSecond}`);
});

test('stale measurement version drops poisoned phase state but keeps solo history', async () => {
  const file = path.join(os.tmpdir(), `routing-v2-phasever-${randomUUID()}.json`);
  try {
    const lb = new LaneSpeeds(file, {now: () => 0, wallNow: () => 1000});
    const rec = (id, I, O, s) => lb.record({worker: {id, identity: 'i'}, tokens: I + O, outputTokens: O, seconds: s, concurrency: 1});
    rec('r', 1000, 40000, 400); rec('r', 2000, 80000, 800); rec('r', 1500, 60000, 600);
    await lb.close();
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(onDisk.measurementVersion, 2, 'save stamps the measurement version');
    // Simulate state saved under an older measurement semantics.
    onDisk.measurementVersion = 1;
    fs.writeFileSync(file, JSON.stringify(onDisk));
    const revived = new LaneSpeeds(file, {now: () => 0, wallNow: () => 2000});
    const lane = revived.status(['r']).lanes[0];
    assert.equal(lane.decodeTokensPerSecond, null, 'poisoned phase class is dropped');
    assert.ok(lane.soloTokensPerSecond > 0, 'solo history survives');
    await revived.close();
  } finally { fs.rmSync(file, {force: true}); }
});
