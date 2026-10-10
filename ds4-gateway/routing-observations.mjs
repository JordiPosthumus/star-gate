// Passive state for the time-based router. Never changes a request or booking.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fitOutputLengths, phaseSpeed, remainingServiceEstimate, serviceEstimate} from './routing-estimates.mjs';
import {chooseRoute} from './routing-plan.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh = (at, now) => Number.isFinite(at) && now >= at && now - at <= 5000;
function savedSpeed(row){
  if(!row||!['prefill','decode'].includes(row.phase)||!['workerId','identity','model','requestId'].every(key=>typeof row[key]==='string'&&row[key].length>0&&row[key].length<=256)
    ||row.scope!=='request'||row.waitExcluded!==true||!(row.concurrencyStable===true||row.engineAggregate===true)||!count(row.concurrency)||row.concurrency<1
    ||!Number.isFinite(row.tokens)||row.tokens<=0||!Number.isFinite(row.seconds)||row.seconds<=0)return null;
  const keys=['workerId','identity','model','requestId','phase','tokens','seconds','concurrency','scope','waitExcluded','concurrencyStable'];
  if(row.engineAggregate===true)keys.push('engineAggregate');
  return Object.fromEntries(keys.map(key=>[key,row[key]]));
}
export const routingIdentity = (node, model, profile = null) => hash({worker: node.id, url: node.url,
  backend: node.backend, model, context: node.contextLength ?? node.context_length,
  capacity: node.max_concurrent_requests, aliases: node.effectiveModelAliases ?? node.model_aliases, profile});

// The text a route carries as request input, so the estimator can size it. Each
// accepted inference route names its input differently; a route we cannot read
// yields null and leaves the estimate unavailable FOR THAT REQUEST ONLY, which is
// strictly better than manufacturing a size. Sizing everything as chat/completions
// would have silently produced a token count of `undefined -> null` on two of the
// four live routes, and `null` is exactly the `input_size_unavailable` that kept
// the fast lanes unscoreable.
function requestInputText(body, route) {
  if (route === '/v1/chat/completions') return body.messages;
  if (route === '/v1/completions') return body.prompt;
  // Responses API: `input` is a string or an array of items.
  if (route === '/v1/responses') return body.input;
  // Messages API: `system` is a separate top-level field, not a message turn.
  if (route === '/v1/messages') return body.system === undefined ? body.messages
    : {system: body.system, messages: body.messages};
  return null;
}

export function routingRequestMetadata(body, route) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !['/v1/chat/completions', '/v1/completions', '/v1/messages', '/v1/responses'].includes(route)) return null;
  const input = requestInputText(body, route);
  const routable = input !== undefined && input !== null;
  // Image/audio token accounting needs a native adapter; encoded bytes are not
  // text tokens. This abstention changes only an estimate, never forwarding.
  const text = JSON.stringify({input, tools: body.tools});
  const multimodal = /"(?:image_url|input_audio|input_image|video_url)"/.test(text);
  const limits = ['max_completion_tokens', 'max_tokens', 'max_output_tokens']
    .filter(key => Object.hasOwn(body, key)).map(key => body[key]);
  const outputLimit = limits.length && limits.every(value => count(value) && value === limits[0]) ? limits[0] : null;
  const settings = Object.fromEntries(Object.entries(body).filter(([key]) => !['messages', 'prompt', 'stream', 'stream_options'].includes(key)));
  return {inputTokens: routable && !multimodal ? Math.ceil(Buffer.byteLength(text) / 4) : null,
    inputEvidence: routable && !multimodal ? 'estimated_bytes' : 'unavailable', outputLimit,
    singleChoice: body.n === undefined || body.n === 1,
    template: hash({route, settings}),
    messages: Array.isArray(body.messages) && body.messages.length <= 512 ? body.messages.map(message => hash(message)) : null};
}

