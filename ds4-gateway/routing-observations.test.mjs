import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RoutingObservations, routingRequestMetadata, routingIdentity} from './routing-observations.mjs';
import {routingObservationText} from './ui/routing-observation.js';

const worker = {id:'m3',identity:'build1',model:'glm',workRevision:1};
const job = {id:'request-1',sequence:1,priority:'normal',routingInput:routingRequestMetadata({messages:[{role:'user',content:'PRIVATE text'}]},'/v1/chat/completions')};
const native = (at, tokens, extra={}) => ({connected:true,source:'omlx',at,activity_at:at,requests:10,running:1,waiting:0,
  request_rows:[{id:job.id,model:'glm',phase:'decode',generatedTokens:tokens}],...extra});
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'routing-observer-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return path.join(dir,'routing.json');
}
function complete(monitor, tokens=100, extra={}) {
  monitor.complete({job,worker,usage:{prompt_tokens:10,completion_tokens:tokens},outcome:'complete',finishReason:'stop',...extra});
}

test('request metadata keeps hashes and estimated text length, with no invented multimodal tokens',()=>{
  assert.equal(job.routingInput.inputEvidence,'estimated_bytes');
  assert.ok(!JSON.stringify(job.routingInput).includes('PRIVATE'));
  assert.equal(routingRequestMetadata({messages:[{content:[{type:'image_url',image_url:'PRIVATE'}]}]},'/v1/chat/completions').inputTokens,null);
  assert.equal(routingRequestMetadata({prompt:'x',max_tokens:10,max_completion_tokens:20},'/v1/completions').outputLimit,null);
  assert.equal(routingRequestMetadata({prompt:'x',max_tokens:10},'/v1/completions').outputLimit,10);
  assert.equal(routingRequestMetadata({},'/v1/models'),null);
  assert.notEqual(routingIdentity({id:'a',url:'one'},'glm'),routingIdentity({id:'a',url:'two'},'glm'));
});

test('disabled observer creates no files or history',async t=>{
  const filename=fixture(t),monitor=new RoutingObservations({filename});
  complete(monitor);monitor.observeNative(worker,native(1000,20),[job]);await monitor.close();
  assert.equal(monitor.snapshot().mode,'off');assert.equal(monitor.outputs.length,0);assert.equal(fs.existsSync(filename),false);
});

test('numeric history survives restart while unverified saved speeds stay dormant',async t=>{
  const filename=fixture(t);let now=1000;
  const monitor=new RoutingObservations({filename,enabled:true,now:()=>now});
  for(const tokens of [100,120,200,300,150])complete(monitor,tokens);
  complete(monitor,1000,{finishReason:'length'});
  monitor.observeNative(worker,native(now,10),[job]);now=3000;monitor.observeNative(worker,native(now,50),[job]);
  assert.equal(monitor.samples[0].tokens/monitor.samples[0].seconds,20);
  assert.equal(monitor.snapshot().fit.sampleCount,5);await monitor.close();
  const saved=fs.readFileSync(filename,'utf8');assert.doesNotMatch(saved,/PRIVATE|messages|template/);
  assert.equal(fs.statSync(filename).mode&0o777,0o600);
  const next=new RoutingObservations({filename,enabled:true,now:()=>now});
  assert.equal(next.snapshot().fit.sampleCount,5);assert.equal(next.snapshot().speedSamples,0);
  next.observeNative(worker,native(now,70),[job]);assert.equal(next.snapshot().speedSamples,0);
  assert.equal(next.snapshot().unverifiedSavedSpeedSamples,1);await next.close();
});

test('malformed saved state is preserved and storage failures cannot escape into inference',async t=>{
  const filename=fixture(t);fs.writeFileSync(filename,'broken original');
  const monitor=new RoutingObservations({filename,enabled:true});complete(monitor);await monitor.close();
  assert.equal(fs.readFileSync(filename,'utf8'),'broken original');assert.match(monitor.snapshot().storageError,/preserved/);
  const blocked=new RoutingObservations({filename:path.join(filename,'child'),enabled:true});
  complete(blocked);await blocked.close();assert.match(blocked.snapshot().storageError,/could not be saved/);
  const active=new RoutingObservations({enabled:true});assert.doesNotThrow(()=>active.attempt(()=>{throw Error('fail');}));
  assert.equal(active.snapshot().errors,1);
});

