import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {once} from 'node:events';
import {setImmediate} from 'node:timers/promises';
import {createDashboard} from './dashboard.mjs';
import {FleetSpeedReader} from './fleet-speed.mjs';
import {RatePeaks} from './rate-peaks.mjs';

test('status compression preserves the full payload and respects gzip refusal',async t=>{
 const value={time:1,devices:[{history:'repeated observation '.repeat(1000)}]};
 const server=createDashboard(()=>value);server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const route of ['/api/status','/api/diagnostics']){
  const compressed=await fetch(base+route,{headers:{'accept-encoding':'gzip'}});
  assert.equal(compressed.headers.get('content-encoding'),'gzip');assert.equal(compressed.headers.get('vary'),'Accept-Encoding');
  assert.ok(Number(compressed.headers.get('content-length'))<JSON.stringify(value).length/4);assert.deepEqual(await compressed.json(),value);
  const plain=await fetch(base+route,{headers:{'accept-encoding':'gzip;q=0, identity'}});
  assert.equal(plain.headers.get('content-encoding'),null);assert.deepEqual(await plain.json(),value);
 }
});

for(const Reader of [FleetSpeedReader,RatePeaks])test(`${Reader.name} skips unchanged file reads but detects append and replacement`,t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-metric-reader-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'metrics-2026-01-01.jsonl');
 const line=JSON.stringify({node:'fixture',kind:'decode',tps:20,time:100})+'\n';fs.writeFileSync(file,line);
 const reader=new Reader(directory);let opens=0;const original=fs.openSync;
 t.mock.method(fs,'openSync',(target,...args)=>{if(target===file)opens++;return original(target,...args);});
 reader.poll();const first=opens;assert.ok(first>0);
 reader.poll();reader.poll();assert.equal(opens,first);
 fs.appendFileSync(file,line);reader.poll();assert.ok(opens>first);const appended=opens;
 fs.renameSync(file,file+'.old');fs.writeFileSync(file,line);reader.poll();reader.poll();assert.ok(opens>appended);
});

for(const [script,view] of [['current-jobs.js','view-activity'],['hourglass.js','view-analytics']])test(`${script} fetches only while its panel is visible`,async()=>{
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,contains:()=>false});return nodes.get(id);};
 get(view).hidden=true;const observers=[],events=new Map(),timers=[];let calls=0;
 const document={hidden:false,activeElement:null,getElementById:get,addEventListener:(name,callback)=>events.set(name,callback)};
 const context=vm.createContext({document,AbortSignal,setInterval:callback=>timers.push(callback),MutationObserver:class{constructor(callback){observers.push(callback);}observe(){}},fetch:async()=>{calls++;return {ok:true,json:async()=>({configured:false,available:false})};}});
 vm.runInContext(fs.readFileSync(new URL('./ui/'+script,import.meta.url),'utf8'),context);
 timers.forEach(callback=>callback());await setImmediate();assert.equal(calls,0);
 get(view).hidden=false;observers.forEach(callback=>callback());await setImmediate();assert.equal(calls,1);
 document.hidden=true;timers.forEach(callback=>callback());await setImmediate();assert.equal(calls,1);
 document.hidden=false;events.get('visibilitychange')();await setImmediate();assert.equal(calls,2);
 get(view).hidden=true;timers.forEach(callback=>callback());await setImmediate();assert.equal(calls,2);
});

const dashboardSource=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8');
const functionSlice=(start,end)=>dashboardSource.slice(dashboardSource.indexOf(start),dashboardSource.indexOf(end,dashboardSource.indexOf(start)));
for(const [name,next,busy,render] of [
 ['loadTesting','toggleTesting','testingBusy','renderTesting'],
 ['loadLanSharing','toggleLanSharing','lanSharingBusy','renderLanSharing'],
])test(`${name} reads only visible Settings and preserves explicit controls`,async()=>{
 const settings={hidden:true},document={hidden:false};let calls=0;
 const context=vm.createContext({document,$:()=>settings,AbortSignal,[busy]:false,[render]:()=>{},fetch:async()=>{calls++;return {ok:true,json:async()=>({})};}});
 vm.runInContext(functionSlice(`async function ${name}(){`,`async function ${next}(){`),context);
 await vm.runInContext(`${name}()`,context);assert.equal(calls,0);
 settings.hidden=false;await vm.runInContext(`${name}()`,context);assert.equal(calls,1);
 document.hidden=true;await vm.runInContext(`${name}()`,context);assert.equal(calls,1);
 document.hidden=false;context[busy]=true;await vm.runInContext(`${name}()`,context);assert.equal(calls,1);
 context[busy]=false;await vm.runInContext(`${name}()`,context);assert.equal(calls,2);
});
test('media summaries follow visible Fleet/Media or known active work; hidden browser does not poll',async()=>{
 const nodes={'view-fleet':{hidden:true},'view-media':{hidden:true}},document={hidden:false};let calls=0,reply={workloads:[],native_engines:[]},fail=false;
 const context=vm.createContext({document,$:id=>nodes[id],AbortSignal,fleetWorkloads:{workloads:[]},fleetWorkloadsUnavailable:false,fetch:async()=>{calls++;if(fail)throw Error();return {ok:true,json:async()=>reply};}});
 vm.runInContext(functionSlice('async function loadFleetWorkloads(){','async function poll() {'),context);
 const run=()=>vm.runInContext('loadFleetWorkloads()',context);
 await run();assert.equal(calls,0);
 nodes['view-fleet'].hidden=false;await run();assert.equal(calls,1);
 nodes['view-fleet'].hidden=true;nodes['view-media'].hidden=false;await run();assert.equal(calls,2);
 nodes['view-media'].hidden=true;context.fleetWorkloads={workloads:[{phase:'restoring'}]};await run();assert.equal(calls,3);
 await run();assert.equal(calls,3,'returned work stops background reads');
 context.fleetWorkloads={native_engines:[{state:'busy'}]};await run();assert.equal(calls,4);
 document.hidden=true;nodes['view-fleet'].hidden=false;await run();assert.equal(calls,4);
 document.hidden=false;fail=true;const old=context.fleetWorkloads;await run();assert.equal(context.fleetWorkloads,old);assert.equal(context.fleetWorkloadsUnavailable,true);
});