export class RoutingObservations {
  constructor({enabled = false, filename, now = Date.now, mode = 'observation_only'} = {}) {
    Object.assign(this, {enabled, filename, now});
    this.outputs = []; this.samples = []; this.cache = new Map(); this.previous = new Map(); this.serial = new Map();
    this.engineEmitted = new Map();
    this.writing = null; this.dirty = false; this.closed = false;
    this.state = {enabled, mode: enabled ? mode : 'off', evaluations: 0, errors: 0, storageError: null, last: null};
    if (enabled && filename && fs.existsSync(filename)) {
      try {
        if (fs.statSync(filename).size > 4 * 1024 * 1024) throw Error();
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.outputs) || !Array.isArray(saved.samples)) throw Error();
        this.outputs = saved.outputs.slice(-256).map(row => ({outputTokens: count(row.outputTokens) ? row.outputTokens : null,
          outcome: row.outcome === 'complete' ? 'complete' : 'other',
          finishReason: ['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(row.finishReason) ? row.finishReason : null}));
        // Preserve old speed rows without using them. A model name alone does not
        // verify that the engine build/configuration behind an endpoint survived.
        // They stay in the file and stay listed as parked so the estimator's real
        // evidence is never confused with unverified history.
        this.restoredSamples = saved.samples.map(savedSpeed).filter(Boolean).slice(-4096).map(row => ({...row, parked: true}));
      } catch {this.state.storageError = 'Saved routing history is unreadable; preserved without overwrite';}
    }
  }
  snapshot() {return {...this.state, outputSamples: this.outputs.length, speedSamples: this.samples.length, unverifiedSavedSpeedSamples: this.restoredSamples?.length ?? 0,
    fit: fitOutputLengths(this.outputs), speed: this.speedSummary(), last: this.state.last ? structuredClone(this.state.last) : null};}
  // What the estimator can actually see, per worker and phase. Distinguishes
  // engine-measured rows (mean work per completed request, taken inside the
  // engine) from single clean request windows, and reports the concurrency the
  // rows were measured at so a stale or empty lane is visible rather than implied.
  // Parked history is deliberately excluded: it is not evidence the estimator uses.
  //
  // `tokensPerSecond` is the pooled rate across ALL concurrency levels and is
  // therefore only comparable between lanes measured at a similar mix. The
  // per-concurrency rows are the honest curve; `tokensPerSecond` is kept for
  // continuity and labelled as pooled so it is never read as a single-lane rate.
  speedSummary() {
    const byWorker = new Map();
    for (const sample of this.samples) {
      if (!sample || !['prefill', 'decode'].includes(sample.phase)) continue;
      const key = `${sample.workerId}\u0000${sample.phase}`;
      const row = byWorker.get(key) ?? {workerId: sample.workerId, phase: sample.phase, samples: 0,
        engineAggregate: 0, cleanWindow: 0, concurrency: new Map(), rate: new Map(), tokens: 0, seconds: 0};
      row.samples++; if (sample.engineAggregate === true) row.engineAggregate++; else row.cleanWindow++;
      row.concurrency.set(sample.concurrency, (row.concurrency.get(sample.concurrency) ?? 0) + 1);
      // Same last-10 window and median the estimator itself uses, so the display
      // shows what placement is actually working from.
      const rates = row.rate.get(sample.concurrency) ?? [];
      rates.push(sample.tokens / sample.seconds);
      row.rate.set(sample.concurrency, rates.slice(-10));
      row.tokens += sample.tokens; row.seconds += sample.seconds;
      byWorker.set(key, row);
    }
    const median = values => {
      const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
      return n % 2 ? sorted[(n - 1) / 2] : (sorted[n - 1 >> 1] + sorted[n >> 1]) / 2;
    };
    return [...byWorker.values()].map(row => ({workerId: row.workerId, phase: row.phase, samples: row.samples,
      engineAggregate: row.engineAggregate, cleanWindow: row.cleanWindow,
      tokensPerSecond: row.seconds > 0 ? row.tokens / row.seconds : null,
      pooledRate: true,
      byConcurrency: [...row.rate.entries()].sort((a, b) => a[0] - b[0]).map(([value, rates]) => ({value, count: row.concurrency.get(value), tokensPerSecond: median(rates)})),
      concurrency: [...row.concurrency.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({value, count}))}))
      .sort((a, b) => a.workerId.localeCompare(b.workerId) || a.phase.localeCompare(b.phase));
  }
  attempt(fn) {if (!this.enabled || this.closed) return; try {return fn();} catch {this.state.errors++;}}
  complete({job, worker, usage, outcome, finishReason}) {
    this.attempt(() => {
      const serial=this.serial.get(worker.id);
      if(serial?.requestId===job.id)serial.completed={outcome,usage};
      this.outputs.push({outputTokens: job.routingInput?.singleChoice === true && count(usage?.completion_tokens) ? usage.completion_tokens : null,
        outcome: outcome === 'complete' ? 'complete' : 'other',
        finishReason: ['stop', 'tool_calls', 'function_call', 'length', 'content_filter'].includes(finishReason) ? finishReason : null});
      this.outputs = this.outputs.slice(-256);
      if (outcome === 'complete' && job.routingInput?.messages && count(usage?.prompt_tokens)) {
        const rows = this.cache.get(worker.identity) ?? [];
        rows.push({at: this.now(), template: job.routingInput.template, messages: job.routingInput.messages, tokens: usage.prompt_tokens});
        this.cache.set(worker.identity, rows.slice(-8));
      }
      this.save();
    });
  }
  request(job, workers) {
    const metadata = job.routingInput;
    const cache = {};
    if (metadata?.messages) for (const worker of workers) {
      const matching = (this.cache.get(worker.identity) ?? []).filter(row => this.now() >= row.at && this.now() - row.at <= 300000
        && row.template === metadata.template && row.messages.length <= metadata.messages.length
        && row.messages.every((value, index) => value === metadata.messages[index]));
      const best = matching.sort((a, b) => b.tokens - a.tokens)[0];
      if (best) cache[worker.id] = {identity: worker.identity, evidence: 'estimated', reusableTokens: best.tokens};
    }
    return {id: job.id, sequence: job.sequence, key: job.key, priority: job.priority, geniePriority: job.geniePriority,
      cancelled: job.cancelled, dispatched: job.dispatched, upstream: !!job.upstream, inputTokens: metadata?.inputTokens ?? null, outputLimit: metadata?.outputLimit ?? null, cache};
  }
  started({job, worker, fleet, concurrency}) {
    this.attempt(() => {
      // An idle-to-idle, single completed request can attribute vLLM's phase
      // histogram deltas without treating engine throughput as request speed.
      const serial=this.serial.get(worker.id);
      if(serial&&job.dispatched){
        if(!serial.requestId&&fresh(serial.before.at,this.now())&&serial.identity===worker.identity)serial.requestId=job.id;
        else if(serial.requestId!==job.id)serial.invalid=true;
        if(concurrency!==1)serial.invalid=true;
      }
      // Record a dispatch basis on the job itself for EVERY request, not only
      // when a full estimate resolves. A request whose lane had no per-concurrency
      // measurement yet still has a known dispatch instant, known remaining input
      // and a default speed guess; without a basis the request contributes NO
      // progress, its lane reads 'running_progress_unavailable' for its whole
      // lifetime, and a lane that is merely slower-but-measured wins placement
      // against a faster lane that cannot be scored at all. The basis is an
      // estimate captured once at dispatch (never a retrospective slowdown) and is
      // labelled 'estimated' wherever it is consumed.
      if (job.routingProgressBasis || !job.dispatched || !job.routingInput) return;
      const request = this.request(job, fleet);
      const estimate=serviceEstimate({job:request,worker,fleet,samples:this.samples,concurrency,
        outputModel:{fit:fitOutputLengths(this.outputs)}});
      const inputTokens = count(estimate.input.tokens) ? estimate.input.tokens
        : count(request.inputTokens) ? request.inputTokens : null;
      const prefill = estimate.prefill.tokensPerSecond > 0 ? estimate.prefill.tokensPerSecond
        : this.basisSpeed(worker, fleet, 'prefill', concurrency);
      const decode = estimate.decode.tokensPerSecond > 0 ? estimate.decode.tokensPerSecond
        : this.basisSpeed(worker, fleet, 'decode', concurrency);
      if (!count(inputTokens) || !(prefill > 0) || !(decode > 0)) return;
      // This is an estimate captured once at dispatch, never a retrospective
      // slowdown of existing work when considering a new candidate. `evidence`
      // records whether BOTH phase speeds were this lane's own measurement
      // ('observed') or whether either came from the approved default guess
      // ('estimated'), so the panel can label the guess rather than present it
      // as a measurement.
      const measured = estimate.input.tokens !== null && count(estimate.input.tokens)
        && estimate.prefill.evidence === 'observed' && estimate.decode.evidence === 'observed';
      job.routingProgressBasis={at:job.dispatched,identity:worker.identity,inputTokens,prefill,decode,concurrency,
        evidence: measured ? 'observed' : 'estimated'};
    });
  }
  // The approved 0.9-per-level default guess, resolved through the same tiered
  // phaseSpeed the estimator uses, so a basis can be built for a lane whose
  // exact concurrency has no row without inventing a separate arithmetic path.
  basisSpeed(worker, fleet, phase, concurrency) {
    return phaseSpeed({worker, fleet, samples: this.samples, phase, concurrency}).tokensPerSecond ?? null;
  }
  observeNative(worker, value, jobs) {
    this.attempt(() => {
      const before = this.previous.get(worker.id);
      this.previous.set(worker.id, {value, identity: worker.identity, workRevision:worker.workRevision,jobIds: jobs.map(job => job.id).sort().join(',')});
      const changed = before && (before.identity !== worker.identity || before.value?.source !== value?.source
        || (value?.connected && !before.value?.connected)
        || (Number.isFinite(value?.uptime_seconds) && value.uptime_seconds < before.value?.uptime_seconds)
        || (value?.metrics_epoch != null && before.value?.metrics_epoch != null && value.metrics_epoch !== before.value.metrics_epoch)
        || (JSON.stringify(value?.model_ids??[]) !== JSON.stringify(before.value?.model_ids??[]))
        || (count(value?.requests) && count(before.value?.requests) && value.requests < before.value.requests));
      if (changed) {
        this.cache.delete(before.identity); this.cache.delete(worker.identity); this.serial.delete(worker.id);
        this.engineEmitted.delete(worker.id);
        this.restoredSamples = [...(this.restoredSamples ?? []), ...this.samples.filter(row => row.workerId === worker.id)].slice(-4096);
        this.samples = this.samples.filter(row => row.workerId !== worker.id);
        this.save();
      }
      this.observeSerial(worker,value,jobs,changed);
      this.observeEnginePhases(worker,value,before,changed);
      if (changed || !value?.connected || !fresh(value.activity_at, this.now()) || !Array.isArray(value.request_rows)) return;
      // Engine rows carry a phase that can be prefill/decode for measurable work,
      // or waiting/preparing for requests that have not produced output yet.
      // Every row is a real engine request, so EVERY row counts toward the
      // engine-vs-gateway agreement check; only prefill/decode rows yield tokens.
      // Filtering the count as well (the old behaviour) made any lane with a
      // queued or cache-restoring request unmeasurable for the whole interval —
      // an oMLX lane preparing a request could then never contribute a sample,
      // which is why its throughput never reached the estimator.
      const all = value.request_rows.filter(row => row && typeof row.id === 'string');
      const rows = all.filter(row => ['prefill', 'decode'].includes(row.phase));
      const prior = before?.value;
      const priorAll = prior?.request_rows?.filter(row => row && typeof row.id === 'string') ?? null;
      // A measurement interval must represent the same known gateway requests,
      // with no engine queue, completion, observed membership or phase change.
      if (!prior?.connected || before.identity !== worker.identity || !fresh(prior.activity_at, this.now())
        ||before.workRevision!==worker.workRevision
        || value.waiting !== 0 || prior.waiting !== 0 || !count(value.requests) || value.requests !== prior.requests
        || !count(value.running) || value.running < 1 || value.running !== jobs.length
        || value.running !== prior.running || !priorAll || priorAll.length !== prior.running
        || all.length !== value.running || new Set(all.map(row => row.id)).size !== all.length
        || before.jobIds !== jobs.map(job => job.id).sort().join(',')) return;
      // The same requests must be present at both ends, in the same phase, so a
      // delta is attributable to work (not to a request entering or leaving).
      const priorPhases = new Map(priorAll.map(row => [row.id, row.phase]));
      if (all.some(row => priorPhases.get(row.id) !== row.phase)) return;
      const seconds = (value.activity_at - prior.activity_at) / 1000;
      if (!(seconds > 0 && seconds <= 5)) return;
      const known = new Set(jobs.map(job => job.id));
      if (rows.some(row => !known.has(row.id) || row.model !== worker.model)) return;
      for (const row of rows) {
        const old = priorAll.find(candidate => candidate.id === row.id && candidate.phase === row.phase && candidate.model === row.model);
        const field = row.phase === 'prefill' ? 'computedTokens' : 'generatedTokens';
        if (!old || !count(old[field]) || old[field] <= 0 || !count(row[field]) || row[field] <= old[field]) continue;
        this.samples.push({workerId: worker.id, identity: worker.identity, model: worker.model, requestId: row.id,
          phase: row.phase, tokens: row[field] - old[field], seconds, concurrency: value.running,
          scope: 'request', waitExcluded: true, concurrencyStable: true});
      }
      this.samples = this.samples.slice(-4096); this.save();
    });
  }
  observeSerial(worker,value,jobs,changed){
    if(changed||!value?.connected||value.source!=='vllm'||!fresh(value.at,this.now())
      ||value.model_ids?.length!==1||value.model_ids[0]!==worker.model){this.serial.delete(worker.id);return;}
    let serial=this.serial.get(worker.id);
    if(serial&&(value.running>1||value.waiting!==0||jobs.length>1||serial.identity!==worker.identity))serial.invalid=true;
    if(value.running!==0||value.waiting!==0||jobs.length!==0)return;
    if(serial?.requestId&&!serial.invalid&&serial.completed?.outcome==='complete'){
      const old=serial.before,usage=serial.completed.usage;
      const difference=key=>Number.isFinite(value[key])&&Number.isFinite(old[key])?value[key]-old[key]:null;
      const one=['requests','decode_count','prefill_count'].every(key=>difference(key)===1)
        &&(value.computed_count==null&&old.computed_count==null||difference('computed_count')===1);
      const tokens=difference('decode_tokens');
      if(one&&count(usage?.completion_tokens)&&tokens===usage.completion_tokens&&tokens>0){
        for(const [phase,tokenKey,timeKey]of [['prefill','prefill_tokens','prefill_seconds'],['decode','decode_tokens','decode_seconds']]){
          const tokens=difference(tokenKey),seconds=difference(timeKey);
          if(tokens>0&&seconds>0)this.samples.push({workerId:worker.id,identity:worker.identity,model:worker.model,requestId:serial.requestId,
            phase,tokens,seconds,concurrency:1,scope:'request',waitExcluded:true,concurrencyStable:true});
        }
        this.samples=this.samples.slice(-4096);this.save();
      }
    }
    // Reanchor only at native and gateway idle; ambiguity loses a sample,
    // never a request. Queuing time is absent from native phase durations.
    this.serial.set(worker.id,{before:value,identity:worker.identity});
  }
  // vLLM publishes cumulative per-request phase counters: how many prefills/
  // decodes finished, the tokens they moved and the seconds they took. Their
  // ratios are mean per-request phase rates taken from inside the engine, so
  // queueing is already excluded — unlike poll-interval throughput, which
  // divides engine-wide tokens by wall time and mixes concurrency. This is the
  // only path that yields measurements on a vLLM lane that is never fully idle.
  // A sample is emitted only for a delta that actually completed work, and is
  // discarded on any identity/epoch change.
  //
  // The executing count moves constantly as requests finish, so requiring it to
  // be equal across the interval would discard nearly every real window — the
  // over-conservatism that starved this estimator. The completed requests ran
  // under the concurrency of their own lifetime, so the row is bucketed at the
  // observed mean over the interval and labelled as that approximation. Both
  // ends must still be non-idle: with an idle end the bucket is ambiguous.
  observeEnginePhases(worker, value, before, changed) {
    this.attempt(() => {
      const prior = before?.value;
      if (changed || !prior || value?.source !== 'vllm' || prior.source !== 'vllm') return;
      if (!value.connected || !Number.isFinite(value.at) || !Number.isFinite(prior.at)) return;
      const seconds = (value.at - prior.at) / 1000;
      if (!(seconds > 0 && seconds <= 15)) return;
      if (!count(value.running) || !count(prior.running) || value.running < 1 || prior.running < 1) return;
      const concurrency = Math.max(1, Math.round((value.running + prior.running) / 2));
      const phases = [['prefill', 'prefill_count', 'prefill_tokens', 'prefill_seconds'],
        ['decode', 'decode_count', 'decode_tokens', 'decode_seconds']];
      for (const [phase, countKey, tokenKey, timeKey] of phases) {
        const events = value[countKey] - prior[countKey];
        const tokens = value[tokenKey] - prior[tokenKey];
        const duration = value[timeKey] - prior[timeKey];
        if (!count(events) || events < 1) continue;
        if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(duration) || duration <= 0) continue;
        // Mean work per completed request in the interval. The ratio is the same
        // as the total delta ratio; per-request sizing keeps the row honest.
        // concurrencyStable is false when the two ends disagree: the rate is
        // still a real engine measurement, but it spans more than one regime, and
        // a consumer must not treat it as a constant-concurrency row.
        const sequence = this.engineEmitted.get(worker.id) ?? 0;
        this.engineEmitted.set(worker.id, sequence + 1);
        this.samples.push({workerId: worker.id, identity: worker.identity, model: worker.model,
          requestId: `engine:${worker.id}:${phase}:${sequence}`, phase, tokens: tokens / events,
          seconds: duration / events, concurrency, scope: 'request',
          waitExcluded: true, concurrencyStable: prior.running === value.running, engineAggregate: true});
        this.state.engineSamples = (this.state.engineSamples ?? 0) + 1;
      }
      this.samples = this.samples.slice(-4096); this.save();
    });
  }
  evaluate({job, workers, currentWorkerId, marginSeconds, eligibility}) {
    return this.attempt(() => {
      const outputModel = {fit: fitOutputLengths(this.outputs)};
      const normalized = workers.map(worker => ({...worker,
        queue: worker.queue.map(queued => this.request(queued, workers)),
        running: worker.running.map(active => {
          const request = this.request(active, workers), row = worker.native?.request_rows?.find(row => row.id === active.id && row.model === worker.model);
          const current = worker.native?.connected && fresh(worker.native?.activity_at, this.now());
          // Engine row present: a prefill/decode row is a real observation; a row
          // in any other phase (waiting/preparing/cache-restore) means the engine
          // holds the request but has produced no measured work yet. Treat that as
          // a request at the start of prefill — conservative, because it assumes
          // nothing is done, and labelled 'estimated' — instead of leaving progress
          // null. A null progress made the whole lane's remaining time unavailable,
          // so one queued request on a fast lane scored its every running request
          // as 'running_progress_unavailable' and the lane lost placements it
          // should have won. Finite-but-labelled beats unscoreable.
          let progress = null;
          if (current && row) progress = ['prefill', 'decode'].includes(row.phase)
            ? {evidence: 'observed', phase: row.phase, generatedTokens: row.phase === 'prefill' ? 0 : row.generatedTokens,
              computedInputTokens: row.computedTokens}
            : {evidence: 'estimated', phase: 'prefill', generatedTokens: 0, computedInputTokens: 0};
          if (row?.phase === 'prefill' && count(row.totalTokens)) request.inputTokens = row.totalTokens;
          // Native prefill progress is already uncached work; do not subtract
          // an historical reusable prefix a second time.
          if (row?.phase === 'prefill') request.cache = {};
          let rateSamples=this.samples,concurrency=worker.native?.running ?? worker.running.length;
          const basis=active.routingProgressBasis;
          if(!progress&&!row&&basis?.identity===worker.identity&&this.now()>=basis.at){
            const elapsed=(this.now()-basis.at)/1000, prefillSeconds=basis.inputTokens/basis.prefill;
            request.inputTokens=basis.inputTokens;request.cache={};concurrency=basis.concurrency;
            progress=elapsed<prefillSeconds?{evidence:'estimated',phase:'prefill',generatedTokens:0,computedInputTokens:Math.floor(elapsed*basis.prefill)}
              :{evidence:'estimated',phase:'decode',generatedTokens:Math.floor((elapsed-prefillSeconds)*basis.decode)};
            rateSamples=['prefill','decode'].map(phase=>({workerId:worker.id,identity:worker.identity,model:worker.model,requestId:active.id,
              phase,tokens:basis[phase],seconds:1,concurrency,scope:'request',waitExcluded:true,concurrencyStable:true}));
          }
          const estimate = remainingServiceEstimate({job: request, worker, fleet: workers, samples: rateSamples,
            concurrency, outputModel, progress});
          return {id: active.id, key: active.key, slotIndex:active.slotIndex, remainingSeconds: estimate.seconds,progressEvidence:progress?.evidence??'unavailable'};
        })}));
      // Unmatched native work is not free capacity. Its unknown remaining time
      // makes timing unavailable without changing actual gateway admissions.
      for (const worker of normalized) if (worker.native?.connected && fresh(worker.native?.at, this.now())
        && (worker.native.running > worker.running.length || worker.native.waiting > 0)) worker.running.push({remainingSeconds: null});
      const decision = chooseRoute({job: this.request(job, workers), workers: normalized, currentWorkerId,
        samples: this.samples, outputModel, marginSeconds, eligibility});
      // The mode of THIS comparison, not a fixed label: the panel showed
      // 'observation_only' while the live policy was 'active', which reads as a
      // contradiction to anyone watching the routing decision.
      const summary = {mode: this.state.mode, at: this.now(), action: decision.action, reason: decision.reason,
        source: currentWorkerId, destination: decision.workerId, marginSeconds,
        savingSeconds: decision.savingSeconds ?? null,
        candidates: decision.candidates.map(row => ({workerId: row.workerId, eligible: row.eligible,
          completionSeconds: row.completionSeconds, waitingSeconds: row.waitingSeconds, reason: row.reason,
          inputEvidence: row.service?.input.evidence ?? null, speedEvidence: row.service?.decode.evidence ?? null}))};
      this.state.evaluations++; this.state.last = summary;
      return summary;
    });
  }
  save() {
    if (!this.filename || this.state.storageError) return;
    this.dirty = true;
    if (this.writing) return;
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const data = JSON.stringify({version: 1, outputs: this.outputs, samples: [...(this.restoredSamples ?? []), ...this.samples].slice(-4096)});
        await fsp.mkdir(path.dirname(this.filename), {recursive: true, mode: 0o700});
        const temporary = `${this.filename}.${randomUUID()}.tmp`;
        try {
          const handle = await fsp.open(temporary, 'wx', 0o600);
          try {await handle.writeFile(data); await handle.sync();} finally {await handle.close();}
          await fsp.rename(temporary, this.filename);
        } finally {await fsp.rm(temporary, {force: true}).catch(() => {});}
      }
    })().catch(() => {this.state.storageError = 'Routing history could not be saved; inference unchanged';})
      .finally(() => {this.writing = null; if (this.dirty && !this.state.storageError) this.save();});
  }
  async close() {this.closed = true; while (this.writing) await this.writing;}
}