test('speed intervals reject waiting, membership churn, missing counts, stale and aggregate evidence',()=>{
  const cases=[
    {value:{waiting:1}}, {value:{requests:11}}, {value:{requests:undefined}},
    {value:{running:2}}, {value:{activity_at:1000}}, {value:{request_rows:undefined}},
    {value:{request_rows:[{id:'unknown',model:'glm',phase:'decode',generatedTokens:60}]}},
    {value:{request_rows:[{id:job.id,model:'new-model',phase:'decode',generatedTokens:60}]}},
    {worker:{workRevision:2}}, {value:{uptime_seconds:1},before:{uptime_seconds:100}},
    {value:{source:'new-engine'}}, {value:{connected:false}}, {now:8000},
  ];
  for(const scenario of cases){
    let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
    monitor.observeNative(worker,native(now,10,scenario.before),[job]);now=scenario.now??3000;
    monitor.observeNative({...worker,...scenario.worker},native(now,50,scenario.value),[job]);
    assert.equal(monitor.samples.length,0,JSON.stringify(scenario));
  }
});

test('stable concurrent per-request intervals yield individual speeds, not aggregate throughput',()=>{
  let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
  const jobs=[job,{...job,id:'request-2'}];
  const sample=n=>native(now,0,{running:2,request_rows:jobs.map((j,i)=>({id:j.id,model:'glm',phase:'prefill',computedTokens:n*(i+1),totalTokens:1000}))});
  monitor.observeNative(worker,sample(10),jobs);now=3000;monitor.observeNative(worker,sample(110),jobs);
  assert.deepEqual(monitor.samples.map(row=>[row.tokens/row.seconds,row.concurrency]),[[50,2],[100,2]]);
  now=4000;monitor.observeNative(worker,native(now,60,{uptime_seconds:1,requests:0}),[job]);
  assert.equal(monitor.samples.length,0);assert.equal(monitor.snapshot().unverifiedSavedSpeedSamples,2);
});

test('cache reuse is estimated, same-template only, short lived, and never saved as verified',()=>{
  let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});complete(monitor);
  const request=monitor.request(job,[worker]);assert.equal(request.cache.m3.evidence,'estimated');
  assert.equal(request.cache.m3.reusableTokens,10);
  assert.deepEqual(monitor.request({...job,routingInput:{...job.routingInput,template:'other'}},[worker]).cache,{});
  now+=300001;assert.deepEqual(monitor.request(job,[worker]).cache,{});
});

test('passive decisions preserve real jobs and distinguish unknown information from a recommendation',()=>{
  const monitor=new RoutingObservations({enabled:true,now:()=>1000});
  for(const tokens of [100,120,200,300,150])complete(monitor,tokens);
  const workers=[{...worker,capacity:1,running:[],queue:[job],turnReservations:[]},
    {...worker,id:'spark',identity:'spark-build',capacity:1,running:[],queue:[],turnReservations:[]}];
  for(const w of workers)for(const phase of ['prefill','decode'])monitor.samples.push({workerId:w.id,identity:w.identity,model:w.model,
    requestId:'measured',phase,tokens:w.id==='spark'?1000:1,seconds:1,concurrency:1,scope:'request',waitExcluded:true,concurrencyStable:true});
  const before=structuredClone(workers);
  const result=monitor.evaluate({job,workers,currentWorkerId:'m3',marginSeconds:30,eligibility:()=>({eligible:true})});
  assert.equal(result.action,'move');assert.equal(result.destination,'spark');assert.match(routingObservationText(result),/Observation only: would move/);
  assert.deepEqual(workers,before);assert.equal(monitor.snapshot().errors,0);
  workers[0].running=[{...job,id:'running'}];
  const unknown=monitor.evaluate({job,workers,currentWorkerId:'m3',marginSeconds:30,eligibility:()=>({eligible:true})});
  assert.equal(unknown.reason,'current_timing_unavailable');assert.match(routingObservationText(unknown),/comparison unavailable/);
});

