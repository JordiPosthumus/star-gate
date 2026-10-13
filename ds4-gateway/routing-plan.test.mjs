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

test('explicit fast fallback covers new, reassigned, and existing slow homes with unknown input',()=>{
 const slow=worker('slow'),fast=worker('fast');
 for(const currentWorkerId of [null,'slow','removed']){
  const result=chooseRoute({job:job('candidate',1,{inputTokens:null}),workers:[slow,fast],currentWorkerId,
   samples:[...speeds(slow),...speeds(fast,4000,40)],outputModel,fastWorkerIds:['fast']});
  assert.equal(result.workerId,'fast');assert.equal(result.reason,'fast_lane_unknown_competitor');
  assert.ok(result.candidates.every(c=>c.completionSeconds===null));
 }
});

test('unknown fast work never hands a supported request to a timeable slow worker',()=>{
 const slow=worker('slow'),fast=worker('fast',{capacity:2,running:[{remainingSeconds:null}]});
 const options={job:job('candidate'),workers:[slow,fast],samples:[...speeds(slow),...speeds(fast)],outputModel,fastWorkerIds:['fast']};
 const result=chooseRoute(options);assert.equal(result.workerId,'fast');assert.equal(result.reason,'fast_lane_unknown_competitor');
 assert.ok(Number.isFinite(result.candidates[0].completionSeconds));
 assert.equal(chooseRoute({...options,currentWorkerId:'fast'}).reason,'mixed_evidence_keep_home');
 const overflow=chooseRoute({...options,workers:[slow,{...fast,eligible:false}]});
 assert.equal(overflow.workerId,'slow');assert.equal(overflow.reason,'overflow_no_fast_lane');
});

test('fast fallback ranks eligible normalized loads and cannot override same-session eligibility',()=>{
 const slow=worker('slow'),one=worker('one',{capacity:8,running:[{remainingSeconds:null}]}),two=worker('two',{capacity:2});
 const options={job:job('candidate',1,{inputTokens:null}),workers:[slow,one,two],fastWorkerIds:['one','two']};
 assert.equal(chooseRoute(options).workerId,'two');
 const result=chooseRoute({...options,eligibility:(_j,w)=>({eligible:w.id==='slow',reason:'same_session_work'})});
 assert.equal(result.workerId,'slow');assert.equal(result.reason,'overflow_no_fast_lane');
});

test('valid cache-aware timing and the switching margin survive the fast fallback policy',()=>{
 const slow=worker('slow'),fast=worker('fast');
 const options={job:job('candidate',1,{inputTokens:250000,cache:{slow:{identity:slow.identity,evidence:'estimated',reusableTokens:249500}}}),
  workers:[slow,fast],currentWorkerId:'slow',samples:[...speeds(slow,1000,25),...speeds(fast,4000,100)],outputModel,fastWorkerIds:['fast'],marginSeconds:30};
 assert.equal(chooseRoute(options).reason,'saving_does_not_exceed_margin');
 const cold=chooseRoute({...options,job:{...options.job,cache:{}}});
 assert.equal(cold.workerId,'fast');assert.equal(cold.reason,'saving_exceeds_margin');
 assert.ok(cold.savingSeconds>30);
});

