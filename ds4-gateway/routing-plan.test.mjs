import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completionEstimate, chooseRoute, planArrivals} from './routing-plan.mjs';

const job = (id, sequence = 1, extra = {}) => ({id, sequence, priority: 'normal', inputTokens: 0, outputLimit: 100, ...extra});
const worker = (id, extra = {}) => ({id, model: 'glm', identity: `${id}/glm/build1`, capacity: 1, eligible: true, running: [], queue: [], ...extra});
const speeds = (node, prefill = 1000, decode = 10) => ['prefill', 'decode'].map(phase => ({workerId: node.id,
  model: node.model, identity: node.identity, requestId: 'measured-1', scope: 'request', phase,
  tokens: phase === 'prefill' ? prefill : decode, seconds: 1, concurrency: 1, concurrencyStable: true, waitExcluded: true}));
const service = () => ({seconds: 30});
const outputModel = {fallbackTokens: 100};
const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;};

test('earliest-slot queue example yields 20 seconds, then 40 with one preceding 30-second job', () => {
  const node = worker('a', {capacity: 4, running: [20, 40, 60, 80].map(remainingSeconds => ({remainingSeconds}))});
  const candidate = job('candidate', 2);
  assert.equal(completionEstimate({job: candidate, worker: node, service}).waitingSeconds, 20);
  node.queue.push(job('ahead'));
  const result = completionEstimate({job: candidate, worker: node, service});
  assert.equal(result.waitingSeconds, 40); assert.equal(result.completionSeconds, 70);
  assert.equal(result.service.seconds, 30); assert.equal(result.bookings[1].concurrency, 4);
});

test('a full worker plus queued requests never becomes execution concurrency six', () => {
  const node = worker('a', {capacity: 4, running: [20, 40, 60, 80].map(remainingSeconds => ({remainingSeconds})),
    queue: [job('one'), job('two', 2)]});
  const calls = [];
  completionEstimate({job: job('three', 3), worker: node, service: (item, c) => {calls.push(c); return service();}});
  assert.deepEqual(calls, [4, 4, 4]);
});

test('blocked same-session successors cannot hold up independent work on a free slot', () => {
  const node = worker('a', {capacity: 2, running: [{remainingSeconds: 20, key: 'A'}], queue: [job('A2', 1, {key: 'A', priority: 'high'})]});
  const result = completionEstimate({job: job('B', 2, {key: 'B'}), worker: node, service});
  assert.equal(result.waitingSeconds, 0); assert.equal(result.bookings.length, 1); assert.equal(result.bookings[0].concurrency, 2);
});

test('priority preserves same-session FIFO and original sequence in a merged destination queue', () => {
  const node = worker('a', {queue: [job('A2', 3, {key: 'A', priority: 'high'}), job('B', 2), job('A1', 1, {key: 'A'})]});
  const result = completionEstimate({job: job('candidate', 4), worker: node, service});
  assert.deepEqual(result.bookings.map(row => row.requestId), ['A1', 'A2', 'B', 'candidate']);
  assert.equal(result.waitingSeconds, 90);
  const genie = completionEstimate({job: job('genie', 5, {geniePriority: true}), worker: node, service});
  assert.equal(genie.waitingSeconds, 0);
});

test('candidate excludes its own booking, cancelled work, and respects cross-worker session readiness', () => {
  const candidate = job('candidate', 2, {key: 'session'}), node = worker('a', {queue: [job('cancelled', 1, {cancelled: true}), candidate]});
  assert.equal(completionEstimate({job: candidate, worker: node, service}).waitingSeconds, 0);
  assert.equal(completionEstimate({job: candidate, worker: node, service, sessionReadySeconds: {session: 60}}).waitingSeconds, 60);
  const bad = completionEstimate({job: candidate, worker: {...node, running: [{remainingSeconds: null}]}, service});
  assert.equal(bad.completionSeconds, null);
});

