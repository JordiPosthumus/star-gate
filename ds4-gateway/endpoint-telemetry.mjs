import {endpointHeaders} from './endpoint.mjs';

const finite=value=>Number.isFinite(value)&&value>=0?value:null;
const POLL_MS=2000,RETRY_MS=15000,HISTORY_MS=900000;
const workerKey=worker=>JSON.stringify([worker.id,worker.url,worker.api_key_file??null]);
class UnsupportedMetrics extends Error {}
class MetricsHttpError extends Error {
  constructor(status){super('Endpoint metrics unavailable');this.status=status;}
}
const canRediscover=error=>error instanceof UnsupportedMetrics||[404,405,415].includes(error.status);
const validInterval=(now,previous)=>previous&&previous.connected!==false&&now>previous.at&&now-previous.at<=30000;
// An absent epoch on either side is not evidence of a change: many builds never
// export generation_tokens_created, so requiring one would disable the counter
// identity on exactly the engines that most need it. Only two differing,
// present epochs count as a restart.
const epochUnchanged=(previous,epoch)=>epoch===null||previous.metrics_epoch===null||previous.metrics_epoch===undefined||epoch===previous.metrics_epoch;
const delta=(value,old)=>finite(value)!==null&&finite(old)!==null&&value>=old?value-old:null;

export function prometheusValues(text){
  const result={};
  for(const line of text.split('\n')){
    const match=line.match(/^((?:vllm|tensorfold|tensorfold_health):[\w]+)(?:\{.*\})?\s+([\d.eE+\-]+)(?:\s|$)/);
    if(!match)continue;
    const value=finite(Number(match[2]));
    if(value!==null)result[match[1]]=(result[match[1]]??0)+value;
  }
  return result;
}