test('waiting home yields to a ready eligible peer despite old preferred IDs or missing timing',()=>{
 for(const fastWorkerIds of [['retired'],['home','peer'],[]]){
  const home=worker('home',{capacity:2,canStartRequest:false,running:[{remainingSeconds:null},{remainingSeconds:null}]}),peer=worker('peer',{capacity:2,canStartRequest:true});
  const result=chooseRoute({job:job('candidate'),workers:[home,peer],currentWorkerId:'home',fastWorkerIds});
  assert.equal(result.workerId,'peer');assert.equal(result.reason,'available_capacity_fallback');
 }
});
test('a missing home forecast alone cannot hold independent work on a busy home while a peer idles',()=>{
 const busy=()=>worker('busy',{capacity:2,running:[{remainingSeconds:null}],queue:[job('candidate')]});
 const idle=()=>worker('idle',{capacity:2,canStartRequest:true});
 const moved=chooseRoute({job:job('candidate'),workers:[busy(),idle()],currentWorkerId:'busy'});
 assert.equal(moved.action,'reassign');assert.equal(moved.workerId,'idle');
 assert.equal(moved.reason,'idle_lane_home_timing_unavailable');
 const timedPeer=chooseRoute({job:job('candidate'),workers:[busy(),idle()],currentWorkerId:'busy',samples:speeds(idle()),outputModel});
 assert.equal(timedPeer.workerId,'idle');assert.equal(timedPeer.reason,'idle_lane_home_timing_unavailable');
 const placed=chooseRoute({job:job('candidate'),workers:[busy(),idle()]});
 assert.equal(placed.action,'place');assert.equal(placed.workerId,'idle');
 const pinned=chooseRoute({job:job('candidate'),workers:[busy(),idle()],currentWorkerId:'busy',fastWorkerIds:['busy','idle']});
 assert.equal(pinned.workerId,'idle');assert.equal(pinned.reason,'idle_lane_home_timing_unavailable');
});
test('the idle-peer rescue is scoped to the configured pool',()=>{
 const busy=worker('busy',{capacity:2,canStartRequest:true,running:[{remainingSeconds:null}],queue:[job('candidate')]});
 const outsider=worker('outsider',{capacity:2,canStartRequest:true});
 const result=chooseRoute({job:job('candidate'),workers:[busy,outsider],currentWorkerId:'busy',fastWorkerIds:['busy']});
 assert.equal(result.action,'stay');assert.equal(result.workerId,'busy');
 assert.equal(result.reason,'mixed_evidence_keep_home');
});
test('same-session confinement and cache warmth keep the home with explicit reasons',()=>{
 const busy=worker('busy',{capacity:2,canStartRequest:true,running:[{remainingSeconds:null,key:'sess'}]});
 const idle=worker('idle',{capacity:2,canStartRequest:true});
 const confined=chooseRoute({job:job('turn2',2,{key:'sess'}),workers:[busy,idle],currentWorkerId:'busy',
  eligibility:(_job,w)=>({eligible:w.id==='busy',reason:w.id==='busy'?null:'same_session_work'})});
 assert.equal(confined.action,'stay');assert.equal(confined.workerId,'busy');
 assert.equal(confined.reason,'same_session_keep_home');
 const warm=chooseRoute({job:job('candidate'),workers:[busy,idle],currentWorkerId:'busy',homeIsWarmCache:true});
 assert.equal(warm.action,'stay');assert.equal(warm.reason,'cache_affinity_keep_home');
 const stranded=chooseRoute({job:job('candidate'),workers:[busy,worker('peer',{capacity:2,canStartRequest:true,running:[{remainingSeconds:null}]})],currentWorkerId:'busy'});
 assert.equal(stranded.action,'stay');assert.equal(stranded.reason,'current_timing_unavailable');
});
test('a warm home that cannot start still yields to a ready peer despite missing timing',()=>{
 const full=worker('busy',{capacity:1,canStartRequest:false,running:[{remainingSeconds:null}]});
 const idle=worker('idle',{capacity:2,canStartRequest:true});
 const result=chooseRoute({job:job('candidate'),workers:[full,idle],currentWorkerId:'busy',homeIsWarmCache:true});
 assert.equal(result.workerId,'idle');assert.equal(result.reason,'available_capacity_fallback');
});
test('old preferred IDs never override a complete finish-time comparison',()=>{
 const home=worker('home',{running:[{remainingSeconds:120}]}),peer=worker('peer');
 const result=chooseRoute({job:job('candidate'),workers:[home,peer],currentWorkerId:'home',fastWorkerIds:['retired'],samples:[...speeds(home),...speeds(peer)],outputModel});
 assert.equal(result.workerId,'peer');assert.equal(result.reason,'saving_exceeds_margin');
});
test('capacity fallback preserves immediately usable homes and rejects unavailable destinations',()=>{
 // Without an idle ready peer, an untimeable home that can start is still kept.
 for(const [homeReady,peerReady,peerEligible] of [[false,false,true],[false,true,false]]){
  const home=worker('home',{canStartRequest:homeReady,running:[{remainingSeconds:null}]}),peer=worker('peer',{canStartRequest:peerReady,eligible:peerEligible});
  assert.equal(chooseRoute({job:job('candidate'),workers:[home,peer],currentWorkerId:'home',fastWorkerIds:['home','peer']}).workerId,'home');
 }
});