test('exactly 30 seconds saving stays; larger saving moves with recorded estimates and margin', () => {
  const a = worker('a', {running: [{remainingSeconds: 30}]}), b = worker('b');
  const options = {job: job('candidate'), workers: [a, b], currentWorkerId: 'a', samples: [...speeds(a), ...speeds(b)], outputModel};
  let result = chooseRoute(options);
  assert.equal(result.action, 'stay'); assert.equal(result.savingSeconds, 30); assert.equal(result.marginSeconds, 30);
  a.running[0].remainingSeconds = 30.01; result = chooseRoute(options);
  assert.equal(result.action, 'move'); assert.equal(result.workerId, 'b');
  assert.ok(result.savingSeconds > 30);
  assert.equal(chooseRoute({...options, marginSeconds: 60}).action, 'stay');
  assert.throws(() => chooseRoute({...options, marginSeconds: -1}));
  assert.throws(() => chooseRoute({...options, marginSeconds: NaN}));
});

test('warm-cache advantage survives small load differences and gives way to a sufficiently faster completion', () => {
  const a = worker('a'), b = worker('b');
  const candidate = job('candidate', 1, {inputTokens: 100000, cache: {a: {identity: a.identity, reusableTokens: 90000, evidence: 'observed', qualified: true}}});
  const options = {job: candidate, workers: [a, b], currentWorkerId: 'a', samples: [...speeds(a), ...speeds(b)], outputModel};
  assert.equal(chooseRoute(options).action, 'stay');
  a.running = [{remainingSeconds: 150}];
  const result = chooseRoute(options); assert.equal(result.action, 'move'); assert.equal(result.savingSeconds, 60);
});

test('partial capacity is usable and lower priority work does not defeat a new high-priority candidate', () => {
  const a = worker('a', {running: [{remainingSeconds: 100}]}), b = worker('b', {capacity: 4,
    running: [{remainingSeconds: 100}], queue: [job('idle', 1, {priority: 'idle-only'})]});
  const result = chooseRoute({job: job('candidate', 2, {priority: 'high'}), workers: [a, b], currentWorkerId: 'a',
    samples: [...speeds(a), ...speeds(b)], outputModel});
  assert.equal(result.workerId, 'b');
  assert.equal(result.candidates[1].waitingSeconds, 0); assert.equal(result.candidates[1].service.concurrency, 2);
});

test('four close arrivals see earlier bookings immediately without mutating source snapshots', () => {
  const a = worker('a'), b = worker('b');
  const options = freeze({jobs: [1, 2, 3, 4].map(n => ({job: job(`r${n}`, n)})), workers: [a, b],
    samples: [...speeds(a), ...speeds(b)], outputModel});
  const result = planArrivals(options);
  assert.deepEqual(result.decisions.map(decision => decision.workerId), ['a', 'b', 'a', 'b']);
  assert.deepEqual(result.workers.map(node => node.queue.length), [2, 2]);
  assert.equal(a.queue.length, 0); assert.equal(b.queue.length, 0);
  assert.equal(result.decisions[2].candidates.find(node => node.workerId === 'a').waitingSeconds, 10);
});

test('queued movement is previewed once and cannot move dispatched or cancelled work', () => {
  const candidate = job('candidate'), a = worker('a', {running: [{remainingSeconds: 100}], queue: [candidate]}), b = worker('b');
  const options = {workers: [a, b], samples: [...speeds(a), ...speeds(b)], outputModel};
  const result = planArrivals({...options, jobs: [{job: candidate, currentWorkerId: 'a'}, {job: candidate, currentWorkerId: 'b'}]});
  assert.deepEqual(result.workers.map(node => node.queue.length), [0, 1]);
  for (const extra of [{dispatched: true}, {upstream: {}}, {cancelled: true}]) {
    const decision = chooseRoute({...options, job: {...candidate, ...extra}, currentWorkerId: 'a'});
    assert.equal(decision.action, 'unchanged'); assert.equal(decision.workerId, 'a');
  }
  a.running = [{id: candidate.id, remainingSeconds: 100}];
  const alreadyRunning = chooseRoute({...options, job: candidate, currentWorkerId: 'b'});
  assert.equal(alreadyRunning.action, 'unchanged'); assert.equal(alreadyRunning.workerId, 'a');
});