test('unmatched native waiting work cannot look like a free engine',()=>{
 const monitor=new RoutingObservations({enabled:true,now:()=>1000});
 const workers=[{...worker,capacity:4,running:[],queue:[job],native:native(1000,0,{running:0,waiting:1,request_rows:[]})}];
 const result=monitor.evaluate({job,workers,currentWorkerId:'m3',marginSeconds:30,eligibility:()=>({eligible:true})});
 assert.equal(result.reason,'current_timing_unavailable');assert.equal(result.candidates[0].reason,'running_progress_unavailable');
});

test('missing native progress uses the dispatch estimate without recursively slowing older work',()=>{
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 for(const tokens of [100,120,200,300,150])complete(monitor,tokens);
 for(const phase of ['prefill','decode'])monitor.samples.push({workerId:worker.id,identity:worker.identity,model:worker.model,requestId:'rate',phase,tokens:phase==='prefill'?1000:100,seconds:1,concurrency:1,scope:'request',waitExcluded:true,concurrencyStable:true});
 const active={...job,id:'active',dispatched:1000};monitor.started({job:active,worker,fleet:[worker],concurrency:1});
 const initial=structuredClone(active.routingProgressBasis);now=1200;
 monitor.started({job:active,worker,fleet:[worker],concurrency:4});assert.deepEqual(active.routingProgressBasis,initial);
 const workers=[{...worker,capacity:2,queue:[job],running:[active]}];
 const result=monitor.evaluate({job,workers,currentWorkerId:'m3',marginSeconds:30,eligibility:()=>({eligible:true})});
 assert.equal(result.candidates[0].waitingSeconds,0);assert.ok(Number.isFinite(result.candidates[0].completionSeconds));
 assert.equal(monitor.samples.length,2,'inferred progress never enters measured speed history');
});

test('active routing receipts are distinct from passive recommendations and failed persistence',()=>{
 assert.match(routingObservationText({mode:'active',applied:true,action:'move',destination:'spark',savingSeconds:45,marginSeconds:30}),/^Moved to spark/);
 assert.match(routingObservationText({mode:'active',applied:true,action:'stay',reason:'ownership_write_failed'}),/^Stayed: saving/);
 assert.equal(routingObservationText({mode:'active',applied:false,action:'move'}),'');
});

const serialNative=(at,extra={})=>({connected:true,source:'vllm',at,model_ids:['glm'],metrics_epoch:1,
 running:0,waiting:0,requests:10,decode_count:10,prefill_count:10,computed_count:10,
 decode_tokens:1000,decode_seconds:50,prefill_tokens:10000,prefill_seconds:10,...extra});