export function vllmSnapshot(text,now,previous){
  const values=prometheusValues(text),get=name=>finite(values['vllm:'+name]);
  if(get('generation_tokens_total')===null||get('num_requests_running')===null)throw new UnsupportedMetrics();
  const generated=get('generation_tokens_total'),seconds=previous?(now-previous.at)/1000:0;
  let computed=null;
  for(const line of text.split('\n')){
    if(!/^vllm:prompt_tokens_by_source_total\{/.test(line)||!line.includes('source="local_compute"'))continue;
    const match=line.match(/\}\s+([\d.eE+\-]+)/),value=match?finite(Number(match[1])):null;
    if(value!==null)computed=(computed??0)+value;
  }
  if(computed===null&&get('prompt_tokens_total')!==null&&get('prompt_tokens_cached_total')!==null)
    computed=Math.max(0,get('prompt_tokens_total')-get('prompt_tokens_cached_total'));
  const generationDelta=delta(generated,previous?.generated);
  const epoch=get('generation_tokens_created');
  const sampleValid=validInterval(now,previous)&&generationDelta!==null&&epochUnchanged(previous,epoch);
  const prefillDelta=sampleValid?delta(computed,previous?.computed):null;
  const running=get('num_requests_running'),requests=get('request_generation_tokens_count');
  const firstTokens=get('time_to_first_token_seconds_count');
  const finishedDelta=sampleValid?delta(requests,previous?.requests):null;
  const firstDelta=sampleValid?delta(firstTokens,previous?.first_tokens):null;
  // Prompt counters are emitted at first output, not incrementally during
  // prefill. A whole prompt divided by the scrape interval is NOT its speed.
  // Track first-token/finish events from an observed idle baseline instead.
  //
  // A request decodes from its first token until it finishes, so the count
  // decoding now is (requests that reached first token) - (requests that
  // finished), measured since an engine was observed idle. Unlike the carry-
  // forward below, this is recomputed from cumulative counters every sample, so
  // one dropped or regressed sample no longer leaves the estimate unseedable
  // for as long as the engine stays busy. An idle crossing is required, not
  // optional: both counters are lifetime totals that already contain drift, so
  // their difference without an anchor would count past drift as current work.
  // Two guards narrow it further — the counters may not regress or change epoch,
  // and the result must fit inside the running batch, a separate gauge. That
  // bound is a plausibility filter rather than a proof: it only catches drift to
  // the extent other requests are prefilling, and requests abandoned after
  // their first token keep inflating it until the engine next drains.
  const countersUsable=Number.isSafeInteger(firstTokens)&&Number.isSafeInteger(requests);
  const countersComparable=!previous||(
    previous.connected!==false&&epochUnchanged(previous,epoch)&&
    Number.isSafeInteger(previous.first_tokens)&&Number.isSafeInteger(previous.requests)&&
    firstTokens>=previous.first_tokens&&requests>=previous.requests);
  const baseline=previous?.decoding_baseline??null;
  const decodingFromBaseline=baseline!==null&&countersUsable&&countersComparable&&running!==null&&running>0
    &&firstTokens>=baseline.first_tokens&&requests>=baseline.requests
    ?(firstTokens-baseline.first_tokens)-(requests-baseline.requests):null;
  let decoding=null;
  if(running===0)decoding=0;
  else{
    if(decodingFromBaseline!==null&&decodingFromBaseline>=0&&decodingFromBaseline<=running)decoding=decodingFromBaseline;
    else if(sampleValid&&Number.isSafeInteger(firstDelta)&&Number.isSafeInteger(finishedDelta)&&Number.isSafeInteger(previous?.decoding_requests)){
      const next=previous.decoding_requests+firstDelta-finishedDelta;
      if(next>=0&&next<=running)decoding=next;
    }
    if(decoding===null&&running===1&&generationDelta>0&&finishedDelta===0)decoding=1;
  }
  const phase=running===0?'idle':decoding===null?(generationDelta>0&&running===1&&finishedDelta===0?'decode':'working'):decoding===0?'prefill':decoding===running?'decode':'mixed';
  const intervalPhase=sampleValid&&generationDelta>0?'decode':null;
  const prefillSeconds=get('request_prefill_time_seconds_sum');
  const prefillTokens=get('request_prefill_kv_computed_tokens_sum');
  const prefillCount=get('request_prefill_time_seconds_count');
  const computedCount=get('request_prefill_kv_computed_tokens_count');
  const decodeSeconds=get('request_decode_time_seconds_sum');
  const decodeCount=get('request_decode_time_seconds_count');
  const decodeTokens=get('request_generation_tokens_sum');
  const durationDelta=sampleValid?delta(prefillSeconds,previous?.prefill_seconds):null;
  const tokensDelta=sampleValid?delta(prefillTokens,previous?.prefill_tokens):null;
  const timingCountDelta=sampleValid?delta(prefillCount,previous?.prefill_count):null;
  const computedCountDelta=sampleValid?delta(computedCount,previous?.computed_count):null;
  const decodeDurationDelta=sampleValid?delta(decodeSeconds,previous?.decode_seconds):null;
  const decodeCountDelta=sampleValid?delta(decodeCount,previous?.decode_count):null;
  const decodeTokenDelta=sampleValid?delta(decodeTokens,previous?.decode_tokens):null;
  const completedDecode=Number.isSafeInteger(finishedDelta)&&finishedDelta>0&&finishedDelta===decodeCountDelta&&decodeDurationDelta>0&&decodeTokenDelta!==null
    ?{requests:finishedDelta,tokens:decodeTokenDelta,seconds:decodeDurationDelta,tps:decodeTokenDelta/decodeDurationDelta}:null;
  // Engines without a computed-token count histogram must not have completed
  // prefill vetoed: every count that IS present still has to match the finish
  // count, and an absent series is simply not required evidence.
  const measured=Number.isSafeInteger(finishedDelta)&&finishedDelta>0&&durationDelta>0&&tokensDelta!==null
    &&[finishedDelta,timingCountDelta,computedCountDelta].every(count=>count===null||count===finishedDelta);
  const singleSince=running===0?now:sampleValid&&running===1&&previous.running<=1?previous.single_since??(finishedDelta>0&&decoding===0?previous.at:null):null;
  let completedPrefill=null;
  if(measured){
    completedPrefill={requests:finishedDelta,tokens:tokensDelta,seconds:durationDelta,tps:tokensDelta/durationDelta};
    // Position a single request using its engine prefill/decode durations.
    // Export/scrape delay limits wall-clock placement to roughly one poll.
    // Never assign a single interval to concurrent or aggregated completions.
    const end=now-decodeDurationDelta*1000,start=end-durationDelta*1000;
    if(finishedDelta===1&&decodeCountDelta===1&&decodeDurationDelta!==null&&previous.single_since!==null&&previous.single_since!==undefined&&previous.running<=1&&running<=1&&start>=previous.single_since-(now-previous.at))
      Object.assign(completedPrefill,{start,end,uncertainty_ms:now-previous.at});
  }
  const rate=(tokens,duration)=>get(duration)>0&&get(tokens)!==null?get(tokens)/get(duration):null;
  return {
    source:'vllm',model_ids:[...new Set([...text.matchAll(/^vllm:num_requests_running\{[^\n]*?model_name="([^"]+)"/gm)].map(match=>match[1]))],live_rate_scope:'poll_interval_throughput',at:now,connected:true,running,
    waiting:get('num_requests_waiting'),generated,computed,phase,phase_basis:decoding===null?'unresolved':'sampled_request_lifecycle',live_activity:true,
    interval_start:sampleValid?previous.at:null,interval_phase:intervalPhase,
    interval_generated:sampleValid?generationDelta:null,interval_prefill:prefillDelta,
    metrics_epoch:epoch,first_tokens:firstTokens,decoding_requests:decoding,single_since:singleSince,
    // An idle engine anchors the identity; a busy one keeps the existing anchor
    // and stays unresolved until it either drains or the carry-forward resolves.
    decoding_baseline:running===0&&countersUsable?Object.freeze({first_tokens:firstTokens,requests}):baseline,
    prefill_seconds:prefillSeconds,prefill_tokens:prefillTokens,prefill_count:prefillCount,computed_count:computedCount,decode_seconds:decodeSeconds,decode_count:decodeCount,
    completed_prefill:completedPrefill,completed_decode:completedDecode,decode_tokens:decodeTokens,prefill_rate_scope:'completed_request_average',
    live_prefill_tps:null,
    live_decode_tps:sampleValid?generationDelta/seconds:null,
    prefill_tps:rate('request_prefill_kv_computed_tokens_sum','request_prefill_time_seconds_sum'),
    decode_tps:rate('request_generation_tokens_sum','request_decode_time_seconds_sum'),
    cached_tokens:get('prefix_cache_hits_total'),requests,scope:'engine_session_average',
  };
}

export function omlxSnapshot(value,now,previous){
  if(value?.status!=='ok'||finite(value.total_requests)===null||finite(value.avg_generation_tps)===null)throw new UnsupportedMetrics();
  const prompt=finite(value.total_prompt_tokens),cached=finite(value.total_cached_tokens);
  const computed=prompt!==null&&cached!==null&&cached<=prompt?prompt-cached:null;
  const uptime=finite(value.uptime_seconds),sameSession=!(uptime!==null&&finite(previous?.uptime_seconds)!==null&&uptime<previous.uptime_seconds);
  return {
    source:'omlx',live_rate_scope:'active_request_average',at:now,connected:true,
    running:finite(value.active_requests),waiting:finite(value.waiting_requests),requests:value.total_requests,
    prefill_tps:value.total_requests>0?finite(value.avg_prefill_tps):null,
    decode_tps:value.total_requests>0?finite(value.avg_generation_tps):null,
    cached_tokens:cached,computed,uptime_seconds:uptime,scope:'engine_session_average',live_decode_tps:null,
    // This is completion evidence, not the duration or instantaneous phase of
    // prefill. It survives prefills too short to appear in /admin/api/activity.
    completed_prefill_tokens:sameSession&&validInterval(now,previous)&&value.total_requests>previous.requests?delta(computed,previous.computed):null,
  };
}

export function omlxActivity(value){
  const models=value?.active_models?.models;
  if(!Array.isArray(models)||models.some(model=>!model||typeof model!=='object'||['prefilling','generating','waiting'].some(key=>model[key]!==undefined&&!Array.isArray(model[key]))))throw new UnsupportedMetrics();
  const prefill=models.flatMap(model=>model.prefilling??[]);
  // oMLX also puts request setup/cache restore and other zero-output work in
  // "generating". Positive generated tokens are the evidence of generation.
  const generation=models.flatMap(model=>model.generating??[]).filter(row=>finite(row?.generated_tokens)>0);
  const sum=(items,key)=>{
    const values=items.map(row=>finite(row?.[key]));
    return values.length&&values.every(n=>n!==null)?values.reduce((a,b)=>a+b,0):null;
  };
  const running=finite(value.active_models.total_active_requests)??(models.length?sum(models,'active_requests'):0);
  const waiting=finite(value.active_models.total_waiting_requests)??(models.length?sum(models,'waiting_requests'):0);
  const request_rows=models.flatMap(model=>['prefilling','generating','waiting'].flatMap(group=>(model[group]??[]).flatMap(row=>
    typeof row?.request_id==='string'&&row.request_id.length<=256&&typeof model.id==='string'&&model.id.length<=256?[{
      id:row.request_id,model:model.id,phase:group==='prefilling'?'prefill':group==='waiting'?'waiting':row.generated_tokens>0?'decode':'preparing',
      computedTokens:finite(row.processed),totalTokens:finite(row.total),generatedTokens:finite(row.generated_tokens)
    }]:[]))).slice(0,512);
  return {
    live_activity:true,running,waiting,request_rows,
    phase:prefill.length&&generation.length?'mixed':prefill.length?'prefill':generation.length?'decode':running===0?'idle':'working',
    live_prefill_tps:sum(prefill,'speed'),live_decode_tps:sum(generation,'tokens_per_second'),
    prefill_processed:sum(prefill,'processed'),prefill_total:sum(prefill,'total'),generated_tokens:sum(generation,'generated_tokens'),
  };
}

// Tensorfold (the EXL3 spark pairs) exposes the same evidence under its own
// namespace, so it is rewritten into the vLLM names the snapshot maths already
// handles. Two semantic differences are accounted for: its per-request
// counters are finish-scoped, and completion_tokens_total is the one series
// that includes running replies, so it alone can drive live decode rates.
// Its TTFT histogram is observed at completion (verified against a running
// engine), so counter-based decode inference cannot resolve — the
// streams-by-state gauges are the exact phase source instead.
const TENSORFOLD_REMAP=[
  ['tensorfold:requests_running','vllm:num_requests_running'],
  ['tensorfold:requests_waiting','vllm:num_requests_waiting'],
  ['tensorfold_health:completion_tokens_total','vllm:generation_tokens_total'],
  ['tensorfold:generation_tokens_total','vllm:request_generation_tokens_sum'],
  ['tensorfold_health:requests_total','vllm:request_generation_tokens_count'],
  ['tensorfold_health:requests_total','vllm:request_prefill_time_seconds_count'],
  ['tensorfold_health:requests_total','vllm:request_decode_time_seconds_count'],
  ['tensorfold:prompt_tokens_total','vllm:prompt_tokens_total'],
  ['tensorfold_health:cached_tokens_total','vllm:prompt_tokens_cached_total'],
  ['tensorfold_health:prefill_seconds_total','vllm:request_prefill_time_seconds_sum'],
  ['tensorfold_health:decode_seconds_total','vllm:request_decode_time_seconds_sum'],
];
const tensorfoldStreams=(text,state)=>{
  const match=text.match(new RegExp(`^tensorfold_health:streams\\{[^}]*state="${state}"[^}]*\\}\\s+([\\d.eE+\\-]+)`,'m'));
  return match?finite(Number(match[1])):null;
};
export function tensorfoldSnapshot(text,now,previous){
  const raw=prometheusValues(text);
  if(raw['tensorfold:requests_running']===null)throw new UnsupportedMetrics();
  const lines=TENSORFOLD_REMAP.filter(([name])=>raw[name]!==null).map(([name,target])=>`${target} ${raw[name]}`);
  const prompt=raw['tensorfold:prompt_tokens_total'],cached=raw['tensorfold_health:cached_tokens_total'];
  if(prompt!==null&&cached!==null&&cached<=prompt)lines.push(`vllm:request_prefill_kv_computed_tokens_sum ${prompt-cached}`);
  const snapshot=vllmSnapshot(lines.join('\n')+'\n',now,previous);
  const decoding=tensorfoldStreams(text,'decoding'),filling=tensorfoldStreams(text,'filling');
  if(decoding!==null||filling!==null){
    const running=raw['tensorfold:requests_running']??0;
    snapshot.decoding_requests=decoding??0;
    snapshot.phase=running===0?'idle':decoding>0&&filling>0?'mixed':filling>0?'prefill':decoding>0?'decode':'working';
    snapshot.phase_basis='engine_stream_gauges';
  }
  snapshot.source='tensorfold';
  const executionCapacity=tensorfoldStreams(text,'max');
  if(Number.isSafeInteger(executionCapacity)&&executionCapacity>0){
    snapshot.execution_capacity=executionCapacity;snapshot.capacity_source='tensorfold_streams_max';
  }
  // Completion-scoped evidence for the activity markers, mirroring oMLX.
  const finished=previous?.source==='tensorfold'&&previous.connected!==false&&Number.isSafeInteger(previous.requests)&&Number.isSafeInteger(snapshot.requests)?snapshot.requests-previous.requests:null;
  snapshot.completed_prefill_tokens=Number.isSafeInteger(finished)&&finished>0?snapshot.interval_prefill??null:null;
  return snapshot;
}

export class EndpointTelemetry {
  constructor({fetcher=fetch,now=Date.now,onSample=()=>{},includeLegacy=false}={}){
    Object.assign(this,{fetcher,now,onSample,includeLegacy});
    this.states=new Map();this.shared=new Map();this.workers=[];this.busy=new Map();this.closed=false;
    this.cookies=new Map();this.histories=new Map();this.activityRetry=new Map();this.identities=new Map();
  }
  sync(workers){
    this.workers=workers.filter(worker=>worker.backend==='openai'||this.includeLegacy);
    const next=new Map(this.workers.map(worker=>[worker.id,workerKey(worker)]));
    for(const [id,key]of this.identities)if(next.get(id)!==key){
      this.states.delete(id);this.shared.delete(id);this.histories.delete(id);this.activityRetry.delete(id);this.cookies.delete(key);
      this.busy.get(id)?.controller.abort();this.busy.delete(id);
    }
    this.identities=next;
  }
  useShared(rows){
    const accepted=new Set();
    for(const row of Array.isArray(rows)?rows:[]){
      const address=url=>{try{return new URL(url).href.replace(/\/v1\/?$/,'').replace(/\/$/,'');}catch{return null;}};
      const worker=this.workers.find(worker=>worker.id===row.id&&address(worker.url)===address(row.url));
      if(!worker)continue;
      accepted.add(worker.id);this.shared.set(worker.id,this.now());
      this.busy.get(worker.id)?.controller.abort();this.busy.delete(worker.id);
      const before=this.states.get(worker.id),value=row.metrics;
      if(!value||!Number.isFinite(value.at))continue;
      this.states.set(worker.id,{...value,url:worker.url});
      this.histories.set(worker.id,Array.isArray(value.series)?value.series.slice(-1024):[]);
      if(before?.at!==value.at||before?.connected!==value.connected)this.notify(worker.id,before);
    }
    for(const id of this.shared.keys())if(!accepted.has(id))this.shared.delete(id);
  }
  snapshot(id){
    const state=this.states.get(id);if(!state)return null;
    const {url,retryAt,...publicState}=state;
    return {...publicState,series:(this.histories.get(id)??[]).filter(point=>this.now()>=point.time&&this.now()-point.time<HISTORY_MS)};
  }
  poll(){
    if(this.closed)return;
    for(const worker of this.workers)if(!this.busy.has(worker.id)&&this.now()>=(this.states.get(worker.id)?.retryAt??0))void this.sample(worker);
  }
  async read(worker,route,extraHeaders={},signal){
    const url=new URL(worker.url);
    url.pathname=url.pathname.replace(/\/v1\/?$/,'').replace(/\/$/,'')+route;
    const timeout=AbortSignal.timeout(2000);
    const response=await this.fetcher(url,{headers:{...endpointHeaders(worker),...extraHeaders},signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw new MetricsHttpError(response.status);}
    if(!response.body)throw new UnsupportedMetrics();
    const reader=response.body.getReader();let bytes=0;const parts=[];
    try{
      for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1048576)throw new UnsupportedMetrics();parts.push(Buffer.from(value));}
    }finally{await reader.cancel();}
    return Buffer.concat(parts).toString();
  }
  async activity(worker,signal){
    const key=workerKey(worker);let cookie=this.cookies.get(key);
    try{return omlxActivity(JSON.parse(await this.read(worker,'/admin/api/activity',cookie?{cookie}:{},signal)));}
    catch(error){this.cookies.delete(key);if(signal?.aborted)throw error;}
    const auth=endpointHeaders(worker).authorization;
    if(!auth)throw new Error('Activity authentication unavailable');
    const url=new URL(worker.url);url.pathname=url.pathname.replace(/\/v1\/?$/,'').replace(/\/$/,'')+'/admin/api/login';
    const timeout=AbortSignal.timeout(2000);
    const response=await this.fetcher(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api_key:auth.slice(7),remember:false}),signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error'});
    await response.body?.cancel();
    if(!response.ok||signal?.aborted)throw new Error('Activity authentication unavailable');
    cookie=response.headers.get('set-cookie')?.split(';')[0];
    if(!cookie?.startsWith('omlx_admin_session='))throw new Error('Activity session unavailable');
    this.cookies.set(key,cookie);
    return omlxActivity(JSON.parse(await this.read(worker,'/admin/api/activity',{cookie},signal)));
  }
  async sample(worker){
    if(this.closed||this.busy.has(worker.id)||(this.shared.has(worker.id)&&this.now()-this.shared.get(worker.id)<=6000))return;
    const key=workerKey(worker),started=this.now(),controller=new AbortController(),pending={key,controller};
    this.busy.set(worker.id,pending);
    const before=this.states.get(worker.id),current=()=>!this.closed&&this.identities.get(worker.id)===key&&this.busy.get(worker.id)===pending;
    const readVllm=async()=>vllmSnapshot(await this.read(worker,'/metrics',{},controller.signal),this.now(),before?.source==='vllm'?before:null);
    const readTensorfold=async()=>tensorfoldSnapshot(await this.read(worker,'/metrics',{},controller.signal),this.now(),before?.source==='tensorfold'?before:null);
    const readOmlx=async()=>{
      const raw=await this.read(worker,'/api/status',{},controller.signal);let value;
      try{value=JSON.parse(raw);}catch{throw new UnsupportedMetrics();}
      return omlxSnapshot(value,this.now(),before?.source==='omlx'?before:null);
    };
    try{
      const readers={vllm:readVllm,tensorfold:readTensorfold,omlx:readOmlx};
      // Probe the previously seen source first, then the remaining engines. A
      // known source is only abandoned when the failure shape (an unparseable
      // or missing endpoint, not a network error) says the engine changed.
      let value=null,failure=null;
      for(const source of [...new Set([before?.source,'vllm','tensorfold','omlx'].filter(Boolean))]){
        try{value=await readers[source]();break;}
        catch(error){failure=error;if(before?.source===source&&!canRediscover(error))throw error;}
      }
      if(!value)throw failure;
      if(value.source==='omlx'){
        value.live_activity=false;
        if(this.now()>=(this.activityRetry.get(worker.id)??0)){
          try{Object.assign(value,await this.activity(worker,controller.signal),{activity_at:this.now()});this.activityRetry.delete(worker.id);}
          catch{this.activityRetry.set(worker.id,this.now()+RETRY_MS);}
        }
      }
      if(current()){
        this.states.set(worker.id,{...value,url:worker.url,retryAt:Math.max(started+POLL_MS,this.now())});
        const rows=(before?.source&&before.source!==value.source?[]:this.histories.get(worker.id)??[]).filter(point=>value.at>=point.time&&value.at-point.time<HISTORY_MS&&point.scope===(point.kind==='prefill'?value.prefill_rate_scope??value.live_rate_scope:value.live_rate_scope));
        for(const kind of ['prefill','decode']){
          const completed=kind==='prefill'?value.completed_prefill??null:null;
          const rate=completed?completed.tps:value['live_'+kind+'_tps'];
          if(Number.isFinite(rate)&&(completed?rate>=0:rate>0))rows.push({time:value.activity_at??value.at,kind,tps:rate,scope:kind==='prefill'?value.prefill_rate_scope??value.live_rate_scope:value.live_rate_scope});
        }
        this.histories.set(worker.id,rows.slice(-1024));
        this.notify(worker.id,before);
      }
    }catch{
      if(current()){
        this.states.set(worker.id,{...before,url:worker.url,connected:false,error:'Endpoint metrics unavailable',retryAt:this.now()+RETRY_MS});
        this.notify(worker.id,before);
      }
    }finally{
      if(this.busy.get(worker.id)===pending)this.busy.delete(worker.id);
      if(this.closed||this.identities.get(worker.id)!==key){this.cookies.delete(key);if(!this.identities.has(worker.id))this.activityRetry.delete(worker.id);}
    }
  }
  notify(id,previous){try{this.onSample(id,this.snapshot(id),this.now(),previous);}catch{/* Observation cannot break polling or inference. */}}
  close(){this.closed=true;for(const {controller}of this.busy.values())controller.abort();this.cookies.clear();}
}