test('unknown timing preserves serving and eligibility is explicit rather than invented', () => {
  const a = worker('a'), b = worker('b'), candidate = job('candidate');
  let result = chooseRoute({job: candidate, workers: [b, a], outputModel});
  assert.equal(result.workerId, 'b'); assert.equal(result.reason, 'timing_unavailable_existing_order');
  result = chooseRoute({job: candidate, workers: [a, b], currentWorkerId: 'a', outputModel});
  assert.equal(result.action, 'stay'); assert.equal(result.reason, 'current_timing_unavailable');
  a.eligible = false; a.ineligibleReason = 'model_not_compatible';
  result = chooseRoute({job: candidate, workers: [a, b], currentWorkerId: 'a', outputModel});
  assert.equal(result.action, 'reassign'); assert.equal(result.candidates[0].reason, 'model_not_compatible');
  b.eligible = false;
  assert.equal(chooseRoute({job: candidate, workers: [a, b], outputModel}).workerId, null);
  assert.throws(() => chooseRoute({job: candidate, workers: [a, a]}));
});

test('unmodelled turn reservations and missing capacity stay unknown rather than assuming free slots', () => {
  for (const [extra, reason] of [[{capacity: undefined}, 'capacity_unavailable'],
    [{turnReservations: [{key: 'held'}]}, 'turn_reservations_not_normalized'],
    [{running: undefined}, 'worker_activity_unavailable'],
    [{running: [{remainingSeconds: 1}, {remainingSeconds: 1}]}, 'capacity_mismatch']]) {
    const result = completionEstimate({job: job('candidate'), worker: worker('a', extra), service});
    assert.equal(result.reason, reason); assert.equal(result.completionSeconds, null);
  }
});

test('each arrival reuses caller eligibility so a fast worker cannot bypass model or ownership restrictions', () => {
  const a = worker('a'), b = worker('b');
  const result = planArrivals({workers: [a, b], jobs: [
    {job: job('only-b', 1, {allowed: 'b'})}, {job: job('only-a', 2, {allowed: 'a'})}],
    samples: [...speeds(a), ...speeds(b)], outputModel,
    eligibility: (candidate, node) => ({eligible: candidate.allowed === node.id, reason: 'existing_eligibility_rule'})});
  assert.deepEqual(result.decisions.map(row => row.workerId), ['b', 'a']);
  assert.equal(result.decisions[0].candidates[0].reason, 'existing_eligibility_rule');
  assert.equal(result.decisions[1].candidates[1].eligible, false);
});

test('prediction honors continuation grace, priority override and exhausted turns',()=>{
 const allocation={slot:0,key:'A',priority:'normal',used:1,until:2};
 const base=worker('a',{conversationTurns:3,turnIdleSeconds:2,turnReservations:[allocation]});
 assert.equal(completionEstimate({job:job('B',2,{key:'B'}),worker:base,service}).waitingSeconds,2);
 assert.equal(completionEstimate({job:job('B',2,{key:'B',priority:'high'}),worker:base,service}).waitingSeconds,0);
 const queued={...base,queue:[job('A2',1,{key:'A'})]};
 assert.equal(completionEstimate({job:job('B',2,{key:'B'}),worker:queued,service}).waitingSeconds,32);
 const exhausted={...queued,turnReservations:[{...allocation,used:3,until:0}]};
 assert.equal(completionEstimate({job:job('B',2,{key:'B'}),worker:exhausted,service}).waitingSeconds,0);
});

test('prediction retains slot identity and one reservation for a running conversation',()=>{
 const node=worker('a',{capacity:2,conversationTurns:3,turnIdleSeconds:2,
   running:[{id:'running-A',key:'A',slotIndex:1,remainingSeconds:20}],
   turnReservations:[{slot:1,key:'A',priority:'normal',used:1,until:0}],queue:[job('A2',1,{key:'A'})]});
 const b=completionEstimate({job:job('B',2,{key:'B'}),worker:node,service});assert.equal(b.waitingSeconds,0);assert.equal(b.bookings[0].slot,0);
 const a=completionEstimate({job:job('A3',3,{key:'A'}),worker:node,service});assert.equal(a.waitingSeconds,50);assert.deepEqual(a.bookings.map(b=>b.slot),[1,1]);
});