function serialRun(change=()=>{},end={}){
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 monitor.observeNative(worker,serialNative(now),[]);
 const running={...job,dispatched:1001};now=1001;
 monitor.started({job:running,worker,fleet:[worker],concurrency:1});
 change({monitor,running,setNow:value=>now=value});
 monitor.complete({job:running,worker,usage:{prompt_tokens:2000,completion_tokens:100},outcome:'complete',finishReason:'stop'});
 now=4000;monitor.observeNative(worker,serialNative(now,{requests:11,decode_count:11,prefill_count:11,computed_count:11,
 decode_tokens:1100,decode_seconds:55,prefill_tokens:11000,prefill_seconds:12,...end}),[]);
 return monitor;
}
test('vLLM singleton completion attributes native phase time and uncached tokens to its gateway request',()=>{
 const monitor=serialRun();assert.equal(monitor.samples.length,2);
 assert.deepEqual(monitor.samples.map(row=>[row.phase,row.tokens/row.seconds,row.concurrency]),[['prefill',500,1],['decode',20,1]]);
 assert.ok(monitor.samples.every(row=>row.requestId===job.id&&row.waitExcluded));
 monitor.observeNative(worker,serialNative(4000),[]);assert.equal(monitor.samples.length,0); // counter reset retires history
});
test('vLLM singleton attribution rejects extra completions, missing timing and unmatched output usage',()=>{
 for(const end of [{requests:12},{decode_count:12},{prefill_count:null},{decode_tokens:1101},{model_ids:['new-model']},{metrics_epoch:2}])
  assert.equal(serialRun(()=>{},end).samples.length,0,JSON.stringify(end));
});
test('vLLM singleton attribution rejects overlapping dispatch, native concurrency and waiting work',()=>{
 for(const change of [
  ({monitor,running})=>monitor.started({job:{...running,id:'other'},worker,fleet:[worker],concurrency:2}),
  ({monitor,running,setNow})=>{setNow(2000);monitor.observeNative(worker,serialNative(2000,{running:2}),[running]);},
  ({monitor,running,setNow})=>{setNow(2000);monitor.observeNative(worker,serialNative(2000,{running:1,waiting:1}),[running]);},
  ({monitor,running,setNow})=>{setNow(2000);monitor.observeNative(worker,{connected:false,at:2000},[running]);}
 ])assert.equal(serialRun(change).samples.length,0);
});
test('duplicate metadata notification does not invalidate one dispatched singleton',()=>{
 const monitor=serialRun(({monitor,running})=>monitor.started({job:running,worker,fleet:[worker],concurrency:1}));
 assert.equal(monitor.samples.length,2);
});
// The engine-histogram path is the only one that yields measurements on a vLLM
// lane that is never fully idle. It reads cumulative per-request phase counters,
// so concurrency is the observed executing count and a delta must carry work.
const engineNative=(at,extra={})=>({connected:true,source:'vllm',at,model_ids:['glm'],metrics_epoch:1,
 running:1,waiting:0,requests:10,decode_count:10,prefill_count:10,computed_count:10,
 decode_tokens:1000,decode_seconds:50,prefill_tokens:10000,prefill_seconds:10,...extra});
test('engine phase deltas yield per-request prefill and decode rates at observed concurrency',()=>{
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 monitor.observeNative(worker,engineNative(now,{running:3}),[]);
 now=5000;monitor.observeNative(worker,engineNative(now,{requests:12,decode_count:12,prefill_count:12,computed_count:12,
   decode_tokens:1400,decode_seconds:70,prefill_tokens:14000,prefill_seconds:14,running:3}),[]);
 assert.equal(monitor.samples.length,2);
 // Two completed requests each: 4000 prefill tokens over 4s, 400 decode tokens over 20s.
 assert.deepEqual(monitor.samples.map(row=>[row.phase,row.tokens,row.seconds,row.concurrency]),
   [['prefill',2000,2,3],['decode',200,10,3]]);
 assert.ok(monitor.samples.every(row=>row.waitExcluded&&row.concurrencyStable&&row.scope==='request'));
});
test('engine phase deltas stay silent without completed work, timing or a stable executing count',()=>{
 for(const end of [
   {requests:10,decode_count:10,prefill_count:10},                       // no completions
   {requests:12,decode_count:12,prefill_count:12,decode_seconds:50,prefill_seconds:10}, // no time moved
   {requests:12,decode_count:12,prefill_count:12,decode_tokens:1000,prefill_tokens:10000}, // no tokens moved
   {requests:12,decode_count:12,prefill_count:12,decode_tokens:1400,decode_seconds:70,prefill_tokens:14000,prefill_seconds:14,running:0}, // engine idle
   {requests:12,decode_count:12,prefill_count:12,decode_tokens:1400,decode_seconds:70,prefill_tokens:14000,prefill_seconds:14,metrics_epoch:2} // identity change
 ]){
  let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
  monitor.observeNative(worker,engineNative(now),[]);
  now=5000;monitor.observeNative(worker,engineNative(now,end),[]);
  assert.equal(monitor.samples.length,0,JSON.stringify(end));
 }
});
test('a changing executing count still yields a measurement, labelled as not constant-concurrency',()=>{
 // Requiring an unchanged count across the interval discarded nearly every real
 // window. The rate is still a genuine engine measurement; it is bucketed at the
 // observed mean and flagged so a consumer can decline to treat it as constant.
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 monitor.observeNative(worker,engineNative(now,{running:1}),[]);
 now=5000;monitor.observeNative(worker,engineNative(now,{requests:12,decode_count:12,prefill_count:12,
   decode_tokens:1400,decode_seconds:70,prefill_tokens:14000,prefill_seconds:14,running:4}),[]);
 assert.equal(monitor.samples.length,2);
 assert.deepEqual(monitor.samples.map(row=>row.concurrency),[3,3]);
 assert.ok(monitor.samples.every(row=>row.concurrencyStable===false));
});
test('an over-long poll gap does not become an engine phase sample',()=>{
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 monitor.observeNative(worker,engineNative(now),[]);
 now=60000;monitor.observeNative(worker,engineNative(now,{requests:12,decode_count:12,prefill_count:12,
   decode_tokens:1400,decode_seconds:70,prefill_tokens:14000,prefill_seconds:14}),[]);
 assert.equal(monitor.samples.length,0);
});
test('the UI speed summary reports measured work per phase and never counts parked history',()=>{
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 monitor.observeNative(worker,engineNative(now,{running:3}),[]);
 now=5000;monitor.observeNative(worker,engineNative(now,{requests:12,decode_count:12,prefill_count:12,
   decode_tokens:1400,decode_seconds:70,prefill_tokens:14000,prefill_seconds:14,running:3}),[]);
 const speed=monitor.snapshot().speed;
 const prefill=speed.find(row=>row.phase==='prefill'),decode=speed.find(row=>row.phase==='decode');
 // 4000 prefill tokens over 4s = 1000 t/s; 400 decode over 20s = 20 t/s.
 assert.deepEqual([prefill.workerId,prefill.tokensPerSecond,prefill.samples,prefill.engineAggregate,prefill.cleanWindow],
   ['m3',1000,1,1,0]);
 assert.deepEqual([decode.tokensPerSecond,decode.concurrency],[20,[{value:3,count:1}]]);
 // A parked row is not evidence the estimator uses, so it must not appear here.
 const parked=new RoutingObservations({enabled:true,now:()=>now});
 parked.samples=[];parked.restoredSamples=[{workerId:'m3',phase:'decode',tokens:999,seconds:1,concurrency:1,engineAggregate:true}];
 assert.deepEqual(parked.snapshot().speed,[]);
});
test('a lane holding a preparing request is still measurable',()=>{
 // Regression: the preparing/waiting rows used to be filtered BEFORE the
 // engine-vs-gateway agreement check, so 2 running requests with 1 still
 // preparing read as 1 row against running=2 and the interval was discarded
 // every time. An oMLX lane could therefore never contribute a speed sample.
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 const other={...job,id:'other'};
 const rows=(tokens)=>({connected:true,source:'omlx',at:now,activity_at:now,requests:10,running:2,waiting:0,
   request_rows:[{id:job.id,model:'glm',phase:'decode',computedTokens:100,generatedTokens:tokens},
     {id:'other',model:'glm',phase:'preparing',computedTokens:0,generatedTokens:0}]});
 monitor.observeNative(worker,rows(20),[job,other]);
 now=3000;monitor.observeNative(worker,rows(60),[job,other]);
 assert.equal(monitor.samples.length,1);
 assert.deepEqual([monitor.samples[0].tokens,monitor.samples[0].concurrency],[40,2]);
 // A phase change between the two ends is still not attributable work.
 const changed=new RoutingObservations({enabled:true,now:()=>now});now=1000;
 changed.observeNative(worker,rows(20),[job,other]);
 now=3000;changed.observeNative(worker,{...rows(60),request_rows:[
   {id:job.id,model:'glm',phase:'preparing',computedTokens:0,generatedTokens:0},
   {id:'other',model:'glm',phase:'decode',computedTokens:100,generatedTokens:60}]},[job,other]);
 assert.equal(changed.samples.length,0);
});
test('an in-flight request whose engine row is not yet working still scores',()=>{
 // Regression: a row present in a non-work phase (waiting/preparing) used to
 // leave progress null, so EVERY running request on that lane scored
 // 'running_progress_unavailable' and the lane could not be timed at all —
 // a slower-but-measured lane then won placement against it.
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 for(const tokens of [100,120,200,300,150])complete(monitor,tokens);
 for(const phase of ['prefill','decode'])monitor.samples.push({workerId:worker.id,identity:worker.identity,model:worker.model,
   requestId:'rate',phase,tokens:phase==='prefill'?1000:100,seconds:1,concurrency:1,scope:'request',waitExcluded:true,concurrencyStable:true});
 const active={...structuredClone(job),id:'active',dispatched:1000};
 monitor.started({job:active,worker,fleet:[worker],concurrency:1});
 now=1200;
 const native={connected:true,source:'omlx',at:now,activity_at:now,requests:10,running:1,waiting:0,
   request_rows:[{id:'active',model:'glm',phase:'preparing',computedTokens:0,generatedTokens:0}]};
 // The lane's own running request must carry a finite remaining time; before the
 // fix it scored 'running_progress_unavailable' and the whole lane was untimed.
 const busy=monitor.evaluate({job,workers:[{...worker,capacity:1,running:[active],queue:[],turnReservations:[],native}],
   currentWorkerId:null,marginSeconds:30,eligibility:()=>({eligible:true})});
 assert.notEqual(busy.candidates[0].reason,'running_progress_unavailable');
 assert.ok(Number.isFinite(busy.candidates[0].completionSeconds));
});
test('a dispatch basis is recorded even when the lane has no per-concurrency measurement',()=>{
 // Regression: the basis was written only when a full estimate resolved, so a
 // lane with a measurement at another concurrency (or none) left its in-flight
 // requests with no basis — and therefore no progress — for their whole life.
 let now=1000;const monitor=new RoutingObservations({enabled:true,now:()=>now});
 for(const tokens of [100,120,200,300,150])complete(monitor,tokens);
 // A lane measured at a DIFFERENT concurrency than the one it is dispatched at,
 // which must fall back to the approved default guess rather than abstaining.
 for(const phase of ['prefill','decode'])monitor.samples.push({workerId:worker.id,identity:worker.identity,model:worker.model,
   requestId:'other-concurrency',phase,tokens:phase==='prefill'?1000:100,seconds:1,concurrency:4,scope:'request',waitExcluded:true,concurrencyStable:true});
 const active={...structuredClone(job),id:'active',dispatched:1000};
 monitor.started({job:active,worker,fleet:[worker],concurrency:1});
 const basis=active.routingProgressBasis;
 assert.ok(basis,'a basis is recorded at an unmeasured concurrency');
 assert.ok(basis.prefill>0&&basis.decode>0&&Number.isSafeInteger(basis.inputTokens));
 // The c=4 measurement extrapolated by the approved default guess: a lower
 // concurrency extrapolates UP (0.9^-3), and the row is labelled a guess.
 assert.ok(basis.prefill>1000&&basis.decode>100);
 assert.equal(basis.evidence,'estimated');
});
test('the reported decision mode is the live policy, not a fixed label',()=>{
 // Regression: the summary hardcoded 'observation_only' while the router ran in
 // 'active' mode, so the panel contradicted the live policy it was reporting.
 const monitor=new RoutingObservations({enabled:true,mode:'active',now:()=>1000});
 const workers=[{...worker,capacity:1,running:[],queue:[job],turnReservations:[]}];
 const result=monitor.evaluate({job,workers,currentWorkerId:null,marginSeconds:30,eligibility:()=>({eligible:true})});
 assert.equal(result.mode,'active');
 assert.equal(monitor.snapshot().last.mode,'active');
});
