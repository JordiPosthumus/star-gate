import {queueChoice} from './queue-choice.mjs';
import {createOmlxEnrollment,restoreOmlxEnrollments} from './recovery-omlx-enrollment.mjs';
import {createPairEnrollment,restorePairEnrollments} from './recovery-pair-enrollment.mjs';
import {requestAuthorized} from './request-auth.mjs';
import {createMediaHosts} from './media-hosts.mjs';
import {createMediaSetup} from './media-setup.mjs';
import { ReasoningLoopObserver } from './reasoning-loop.mjs';
import {genieCapabilityKeys,validateGenieCapabilities,genieCapabilities} from './fleet-feature-config.mjs';
import {createMediaExecution} from './media-execution.mjs';
import {sparkServiceBinding,validateServiceAddition,applyServiceAddition,restoreSparkServices} from './spark-services.mjs';
import {MediaJobs,handleMediaRequest} from './media-jobs.mjs';
import {inspectMediaJobInputs} from './media-input-placement.mjs';
import {activeJobs,activeCount,requestCapacity,oldestActive} from './worker-activity.mjs';
import {GENIE_KEY_HEADER,isGenieRequest,PRIORITY_HEADER,requestPriority,priorityRank,priorityIndex,priorityOrder} from './job-priority.mjs';
import {outputShape} from './output-shape.mjs';
import {upstreamAgentOptions} from './upstream-agent.mjs';
import http from 'node:http';
import {compose,PassThrough} from 'node:stream';
import {servingProfiles,servingProfileTransform} from './serving-profile.mjs';
import {modelAliasTransform} from './model-alias.mjs';
import {MODEL_ROUTE_HEADER,modelRoutes,routeSelection,allowsWorker} from './model-routing.mjs';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { RequestedThinkingObserver } from './requested-thinking.mjs';
import {requestUserExcerpt} from './request-preview.mjs';
import {QueuedBodyBudget,QueuedRequestBody,ROUTING_BODY_WAIT_MS} from './queued-request-body.mjs';
import { Dataset } from './dataset.mjs';
import { clientMetadata, CLIENT_METADATA_HEADER } from './client-metadata.mjs';
import { RoutingShadow } from './routing-shadow.mjs';
import {RoutingObservations,routingRequestMetadata,routingIdentity} from './routing-observations.mjs';
import {EndpointTelemetry} from './endpoint-telemetry.mjs';
import { GenerationFaultObserver, verifyGeneration } from './generation-health.mjs';
import { workerConfig, workerConfigs, workerFields, assertUniqueWorker, sshTargets, replaceSshFallbacks } from './worker-config.mjs';
import { powerWorkers } from './power-scripts.mjs';
import {endpointUrl, endpointTransport, endpointHeaders, endpointMetadata, endpointAliases} from './endpoint.mjs';
import { Recovery } from './recovery.mjs';
import { classifySshFailure } from './recovery-transport.mjs';
import { loadConfig, isMain, gatewayPort, gatewayHost, continuityEnabled } from './config.mjs';
import { AgentControl } from './agent-control.mjs';
import {deadlineTimer,queueTimeout,queueTimeoutMessage} from './deadline.mjs';
import {CALL_ID_HEADER,DISPATCH_HEADER,validCallId,unavailableReason,sessionWork,rejectionReceipt} from './continuity.mjs';
import {JsonUsageObserver} from './json-usage.mjs';

// Quarantine threshold: how many qualifying ENGINE failures a worker may
// accumulate before it is pulled out of rotation. Deliberately generous: a
// flaky transport link must not sideline a healthy worker, so only a worker
// that keeps failing this many times in a row is treated as broken. Any
// completed request clears the streak.
const QUARANTINE_FAILURE_THRESHOLD = 20;

// Transport failures are NOT engine evidence and must never advance the
// quarantine counter. A dead ssh tunnel and a dying engine produce identical
// request outcomes (ECONNRESET/EPIPE) from identical call sites, so the outcome
// string alone cannot separate them. ENGINE_FAILURE_OUTCOMES are the only
// outcomes that prove the engine itself produced a response that failed;
// everything in AMBIGUOUS_FAILURE_OUTCOMES can equally be a severed link, so
// finish() arbitrates those with the ssh supervisor's own state, which a
// separate process writes and the engine cannot influence.
const ENGINE_FAILURE_OUTCOMES = new Set(['incomplete_sse','upstream_engine_error']);
const AMBIGUOUS_FAILURE_OUTCOMES = new Set(['upstream_error','upstream_stream_error','upstream_aborted','connection_closed']);
// Tunnel states the ssh supervisor itself declares broken. It writes these only
// from ssh stderr/error/exit, never from anything the engine reports, and no
// other subsystem writes managementPath except the health probe.
const TRANSPORT_DEAD_STATES = new Set(['ssh_error','retrying']);
import {dsgReport,invalidHttp} from './report.mjs';
import {ClientWatch,CLIENT_WATCH_HEADER,CLIENT_WATCH_ROUTE,validClientWatchId} from './client-watch.mjs';
import {
  buildPiClientBundle,renderPiClientScript,mergePiClientTemplate,piClientProviderObject,PI_CLIENT_KEY,
} from './pi-client-config.mjs';
import {PiClientReports,piClientForDisplay} from './pi-client-reports.mjs';
import {lanAddresses,lanSharingDetails} from './lan-sharing.mjs';
import {JPEG_REJECTION_INSPECTION_BYTES,VisionProtection,visionGuidance,visionRejectionKind} from './vision-protection.mjs';
import {observeJobPreview,clearJobPreview} from './current-jobs.mjs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const validContext = value => Number.isSafeInteger(value) && value > 0;
// Read once per process; these are committed assets, not per-request state.
const piClientDefaultsFile=JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'pi-client-defaults.json'),'utf8'));
// The Windows sync script is a committed template the core injects defaults
// into. Read lazily and cached: the gateway must start and serve traffic even
// if the asset is missing, and the compile check must not depend on it.
let piClientScriptCache;
function piClientScriptTemplate(){
  if(piClientScriptCache===undefined){
    // Cache only a successful read: the asset may legitimately land while the
    // gateway is already running, and a miss must not be sticky.
    try{piClientScriptCache=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'client','pi-stargate-sync.ps1'),'utf8');}
    catch(e){return undefined;}
  }
  return piClientScriptCache;
}
const validOperatorAction=action=>action&&typeof action==='object'&&/^[a-f0-9-]{36}$/.test(action.id)&&['pause','resume'].includes(action.action)&&Array.isArray(action.workers)&&action.workers.length>0&&action.workers.length<=128&&action.workers.every(id=>typeof id==='string'&&/^[a-zA-Z0-9][\w-]{0,63}$/.test(id))&&typeof action.control_channel==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(action.control_channel)&&typeof action.time==='string'&&Number.isFinite(Date.parse(action.time));
export const workerRegistrationTimeout=(config,node)=>config.registration_timeout_ms??Math.max(15000,sshTargets(node).length*15000);
const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardHeaders(headers) {
  const excluded = new Set([...hopHeaders, ...(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !excluded.has(k.toLowerCase())));
}
function json(res, status, value) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function error(res, status, code, message) { json(res, status, { error: { type: 'gateway_error', code, message:dsgReport(message) } }); }

// PID alone is not an identity: after reboot it may belong to an unrelated process.
const processStartedAt = pid => {
  const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 3000, env: {...process.env, LC_ALL: 'C', TZ: 'UTC'},
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!value) throw new Error(`Cannot establish state-lock owner identity for PID ${pid}`);
  return value;
};
let ownProcessStartedAt;

// Tiny durable metadata store. No prompts, model outputs, or KV data live here.
// Atomic replace + fsync; an unreadable/corrupt store fails startup, never resets.
export class AffinityStore {
  constructor(filename) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.lock = `${filename}.lock`;
    const startedAt = ownProcessStartedAt ??= processStartedAt(process.pid);
    const acquire = () => fs.openSync(this.lock, 'wx', 0o600);
    let fd;
    try { fd = acquire(); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = JSON.parse(fs.readFileSync(this.lock, 'utf8'));
      if (!Number.isInteger(old.pid) || old.pid <= 1) throw new Error('Invalid state lock; inspect manually');
      if (old.process_started_at !== undefined && (typeof old.process_started_at !== 'string' || !old.process_started_at.trim())) throw new Error('Invalid state lock identity; inspect manually');
      let alive = true;
      try { process.kill(old.pid, 0); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; alive = false; }
      // Legacy live-PID locks and unreadable identities remain protected.
      if (alive && (!old.process_started_at || old.process_started_at === processStartedAt(old.pid))) throw new Error(`State already locked by PID ${old.pid}`);
      fs.unlinkSync(this.lock);
      fd = acquire();
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, process_started_at: startedAt })); fs.fsyncSync(fd); fs.closeSync(fd);
    try {
      let data = { version: 1, sessions: {} };
      if (fs.existsSync(filename)) data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (data.version !== 1 || !data.sessions || Array.isArray(data.sessions)) throw new Error('Invalid affinity store');
      if (data.pool_context_length !== undefined && !validContext(data.pool_context_length)) throw new Error('Invalid saved pool context limit');
      if(data.conversation_turns!==undefined&&(!Number.isSafeInteger(data.conversation_turns)||data.conversation_turns<1))throw new Error('Invalid saved conversation turn allowance');
      if(data.queue_timeout_ms!==undefined){if(typeof data.queue_timeout_ms!=='number')throw new Error('Invalid saved queue allowance');queueTimeout(data.queue_timeout_ms);}
      if(data.direct_reserve_enabled!==undefined&&typeof data.direct_reserve_enabled!=='boolean')throw new Error('Invalid saved direct-reserve toggle');
      if(data.quarantined!==undefined && (!data.quarantined || typeof data.quarantined!=='object' || Array.isArray(data.quarantined)))throw new Error('Invalid saved quarantine state');
      if(data.archived!==undefined && (!data.archived || typeof data.archived!=='object' || Array.isArray(data.archived) || Object.values(data.archived).some(v=>typeof v!=='boolean')))throw new Error('Invalid saved archived state');
      if(data.protections!==undefined&&(!data.protections||typeof data.protections!=='object'||Array.isArray(data.protections)||Object.keys(data.protections).some(k=>k!=='vision_jpeg')||(data.protections.vision_jpeg!==undefined&&typeof data.protections.vision_jpeg!=='boolean')))throw new Error('Invalid saved protection state');
      if(data.operator_actions!==undefined&&(!Array.isArray(data.operator_actions)||data.operator_actions.length>256||data.operator_actions.some(action=>!validOperatorAction(action))))throw new Error('Invalid saved operator action history');
      if(data.operator_action_heads!==undefined&&(!data.operator_action_heads||typeof data.operator_action_heads!=='object'||Array.isArray(data.operator_action_heads)||Object.entries(data.operator_action_heads).some(([id,action])=>!validOperatorAction(action)||!action.workers.includes(id))))throw new Error('Invalid saved current operator actions');
      for(const entry of Object.values(data.quarantined??{}))if(!entry || !['fatal_accelerator_error','accelerator_checkpoint_failure','repeated_inference_failures'].includes(entry.reason) || typeof entry.request_id!=='string' || !Number.isFinite(Date.parse(entry.at)))throw new Error('Invalid saved quarantine entry');
      for (const [key, item] of Object.entries(data.sessions)) {
        if (!/^[a-f0-9]{64}$/.test(key) || typeof item.node !== 'string') throw new Error('Invalid affinity entry');
      }
      data.genie_capabilities=validateGenieCapabilities(data.genie_capabilities);
      this.data = data;
    } catch (e) { this.close(); throw e; }
  }
  get(key) { return this.data.sessions[key]; }
  count(node) { return Object.values(this.data.sessions).filter(s => s.node === node).length; }
  set(key, node) {
    this.save({ ...this.data, sessions: { ...this.data.sessions, [key]: { node, assigned_at: new Date().toISOString() } } });
  }
  setDrained(ids, drained) {
    const next = { ...this.data, drained: { ...this.data.drained } };
    for (const id of ids) next.drained[id] = drained;
    this.save(next);
  }
  // Archive is presentation-only: it keeps the registration (so sessions, scripts
  // and history survive) and hides the worker from the main Fleet view. It never
  // replaces draining — a worker must already be routing-paused to be archived.
  setArchived(ids, archived) {
    const next = { ...this.data, archived: { ...this.data.archived } };
    for (const id of ids) { if (archived) next.archived[id] = true; else delete next.archived[id]; }
    this.save(next);
  }
  setWorkers(workers, drained = this.data.drained ?? {}) {
    this.save({ ...this.data, workers, drained });
  }
  save(next) {
    const tmp = `${this.filename}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.filename);
    const dir = fs.openSync(path.dirname(this.filename), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    this.data = next;
  }
  close() { if (this.lock) { fs.unlinkSync(this.lock); this.lock = null; } }
}

// Buffers at most one SSE line to observe usage and semantic progress. Forwarded bytes are
// never decoded/re-encoded. No answer/reasoning text is logged.
export class UsageObserver {
  phase='awaiting_content';semanticCharacters=0;lastSemanticAt=null;
  thinkingCharacters=0;answerCharacters=0;toolCharacters=0;firstSemanticAt=null;
  outputPresent=false;shapeComplete=true;
  pending = ''; usage = undefined; done = false; finish_reason = null;
  skipping = false; limited = false; failed = false; decoder = new StringDecoder('utf8');
  eventBoundary = true; closed = false; afterCR = false;
  singleChoiceFinish=false; reasonEofAmbiguous=false; reasonEventDataLines=0;
  constructor(route='/v1/chat/completions',{loopObserver=null}={}){this.route=route;this.loopObserver=loopObserver;}
  accept(chunk) {
    if(this.closed)return;
    // Bound transient decoding even if accept receives one enormous chunk.
    // After overflow, discard through the actual newline, not just this chunk.
    for(let i=0;i<chunk.length;i+=4096) {
      let text=this.decoder.write(chunk.subarray(i,i+4096));
      if(!text.length)continue;
      // SSE accepts CR, LF and CRLF. A CR already ended the previous line;
      // swallow its optional LF even across input/decoder chunk boundaries.
      // Otherwise a split CRLF would invent a blank event boundary.
      if(this.afterCR&&text.startsWith('\n'))text=text.slice(1);
      this.afterCR=text.endsWith('\r');
      for(const [j,part] of text.split(/\r\n|[\r\n]/).entries()) {
        if(j) {
          if(!this.skipping){const blank=this.pending.trim().length===0;this.line();this.eventBoundary=blank;}
          else this.eventBoundary=false;
          this.pending='';this.skipping=false;
        }
        if(!this.skipping) {
          if(this.pending.length+part.length>1048576){this.pending='';this.skipping=true;this.limited=true;}
          else this.pending+=part;
        }
      }
    }
  }
  line() {
    const line=this.pending.trim();
    if(!line){
      if(!/^\r?$/.test(this.pending))this.reasonEofAmbiguous=true;
      this.reasonEventDataLines=0;
    }
    if(!line.startsWith('data:'))return;
    if(!this.pending.startsWith('data:'))this.reasonEofAmbiguous=true;
    if(++this.reasonEventDataLines>1)this.reasonEofAmbiguous=true;
    const payload=line.slice(5).trim();
    if(payload==='[DONE]'){
      if(['/v1/chat/completions','/v1/completions'].includes(this.route))this.done=true;
      return;
    }
    try {
      const parsed=JSON.parse(payload),u=parsed.usage,reason=parsed.choices?.[0]?.finish_reason;
      if(['/v1/chat/completions','/v1/completions'].includes(this.route)){
        const choices=parsed.choices;
        // A clean EOF after an explicit single-choice finish is accepted by Pi.
        // Retain [DONE] separately. Never infer completion from partial events,
        // multiple choices, malformed data, or more output after the finish.
        if(Array.isArray(choices)&&choices.length===0&&u&&typeof u==='object'){}
        else if(!Array.isArray(choices)||choices.length!==1||choices[0]?.index!==0||this.singleChoiceFinish)this.reasonEofAmbiguous=true;
        else if(['stop','length','tool_calls','function_call','content_filter'].includes(reason))this.singleChoiceFinish=true;
        else if(reason!=null)this.reasonEofAmbiguous=true;
      }
      const delta=parsed.choices?.[0]?.delta;
      const progress=(text,phase)=>{if(typeof text==='string'&&text.length){this.semanticCharacters+=text.length;this.lastSemanticAt=performance.now();this.firstSemanticAt??=this.lastSemanticAt;this.phase=phase;if(phase==='thinking')this.thinkingCharacters+=text.length;else if(phase==='answering')this.answerCharacters+=text.length;else if(phase==='tool_output')this.toolCharacters+=text.length;}};
      if(delta) {
        // Loop detection reads reasoning text in flight and retains only line
        // hashes; the text itself is never stored or reported.
        if(this.loopObserver)this.observeReasoning(delta.reasoning_content??delta.reasoning??delta.reasoning_text);
        const shape=outputShape(delta);
        this.outputPresent ||= shape.output_present;
        this.shapeComplete &&= shape.observation_complete;
        // Use lengths directly: observed text is never retained for reporting.
        for(const [key,phase] of [['thinking_characters','thinking'],['answer_characters','answering'],['tool_characters','tool_output']]){
          const n=shape[key];if(!n)continue;
          this.semanticCharacters+=n;this.lastSemanticAt=performance.now();this.firstSemanticAt??=this.lastSemanticAt;this.phase=phase;
          if(phase==='thinking')this.thinkingCharacters+=n;else if(phase==='answering')this.answerCharacters+=n;else this.toolCharacters+=n;
        }
      } else if(parsed.type==='content_block_delta') {
        const d=parsed.delta;if(d?.type==='thinking_delta')progress(d.thinking,'thinking');
        else if(d?.type==='text_delta')progress(d.text,'answering');
        else if(d?.type==='input_json_delta')progress(d.partial_json,'tool_output');
      } else if(['response.output_text.delta','response.reasoning_summary_text.delta','response.reasoning_text.delta','response.function_call_arguments.delta'].includes(parsed.type)) {
        progress(parsed.delta,parsed.type.includes('reasoning')?'thinking':parsed.type.includes('arguments')?'tool_output':'answering');
      }
      const count=x=>Number.isFinite(x)&&x>=0?x:undefined;
      if(parsed.type==='error' || parsed.error)this.failed=true;
      if(this.route==='/v1/messages') {
        if(parsed.type==='message_stop')this.done=true;
        if(parsed.type==='message_delta')this.finish_reason=({end_turn:'stop',stop_sequence:'stop',tool_use:'tool_calls',max_tokens:'length'})[parsed.delta?.stop_reason]??null;
        // Anthropic usage has different cache accounting; leave it unknown
        // until its full start/delta contract is explicitly instrumented.
        return;
      }
      if(this.route==='/v1/responses') {
        if(['response.completed','response.incomplete','response.failed'].includes(parsed.type)) {
          const r=parsed.response;
          if(!r || !['completed','incomplete','failed'].includes(r.status))return;
          this.done=true;
          if(parsed.type==='response.failed' || r.status==='failed' || r.error)this.failed=true;
          else if(parsed.type==='response.completed' && r.status==='completed')this.finish_reason='stop';
          else if(['max_tokens','max_output_tokens'].includes(r.incomplete_details?.reason))this.finish_reason='length';
          else this.finish_reason=null;
          if(r.usage)this.usage={prompt_tokens:count(r.usage.input_tokens),completion_tokens:count(r.usage.output_tokens),cached_tokens:count(r.usage.input_tokens_details?.cached_tokens)};
        }
        return;
      }
      if(['stop','length','tool_calls','function_call','content_filter'].includes(reason))this.finish_reason=reason;
      if(u)this.usage={prompt_tokens:count(u.prompt_tokens),completion_tokens:count(u.completion_tokens),cached_tokens:count(u.prompt_tokens_details?.cached_tokens)};
    } catch { this.reasonEofAmbiguous=true; /* A telemetry failure must not affect inference. */ }
  }
  // Reasoning text arrives as partial deltas; a line is only complete when a
  // newline appears. Buffer the partial tail (bounded) and feed whole lines.
  observeReasoning(text) {
    if (typeof text !== 'string' || !text.length) return;
    if (this.loopTail === undefined) this.loopTail = '';
    this.loopTail += text;
    if (this.loopTail.length > 65536) this.loopTail = this.loopTail.slice(-8192);
    let index;
    while ((index = this.loopTail.indexOf('\n')) !== -1) {
      const line = this.loopTail.slice(0, index);
      this.loopTail = this.loopTail.slice(index + 1);
      this.loopObserver.acceptLine(line);
      if (this.loopObserver.detected) return;
    }
  }
  finishState({cleanEOF=true}={}) {    if(!this.closed){
      const tail=this.decoder.end();this.closed=true;
      if(tail&&!this.skipping){
        if(this.pending.length+tail.length>1048576){this.pending='';this.skipping=true;this.limited=true;}
        else this.pending+=tail;
      }
    }
    if(this.failed)return 'engine_error';
    if(this.done){
      // [DONE] proves the marker arrived, not that a strict harness accepted
      // the turn. Keep observation gaps distinct from a known absent reason.
      if(['/v1/chat/completions','/v1/completions'].includes(this.route)&&!this.finish_reason)
        return this.limited?'terminal_reason_unobserved':'terminal_without_finish_reason';
      return 'terminal';
    }
    if(this.limited)return 'observation_limited';
    if(this.skipping||this.pending.length>0||!this.eventBoundary)return 'partial_sse_event';
    if(cleanEOF&&this.singleChoiceFinish&&!this.reasonEofAmbiguous)return 'terminal_without_done';
    return 'clean_eof_no_terminal';
  }
}

export function createGateway(config,{visionTranscode,tunnelFactory=superviseTunnel,routingFetcher}={}) {
  if (!validContext(config.context_length)) throw new Error('Invalid configured pool context limit');
  if (config.model_agnostic !== undefined && typeof config.model_agnostic !== 'boolean') throw new Error('model_agnostic must be a boolean');
  const configuredQueueTimeout=queueTimeout(config.queue_timeout_ms);
  const configuredConversationTurns=config.conversation_turns??5;
  const conversationTurnIdleMs=config.conversation_turn_idle_ms??2000;
  if(!Number.isSafeInteger(configuredConversationTurns)||configuredConversationTurns<1)throw new Error('conversation_turns must be a positive whole number');
  if(!Number.isSafeInteger(conversationTurnIdleMs)||conversationTurnIdleMs<0||conversationTurnIdleMs>2147483647)throw new Error('conversation_turn_idle_ms must be a whole millisecond count from 0 to 2147483647');
  if(config.routing_time_enabled!==undefined&&typeof config.routing_time_enabled!=='boolean')throw new Error('routing_time_enabled must be boolean');
  const timeRouting=config.routing_time_enabled===true;
  const configuredFastWorkers=config.routing_fast_workers??[];
  const fastWorkerIds=Array.isArray(configuredFastWorkers)?[...configuredFastWorkers]:configuredFastWorkers;
  if(!Array.isArray(fastWorkerIds)||fastWorkerIds.some(id=>typeof id!=='string'||!id)||new Set(fastWorkerIds).size!==fastWorkerIds.length)
    throw new Error('routing_fast_workers must be an array of unique worker IDs');
  const initial = workerConfigs(config.nodes);
  if(config.media_jobs!==undefined&&(!config.media_jobs||typeof config.media_jobs!=='object'||typeof config.media_jobs.enabled!=='boolean'))throw new Error('media_jobs.enabled must be a boolean');
  const store = new AffinityStore(config.state_file);
  let mediaJobs;
  try{if(config.media_jobs?.enabled)mediaJobs=new MediaJobs(path.join(path.dirname(config.state_file),'media-jobs.json'),{inputLimits:config.media_jobs});}catch(e){store.close();throw e;}
  const conversationTurns=()=>store.data.conversation_turns??configuredConversationTurns;
  const queueTimeoutMs=()=>store.data.queue_timeout_ms??configuredQueueTimeout;
  // Like registered workers, an explicit UI setting survives process restarts.
  const contextLimit = () => store.data.pool_context_length ?? config.context_length;
  const requiredContext = node => node.route_only ? node.context_length : contextLimit();
  const makeNode = n => ({ ...n, drained: store.data.drained?.[n.id] === true, archived: store.data.archived?.[n.id] === true, quarantine:store.data.quarantined?.[n.id] ?? null, inferenceFailures:0, transportFailures:0, healthy: false, failures: 0, slots: [{}], get active(){return oldestActive(this);}, queue: [], completed: 0, failed: 0, protected:0, observationLimited:0, probing: false, healthProbeDeferred:0,
    managementPath:n.ssh?{transport:'ssh_tunnel',state:'pending',reason:null,attempts:0,route_count:sshTargets(n).length,changed_at:new Date().toISOString(),last_verified_at:null}:{transport:'local',state:'local',reason:null,attempts:0,route_count:0,changed_at:new Date().toISOString(),last_verified_at:null} });
  let definitions;
  try {
    definitions = store.data.workers === undefined ? initial : workerConfigs(store.data.workers);
    if(fastWorkerIds.some(id=>![...initial,...definitions].some(worker=>worker.id===id)))
      throw new Error('routing_fast_workers contains an unknown worker ID');
  }
  catch (e) { store.close(); throw e; }
  const serviceConfig={...config,recovery:structuredClone(config.recovery),media_jobs:structuredClone(config.media_jobs),genie_chat:structuredClone(config.genie_chat)};
  try { restoreSparkServices(serviceConfig,store.data.spark_services??{},definitions); restorePairEnrollments(serviceConfig,store.data.pair_recovery_enrollments??{},definitions); restoreOmlxEnrollments(serviceConfig,store.data.omlx_recovery_enrollments??{},definitions); }
  catch(e){store.close();throw e;}
  // Persisted registrations are authoritative after removals. Keep dormant profile/route
  // definitions intact, but they cannot make a removed worker routable or block restart.
  const registryOptions={allowUnregistered:store.data.workers!==undefined};
  let profiles;try{profiles=servingProfiles(config.serving_profiles,definitions,registryOptions);}catch(e){store.close();throw e;}
  const nodes = definitions.map(makeNode);
  let routes;try{routes=modelRoutes(config.model_routes,definitions,registryOptions);}catch(e){store.close();throw e;}
  const dataset = new Dataset(path.join(path.dirname(config.state_file),'requests'),{enabled:config.dataset_enabled===true});
  const shadow = new RoutingShadow({enabled:config.routing_shadow_enabled===true && config.dataset_enabled===true});
  const routingObservations=new RoutingObservations({enabled:timeRouting||config.routing_time_observe===true,mode:timeRouting?'active':'observation_only',
    filename:path.join(path.dirname(config.state_file),'routing-estimates.json')});
  const routingMargin=()=>store.data.routing_switching_margin_seconds??config.routing_switching_margin_seconds??30;
  if(!Number.isFinite(routingMargin())||routingMargin()<0){store.close();throw new Error('Switching margin must be a finite non-negative number of seconds');}
  const routingTelemetry=routingObservations.enabled?new EndpointTelemetry({includeLegacy:true,fetcher:routingFetcher,onSample:(id,value)=>{
    const node=nodes.find(node=>node.id===id);if(node)routingObservations.observeNative(routingWorker(node),value,activeJobs(node));
  }}):null;
  const observe = fn => {if(shadow.enabled)try{return fn();}catch{shadow.state.errors++;}};
  let draining = false, shuttingDown = false, healthTimer, recoveryTimer, waitingTimer, routingTimer;
  const startup={barrier:continuityEnabled(config),complete:false,started_at:new Date().toISOString(),completed_at:null,unavailable:[]};
  // Undispatched HTTP requests only. Bodies remain on their original streams,
  // with backpressure; no prompt spool and no optimistic 200/SSE response.
  const waiting=[];
  let sequence=0;
  const relocation={completed:0,rejected:0,last:null};
  // This may influence only genuinely new/unaffined work, where no established
  // cache home exists. It still abstains unless every tied worker has fresh
  // forecasts from the deployed, independently validated models.
  const nextQueued=node=>node?node.queue[priorityIndex(node.queue)]:undefined;
  const queueBound=()=>config.max_queued_per_node??128;
  const waitingBound=()=>Math.max(1,nodes.length)*queueBound();
  // Long affinity-bound waits must not depend on the dashboard/Genie process.
  // The warm home gets first refusal, then the core may trade unknown cache
  // locality for a truly empty compatible server. `false` keeps strict affinity.
  const automaticAffinityWait=config.automatic_affinity_rebalance_min_wait_ms===false?null:(config.automatic_affinity_rebalance_min_wait_ms??300000);
  if(automaticAffinityWait!==null&&(!Number.isSafeInteger(automaticAffinityWait)||automaticAffinityWait<0))throw new Error('automatic_affinity_rebalance_min_wait_ms must be false or a non-negative whole millisecond count');
  const automaticRelocationScope=timeRouting?'completion_time_margin':automaticAffinityWait===null?'first_dsg_request_or_unaffined':'first_unaffined_or_affinity_wait_expired';
  const parkedFor=n=>waiting.filter(j=>j.fixedHome===n);
  const rejections=[];
  const clientWatch=new ClientWatch();
  const queuedBodyBudget=new QueuedBodyBudget();
  const currentJobs=()=>[...nodes.flatMap(node=>[...activeJobs(node),...node.queue]),...waiting];
  const jobEligible=job=>!draining&&!shuttingDown&&job.node?.healthy&&!job.node.drained&&!job.node.quarantine&&!job.node.recovering&&!job.node.removed&&!job.waitReason&&(!job.key||!nodes.some(node=>activeJobs(node).some(active=>active.key===job.key)));
  // Request previews are local, transient UI data. They never enter scheduling,
  // general status, logs, the request journal, or Genie prompts.
  function currentJobsStatus(){
    const jobs=currentJobs();
    return {schema:1,queue_priority_version:1,genie_progress_version:1,observed_at:Date.now(),queued_body:{buffered_bytes:queuedBodyBudget.used,budget_bytes:queuedBodyBudget.limit},jobs:jobs.slice(0,512).map(job=>({
      request_id:job.id,call_id:job.trafficClass==='genie'?job.callId:null,traffic_class:job.trafficClass,priority:job.priority,priority_policy:job.geniePriority?'genie':null,chat:job.key??null,title:null,request_preview:job.preview??null,machine:job.node?.id??job.fixedHome?.id??null,
      state:job.dispatched?'running':job.waitReason||!jobEligible(job)?'blocked':'queued',
      request_reason:job.dispatched?'Request is already running':job.waitReason??(job.node?.drained?'Routing is paused':!jobEligible(job)?'Worker or conversation is not eligible':null),
      waiting_ms:job.dispatched?Math.max(0,job.dispatchedMono-job.createdMono):Math.max(0,performance.now()-job.createdMono),
      running_ms:job.dispatched?Math.max(0,performance.now()-job.dispatchedMono):null,
      routing_observation:job.routingObservation??null,routing_decision:job.routingDecision??null
    })),jobs_truncated:jobs.length>512};
  }
  function setJobPriority(input){
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expected_priority,priority,request_id'||typeof input.request_id!=='string'||!input.request_id)
      throw new Error('Specify request_id, expected_priority and priority only');
    if(input.priority===undefined||input.expected_priority===undefined)throw new Error('Specify both the current and requested priority');
    const priority=requestPriority(input.priority),expected=requestPriority(input.expected_priority);
    const conflict=message=>{throw Object.assign(new Error(message),{status:409,code:'job_priority_conflict'});};
    const job=currentJobs().find(job=>job.id===input.request_id&&!job.cancelled);
    if(!job)return conflict('This request has finished or left the queue; refresh Current Jobs');
    if(job.dispatched||job.upstream)return conflict('This request is already running; its priority was left unchanged');
    if(job.priority!==expected)return conflict('This request’s priority changed; refresh Current Jobs before retrying');
    const previous=job.priority;job.priority=priority;
    if(previous!==priority)log('queued_priority_changed',{request_id:job.id,previous,priority});
    // Keep body, queue deadline, placement and conversation sequence intact.
    // Existing admission/dispatch checks still decide which work is eligible.
    pumpWaiting();for(const node of nodes)schedule(node);
    return {request_id:job.id,previous,priority,state:job.dispatched?'running':'waiting'};
  }
  function reject(req,res,status,code,message,{id=randomUUID(),callId=validCallId(req.headers[CALL_ID_HEADER]),key=null,node=null,reason}={}){
    const receipt=rejectionReceipt({request_id:id,call_id:callId,session:key,node:node?.id??null,code,reason});
    const recorded={time:new Date().toISOString(),...receipt};
    rejections.unshift(recorded);rejections.length=Math.min(rejections.length,32);
    clientWatch.observeRequest(req.headers[CLIENT_WATCH_HEADER],id,'rejected');
    log('request_rejected',receipt);dataset.record('rejection',receipt);
    if(!res.headersSent&&!res.destroyed){res.setHeader(DISPATCH_HEADER,'not_dispatched');res.setHeader('x-request-id',id);res.setHeader('retry-after','5');}
    json(res,status,{error:{type:'gateway_error',code,message:dsgReport(message),request_id:id,continuity:receipt}});
    req.resume();
  }
  let mutation = Promise.resolve();
  const serialize = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
  const definition = n => Object.fromEntries(workerFields.filter(k => n[k] !== undefined).map(k => [k,n[k]]));
  // Script-only fleet entries (power switches with no routing registration).
  // These are the lanes that still show start/stop scripts but are not current
  // recipes; archive hides them from the Fleet view without touching routing.
  const scriptEntries = new Set(powerWorkers());
  let recovery;
  try { recovery=new Recovery(serviceConfig.recovery,{store,nodes,model:config.model,stopping:()=>shuttingDown||draining,log,fleetConfig:serviceConfig,directReserved,isPairQualificationEnabled:()=>capabilityStatus().server_changes&&capabilityStatus().inspection,isOmlxQualificationEnabled:()=>capabilityStatus().server_changes&&capabilityStatus().inspection,
    reinstate:(n,expected,recoveryState)=>{
      if(n.removed || n.drained || n.active || (n.queue.length&&!recovery.omlxReadmissionOwnsQueue(n,recoveryState)) || JSON.stringify(n.quarantine)!==JSON.stringify(expected) || shuttingDown || draining)throw new Error('reinstatement_state_changed');
      const quarantined={...store.data.quarantined};delete quarantined[n.id];
      store.save({...store.data,quarantined,recovery:recoveryState});
      n.quarantine=null;n.inferenceFailures=0;n.transportFailures=0;n.healthy=true;n.failures=0;
      observe(()=>shadow.reset(n.id));
    }}); } catch(e){store.close();throw e;}
  const pairEnrollment=createPairEnrollment({config:serviceConfig,store,recovery,isEnabled:()=>!draining&&!shuttingDown&&capabilityStatus().server_changes&&capabilityStatus().inspection&&recovery.state.automatic});
  const omlxEnrollment=createOmlxEnrollment({config:serviceConfig,store,recovery,isEnabled:()=>!draining&&!shuttingDown&&capabilityStatus().server_changes&&capabilityStatus().inspection&&recovery.state.automatic});
  let agents;
  try {agents=new AgentControl({store,nodes,log,onPause:ids=>recovery.operatorPause(ids),canHandback:async (n,{releasingHoldId})=>recovery.profileHandbackOffer(n,{ignorePause:true,releasingHoldId}),onHandback:()=>void recovery.tick(),canResume:async n=>{
    if(shuttingDown||draining)throw new Error('Gateway is draining; hold retained');
    await freshProbe(n);
    if(shuttingDown||draining||n.recovering||n.quarantine||n.probeError||!n.modelMatches||!validContext(n.contextLength)||n.contextLength<requiredContext(n))throw new Error('Fresh compatible worker readiness required; hold retained');
  }});}catch(e){store.close();throw e;}
  const visionProtection=new VisionProtection(config.vision_compatibility,store,path.dirname(config.state_file),visionTranscode?{transcode:visionTranscode}:undefined);
  const upstreamPoolSockets = Math.max(16,definitions.reduce((sum,node)=>sum+requestCapacity(node),0));
  const agent = new http.Agent(upstreamAgentOptions(upstreamPoolSockets));
  const tlsAgent = new https.Agent(upstreamAgentOptions(upstreamPoolSockets));
  const upstreamOptions = (node, url) => ({ agent: url.protocol === 'https:' ? tlsAgent : agent, headers: node.upstreamHeaders ?? {} });
  // Rewritten uploads buffer up to this bound so the upstream request can carry
  // an exact Content-Length; larger uploads keep streaming chunked.
  const rewriteBufferBytes=Number.isSafeInteger(config.rewrite_buffer_bytes)&&config.rewrite_buffer_bytes>0?config.rewrite_buffer_bytes:268435456;
  const accepted = new Set(['POST /v1/chat/completions', 'POST /v1/completions', 'POST /v1/responses', 'POST /v1/messages', 'GET /v1/models']);
  // Pi client config: committed defaults, optional private override, and the
  // bounded durable report store beside the affinity state. Reverse-proxied
  // routes to the Door, so they are NOT added to the inference allowlist.
  const PI_CLIENT_BUNDLE_ROUTE = '/v1/client/pi';
  const PI_CLIENT_SCRIPT_ROUTE = '/v1/client/pi/install.ps1';
  const PI_CLIENT_REPORT_ROUTE = '/v1/client/pi/report';
  const piClientTemplate=mergePiClientTemplate(piClientDefaultsFile,config.pi_client);
  const piClientReports=new PiClientReports({
    file:path.join(path.dirname(config.state_file),'client-reports.jsonl'),
    redactHosts:[config.host,...lanAddresses(config).map(url=>new URL(url).hostname)].filter(host=>typeof host==='string'&&host.length>0)});
  // Advertise the address clients actually reach: the Door's bind host and port,
  // never the core's private port.
  //
  // The Host header the caller used OUTRANKS any advertised list. The Mac's
  // Bonjour name (.local) is advertised first because it survives DHCP changes,
  // but a Windows client without Bonjour cannot resolve it at all — so a client
  // that reached us by LAN IP would be handed a .local base URL it can never
  // use, and would only discover that when its first inference failed. Echoing
  // the name the client itself resolved keeps the written config reachable by
  // construction. Only a hostname or IP is accepted, never a URL or encoded
  // characters, so the header cannot inject structure into the client config.
  const clientReachableHost=req=>{
    const raw=req.headers.host;
    if(typeof raw!=='string'||raw.length>255)return null;
    const host=raw.trim();
    if(!/^[a-zA-Z0-9](?:[a-zA-Z0-9.\-]{0,251}[a-zA-Z0-9])?(?::\d{1,5})?$/.test(host))return null;
    return host;
  };
  const piClientBaseUrls=req=>{
    const urls=lanAddresses(config);
    const details=lanSharingDetails({urls},config.port);
    const advertised=details.urls?.length?details.urls:[`http://127.0.0.1:${config.port}/v1`];
    const reached=clientReachableHost(req);
    // Demote, never drop: the advertised list stays as fallbacks, so a client
    // that later moves between networks still has the known-good addresses.
    const ordered=reached?[`http://${reached}/v1`,...advertised.filter(url=>url!==`http://${reached}/v1`)]:advertised;
    return {baseUrl:ordered[0],fallbackBaseUrls:ordered.slice(1)};
  };
  const lastOperatorAction=id=>Object.hasOwn(store.data.operator_action_heads??{},id)?store.data.operator_action_heads[id]:[...(store.data.operator_actions??[])].reverse().find(action=>action.workers.includes(id))??null;
  const oldestQueued=queue=>queue.reduce((oldest,job)=>!oldest||job.createdMono<oldest.createdMono?job:oldest,null);

  const capabilityStatus=()=>genieCapabilities(store.data.genie_capabilities,config,recovery.state.automatic);
  const mediaHosts=createMediaHosts(serviceConfig,store,{workers:()=>registry().workers,enrollmentWorker:id=>{const n=nodes.find(n=>n.id===id);return n?definition(n):null;},binding:(id,c)=>recovery.binding(nodes.find(n=>n.id===id),c)});
  const mediaStatus=()=>{const state=mediaExecution.status();return {...state,text_video_supported:!!mediaJobs,...mediaHosts.status(state.jobs),setup:mediaSetup?.status()??null};};
  const mediaExecution=createMediaExecution(serviceConfig,mediaJobs,{workers:()=>nodes.map(definition),isAllowed:mediaHosts.allowed,isEnabled:()=>!draining&&capabilityStatus().media,matchesWorker:(id,c)=>{const n=nodes.find(n=>n.id===id);return !!n&&recovery.binding(n,c);}});
  const mediaSetup=mediaJobs?createMediaSetup(serviceConfig,store,{directory:path.join(path.dirname(config.state_file),'media-setup'),workers:()=>nodes.map(definition),binding:(id,c)=>{const n=nodes.find(n=>n.id===id);return !!n&&recovery.binding(n,c);},isEnabled:()=>!draining&&capabilityStatus().media,isInspectionEnabled:()=>capabilityStatus().inspection,isAllowed:mediaHosts.allowed}):null;
  const rebalanceEnabled=()=>capabilityStatus().rebalance;
  const allocationStatus=slot=>slot.turnAllocation?{turns_used:slot.turnAllocation.used,remaining:Math.max(0,conversationTurns()-slot.turnAllocation.used),waiting_for_next_turn:!slot.active&&slot.turnAllocation.until>performance.now(),idle_remaining_ms:Math.max(0,Math.ceil(slot.turnAllocation.until-performance.now()))}:null;
  const stats = () => ({ version: 1, genie_capabilities:capabilityStatus(), genie_thinking:genieThinking(), serving_profiles:profiles, conversation_turns:conversationTurns(),conversation_turn_idle_ms:conversationTurnIdleMs, model_routes:routes?Object.fromEntries([...routes].map(([name,workers])=>[name,[...workers]])):null, agent_api_version:1, maintenance_lock_version:1,client_watch_version:1,client_watch:clientWatch.snapshot(), pi_client_version:1,pi_client:piClientForDisplay(piClientReports.snapshot()), model: config.model, context_length: contextLimit(), queue_timeout_ms:queueTimeoutMs(), request_timeout_ms:config.request_timeout_ms??360000000, direct_reserve:{enabled:directReserveEnabled(),release_ms:directReserveMs(),reserved:nodes.filter(n=>directReserved(n)).map(n=>n.id)}, draining,startup:{...startup}, dataset:dataset.snapshot(), routing_shadow:shadow.snapshot(),routing_metrics:routingTelemetry?nodes.map(node=>{const metrics=routingTelemetry.snapshot(node.id);if(!metrics)return {id:node.id,url:node.url,metrics:null};const {request_rows,...display}=metrics;return {id:node.id,url:node.url,metrics:display};}):null,routing_time:{...routingObservations.snapshot(),margin_seconds:routingMargin()},recovery:{...recovery.status(),pair_enrollment:pairEnrollment.status(),omlx_enrollment:omlxEnrollment.status()},protections:visionProtection.status(),
    genie_admission_version:1,genie_flexible_assignment:true,placement_policy:timeRouting?'completion_time_v1':'live_load_v1',capacity_basis:'configured_gateway_admissions',continuity:{schema:1,recent_rejections:rejections.slice(0,20),safe_retry_contract:true,queued_relocation:true,automatic_relocation:true,automatic_relocation_scope:automaticRelocationScope,automatic_affinity_rebalance_min_wait_ms:automaticAffinityWait,patient_wait:true,
      relocation:{completed:relocation.completed,rejected:relocation.rejected,offers:relocationOffers().length,genie_enabled:rebalanceEnabled(),genie_offers:genieRelocationOffers(),diagnostics:relocationDiagnostics(),last:relocation.last},
      waiting:waiting.length,oldest_wait_seconds:waiting.length?Math.max(0,(performance.now()-oldestQueued(waiting).createdMono)/1000):null,
      waiting_reasons:Object.fromEntries([...new Set(waiting.map(j=>j.waitReason))].map(reason=>[reason,waiting.filter(j=>j.waitReason===reason).length]))},
    total: nodes.length, healthy: nodes.filter(n => n.healthy).length, available: nodes.filter(n => n.healthy && !n.drained).length,
    archived: [...new Set([...nodes.filter(n=>n.archived===true).map(n=>n.id),...Object.entries(store.data.archived??{}).filter(([,v])=>v===true).map(([id])=>id)])],
    active: nodes.reduce((sum,n)=>sum+activeCount(n),0), queued: waiting.length+nodes.reduce((s, n) => s + n.queue.length, 0),media_uploads:mediaJobs?.inputs.active??0,
    workers: nodes.map(n => ({ id: n.id, url: n.url, is_healthy: n.healthy, drained: n.drained, archived: n.archived === true, quarantine:n.quarantine, inference_failures:n.inferenceFailures, transport_failures:n.transportFailures, last_failure_class:n.lastFailureClass??null,
      ...agents.pauseStatus(n.id),last_operator_action:lastOperatorAction(n.id),
      gateway_drained: n.drained && !n.active && !n.queue.length, load: activeCount(n),
      max_concurrent_requests:requestCapacity(n),execution_capacity:routingCapacity(n),
      turn_allocation:requestCapacity(n)===1?allocationStatus(n.slots[0]):null,
      turn_allocations:n.slots.map(allocationStatus).filter(Boolean),
      queued: n.queue.length, recovery_waiting:parkedFor(n).length, assigned_sessions: store.count(n.id), completed: n.completed, failed: n.failed, protected:n.protected, observation_limited:n.observationLimited,
      oldest_queue_seconds:n.queue.length?Math.max(0,(performance.now()-oldestQueued(n.queue).createdMono)/1000):null,
      oldest_queue_remaining_seconds:n.queue.length?Math.max(0,(oldestQueued(n.queue).queueTimeoutMs-(performance.now()-oldestQueued(n.queue).createdMono))/1000):null,
      active_seconds: n.active ? Math.round((Date.now() - n.active.dispatched) / 1000) : 0,
      requested_thinking: activeCount(n)===1?n.active.thinking?.result??null:null,
      last_requested_thinking: n.lastThinking ?? null, last_request_finished_at: n.lastFinishedAt ?? null,
      context_length: n.contextLength ?? null,
      served_model: (n.effectiveModelAliases ?? n.model_aliases)?.[config.model] ?? null,
      direct_reserved: directReserved(n),
      health_probe_deferred:n.healthProbeDeferred,
      health_state_source:n.probeError==='busy_probe_deferred'?'recent_upstream_progress':'model_probe',
      management_path:{...n.managementPath},
      last_probe: n.lastProbe, probe_error: n.probeError })) });

  const briefJob = j => ({key:j.key,route:j.req.url,trafficClass:j.trafficClass});
  function routingWorker(node){
    const model=(node.effectiveModelAliases??node.model_aliases)?.[config.model]??node.probeModel??config.model;
    return {id:node.id,model,identity:routingIdentity(node,model,profiles[node.id]),workRevision:node.routingWorkRevision??0};
  }
  function routingCapacity(node){
    const native=routingTelemetry?.snapshot(node.id),fresh=native?.connected&&Date.now()>=native.at&&Date.now()-native.at<=5000;
    const detected=fresh&&Number.isSafeInteger(native.execution_capacity)&&native.execution_capacity>0?native.execution_capacity:null;
    const identity=routingWorker(node).identity,saved=store.data.routing_execution_capacity?.[node.id];
    const manual=saved?.identity===identity&&Number.isSafeInteger(saved.capacity)&&saved.capacity>0?saved.capacity:null;
    const execution=detected??manual;
    return {gateway_admissions:requestCapacity(node),engine_execution:execution,
      source:detected!==null?native.capacity_source:manual!==null?'manual_execution':'configured_gateway_admissions',
      manual_execution:manual,manual_identity:identity,manual_stale:!!saved&&manual===null,
      running:fresh?native.running:null,waiting:fresh?native.waiting:null,
      effective_dispatch:timeRouting?Math.min(requestCapacity(node),execution??requestCapacity(node)):requestCapacity(node),
      mismatch:execution===null?null:execution!==requestCapacity(node),
      // An engine that does not publish its execution concurrency (oMLX/vLLM)
      // leaves `execution` null, so the configured admission count is trusted
      // unverified. Surface that rather than let queue depth masquerade as
      // execution capacity; a human must validate the number.
      unvalidated:execution===null&&requestCapacity(node)>1};
  }
  function dispatchCapacity(node){return timeRouting?routingCapacity(node).effective_dispatch:requestCapacity(node);}
  function hasCapacity(node){return activeCount(node)<dispatchCapacity(node);}

  function evaluateRoutingTime(node,job,reason){
    if(!routingObservations.enabled||job.cancelled||job.dispatched||job.routingInputPending||shuttingDown)return;
    return routingObservations.attempt(()=>{
      const workers=[node,...nodes.filter(candidate=>candidate!==node)].map(candidate=>({...routingWorker(candidate),
        capacity:Math.min(requestCapacity(candidate),routingCapacity(candidate).engine_execution??requestCapacity(candidate)),
        running:activeJobs(candidate).filter(active=>active!==job).map(active=>({...active,slotIndex:candidate.slots.indexOf(active.slot)})),queue:candidate.queue,
        canStartRequest:canStartNow(candidate,job,[...candidate.queue.filter(queued=>queued!==job),...parkedFor(candidate),job]),
        conversationTurns:conversationTurns(),turnIdleSeconds:conversationTurnIdleMs/1000,
        native:routingTelemetry?.snapshot(candidate.id),
        turnReservations:candidate.slots.flatMap((slot,index)=>slot.active!==job&&slot.turnAllocation?[{...slot.turnAllocation,slot:index,until:Math.max(0,(slot.turnAllocation.until-performance.now())/1000)}]:[])}));
      const currentWorkerId=timeRouting&&!job.routingPlaced&&['new','none'].includes(job.affinity)?null:node.id;
      // An established conversation's durable home is a real cache reason to stay;
      // it must be visible to the planner so a stay says 'cache', not 'unknown timing'.
      const homeIsWarmCache=job.affinity==='existing'&&!!job.key&&store.get(job.key)?.node===node.id;
      const result=routingObservations.evaluate({job,workers,currentWorkerId,marginSeconds:routingMargin(),fastWorkerIds,homeIsWarmCache,
        eligibility:(_request,worker)=>{
          const target=nodes.find(candidate=>candidate.id===worker.id);
          const ok=target.healthy&&!target.drained&&!target.quarantine&&!target.recovering&&!target.removed&&allowsWorker(job.modelRoute,target)
            &&(target===node||target.queue.length+parkedFor(target).length<queueBound())
            &&(!job.genieFlexible||target===node||canStartNow(target,job,[...target.queue,...parkedFor(target),job].sort((a,b)=>a.sequence-b.sequence)));
          const conflict=target!==node&&conflictingSessionWork(job);
          return {eligible:ok&&!conflict,reason:conflict?'same_session_work':ok?null:'existing_worker_eligibility'};
        }});
      if(result&&!timeRouting)job.routingObservation={...result,decision_point:reason};
      return result?{...result,source:node.id,decision_point:reason}:null;
    });
  }
  function observeRoutingBody(job,body){
    if(!routingObservations.enabled||job.cancelled)return;
    routingObservations.attempt(()=>{job.routingInput=routingRequestMetadata(body,job.req.url);
      if(job.node&&job.dispatched)routingObservations.started({job,worker:routingWorker(job.node),fleet:nodes.map(routingWorker),concurrency:activeCount(job.node)});
      if(job.node){if(timeRouting)reconsiderRouting(job,'queued_body_ready');else evaluateRoutingTime(job.node,job,'queued_body_ready');}});
  }
  // All active time-based handovers reach this synchronous compare-and-commit.
  // There are no network awaits between the snapshot, durable owner and booking.
  function reconsiderRouting(job,reason,actor='scheduler',expected=null){
    const source=job.node;
    if(!timeRouting||draining||shuttingDown||!source||!source.queue.includes(job)||job.cancelled||job.dispatched||job.upstream)return null;
    const decision=evaluateRoutingTime(source,job,reason);
    if(!decision)return null;
    const destination=nodes.find(node=>node.id===decision.destination);
    if(expected&&(expected.destination!==decision.destination||expected.evidence_id!==relocationEvidence(job,source,destination)))
      throw new Error('Routing estimate changed; request was left in place');
    if(!destination||destination===source||!['move','place','reassign'].includes(decision.action)){
      job.routingLastComparison={...decision,mode:'active',applied:true};
      if(!job.routingDecision||!['move','reassign'].includes(job.routingDecision.action))job.routingDecision=job.routingLastComparison;
      return null;
    }
    const home=job.key&&store.get(job.key);
    if(conflictingSessionWork(job)||(job.key&&home?.node!==source.id))return null;
    // Persist first. A failed write cannot strand the client between queues.
    const previousOwnership=store.data;
    try{if(job.key)store.set(job.key,destination.id);}catch{
      // A directory fsync can fail after rename. Restore the complete old state,
      // not merely the in-memory queue, before continuing on the old worker.
      try{store.save(previousOwnership);}catch{draining=true;job.routingCommitBlocked=true;}
      job.routingDecision={...decision,mode:'active',action:'stay',destination:source.id,reason:job.routingCommitBlocked?'ownership_recovery_required':'ownership_write_failed',applied:true};
      log('queue_relocation_persistence_failed',{request_id:job.id,source:source.id,destination:destination.id});return null;
    }
    source.queue.splice(source.queue.indexOf(job),1);
    job.node=destination;job.fixedHome=null;job.affinity='rebalanced';job.routingPlaced=true;
    destination.queue.push(job);destination.queue.sort((a,b)=>a.sequence-b.sequence);
    // An empty continuation reservation must not pull the next tool return back.
    for(const slot of source.slots)if(!slot.active&&slot.turnAllocation?.key===job.key)releaseTurns(source,slot);
    job.routingDecision={...decision,mode:'active',applied:true};
    const receipt={schema:1,request_id:job.id,source:source.id,destination:destination.id,actor,
      waiting_ms:performance.now()-job.createdMono,dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,
      reason:decision.reason,estimated_saving_seconds:decision.savingSeconds,margin_seconds:decision.marginSeconds};
    relocation.completed++;relocation.last={...receipt,time:new Date().toISOString()};
    log('queued_request_relocated',receipt);dataset.record('queue_relocation',{...receipt,node:destination.id});
    setImmediate(()=>{if(!shuttingDown){schedule(source);schedule(destination);}});
    return {state:'relocated',...receipt};
  }
  function timeRoutingCandidates(){
    // Reconsider one eligible head per worker per tick; later jobs also get
    // their own arrival/body-ready/pre-dispatch comparisons.
    return priorityOrder(nodes.flatMap(node=>{
      const eligible=node.queue.filter(job=>!conflictingSessionWork(job));
      const head=eligible[priorityIndex(eligible)];return head?[head]:[];
    }).sort((a,b)=>a.sequence-b.sequence)).slice(0,32);
  }
  function timeRoutingOffers(){
    if(draining||shuttingDown)return [];
    return timeRoutingCandidates().flatMap(job=>{
      const source=job.node,decision=evaluateRoutingTime(source,job,'offer');
      if(!decision||decision.destination===source.id||!['move','place','reassign'].includes(decision.action))return [];
      const destination=nodes.find(node=>node.id===decision.destination);if(!destination)return [];
      return [{schema:1,evidence_id:relocationEvidence(job,source,destination),request_id:job.id,priority:job.priority,geniePriority:job.geniePriority,
        source:source.id,destination:destination.id,source_queued:source.queue.length,waiting_seconds:(performance.now()-job.createdMono)/1000,
        estimated_saving_seconds:decision.savingSeconds,margin_seconds:decision.marginSeconds,destination_immediately_free:canStartNow(destination,job,[...destination.queue,job].sort((a,b)=>a.sequence-b.sequence)),automatic:true}];
    }).slice(0,32);
  }
  function candidate(n,key) {
    return {node:n.id,healthy:n.healthy,paused:n.drained,active:activeCount(n),max_concurrent_requests:requestCapacity(n),queued:n.queue.length,
      assigned_sessions:store.count(n.id),context_length:n.contextLength,
      profile:digest(JSON.stringify({id:n.id,url:n.url,model:config.model,context:n.contextLength,...(requestCapacity(n)>1?{max_concurrent_requests:requestCapacity(n)}:{})})),
      ...(observe(()=>({...shadow.timing(n.id,key,n.active),active_request_id:activeCount(n)===1?n.active.id:null}))??{})};
  }
  function evaluateShadow(node,job,reason) {
    observe(()=>{
      if(job.cancelled || job.upstream)return;
      const sessionBusy=!!job.key && nodes.some(n=>activeJobs(n).some(active=>active.key===job.key) || n.queue.some(j=>j!==job && j.key===job.key && !j.cancelled));
      const ordered=priorityOrder(node.queue);
      const candidates=nodes.slice(0,128).map(n=>({...candidate(n,job.key),active_job:n.active?briefJob(n.active):null,
        ahead_jobs:n===node?ordered.slice(0,ordered.indexOf(job)).map(briefJob):[]}));
      const result=shadow.assess({job:briefJob(job),home:node.id,candidates,reason,
        waiting_ms:performance.now()-job.createdMono,session_busy:sessionBusy});
      dataset.record('routing_shadow',{request_id:job.id,node:node.id,session:job.key,...result,candidates_truncated:nodes.length>128});
    });
  }
  function evaluateWaiting() {
    // Sample the next priority-eligible request, not the oldest telemetry subject.
    // At most one request per worker, 32 workers per free event.
    // This callback never reads/consumes queued uploads or changes ownership.
    if(shuttingDown)return;
    let count=0;
    for(const n of nodes)if(n.queue.length){if(count++>=32){shadow.state.skipped++;continue;}const next=nextQueued(n);if(next){evaluateShadow(n,next,'worker_free');if(!timeRouting)evaluateRoutingTime(n,next,'worker_free');}}
  }

  const eligibleDestination=n=>n.healthy&&!n.drained&&!n.quarantine&&!n.recovering&&!n.removed&&!n.active&&n.queue.length===0;
  function conflictingSessionWork(job) {
    if(!job.key)return null;
    for(const node of nodes)if(activeJobs(node).some(active=>active.key===job.key))return {node,reason:'same_session_active'};
    for(const node of nodes)if(node.queue.some(other=>other!==job&&!other.cancelled&&other.key===job.key))return {node,reason:'same_session_queued'};
    if(waiting.some(other=>other!==job&&!other.cancelled&&other.key===job.key))return {node:null,reason:'same_session_waiting'};
    return null;
  }
  const relocationEvidence=(job,source,destination)=>digest(['queue-relocation-v1',job.id,source.id,destination.id,job.sequence,job.created].join('\0'));
  function relocationDecision(source,idle) {
    const job=nextQueued(source);
    if(!job)return null;
    let reason='offer_ready',conflict=null;
    if(!source.active)reason='source_not_active';
    else if(job.upstream||job.dispatched)reason='already_dispatched';
    else if((conflict=conflictingSessionWork(job)))reason=conflict.reason;
    const destination=idle.find(node=>node!==source&&allowsWorker(job.modelRoute,node));
    if(reason==='offer_ready'&&!destination)reason='no_idle_destination';
    const home=job.key&&store.get(job.key);
    if(reason==='offer_ready'&&job.key&&home?.node!==source.id)reason='durable_home_mismatch';
    return {source,job,destination:reason==='offer_ready'?destination:null,reason,conflict};
  }
  const queuedCount=source=>source.queue.filter(job=>!job.cancelled).length;
  function relocationDiagnostics() {
    if(timeRouting)return {schema:1,policy:'completion_time_v1',sources:timeRoutingCandidates().map(job=>({source:job.node.id,request_id:job.id,...evaluateRoutingTime(job.node,job,'diagnostic')})),truncated:false};
    const idle=nodes.filter(eligibleDestination).sort((a,b)=>store.count(a.id)-store.count(b.id)||a.id.localeCompare(b.id));
    const gateway_reason=shuttingDown?'gateway_stopping':draining?'gateway_draining':null;
    const sources=[];
    for(const source of nodes){
      const decision=relocationDecision(source,idle);if(!decision)continue;
      const {job,destination,reason,conflict}=decision,waiting_seconds=Math.max(0,(performance.now()-job.createdMono)/1000);
      const automatic_reason=gateway_reason??(reason!=='offer_ready'?reason:['new','none'].includes(job.affinity)?'automatic_ready':automaticAffinityWait===null?'affinity_automatic_disabled':waiting_seconds<automaticAffinityWait/1000?'automatic_wait_threshold':'automatic_ready');
      const minimum=(config.genie_rebalance_min_wait_ms??60000)/1000;
      const source_queued=queuedCount(source),genie_pressure=!gateway_reason&&rebalanceEnabled()&&source_queued>=2&&idle.some(node=>node!==source&&allowsWorker(job.modelRoute,node));
      const genie_reason=gateway_reason??(reason!=='offer_ready'?reason:!rebalanceEnabled()?'genie_disabled':!genie_pressure&&waiting_seconds<minimum?'genie_wait_threshold':'genie_offer_ready');
      sources.push({source:source.id,source_queued,genie_pressure,request_id:job.id,affinity:job.affinity,waiting_seconds,reason:gateway_reason??reason,
        destination:gateway_reason?null:destination?.id??null,conflicting_worker:conflict?.node?.id??null,automatic_reason,genie_reason});
      if(sources.length>=32)break;
    }
    return {schema:1,gateway_reason,idle_destinations:idle.map(node=>node.id).slice(0,32),sources,truncated:nodes.some(node=>node.queue.some(job=>!job.cancelled))&&sources.length>=32};
  }
  function relocationOffers() {
    if(timeRouting)return timeRoutingOffers();
    if(shuttingDown||draining)return [];
    const idle=nodes.filter(eligibleDestination).sort((a,b)=>store.count(a.id)-store.count(b.id)||a.id.localeCompare(b.id));
    if(!idle.length)return [];
    const offers=[];
    for(const source of nodes) {
      const decision=relocationDecision(source,idle);if(!decision||decision.reason!=='offer_ready')continue;
      const {job,destination}=decision;
      offers.push({schema:1,evidence_id:relocationEvidence(job,source,destination),request_id:job.id,priority:job.priority,source:source.id,destination:destination.id,
        source_queued:queuedCount(source),waiting_seconds:Math.max(0,(performance.now()-job.createdMono)/1000),source_active_seconds:source.active?Math.max(0,(performance.now()-source.active.dispatchedMono)/1000):null,
        affinity:job.affinity,cache_locality:'unknown',destination_immediately_free:true,automatic:false});
    }
    return offers.slice(0,32);
  }
  function genieRelocationOffers(){
    if(!rebalanceEnabled())return [];
    if(timeRouting)return timeRoutingOffers().slice(0,8).map(offer=>({...offer,trigger:'completion_time'}));
    const minimum=(config.genie_rebalance_min_wait_ms??60000)/1000;
    if(!Number.isFinite(minimum)||minimum<0)throw new Error('genie_rebalance_min_wait_ms must be non-negative');
    return relocationOffers().filter(offer=>offer.source_queued>=2||offer.waiting_seconds>=minimum).slice(0,8)
      .map(offer=>({...offer,trigger:offer.source_queued>=2?'queue_pressure':'wait_threshold'}));
  }
  function relocateQueued(input,actor='operator') {
    const keys=Object.keys(input??{}).sort().join(',');
    if(keys!=='destination,evidence_id,request_id,source'||!validCallId(input.request_id)||!/^[a-f0-9]{64}$/.test(input.evidence_id)||
      !/^[\w-]{1,64}$/.test(input.source)||!/^[\w-]{1,64}$/.test(input.destination))throw new Error('Specify one current queued-handover offer exactly');
    if(timeRouting){
      const job=nodes.find(n=>n.id===input.source)?.queue.find(job=>job.id===input.request_id);
      if(!job)throw new Error('Queued-handover offer is stale; refresh before retrying');
      const receipt=reconsiderRouting(job,'explicit_handover',actor,input);
      if(!receipt)throw new Error('The current routing comparison does not permit this move; request was left in place');
      return receipt;
    }
    const source=nodes.find(n=>n.id===input.source),destination=nodes.find(n=>n.id===input.destination),job=nextQueued(source);
    const rejectMove=message=>{relocation.rejected++;throw new Error(message);};
    if(!source||!destination||source===destination||!job||job.id!==input.request_id)return rejectMove('Queued-handover offer is stale; refresh before retrying');
    if(job.cancelled||job.upstream||job.dispatched||!source.active||(!eligibleDestination(destination)||!allowsWorker(job.modelRoute,destination)))return rejectMove('Queued-handover state changed; request was left in place');
    if(relocationEvidence(job,source,destination)!==input.evidence_id)return rejectMove('Queued-handover evidence changed; request was left in place');
    if(conflictingSessionWork(job))return rejectMove('Same-session work prevents a safe handover; request was left in place');
    const home=job.key&&store.get(job.key);
    if(job.key&&home?.node!==source.id)return rejectMove('Durable session ownership changed; request was left in place');
    // Persist the new conversation owner before changing in-memory queue
    // ownership. A failed fsync leaves the original queue and client intact.
    try {if(job.key)store.set(job.key,destination.id);}catch{
      log('queue_relocation_persistence_failed',{request_id:job.id,source:source.id,destination:destination.id});
      return rejectMove('Durable handover failed; request remains queued on its original server');
    }
    source.queue.splice(source.queue.indexOf(job),1);job.node=destination;job.affinity='rebalanced';destination.queue.push(job);
    const receipt={schema:1,request_id:job.id,source:source.id,destination:destination.id,actor,waiting_ms:performance.now()-job.createdMono,
      dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,cache_locality:'unknown'};
    relocation.completed++;relocation.last={...receipt,time:new Date().toISOString()};
    log('queued_request_relocated',receipt);dataset.record('queue_relocation',{...receipt,node:destination.id});
    schedule(destination);evaluateWaiting();
    return {state:'relocated',...receipt};
  }
  function rebalanceUndispatched() {
    if(timeRouting){
      for(const job of timeRoutingCandidates())reconsiderRouting(job,'waiting');
      return;
    }
    const offer=relocationOffers().filter(candidate=>{
      const job=nextQueued(nodes.find(node=>node.id===candidate.source));
      return job&&(['new','none'].includes(job.affinity)||(automaticAffinityWait!==null&&candidate.waiting_seconds*1000>=automaticAffinityWait));
    }).sort((a,b)=>priorityRank(b)-priorityRank(a)||b.waiting_seconds-a.waiting_seconds||a.source.localeCompare(b.source))[0];
    if(!offer)return;
    try {relocateQueued({request_id:offer.request_id,source:offer.source,destination:offer.destination,evidence_id:offer.evidence_id},'scheduler');}
    catch{/* Exact-offer revalidation failed; the untouched request remains queued. */}
  }

  function quarantine(node, reason, requestId) {
    if(node.quarantine)return;
    node.quarantine={reason,request_id:requestId,at:new Date().toISOString()};
    observe(()=>shadow.reset(node.id));
    node.healthy=false;
    try {store.save({...store.data,quarantined:{...store.data.quarantined,[node.id]:node.quarantine}});}
    catch {draining=true;log('quarantine_persistence_failed',{node:node.id});}
    log('worker_quarantined',{node:node.id,...node.quarantine});
  }

  function pick(exclude,modelRoute) {
    return placementChoice(nodes.filter(n => n.healthy && !n.drained && n.id !== exclude && allowsWorker(modelRoute,n)));
  }
  function placementChoice(eligible) {
    // Share ranking, not eligibility: flexible Genie must still pass its
    // immediate-start/turn checks, while ordinary placement may enqueue.
    // Capacity comes from the worker registry, never a model or machine name.
    // Direct-reserve is soft: a worker in active owner use is deprioritized, not
    // excluded. If every eligible worker is reserved, the pool still serves.
    const preferred=eligible.filter(n=>!directReserved(n));
    return (preferred.length?preferred:eligible).sort((a, b) =>
      Number(!hasCapacity(a))-Number(!hasCapacity(b)) ||
      (activeCount(a)+a.queue.length)/requestCapacity(a)-(activeCount(b)+b.queue.length)/requestCapacity(b) ||
      store.count(a.id) - store.count(b.id) || a.id.localeCompare(b.id))[0];
  }
  // A worker whose engine reports active work while the gate has no dispatched
  // job on it is in direct owner use (pi, curl, any client bypassing the gate).
  // While reserved, new admissions prefer other workers; the reservation lapses
  // after a quiet window so cache warmth survives short pauses.
  //
  // Engine gauges lag the slot books by up to one dashboard poll, so a sample
  // scraped before the gate's own last dispatch or finish still shows the
  // gate's own request as running. Only a sample newer than the gate's last
  // touch of the node (plus a second of engine-lag grace) may prove a bypass;
  // older samples are ambiguous, never evidence.
  function directReserveEnabled(){return store.data.direct_reserve_enabled===true;}
  function directReserved(node,now=Date.now()){return directReserveEnabled()&&Number.isFinite(node.directReservedUntil)&&now<node.directReservedUntil;}
  function observeDirectActivity(node,metrics,now=Date.now()){
    if(!metrics||metrics.connected===false||!Number.isFinite(metrics.at)||now-metrics.at>=15000)return;
    if(Number.isFinite(node.lastGateActivityAt)&&metrics.at<=node.lastGateActivityAt+1000)return;
    if(metrics.running>0&&activeCount(node)===0)node.directReservedUntil=now+directReserveMs();
  }
  function reportDirectActivity(rows,now=Date.now()){
    if(!directReserveEnabled()||!Array.isArray(rows))throw new Error('Specify an activity row array');
    if(rows.length>256)throw new Error('Too many activity rows');
    let reported=0;
    for(const row of rows){
      if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='at,connected,id,running')throw new Error('Each row needs id, connected, running, at');
      const node=nodes.find(n=>n.id===row.id);if(!node)continue;
      if(typeof row.connected!=='boolean'||!Number.isSafeInteger(row.running)||row.running<0||!Number.isSafeInteger(row.at))throw new Error('Invalid activity row values');
      if(now-row.at<0||now-row.at>30000)continue;
      const before=directReserved(node,now);
      observeDirectActivity(node,row,now);
      if(!before&&directReserved(node,now)){reported++;log('direct_reserve_started',{node:node.id,engine_running:row.running});}
    }
    return {accepted:true,reserved:nodes.filter(n=>directReserved(n,now)).map(n=>n.id),reported};
  }
  function directReserveMs(){const value=config.direct_reserve?.release_ms??180000;return Number.isSafeInteger(value)&&value>=30000&&value<=3600000?value:180000;}
  function detach(job) {
    if(job.node)job.node.queue=job.node.queue.filter(j=>j!==job);
    const i=waiting.indexOf(job);if(i>=0)waiting.splice(i,1);
  }
  function park(job,node,reason) {
    if(job.upstream)throw new Error('Cannot park dispatched work');
    detach(job);
    // Previously admitted work keeps its home. No cache migration or replay.
    if(node)job.fixedHome=node;
    job.node=null;job.waitReason=reason;
    if(shuttingDown){reject(job.req,job.res,503,'draining','Gateway is stopping; the recovery-waiting request was not dispatched.',{...job,node:job.fixedHome,reason:'gateway_draining'});job.cleanup();return;}
    waiting.push(job);waiting.sort((a,b)=>a.sequence-b.sequence);
    clientWatch.observeRequest(job.watchId,job.id,'queued');
    heartbeat(job);
    log('request_waiting',{request_id:job.id,node:job.fixedHome?.id??null,reason,dispatch_state:'not_dispatched'});
    dataset.record('waiting',{request_id:job.id,node:job.fixedHome?.id??null,reason,total_ms:performance.now()-job.createdMono});
  }
  function admit(job,node) {
    if(!allowsWorker(job.modelRoute,node))throw new Error("Model route does not allow this worker");
    const home=job.key&&store.get(job.key);
    const wasAdmitted=job.recordedDecision===true;
    const candidates=job.recordedDecision?null:nodes.map(n=>candidate(n,job.key));
    try {if(job.key&&home?.node!==node.id)store.set(job.key,node.id);}
    catch(e){
      detach(job);log('state_write_error',{error:e.message});
      reject(job.req,job.res,503,'state_unavailable','Cannot durably record affinity; request was not dispatched',{...job,node,reason:'affinity_write_failed'});job.cleanup();return;
    }
    detach(job);job.node=node;
    if(!job.recordedDecision){
      dataset.record('decision',{request_id:job.id,call_id:job.callId,node:node.id,session:job.key,affinity:job.affinity,context_length:contextLimit(),candidates,
        traffic_class:job.trafficClass,client_metadata:job.admissionMetadata,admission_wait_ms:performance.now()-job.createdMono});
      job.recordedDecision=true;job.admissionMetadata=null;
    }
    if(job.waitReason)log('request_wait_resumed',{request_id:job.id,node:node.id,wait_ms:performance.now()-job.createdMono});
    job.waitReason=null;
    node.queue.push(job);node.queue.sort((a,b)=>a.sequence-b.sequence);
    clientWatch.observeRequest(job.watchId,job.id,'queued');
    evaluateShadow(node,job,wasAdmitted?'worker_free':'admission');evaluateRoutingTime(node,job,'admission');
    if(timeRouting){
      reconsiderRouting(job,'admission');
      // Supported uploads get a bounded chance to provide routing input first.
      // Slow/oversized uploads still dispatch with labelled unknown estimates.
      setImmediate(()=>{if(!shuttingDown&&!job.cancelled&&job.node)schedule(job.node);});
    }else schedule(node);
  }
  const freeGenieNode=(modelRoute,priority='normal',arrival=Number.MAX_SAFE_INTEGER,geniePriority=false)=>placementChoice(nodes.filter(node=>{
    if(!allowsWorker(modelRoute,node)||!node.healthy||node.drained||node.quarantine||node.recovering||node.removed||!hasCapacity(node))return false;
    const candidate={key:null,priority,sequence:arrival,geniePriority};
    return canStartNow(node,candidate,[...node.queue,...parkedFor(node),candidate]);
  }));
  function pumpWaiting() {
    if(shuttingDown)return;
    for(const n of nodes)for(const job of n.queue)heartbeat(job);
    // Retain FIFO within each conversation; independent conversations can proceed.
    for(const job of priorityOrder(waiting)){
      if(job.cancelled)continue;
      heartbeat(job);
      if(job.genieFlexible){const free=freeGenieNode(job.modelRoute,job.priority,job.sequence,job.geniePriority);if(free)admit(job,free);else job.waitReason='no_ready_worker';continue;}
      if(job.key&&waiting.some(j=>j!==job&&j.sequence<job.sequence&&j.key===job.key)){job.waitReason='same_session_queued';continue;}
      const home=job.key&&store.get(job.key),outstanding=sessionWork(nodes,job.key);
      let node=job.fixedHome??(home&&nodes.find(n=>n.id===home.node));
      if(job.fixedHome){
        if(node.removed||!node.healthy||node.drained||node.quarantine||node.recovering){job.waitReason=unavailableReason(node);continue;}
        if(outstanding&&outstanding.node!==node){job.waitReason=outstanding.reason;continue;}
      }else{
        if(node&&(!allowsWorker(job.modelRoute,node)||!node.healthy||node.drained||node.quarantine||node.recovering)){
          if(outstanding){job.waitReason=outstanding.reason;continue;}
          node=pick(node.id,job.modelRoute);job.affinity='reassigned';
        }
        if(!node)node=pick(undefined,job.modelRoute);
        if(!node){job.waitReason='no_ready_worker';continue;}
        if(outstanding&&outstanding.node!==node){job.waitReason=outstanding.reason;continue;}
      }
      if(node.queue.length>=queueBound()){
        const merged=[...node.queue,job].sort((a,b)=>a.sequence-b.sequence);
        const takesFreeSlot=canStartNow(node,job,merged);
        // Already-accepted waiting work can occupy the newly free active slot;
        // it need not wait for a lower-priority queued request to consume it.
        // Admission immediately dispatches this job, so queue capacity is retained.
        if(!takesFreeSlot){job.waitReason='queue_full';continue;}
      }
      admit(job,node);
    }
    rebalanceUndispatched();
  }
  function heartbeat(job) {
    // A standard informational response, NOT final 200/SSE headers. This lets
    // TCP surface disconnects even when a large upload is backpressured and EOF
    // is behind unread bytes. Clients must still set their own HTTP deadlines.
    if(job.res.destroyed||job.res.headersSent||job.cancelled)return;
    const now=performance.now();
    if(job.lastHeartbeat!==undefined&&now-job.lastHeartbeat<5000)return;
    job.lastHeartbeat=now;
    try{job.res.writeProcessing();}catch{job.res.destroy();}
  }
  function queuedChoice(node,slot,queue){
    const release=!!(slot.turnAllocation?.until&&slot.turnAllocation.until<=performance.now())||!node.healthy||node.quarantine||node.recovering||shuttingDown;
    // Release before checking other slots, matching the dispatcher's original order.
    if(release)releaseTurns(node,slot);
    const choice=queueChoice({queue,allocation:slot.turnAllocation,turns:conversationTurns(),now:performance.now(),
      blocked:job=>job.routingInputPending||job.routingCommitBlocked||!!job.key&&(nodes.some(n=>activeJobs(n).some(active=>active.key===job.key))||
        node.slots.some(other=>other!==slot&&other.turnAllocation?.key===job.key&&other.turnAllocation.used<conversationTurns()))});
    if(choice.clearAllocation)releaseTurns(node,slot);
    return choice.job;
  }
  function canStartNow(node,job,queue){
    if(!hasCapacity(node))return false;
    // Preview reservation changes without clearing real timers or assigning a
    // flexible request to a worker whose free slot belongs to another turn.
    const slots=node.slots.map(slot=>({...slot,turnTimer:null,turnAllocation:slot.turnAllocation?{...slot.turnAllocation}:null}));
    if(slots.length<dispatchCapacity(node))slots.push({});
    const preview={...node,slots},pending=[...queue].sort((a,b)=>a.sequence-b.sequence);
    return slots.some((slot,index)=>index<dispatchCapacity(node)&&!slot.active&&queuedChoice(preview,slot,pending)===job);
  }
  function schedule(node) {
    if(node.scheduling||!hasCapacity(node))return;
    node.scheduling=true;
    try{
      node.queue=node.queue.filter(job=>!job.cancelled);
      // Allocate additional slots only as work needs them; capacity is explicit.
      for(let i=0;i<dispatchCapacity(node)&&node.queue.length;i++){
        const slot=node.slots[i]??(node.slots[i]={});if(slot.active)continue;
        let job;
        while((job=queuedChoice(node,slot,node.queue))){
          if(timeRouting&&reconsiderRouting(job,'before_dispatch'))continue;
          node.queue.splice(node.queue.indexOf(job),1);
          if(!node.healthy||node.quarantine||node.recovering){park(job,node,unavailableReason(node));continue;}
          job.queueTimer?.cancel();clearTimeout(slot.turnTimer);slot.turnTimer=null;
          if(conversationTurns()>1&&job.key){
            if(slot.turnAllocation?.key!==job.key)slot.turnAllocation={key:job.key,priority:job.priority,used:0,until:0};
            slot.turnAllocation.priority=job.priority;slot.turnAllocation.used++;slot.turnAllocation.until=0;
          }else releaseTurns(node,slot);
          slot.active=job;job.slot=slot;dispatch(node,job);if(slot.active)break;
        }
        // No unallocated slot can help if all queued conversations are active
        // or reserved in a slot already visited.
        if(!job&&i>=node.slots.length-1&&!queuedChoice(node,{},node.queue))break;
      }
    }finally{node.scheduling=false;}
  }
  function releaseTurns(node,slot){
    for(const target of slot?[slot]:node.slots){clearTimeout(target.turnTimer);target.turnTimer=null;target.turnAllocation=null;}
  }
  function finishTurn(node,slot,outcome){
    const allocation=slot.turnAllocation;
    if(outcome!=='complete'||shuttingDown||!allocation){releaseTurns(node,slot);return;}
    if(allocation.used>=conversationTurns())return;
    allocation.until=performance.now()+conversationTurnIdleMs;
    slot.turnTimer=setTimeout(()=>{releaseTurns(node,slot);pumpWaiting();schedule(node);},conversationTurnIdleMs);
    slot.turnTimer.unref?.();
  }
  function dispatch(node, job) {
    // Capture one resolved mapping for the whole request, including image repair.
    const resolvedAliases=node.effectiveModelAliases ?? node.model_aliases;
    // Identity mappings substitute nothing; treating them as a rewrite would only
    // reframe the upload (chunked) for no change at all.
    const aliases=resolvedAliases&&Object.entries(resolvedAliases).some(([alias,id])=>alias!==id)?resolvedAliases:undefined;
    const { req, res } = job;
    const effortAliases=req.url==='/v1/chat/completions'?node.reasoningEffortAliases:undefined;
    const rewriteRequired=aliases||profiles[node.id]||effortAliases;
    const rewriteBody=()=>{
      const transforms=[];
      if(profiles[node.id])transforms.push(servingProfileTransform(profiles[node.id],req.headers['content-encoding'],req.url));
      if(aliases)transforms.push(modelAliasTransform(aliases,req.headers['content-encoding']));
      if(effortAliases)transforms.push(modelAliasTransform(effortAliases,req.headers['content-encoding'],'reasoning_effort'));
      return transforms.length===1?transforms[0]:transforms.length?compose(...transforms):new PassThrough();
    };
    // Buffered alias/profile rewriting for paths that already hold the full body
    // (vision recovery turns): the rewritten body ships with an exact
    // Content-Length instead of relying on the streaming rewrite.
    const rewriteBodyToBuffer=body=>new Promise((resolve,reject)=>{
      const rewrite=rewriteBody();const pieces=[];
      rewrite.on('data',piece=>pieces.push(piece));
      rewrite.once('error',reject);
      rewrite.once('end',()=>resolve(Buffer.concat(pieces)));
      rewrite.end(body);
    });
    const requestBody=job.queuedBody?.stream()??req;
    if(!timeRouting)evaluateRoutingTime(node,job,'before_dispatch');
    job.dispatched = Date.now();
    job.dispatchedMono=performance.now();
    if(routingObservations.enabled)routingObservations.started({job,worker:routingWorker(node),fleet:nodes.map(routingWorker),concurrency:activeCount(node)});
    if(routingObservations.enabled)node.routingWorkRevision=(node.routingWorkRevision??0)+1;
    clientWatch.observeRequest(job.watchId,job.id,'dispatched');
    observe(()=>shadow.started(node.id,job.key));
    let requestBytes=0, firstBodyByte=null;
    const captureLimit=visionProtection.captureLimit(req.url,req.headers['content-encoding']);
    let captureChunks=[],captureBytes=0,captureOverflow=false,captureResolved=false,resolveCapture;
    const bodyReady=new Promise(resolve=>{resolveCapture=resolve;});
    const finishCapture=value=>{if(captureResolved)return;captureResolved=true;resolveCapture(value);};
    const target = endpointUrl(node, req.url);
    const headers = forwardHeaders(req.headers);
    // The bearer credential authenticates callers to DSG. Stock DS4 workers
    // are intentionally unauthenticated behind loopback or an SSH tunnel, so
    // the ingress secret must never cross the worker boundary.
    delete headers.authorization;
    delete headers[GENIE_KEY_HEADER]; // Local scheduling credential never reaches model servers.
    delete headers['x-api-key'];
    delete headers[MODEL_ROUTE_HEADER];
    Object.assign(headers, node.upstreamHeaders ?? {});
    delete headers['x-dsg-review-flexible']; // Core-owned undispatched assignment only.
    delete headers['x-dsg-review-no-wait']; // Advisory admission option only.
    delete headers[PRIORITY_HEADER]; // Queue metadata never becomes an engine option.
    delete headers['x-dsg-priority-intent']; // Strip retired client metadata during upgrades.
    delete headers[CLIENT_METADATA_HEADER]; // DSG hint only; never a DS4 setting.
    delete headers[CALL_ID_HEADER];
    delete headers[CLIENT_WATCH_HEADER]; // Ephemeral client liveness hint; never DS4 input.
    headers.host = target.host;
    headers['x-request-id'] = job.id;
    delete headers.expect;
    const loopObserver = new ReasoningLoopObserver(config.reasoning_loop);
    const observer = new UsageObserver(req.url,{loopObserver});
    job.thinking = new RequestedThinkingObserver(req.headers['content-encoding'],(body,thinking)=>{
      job.requestStream=typeof body?.stream==='boolean'?body.stream:null;
      job.requestedUsage=typeof body?.stream_options?.include_usage==='boolean'?body.stream_options.include_usage:null;
      observeRoutingBody(job,body);
      if(job.previewFromRequest)observeJobPreview(job,requestUserExcerpt(body));
    },{route:req.url,model:node.backend === 'openai' ? undefined : node.probeModel ?? config.model,contextLength:node.contextLength});
    const observeBody = chunk => {
      requestBytes+=chunk.length;job.requestBytes=requestBytes;job.thinking.accept(chunk);
      if(captureLimit&&!captureOverflow){
        if(captureBytes+chunk.length<=captureLimit){captureChunks.push(chunk);captureBytes+=chunk.length;}
        else{captureOverflow=true;captureChunks=[];}
      }
    };
    const bodyEnded = () => {
      job.thinking.finish();
      const body=captureLimit&&!captureOverflow?Buffer.concat(captureChunks,captureBytes):null;
      captureChunks=[];finishCapture(body);
    };
    const bodyAborted=()=>{captureChunks=[];finishCapture(null);};
    let settled = false, response, faults,jsonUsage,responseFormat='no_response',clientStatus=null,responseEncoded=false;
    const finish = (outcome, detail, observedStreamEnd=null) => {
      if (settled) return; settled = true;
      if(routingObservations.enabled)node.routingWorkRevision=(node.routingWorkRevision??0)+1;
      const streamEnd=responseFormat==='sse'?(observedStreamEnd??(responseEncoded?'encoded_unobserved':observer.finishState({cleanEOF:false}))):null;
      const jsonMetadata=jsonUsage?.finish();
      if(jsonMetadata){observer.usage=jsonMetadata.usage??undefined;observer.finish_reason=jsonMetadata.finish_reason??null;}
      const usageObservation=responseEncoded?'encoded_body':jsonMetadata?.status??(responseFormat!=='sse'?'unsupported_format':!observer.usage?'not_reported':observer.usage.prompt_tokens!=null&&observer.usage.completion_tokens!=null?'observed':'partial');
      const fault=faults?.finish();
      if(fault){quarantine(node,fault,job.id);if(outcome==='complete')outcome='upstream_engine_error';}
      else if(!job.cancelled && ((outcome==='upstream_http_error' && detail>=500) || ENGINE_FAILURE_OUTCOMES.has(outcome) || AMBIGUOUS_FAILURE_OUTCOMES.has(outcome))) {
        // A severed ssh tunnel and a dying engine produce the same outcomes from
        // the same call sites, so the outcome string alone must not convict the
        // engine. The ssh supervisor tracks the link independently; when it
        // reports the tunnel dead, the ambiguous outcomes are transport failures
        // and must not advance the engine counter. A response the engine itself
        // emitted (truncated SSE, fatal reason envelope) stays engine evidence
        // even while the tunnel is down.
        const tunnelDead=node.managementPath?.transport==='ssh_tunnel'&&TRANSPORT_DEAD_STATES.has(node.managementPath.state);
        if(!ENGINE_FAILURE_OUTCOMES.has(outcome)&&tunnelDead){
          node.transportFailures++;node.lastFailureClass='transport';
        }else{
          if(node.transportFailures)node.transportFailures=0;
          node.lastFailureClass='engine';
          if(++node.inferenceFailures>=QUARANTINE_FAILURE_THRESHOLD)quarantine(node,'repeated_inference_failures',job.id);
        }
      } else if(outcome==='complete'){node.inferenceFailures=0;node.transportFailures=0;node.lastFailureClass='complete';}
      clearTimeout(job.deadline);
      requestBody.off('data', observeBody);requestBody.off('end',bodyEnded);req.off('aborted',bodyAborted);requestBody.off('error',bodyAborted);job.thinking.dispose();
      captureChunks=[];finishCapture(null);
      node.lastThinking = job.thinking.result; node.lastFinishedAt = new Date().toISOString();
      node.lastGateActivityAt = Date.now();
      if (outcome === 'complete') node.completed++; else if(outcome==='vision_guidance')node.protected++;else if(outcome==='sse_observation_limited')node.observationLimited++;else node.failed++;
      clientWatch.observeRequest(job.watchId,job.id,['complete','vision_guidance'].includes(outcome)?'complete':outcome==='client_cancelled'?'cancelled':['incomplete_sse','sse_observation_limited'].includes(outcome)?'incomplete':'failed');
      if(job.visionNormalized){
        if(outcome==='complete'){
          visionProtection.record('rescued',{images:job.visionNormalized.images,formats:job.visionNormalized.formats,node:node.id});
          log('vision_image_rescued',{request_id:job.id,node:node.id,images:job.visionNormalized.images,formats:job.visionNormalized.formats});
        }
        else if(!['vision_guidance','client_cancelled'].includes(outcome))visionProtection.record('failed',{reason:'normalized_retry_failed',node:node.id});
      }
      log('request_finished', { request_id: job.id, node: node.id, session: job.key?.slice(0, 12), outcome,
        queue_ms: job.dispatched - job.created, elapsed_ms: Date.now() - job.dispatched,
        usage: observer.usage, sse_done: observer.done, stream_end:streamEnd, requested_thinking: job.thinking.result, detail });
      dataset.record('finish',{request_id:job.id,node:node.id,outcome,queue_ms:job.dispatchedMono-job.createdMono,
        route:req.url,response_format:responseFormat,http_status:clientStatus??response?.statusCode,usage_observation:usageObservation,request_stream:job.requestStream,requested_usage:job.requestedUsage,traffic_class:job.trafficClass,
        service_ms:performance.now()-job.dispatchedMono,total_ms:performance.now()-job.createdMono,first_body_byte_ms:firstBodyByte,
        request_bytes:requestBytes,usage:observer.usage,finish_reason:observer.finish_reason,stream_end:streamEnd,requested_thinking:job.thinking.result,
        generation:jsonMetadata?.generation??(responseFormat==='sse'&&!responseEncoded?{thinking_characters:observer.thinkingCharacters,answer_characters:observer.answerCharacters,tool_characters:observer.toolCharacters,output_present:observer.outputPresent,observation_complete:observer.shapeComplete&&!observer.limited&&!observer.reasonEofAmbiguous&&observer.singleChoiceFinish,first_semantic_ms:observer.firstSemanticAt===null?null:observer.firstSemanticAt-job.dispatchedMono}:null)});
      observe(()=>shadow.finished(node.id,job.key,{outcome,finish_reason:observer.finish_reason,
        service_ms:performance.now()-job.dispatchedMono,usage:observer.usage,route:req.url,traffic_class:job.trafficClass,remaining_active:activeCount(node)-1}));
      if(routingObservations.enabled)routingObservations.complete({job,worker:routingWorker(node),usage:observer.usage,outcome,finishReason:observer.finish_reason});
      job.cleanup();
      job.upstream=null;job.upstreamResponse=null;
      job.slot.active = null;
      finishTurn(node,job.slot,outcome);
      pumpWaiting();
      schedule(node);
      if(shadow.enabled||routingObservations.enabled)setImmediate(evaluateWaiting);
    };
    // A caught reasoning loop ends the turn. The engine is still emitting, so
    // the gateway stops reading it and closes the client stream with a
    // well-formed terminal sequence: an SSE comment naming the reason (ignored
    // by every compliant client, visible in raw logs) followed by a normal
    // finish chunk and [DONE]. The client sees a clean stop, not a torn stream,
    // and the reason is recorded on the turn for the Fleet and Evidence views.
    const stopReasoningLoop=loop=>{
      if(settled||res.destroyed||res.headersSent===false)return;
      const reason=`reasoning_loop_${loop.kind}`;
      const upstreamResponse=job.upstreamResponse,upstreamRequest=job.upstream;
      try{
        res.write(`: dsg-stop ${reason} repeats=${loop.repeats} period=${loop.period} lines=${loop.lines}\n\n`);
        res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }catch{}
      // Settle first: destroying the upstream emits `aborted`, which would
      // otherwise claim this turn as an upstream failure and lose the reason.
      log('reasoning_loop_stopped',{request_id:job.id,node:node.id,kind:loop.kind,repeats:loop.repeats,period:loop.period,lines:loop.lines});
      finish('reasoning_loop',reason,'terminal');
      upstreamResponse?.destroy();upstreamRequest?.destroy();
    };
    const responseHeaders=up=>{
      const outHeaders = forwardHeaders(up.headers);
      outHeaders['x-ds4-node'] = node.id;
      outHeaders['x-request-id'] = job.id;
      outHeaders['x-ds4-affinity'] = job.affinity;
      // An upstream response can never attest that DSG did not dispatch it.
      outHeaders[DISPATCH_HEADER] = 'dispatched';
      outHeaders['x-accel-buffering'] = 'no';
      if(job.visionNormalized?.kind==='image_limit'){
        outHeaders['x-dsg-protection']='vision-image-limit-recovery';
        outHeaders['x-dsg-images-withheld']=String(job.visionNormalized.images);
      }else if(job.visionNormalized?.kind==='gif'){
        outHeaders['x-dsg-protection']='vision-gif-recovery';
        outHeaders['x-dsg-gifs-withheld']=String(job.visionNormalized.images);
      }
      return outHeaders;
    };
    const observeResponse=(up,isSSE)=>{
      response=up;clientStatus=up.statusCode;
      responseFormat=isSSE?'sse':String(up.headers['content-type']).includes('application/json')?'json':'other';
      responseEncoded=!!up.headers['content-encoding']&&String(up.headers['content-encoding']).trim().toLowerCase()!=='identity';
      if(responseFormat==='json'&&!responseEncoded)jsonUsage=new JsonUsageObserver(req.url);
      faults=responseEncoded?null:new GenerationFaultObserver(isSSE);
    };
    const acceptResponseChunk=(up,chunk,isSSE)=>{
      if(firstBodyByte===null)firstBodyByte=performance.now()-job.dispatchedMono;
      job.lastUpstreamByteMono=performance.now();
      if(jsonUsage)jsonUsage.accept(chunk);
      if(isSSE||up.statusCode>=400)faults?.accept(chunk);
      if(isSSE&&!responseEncoded)observer.accept(chunk);
      // Never cut a turn the engine already finished: a loop seen after a
      // terminal reason is history, not an in-flight loop.
      if(isSSE&&!responseEncoded&&loopObserver.detected&&!settled&&!observer.done&&!observer.finish_reason)stopReasoningLoop(loopObserver.detected);
    };
    const sendBuffered=(up,body)=>{
      // A settle path (upstream error, deadline, client abort) may already have
      // answered or destroyed the client. Re-writing headers here throws
      // ERR_HTTP_HEADERS_SENT inside this async handler, which takes down the
      // whole gateway process — the crash this guard prevents.
      if(settled||res.destroyed||res.headersSent){if(!settled)finish('upstream_stream_error','RESPONSE_ALREADY_SENT');return;}
      const isSSE=String(up.headers['content-type']).includes('text/event-stream');
      observeResponse(up,isSSE);if(body.length)acceptResponseChunk(up,body,isSSE);
      res.writeHead(up.statusCode,responseHeaders(up));res.end(body);
      const streamEnd=isSSE?(responseEncoded?'encoded_unobserved':observer.finishState()):null;
      finish(up.statusCode>=400?'upstream_http_error':!isSSE?'complete':streamEnd==='engine_error'?'upstream_engine_error':['terminal','terminal_without_done','terminal_without_finish_reason','terminal_reason_unobserved'].includes(streamEnd)?'complete':['observation_limited','encoded_unobserved'].includes(streamEnd)?'sse_observation_limited':'incomplete_sse',up.statusCode,streamEnd);
    };
    const sendGuidance=(reason,stream,kind='jpeg')=>{
      if(settled)return;
      if(job.cancelled||res.destroyed){finish('client_cancelled','CLIENT_CLOSED');return;}
      const guide=visionGuidance({stream,model:config.model,requestId:job.id,kind});
      response=undefined;clientStatus=200;responseFormat=guide.format;observer.done=true;observer.finish_reason='stop';
      const protectionKind=kind==='gif'?'vision-gif-guidance':kind==='image_limit'?'vision-image-limit-guidance':'vision-jpeg-guidance';
      const outHeaders={'content-type':guide.contentType,'content-length':guide.body.length,'cache-control':'no-store','x-ds4-node':node.id,'x-request-id':job.id,'x-ds4-affinity':job.affinity,[DISPATCH_HEADER]:'dispatched','x-accel-buffering':'no','x-dsg-protection':protectionKind};
      firstBodyByte=performance.now()-job.dispatchedMono;
      res.writeHead(200,outHeaders);res.end(guide.body);
      visionProtection.record('guided',{reason,formats:[kind],node:node.id});log('vision_image_guidance',{request_id:job.id,node:node.id,format:kind,reason});
      finish('vision_guidance',reason);
    };
    const bufferCandidate=(up,retry)=>{
      job.upstreamResponse=up;
      let chunks=[],bytes=0,passthrough=false,isSSE=false;
      const write=chunk=>{acceptResponseChunk(up,chunk,isSSE);if(!res.write(chunk)){up.pause();res.once('drain',()=>up.resume());}};
      const beginPassthrough=()=>{if(passthrough||settled||res.destroyed||res.headersSent)return;passthrough=true;observeResponse(up,isSSE);res.writeHead(up.statusCode,responseHeaders(up));res.flushHeaders();for(const chunk of chunks)write(chunk);chunks=[];};
      up.on('data',chunk=>{
        if(settled||res.destroyed)return;
        if(passthrough)return write(chunk);
        if(bytes+chunk.length<=JPEG_REJECTION_INSPECTION_BYTES){chunks.push(chunk);bytes+=chunk.length;}
        else{beginPassthrough();write(chunk);}
      });
      up.on('error',e=>{res.destroy();finish(job.cancelled?'client_cancelled':'upstream_stream_error',e.code);});
      up.on('aborted',()=>{res.destroy();finish(job.cancelled?'client_cancelled':'upstream_aborted');});
      up.on('end',()=>void (async()=>{
        if(passthrough){res.end();finish('upstream_http_error',up.statusCode);return;}
        const rejected=Buffer.concat(chunks,bytes);
        const rejection=visionRejectionKind(up.statusCode,rejected);
        if(!rejection){sendBuffered(up,rejected);return;}
        if(rejection==='image_limit'&&!retry){
          const original=await bodyReady;
          if(job.cancelled){finish('client_cancelled','CLIENT_CLOSED');return;}
          try{
            const repaired=visionProtection.recoverImageLimit(original,req.url);
            job.visionNormalized={images:repaired.removed,formats:['image_limit'],totalImages:repaired.retained,kind:'image_limit',stream:repaired.stream};firstBodyByte=null;
            log('vision_image_limit_recovery',{request_id:job.id,node:node.id,withheld:repaired.removed,retained:repaired.retained});
            issue(await rewriteBodyToBuffer(repaired.body),true);
          }catch{sendBuffered(up,rejected);}
          return;
        }
        if(rejection==='image_limit'&&retry){
          if(job.visionNormalized?.kind==='image_limit')sendGuidance('image_limit_recovery_rejected',job.visionNormalized.stream,'image_limit');
          else if(job.visionNormalized?.totalImages>16)sendGuidance('image_limit_exceeded',job.visionNormalized.stream,'image_limit');
          else sendBuffered(up,rejected);
          return;
        }
        if(rejection==='gif_candidate'){
          const original=await bodyReady;
          if(job.cancelled){finish('client_cancelled','CLIENT_CLOSED');return;}
          try{
            if(retry){
              const inspected=visionProtection.inspectGif(original,req.url);
              sendGuidance('gif_recovery_rejected',job.visionNormalized?.stream??inspected.stream,'gif');
            }else{
              const repaired=visionProtection.recoverGif(original,req.url);
              job.visionNormalized={images:repaired.removed,formats:['gif'],totalImages:repaired.totalImages,kind:'gif',stream:repaired.stream};firstBodyByte=null;
              log('vision_gif_recovery',{request_id:job.id,node:node.id,withheld:repaired.removed});
              issue(await rewriteBodyToBuffer(repaired.body),true);
            }
          }catch{
            // A generic JSON response is not enough evidence. Preserve it
            // exactly unless the submitted Chat Completions body proves that a
            // valid typed GIF caused the pre-generation rejection.
            sendBuffered(up,rejected);
          }
          return;
        }
        const kind=job.visionNormalized?.kind??'jpeg';
        if(retry){sendGuidance('normalized_image_rejected',job.visionNormalized?.stream??job.requestStream===true,kind);return;}
        const original=await bodyReady;
        if(job.cancelled){finish('client_cancelled','CLIENT_CLOSED');return;}
        try{
          const normalized=await visionProtection.normalize(original,req.url);
          if(job.cancelled){finish('client_cancelled','CLIENT_CLOSED');return;}
          job.visionNormalized={images:normalized.converted,formats:normalized.formats,totalImages:normalized.totalImages,kind:'jpeg',stream:normalized.stream};firstBodyByte=null;
          issue(await rewriteBodyToBuffer(normalized.body),true);
        }catch(error){
          let stream=job.requestStream===true;
          if(Buffer.isBuffer(original))try{stream=JSON.parse(original.toString('utf8'))?.stream===true;}catch{}
          const guidanceKind=error.message==='gif_not_supported'?'gif':kind;
          sendGuidance(/^[a-z_]{1,64}$/.test(error.message)?error.message:'normalization_failed',stream,guidanceKind);
        }
      })().catch(()=>{if(!settled){res.destroy();finish('upstream_stream_error','END_HANDLER');}}));
    };
    const forwardResponse=up=>{
      job.upstreamResponse=up;
      if(settled||res.destroyed){up.destroy();return;}
      const isSSE = String(up.headers['content-type']).includes('text/event-stream');
      observeResponse(up,isSSE);
      res.writeHead(up.statusCode,responseHeaders(up));res.flushHeaders();
      up.on('data',chunk=>acceptResponseChunk(up,chunk,isSSE));
      up.on('error',e=>{res.destroy();finish(job.cancelled?'client_cancelled':'upstream_stream_error',e.code);});
      up.on('aborted',()=>{res.destroy();finish(job.cancelled?'client_cancelled':'upstream_aborted');});
      up.on('end',()=>{const streamEnd=isSSE?(responseEncoded?'encoded_unobserved':observer.finishState()):null;finish(up.statusCode>=400?'upstream_http_error':!isSSE?'complete':streamEnd==='engine_error'?'upstream_engine_error':['terminal','terminal_without_done','terminal_without_finish_reason','terminal_reason_unobserved'].includes(streamEnd)?'complete':['observation_limited','encoded_unobserved'].includes(streamEnd)?'sse_observation_limited':'incomplete_sse',up.statusCode,streamEnd);});
      up.pipe(res);
    };
    const issue=(replacement,retry=false,exactLength=null)=>{
      let gotResponse=false,freshConnectingSocket=false,connected=false;
      const attemptHeaders={...headers};
      if(exactLength!=null)attemptHeaders['content-length']=exactLength;
      else if(replacement){delete attemptHeaders['transfer-encoding'];attemptHeaders['content-length']=replacement.length;}
      else if(rewriteRequired)delete attemptHeaders['content-length'];
      const upstream=endpointTransport(target).request(target,{...upstreamOptions(node,target),method:req.method,headers:attemptHeaders},up=>{
        gotResponse=true;
        if(up.statusCode===400&&visionProtection.enabled&&(retry||captureLimit))bufferCandidate(up,retry);
        else forwardResponse(up);
      });
      job.upstream=upstream;
      upstream.on('socket',socket=>{
        if(!socket.connecting){connected=true;return;}
        freshConnectingSocket=true;
        const timer=setTimeout(()=>upstream.destroy(Object.assign(new Error('Connect timeout'),{code:'CONNECT_TIMEOUT'})),config.connect_timeout_ms??10000);
        socket.once('connect',()=>{connected=true;clearTimeout(timer);});socket.once('close',()=>clearTimeout(timer));
      });
      upstream.on('error',errorValue=>{
        // Only the original POST on a witnessed fresh, never-connected socket
        // can prove that no worker received it. Resets, timeouts, reused sockets
        // and normalized follow-up attempts remain ambiguous. Never replay here.
        if(!settled&&!job.cancelled&&!res.destroyed&&!res.headersSent&&req.method==='POST'&&!retry&&!replacement&&
          !gotResponse&&freshConnectingSocket&&!connected&&upstream.reusedSocket===false&&errorValue.code==='ECONNREFUSED'){
          requestBody.unpipe(upstream);clientStatus=503;
          finish('upstream_error',errorValue.code);
          return reject(req,res,503,'home_unavailable','The DS4 connection was refused before it connected; this request did not reach the server. A compatible patient client can wait and retry the unchanged request.',{id:job.id,callId:job.callId,key:job.key,node,reason:'worker_connect_refused'});
        }
        const retryMessage=job.visionNormalized?.kind==='image_limit'?'Image-limit recovery turn could not reach DS4. Execution may have started; DSG did not retry again.':job.visionNormalized?.kind==='gif'?'GIF recovery turn could not reach DS4. Execution may have started; DSG did not retry again.':'Normalized image retry could not reach DS4. Execution may have started; DSG did not retry again.';
        if(!res.headersSent)error(res,502,'upstream_error',retry?retryMessage:'Upstream connection failed. Execution may have started; gateway did not retry.');
        else res.destroy();
        // Parse faults carry the raw received bytes; a bounded preview turns an
        // opaque llhttp code into evidence about what the engine actually sent.
        if(errorValue?.rawPacket?.length)log('upstream_parse_fault',{node:node.id,request_id:job.id,bytes:errorValue.rawPacket.length,preview:errorValue.rawPacket.toString('latin1').slice(0,400)});
        finish(job.cancelled?'client_cancelled':'upstream_error',errorValue.code);
      });
      upstream.on('close',()=>{if(!settled&&(job.cancelled||!gotResponse))finish(job.cancelled?'client_cancelled':'connection_closed');});
      if(replacement!=null)upstream.end(replacement);
      return upstream;
    };
    job.deadline = setTimeout(() => { job.upstream?.destroy(Object.assign(new Error('100-hour request deadline'), { code: 'REQUEST_DEADLINE' })); }, config.request_timeout_ms ?? 360000000);
    log('request_dispatched', { request_id: job.id, node: node.id, session: job.key?.slice(0, 12), affinity: job.affinity, queue_ms: job.dispatched - job.created });
    node.lastGateActivityAt = Date.now();
    dataset.record('dispatch',{request_id:job.id,node:node.id,queue_ms:job.dispatchedMono-job.createdMono});
    // A queued read-ahead prefix feeds the same observers and upstream once,
    // followed by the still-streaming original upload with backpressure.
    requestBody.on('data',observeBody);requestBody.once('end',bodyEnded);req.once('aborted',bodyAborted);requestBody.once('error',bodyAborted);
    if(rewriteRequired&&!profiles[node.id]&&!effortAliases){
      // Exact-length streaming rewrite. Some engine HTTP frontends cannot decode
      // chunked request bodies (observed on TensorFold 0.6.5: an empty body, then
      // a double-framed 400). The alias rewrite substitutes only the top-level
      // model string, so once that substitution is observed the final body length
      // is known: send the corrected Content-Length and stream the remainder
      // through unchanged. Uploads without a match (or beyond the pre-read bound,
      // or without a declared length) keep streaming chunked, as before.
      const state={delta:0,settled:false};
      const rewrite=modelAliasTransform(aliases,req.headers['content-encoding'],'model',state);
      const pieces=[];let size=0,mode=null,upstream=null;
      const clientLength=/^\d+$/.test(req.headers['content-length']??'')?Number(req.headers['content-length']):null;
      const writePiece=chunk=>{if(upstream.write(chunk))return;rewrite.pause();upstream.once('drain',()=>rewrite.resume());};
      const onData=chunk=>{
        if(mode)return;
        pieces.push(chunk);size+=chunk.length;
        // A client that declared no length has no exact-length rewrite available
        // — that is the whole premise of this branch — so there is nothing to
        // wait for. Stream immediately and let the transform hold only the
        // unfinished model token. Buffering here instead stalled every chunked
        // upload until the model value completed, which for a pretty-printed or
        // large streamed body means holding back bytes the engine could already
        // have been reading.
        const goChunked=()=>{
          mode='chunked';rewrite.removeListener('data',onData);
          upstream=issue(null);
          upstream.once('close',()=>{requestBody.unpipe(rewrite);rewrite.destroy();});
          for(const piece of pieces)writePiece(piece);
          pieces.length=0;
          rewrite.pipe(upstream);
        };
        if(clientLength==null){goChunked();return;}
        if(state.settled&&clientLength!=null){
          mode='exact';rewrite.removeListener('data',onData);
          upstream=issue(null,null,clientLength+state.delta);
          upstream.once('close',()=>{requestBody.unpipe(rewrite);rewrite.destroy();});
          for(const piece of pieces)writePiece(piece);
          pieces.length=0;
          // The transform keeps draining its buffered tail and the remainder;
          // after the settled substitution it is a pass-through.
          rewrite.pipe(upstream);
        }
        else if(state.settled||size>rewriteBufferBytes){goChunked();}
      };
      rewrite.on('data',onData);
      rewrite.once('error',e=>{if(upstream)upstream.destroy(e);else requestBody.destroy(e);});
      requestBody.once('end',()=>{if(mode===null)upstream=issue(Buffer.concat(pieces,size));});
      requestBody.pipe(rewrite);
      res.once('close',()=>rewrite.destroy());
    }
    else if(rewriteRequired){
      // Any rewrite the exact-length specialization above does not own lands
      // here: a serving profile, an engine-dialect effort alias, or both. This
      // branch must apply rewriteBody(), which composes every transform.
      //
      // It previously piped the ORIGINAL body instead, so a request whose only
      // required rewrite was a reasoning-effort alias — or any request carrying
      // one alongside a model alias — reached the engine unmodified: the model
      // alias was dropped too, and a dialect that names its top effort
      // differently answered 400. The exact-length path cannot cover these
      // cases, because an effort substitution has no fixed-size relationship to
      // the original body the way a single model-string swap does.
      const rewrite=rewriteBody();
      rewrite.on('error',e=>{if(job.upstream)job.upstream.destroy(e);else requestBody.destroy(e);});
      const upstream=issue(null);
      upstream.once('close',()=>{requestBody.unpipe(rewrite);rewrite.destroy();});
      requestBody.pipe(rewrite).pipe(upstream);
    }
    else{const upstream=issue(null);requestBody.pipe(upstream);}
  }

  const server = http.createServer((req, res) => {
    if (!requestAuthorized(config,req)) { req.resume(); return error(res, 401, 'unauthorized', 'Bearer API key required'); }
    if(handleMediaRequest(req,res,{jobs:mediaJobs,accepting:!draining}))return;
    // Reject absolute URLs and encoded/normalized alternate routes; no admin forwarding.
    const discovery = req.method === 'GET' && /^\/v1\/models(?:\?[^#]*)?$/.test(req.url);
    const route = discovery ? 'GET /v1/models' : `${req.method} ${req.url}`;
    if (route === 'GET /gateway/status' || route === 'GET /workers') return json(res, 200, stats());
    if (route === 'GET /health') {const ready=!draining&&nodes.some(n=>n.healthy&&!n.drained);return json(res,ready?200:503,{...stats(),...(!ready?{error:{type:'gateway_error',code:'not_ready',message:dsgReport('Gateway is draining or no DS4 server is ready.')}}:{})});}
    if(route===`POST ${CLIENT_WATCH_ROUTE}`){
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){req.resume();return error(res,415,'client_watch_media_type','Client Watch requires JSON');}
      const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>2048){req.resume();return error(res,413,'client_watch_too_large','Client Watch heartbeat exceeds 2 KiB');}
      let body='',bytes=0,finished=false;
      const timer=setTimeout(()=>{if(finished)return;finished=true;error(res,408,'client_watch_timeout','Client Watch heartbeat was incomplete');req.destroy();},5000);timer.unref();
      req.on('data',chunk=>{if(finished)return;bytes+=chunk.length;if(bytes>2048){finished=true;clearTimeout(timer);error(res,413,'client_watch_too_large','Client Watch heartbeat exceeds 2 KiB');req.resume();return;}body+=chunk;});
      req.on('error',()=>{finished=true;clearTimeout(timer);});req.on('aborted',()=>{finished=true;clearTimeout(timer);});
      req.on('end',()=>{if(finished)return;finished=true;clearTimeout(timer);try{return json(res,200,{schema:1,...clientWatch.heartbeat(JSON.parse(body))});}catch{return error(res,400,'invalid_client_watch','Invalid Client Watch heartbeat');}});
      return;
    }
    if(route===`GET ${PI_CLIENT_BUNDLE_ROUTE}`){
      req.resume();
      const {baseUrl,fallbackBaseUrls}=piClientBaseUrls(req);
      try{
        return json(res,200,buildPiClientBundle({baseUrl,fallbackBaseUrls,poolModel:config.model,contextWindow:contextLimit(),template:piClientTemplate,generatedAt:new Date().toISOString()}));
      }catch(e){return error(res,503,'pi_client_bundle_unavailable',dsgReport('Client bundle could not be built.'));}
    }
    if(route===`GET ${PI_CLIENT_SCRIPT_ROUTE}`){
      req.resume();
      const {baseUrl,fallbackBaseUrls}=piClientBaseUrls(req);
      const template=piClientScriptTemplate();
      if(!template)return error(res,503,'pi_client_script_unavailable',dsgReport('Client script is not installed on this gateway.'));
      let script;
      try{script=renderPiClientScript(template,{baseUrl,fallbackBaseUrls,apiKey:PI_CLIENT_KEY});}
      catch(e){return error(res,503,'pi_client_script_unavailable',dsgReport('Client script could not be rendered.'));}
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','content-disposition':'inline; filename="pi-stargate-sync.ps1"'});
      return res.end(script);
    }
    if(route===`POST ${PI_CLIENT_REPORT_ROUTE}`){
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){req.resume();return error(res,415,'pi_client_report_media_type','Client report requires JSON');}
      const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>8192){req.resume();return error(res,413,'pi_client_report_too_large','Client report exceeds 8 KiB');}
      let body='',bytes=0,finished=false;
      const timer=setTimeout(()=>{if(finished)return;finished=true;error(res,408,'pi_client_report_timeout','Client report was incomplete');req.destroy();},5000);timer.unref();
      req.on('data',chunk=>{if(finished)return;bytes+=chunk.length;if(bytes>8192){finished=true;clearTimeout(timer);error(res,413,'pi_client_report_too_large','Client report exceeds 8 KiB');req.resume();return;}body+=chunk;});
      req.on('error',()=>{finished=true;clearTimeout(timer);});req.on('aborted',()=>{finished=true;clearTimeout(timer);});
      req.on('end',()=>{if(finished)return;finished=true;clearTimeout(timer);
        let parsed;try{parsed=JSON.parse(body);}catch{return error(res,400,'invalid_pi_client_report','Invalid client report');}
        try{return json(res,200,{schema:1,...piClientReports.record(parsed)});}
        catch(e){return error(res,e&&e.code==='invalid'?400:503,e&&e.code==='invalid'?'invalid_pi_client_report':'pi_client_report_unavailable',e&&e.code==='invalid'?'Invalid client report':'Client report could not be stored');}
      });
      return;
    }
    if (!accepted.has(route)) { req.resume(); return error(res, 404, 'unsupported_route', 'Endpoint is not on the inference allowlist'); }
    let priority;try{priority=requestPriority(req.headers[PRIORITY_HEADER]);}catch(e){req.resume();return error(res,400,'invalid_priority',e.message);}
    const geniePriority=isGenieRequest(config,req.headers);
    const admissionMetadata=clientMetadata(req.headers[CLIENT_METADATA_HEADER]);
    const keyValue = req.headers['x-session-affinity'] || req.headers['x-ds4-conversation-id'] || req.headers['x-session-id'] || req.headers.session_id;
    const key = keyValue && req.method === 'POST' ? digest(String(keyValue)) : null;
    const requestId=randomUUID(),callId=validCallId(req.headers[CALL_ID_HEADER]),watchId=validClientWatchId(req.headers[CLIENT_WATCH_HEADER]),trafficClass=geniePriority||req.headers['x-dsg-observer']==='gate-genie'?'genie':'unclassified';
    if(req.method==='POST')clientWatch.observeRequest(watchId,requestId,'received');
    if(draining)return reject(req,res,503,'draining','Gateway is draining; no new requests admitted',{id:requestId,callId,key,reason:'gateway_draining'});
    let modelRoute;try{modelRoute=routeSelection(routes,req.headers[MODEL_ROUTE_HEADER]);}catch(e){req.resume();return error(res,400,'unknown_model_route',e.message);}
    const home = key && store.get(key);
    let node = home && nodes.find(n => n.id === home.node);
    let affinity = key ? home ? 'existing' : 'new' : 'none';
    let waitReason=null;
    if (node && (!allowsWorker(modelRoute,node) || !node.healthy || node.drained)) {
      // Ownership is conversation-scoped. Unrelated work must not block a safe
      // undispatched retry; same-session work, including cancelled active work,
      // retains ownership until its dispatch actually settles.
      const outstanding=sessionWork(nodes,key);
      if(outstanding){waitReason=outstanding.reason;node=null;}
      else {node = pick(node.id,modelRoute); affinity = 'reassigned';}
    }
    if (!node&&!waitReason) {
      node=pick(undefined,modelRoute);
      // Existing homes and reassignment retain their established safety/cache
      // behavior. Only genuinely new conversations may use validated placement.
    }
    if(key&&waiting.some(j=>j.key===key)){node=null;waitReason='same_session_queued';}
    if (req.method === 'GET') {
      if(!node)return reject(req,res,503,'no_healthy_workers','No DS4 server is currently ready; model metadata is unavailable',{id:requestId,callId,key,reason:'no_ready_worker'});
      // Model-list requests must not sit behind a multi-hour generation.
      const modelsUrl = endpointUrl(node, req.url);
      const probe = endpointTransport(modelsUrl).get(modelsUrl, upstreamOptions(node,modelsUrl), up => {
        let body = '';
        up.on('data', chunk => { body += chunk; if (body.length > 1048576) probe.destroy(new Error('Model metadata too large')); });
        up.on('error', () => error(res, 502, 'models_unavailable', 'Model metadata unavailable'));
        up.on('end', () => {
          try {
            if (up.statusCode !== 200) throw new Error();
            const data = JSON.parse(body); if (!Array.isArray(data.data)) throw new Error();
            const aliases=endpointAliases(node,data,config);
            node.effectiveModelAliases=aliases;
            node.reasoningEffortAliases=endpointMetadata(node,data,config).reasoningEffortAliases;
            if(Object.keys(aliases).length){const originals=[...data.data];for(const [alias,id] of Object.entries(aliases)){const model=originals.find(m=>m.id===id);if(model&&!data.data.some(m=>m.id===alias))data.data.push({...model,id:alias,owned_by:'dsg-pool'});}}
            const publishedContext=modelRoute?Math.min(...nodes.filter(n=>modelRoute.workers.has(n.id)).map(n=>n.context_length??contextLimit())):contextLimit();
            // Explicit routes publish their guarantee; unselected traffic keeps the pool limit.
            // Explicit per-worker aliases only rewrite the top-level request model.
            for (const model of data.data) {
              model.context_length = publishedContext;
              if(profiles[node.id]){model.max_output_tokens=profiles[node.id].max_output_tokens;model.input=profiles[node.id].input;model.reasoning=profiles[node.id].reasoning;}
              if (model.max_model_len !== undefined) model.max_model_len = publishedContext;
              if (model.top_provider) model.top_provider = { ...model.top_provider, context_length:publishedContext,
                max_completion_tokens: Math.min(model.top_provider.max_completion_tokens ?? publishedContext, publishedContext) };
            }
            json(res, 200, data);
          } catch { error(res, 502, 'models_unavailable', 'Model metadata unavailable'); }
        });
      });
      probe.setTimeout(config.health_timeout_ms ?? 5000, () => probe.destroy());
      probe.on('error', () => error(res, 502, 'models_unavailable', 'Model metadata unavailable'));
      res.on('close', () => probe.destroy());
      return;
    }
    const genieFlexible=!key&&(geniePriority||(trafficClass==='genie'&&req.headers['x-dsg-review-flexible']==='1'));
    if(genieFlexible){node=freeGenieNode(modelRoute,priority,Number.MAX_SAFE_INTEGER,geniePriority);waitReason=node?null:'no_ready_worker';}
    if(trafficClass==='genie'&&req.headers['x-dsg-review-no-wait']==='1'){
      // Check atomically at admission. A previously free snapshot cannot grant
      // permission to put an advisory review behind user work after a race.
      if(key||waitReason||!node||!hasCapacity(node)||node.queue.length||parkedFor(node).length||node.quarantine||node.recovering||node.removed)return reject(req,res,503,'no_healthy_workers','No compatible worker is immediately free for this advisory review',{id:requestId,callId,key,reason:'no_ready_worker'});
    }
    if ((node&&node.queue.length+parkedFor(node).length>=queueBound())||(!node&&waiting.length>=waitingBound()))return reject(req,res,429,'queue_full','DSG waiting capacity is full; request was not dispatched. Wait for capacity or use the patient client adapter.',{id:requestId,callId,key,node,reason:'queue_full'});
    const job = { req, res, key, affinity, id:requestId,callId,watchId, sequence:sequence++,admissionMetadata,created: Date.now(), createdMono:performance.now(), cancelled: false,queueTimeoutMs:queueTimeoutMs(),
      trafficClass,geniePriority,genieFlexible,modelRoute,priority };
    job.previewFromRequest=req.headers['x-dsg-priority-intent']!=='off'&&trafficClass!=='genie'&&req.url==='/v1/chat/completions';
    const cancel = () => {
      if (res.writableFinished) return;
      job.cancelled = true;
      if (job.upstream) {
        // Once response headers exist, destroying ClientRequest alone does not
        // reliably close its IncomingMessage. Close both halves so DS4 sees the
        // cancelled consumer and the gateway cannot retain a ghost active slot.
        const outbound=job.upstream,inbound=job.upstreamResponse;
        inbound?.destroy();
        outbound.destroy();
      }
      else {
        detach(job);
        job.queueTimer?.cancel(); job.cleanup();
        clientWatch.observeRequest(job.watchId,job.id,'cancelled');
        log('queued_request_cancelled', { request_id: job.id, node: job.node?.id??job.fixedHome?.id??null });
        dataset.record('queued_cancel',{request_id:job.id,node:job.node?.id??job.fixedHome?.id??null,total_ms:performance.now()-job.createdMono});
        pumpWaiting();
      }
    };
    job.cleanup = () => { clearTimeout(job.routingInputTimer);job.routingInputPending=false;clearJobPreview(job);job.queueTimer?.cancel();job.queuedBody?.dispose();req.off('aborted', cancel); res.off('close', cancel); req.off('error', cancel); };
    req.on('aborted', cancel); req.on('error', cancel); res.on('close', cancel);
    job.queueTimer = deadlineTimer(() => {
      detach(job);
      const owner=job.node??job.fixedHome;
      reject(req,res,504,'queue_timeout',queueTimeoutMessage(job.queueTimeoutMs),{...job,node:owner,reason:'queue_deadline'});
      dataset.record('queue_timeout',{request_id:job.id,node:owner?.id??null,total_ms:performance.now()-job.createdMono});
      job.cleanup(); req.resume();pumpWaiting();
    }, job.queueTimeoutMs);
    if((job.previewFromRequest||routingObservations.enabled)&&(!req.headers['content-encoding']||req.headers['content-encoding']==='identity')){
      const releaseRoutingInput=()=>{
        if(!job.routingInputPending)return;
        job.routingInputPending=false;clearTimeout(job.routingInputTimer);
        // The observer can finish in its constructor, before admit() sets node.
        queueMicrotask(()=>{if(!job.cancelled&&!job.dispatched&&!shuttingDown&&job.node){
          reconsiderRouting(job,'input_observation_ready');schedule(job.node);
        }});
      };
      if(timeRouting){job.routingInputPending=true;job.routingInputTimer=setTimeout(releaseRoutingInput,ROUTING_BODY_WAIT_MS);job.routingInputTimer.unref?.();}
      job.queuedBody=new QueuedRequestBody(req,{budget:queuedBodyBudget,onBody:body=>{
        if(!job.cancelled&&job.previewFromRequest)observeJobPreview(job,requestUserExcerpt(body));
        observeRoutingBody(job,body);
      },onReady:releaseRoutingInput});
    }
    if(node)admit(job,node);else park(job,null,waitReason??'no_ready_worker');
  });
  server.requestTimeout = 0; // Covers upload + queue; no hidden five-minute Node default.
  server.timeout = 0; // Long prefill/decode streams are intentionally allowed to be idle.
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 5000;
  server.on('clientError',invalidHttp);

  async function probe(node,force=false) {
    if(node.endpointEditing&&!force)return;
    if (node.probing) return;
    node.probing = true;
    const activeAtStart=activeJobs(node);
    await new Promise(resolve => {
      let settled = false, deadline;
      const finish = (ok, reason) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); node.probeRequest = null;
        node.probing = false; node.lastProbe = new Date().toISOString();
        // A model-list timeout alone cannot contradict contemporaneous bytes
        // from the live inference stream. Merely being active is NOT enough:
        // silent prefill, a stuck socket and real network loss still fail probes.
        const inference=[...activeJobs(node),...activeAtStart];
        if(!ok&&reason==='PROBE_TIMEOUT'&&inference.some(job=>job.lastUpstreamByteMono!==undefined&&
          performance.now()-job.lastUpstreamByteMono<(config.health_timeout_ms??5000))){
          node.healthProbeDeferred++;
          node.probeError='busy_probe_deferred';
          resolve();return;
        }
        node.probeError = reason;
        if (reason && reason !== 'model_or_context_mismatch') node.modelMatches=false;
        const was = node.healthy;
        if (ok) {
          node.failures = 0; node.healthy = !node.quarantine && !node.recovering;
          if(node.ssh)node.managementPath={...node.managementPath,state:'verified',reason:null,changed_at:new Date().toISOString(),last_verified_at:new Date().toISOString()};
        }
        else if (++node.failures >= (config.health_failures ?? 3)) node.healthy = false;
        if(!ok&&node.ssh&&node.managementPath.state==='verified')node.managementPath={...node.managementPath,state:'ssh_process_active',reason:null,changed_at:new Date().toISOString()};
        if(was && !node.healthy)observe(()=>shadow.reset(node.id));
        if (was !== node.healthy) log('worker_health', { node: node.id, healthy: node.healthy, reason });
        resolve();
      };
      try { node.upstreamHeaders = endpointHeaders(node); }
      catch { finish(false, 'endpoint_credentials_unavailable'); return; }
      const modelsUrl = endpointUrl(node, '/v1/models');
      // A full inference connection pool must not delay the health request and
      // manufacture a timeout before the backend even receives it.
      const p = endpointTransport(modelsUrl).get(modelsUrl, {...upstreamOptions(node,modelsUrl),agent:false}, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; if (body.length > 1048576) p.destroy(); });
        res.on('error', e => finish(false, e.code));
        res.on('end', () => {
          if(res.statusCode===401||res.statusCode===403){finish(false,'authentication_required');return;}
          try {
            const metadata = endpointMetadata(node, JSON.parse(body), config);
            node.modelMatches = res.statusCode === 200 && metadata.available;
            node.probeModel = metadata.probeModel;
            if(res.statusCode===200&&metadata.available){node.effectiveModelAliases=metadata.aliases;node.reasoningEffortAliases=metadata.reasoningEffortAliases;}
            const previousContext=node.contextLength;
            node.contextLength = metadata.contextLength;
            if(previousContext!==undefined && previousContext!==node.contextLength)observe(()=>shadow.reset(node.id));
            const ok = node.modelMatches && node.contextLength >= requiredContext(node);
            finish(ok, ok ? undefined : 'model_or_context_mismatch');
          } catch { finish(false, 'invalid_model_response'); }
        });
      });
      node.probeRequest = p;
      // Total health-check deadline, not an inference or idle-stream limit.
      deadline = setTimeout(() => { p.destroy(); finish(false, 'PROBE_TIMEOUT'); }, config.health_timeout_ms ?? 5000);
      p.setTimeout(config.health_timeout_ms ?? 5000, () => p.destroy(Object.assign(new Error('probe timeout'), { code: 'PROBE_TIMEOUT' })));
      p.on('error', e => finish(false, e.code));
    });
  }
  const startTunnel = node => {
    if (node.ssh) node.stopTunnel = tunnelFactory(node, () => shuttingDown || node.removed);
  };
  const registry = () => ({ routing_capacity_control:true,routing_margin_control:true,routing_switching_margin_seconds:routingMargin(),routing_time_mode:timeRouting?'active':routingObservations.enabled?'observation_only':'off',spark_services_version:1,genie_capabilities:capabilityStatus(), model: config.model, minimum_context: contextLimit(), context_limit_control:true,concurrency_control_version:1,conditional_resume_version:1,media_maintenance_version:1,direct_reserve_control:true,direct_reserve_enabled:directReserveEnabled(),direct_reserve_release_ms:directReserveMs(),
    archived:[...new Set([...nodes.filter(n=>n.archived===true).map(n=>n.id),...Object.entries(store.data.archived??{}).filter(([,v])=>v===true).map(([id])=>id)])],
    genie_admission_version:1,genie_flexible_assignment:true,
    context_limit_source:store.data.pool_context_length === undefined ? 'config' : 'saved',
    conversation_turns:conversationTurns(),conversation_turn_idle_ms:conversationTurnIdleMs,conversation_turns_control:true,conversation_turns_source:store.data.conversation_turns!==undefined?'saved':config.conversation_turns!==undefined?'config':'default',
    queue_timeout_ms:queueTimeoutMs(),queue_timeout_control:true,queue_timeout_source:store.data.queue_timeout_ms!==undefined?'saved':config.queue_timeout_ms!==undefined?'config':'default',
    recovery:{...recovery.status(),pair_enrollment:pairEnrollment.status(),omlx_enrollment:omlxEnrollment.status()},protections:visionProtection.status(),queued_relocation:{schema:1,automatic:true,automatic_scope:automaticRelocationScope,automatic_affinity_rebalance_min_wait_ms:automaticAffinityWait,offers:relocationOffers(),diagnostics:relocationDiagnostics(),completed:relocation.completed,rejected:relocation.rejected},
    workers: nodes.map(n => ({ ...definition(n), ...stats().workers.find(w => w.id === n.id),...agents.pauseStatus(n.id,{includeReason:true}) })) });
  async function freshProbe(node) {
    while (node.probing) await delay(10);
    await probe(node);
  }
  function setExecutionCapacity(input){
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    if(!input||Object.keys(input).sort().join(',')!=='capacity,expected_capacity,expected_identity,id'
      ||!Number.isSafeInteger(input.capacity)||input.capacity<1)throw new Error('Specify a positive whole execution capacity, worker ID and the displayed current values');
    const node=nodes.find(node=>node.id===input.id);if(!node)throw new Error('Unknown worker');
    const current=routingCapacity(node);
    if(input.expected_identity!==current.manual_identity||input.expected_capacity!==current.manual_execution)throw new Error('Worker or manual execution capacity changed; refresh before saving');
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.execution-capacity-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,routing_execution_capacity:{...store.data.routing_execution_capacity,[node.id]:{capacity:input.capacity,identity:current.manual_identity}}});
    log('manual_execution_capacity_changed',{node:node.id,capacity:input.capacity,engine_settings_changed:false});
    pumpWaiting();for(const worker of nodes)schedule(worker);
    return registry();
  }
  function setRoutingMargin(input){
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expected_margin_seconds,margin_seconds'
      ||!Number.isFinite(input.margin_seconds)||input.margin_seconds<0)throw new Error('Specify a finite non-negative switching margin in seconds and the expected current value');
    if(input.expected_margin_seconds!==routingMargin())throw new Error('Switching margin changed; refresh before saving');
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.routing-margin-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,routing_switching_margin_seconds:input.margin_seconds});
    log('routing_switching_margin_changed',{margin_seconds:routingMargin(),mode:timeRouting?'active':routingObservations.enabled?'observation_only':'off'});
    return registry();
  }
  function setConversationTurns(input){
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='conversation_turns,expected_conversation_turns'||!Number.isSafeInteger(input.conversation_turns)||input.conversation_turns<1)throw new Error('Specify a positive whole conversation turn allowance and expected current value');
    if(input.expected_conversation_turns!==conversationTurns())throw new Error('Conversation turn allowance changed; refresh before applying');
    const before=conversationTurns();
    if(before===input.conversation_turns&&store.data.conversation_turns!==undefined)return registry();
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.turns-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,conversation_turns:input.conversation_turns});
    if(before!==conversationTurns())for(const node of nodes){
      // An active model call finishes on its original server. Count it when
      // enabling allocations from FIFO, and preserve used turns otherwise.
      for(const slot of node.slots){
      if(slot.active&&!slot.turnAllocation&&conversationTurns()>1&&slot.active.key)slot.turnAllocation={key:slot.active.key,priority:slot.active.priority,used:1,until:0};
      if(!slot.active&&slot.turnAllocation){
        if(slot.turnAllocation.used>=before&&conversationTurns()>before)releaseTurns(node,slot);
        else if(slot.turnAllocation.used>=conversationTurns()){
          // End only the grace timer. Retain the exhausted allocation so the
          // scheduler still yields to the oldest OTHER conversation.
          clearTimeout(slot.turnTimer);slot.turnTimer=null;slot.turnAllocation.until=0;
        }
      }
      }
      schedule(node);
    }
    log('conversation_turn_allowance_changed',{before,after:conversationTurns(),applies_to:'next_dispatch'});
    return registry();
  }
  function setDirectReserve(input){
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='enabled'||typeof input.enabled!=='boolean')throw new Error('Specify boolean enabled only');
    if(directReserveEnabled()===input.enabled&&store.data.direct_reserve_enabled!==undefined)return registry();
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.direct-reserve-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,direct_reserve_enabled:input.enabled});
    if(!input.enabled)for(const node of nodes)delete node.directReservedUntil;
    log('direct_reserve_changed',{enabled:input.enabled});
    return registry();
  }
  function setWorkerConcurrency(input){
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expected_max_concurrent_requests,id,max_concurrent_requests')throw new Error('Specify worker ID, current capacity and replacement capacity only');
    const node=nodes.find(n=>n.id===input.id);if(!node)throw new Error('Unknown worker');
    const before=requestCapacity(node);
    if(input.expected_max_concurrent_requests!==before)throw new Error('Worker capacity changed; refresh before saving');
    if(!node.drained||activeCount(node)||node.queue.length||parkedFor(node).length||node.recovering)throw new Error('Pause this worker and wait for all admitted requests to finish before changing its capacity');
    const settings=workerConfig({...definition(node),max_concurrent_requests:input.max_concurrent_requests});
    if(settings.max_concurrent_requests===before)return registry();
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.capacity-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,workers:nodes.map(n=>n===node?settings:definition(n))});
    node.max_concurrent_requests=settings.max_concurrent_requests;
    if(node.slots.length>requestCapacity(node)){for(const slot of node.slots.slice(requestCapacity(node)))releaseTurns(node,slot);node.slots.length=requestCapacity(node);}
    agent.maxSockets=tlsAgent.maxSockets=Math.max(16,nodes.reduce((sum,worker)=>sum+requestCapacity(worker),0));
    observe(()=>shadow.reset(node.id));
    log('worker_request_capacity_changed',{node:node.id,before,after:requestCapacity(node),drained:true,engine_settings_changed:false});
    return registry();
  }
  const THINKING_LEVELS=['none','minimal','low','medium','high','xhigh','max'];
  const savedThinking=()=>store.data.genie_thinking??{};
  function setGenieThinking(input){
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    if(!input||Array.isArray(input)||!['chat','reviewer'].some(k=>Object.hasOwn(input,k)))throw new Error('Specify genie thinking for chat, reviewer or both');
    const picked={};
    for(const key of ['chat','reviewer'])if(Object.hasOwn(input,key)){
      if(!THINKING_LEVELS.includes(input[key]))throw new Error(`genie thinking ${key} must be one of ${THINKING_LEVELS.join(', ')}`);
      picked[key]=input[key];
    }
    const saved={...(store.data.genie_thinking??{}),...picked};
    store.save({...store.data,genie_thinking:saved});
    log('genie_thinking_changed',{...picked,operator_action:'set-genie-thinking'});
    return saved;
  }
  const genieThinking=()=>({chat:savedThinking().chat??config.genie_chat?.reasoning_effort??'xhigh',reviewer:savedThinking().reviewer??config.genie?.reasoning_effort??'high',saved:store.data.genie_thinking??null,levels:THINKING_LEVELS});
  function setQueueTimeout(input){
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expected_queue_timeout_ms,queue_timeout_ms'||!Number.isSafeInteger(input.queue_timeout_ms)||input.queue_timeout_ms<1)throw new Error('Specify a positive whole queue timeout and expected current value');
    if(input.expected_queue_timeout_ms!==queueTimeoutMs())throw new Error('Queue allowance changed; refresh before applying');
    const before=queueTimeoutMs();
    if(before===input.queue_timeout_ms&&store.data.queue_timeout_ms!==undefined)return registry();
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.queue-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,queue_timeout_ms:input.queue_timeout_ms});
    log('queue_allowance_changed',{before_ms:before,after_ms:queueTimeoutMs(),applies_to:'new_admissions'});
    return registry();
  }
  async function setContextLimit(input) {
    if (shuttingDown || draining) throw new Error('Gateway is draining');
    if (!input || Object.keys(input).some(k=>!['context_length','expected_context_length'].includes(k)) || !validContext(input.context_length)) throw new Error('Context limit must be a positive whole token count');
    if (input.expected_context_length !== contextLimit()) throw new Error('Pool context changed; refresh before applying');
    const enabled=nodes.filter(n=>!n.drained&&!n.route_only);
    if (!enabled.length) throw new Error('Enable at least one model server before changing the pool context');
    await Promise.all(enabled.map(freshProbe));
    if (shuttingDown || draining) throw new Error('Gateway is draining');
    const incompatible=enabled.filter(n=>!n.modelMatches || !validContext(n.contextLength) || n.contextLength<input.context_length);
    if (incompatible.length) throw new Error(`Enabled servers unavailable or below requested context: ${incompatible.map(n=>n.id).join(', ')}`);
    const before=contextLimit();
    if (before === input.context_length && store.data.pool_context_length !== undefined) return registry();
    // Backup before the existing atomic, fsynced store commit. Never overwrite
    // worker registration or newer affinity assignments with a stale snapshot.
    if (fs.existsSync(store.filename)) {
      const backup=`${store.filename}.context-${Date.now()}-${randomUUID()}.bak`;
      fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);
    }
    store.save({...store.data,pool_context_length:input.context_length});
    for (const n of enabled) {n.healthy=!n.quarantine&&!n.recovering;n.failures=0;n.probeError=undefined;}
    for (const n of nodes) if (!n.modelMatches || !validContext(n.contextLength) || n.contextLength<requiredContext(n)) {
      n.healthy=false;n.failures=config.health_failures ?? 3;
      n.probeError=n.probeError || 'model_or_context_mismatch';
    }
    log('pool_context_changed',{previous:before,context_length:contextLimit()});
    return registry();
  }
  async function addWorker(raw,services) {
    if (shuttingDown || draining) throw new Error('Gateway is draining');
    const settings = workerConfig(raw, { registration: true });
    assertUniqueWorker(nodes, settings);
    let binding;
    if(services!==undefined){
      if(Object.hasOwn(store.data.spark_services??{},settings.id))throw new Error('Saved service enrollment already exists; reconcile it before reusing this worker ID');
      binding=sparkServiceBinding(settings,services);validateServiceAddition(serviceConfig,binding);
    }
    // Do not mistake another process's listener for our new SSH tunnel.
    if (settings.ssh) await new Promise((resolve, reject) => {
      const check = net.createServer(); check.once('error', () => reject(new Error('Local tunnel port is already in use')));
      check.listen(Number(new URL(settings.url).port), '127.0.0.1', () => check.close(resolve));
    });
    const node = makeNode(settings); node.drained = true;
    // Registration proves compatibility, not recovery. A retained quarantine
    // must survive removal/re-add, but cannot make the recovery CLI unreachable.
    const compatible=()=>node.modelMatches && validContext(node.contextLength) && node.contextLength>=requiredContext(node) && !node.probeError;
    try {
      startTunnel(node);
      const until = Date.now() + workerRegistrationTimeout(config,node);
      do {
        if (shuttingDown) throw new Error('Gateway is stopping');
        await probe(node);
        if (compatible()) break;
        if (!node.ssh || node.probeError === 'model_or_context_mismatch' || node.probeError === 'invalid_model_response') break;
        await delay(250);
      } while (Date.now() < until);
      if (shuttingDown) throw new Error('Gateway is stopping');
      if (!compatible()) throw new Error(`Compatibility check failed (${node.probeError || 'unavailable'}). Required ${config.model_agnostic || node.backend === 'openai' ? 'available endpoint' : `model ${config.model}`}, context at least ${requiredContext(node)}; observed context ${node.contextLength ?? 'unknown'}.`);
      if(binding){
        if(fs.existsSync(store.filename)){const backup=`${store.filename}.enrollment-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
        store.save({...store.data,workers:[...nodes.map(definition),settings],drained:{...store.data.drained,[node.id]:true},spark_services:{...store.data.spark_services,[node.id]:binding}});
        applyServiceAddition(serviceConfig,binding);recovery.configs.set(node.id,binding.recovery);
      }else store.setWorkers([...nodes.map(definition), settings], { ...store.data.drained, [node.id]: true });
      nodes.push(node);
      const recoveryOwner=recovery.physicalOwner(node.id);
      if(recoveryOwner){node.recoveryOperationId=recoveryOwner;node.recovering=true;node.healthy=false;}
      agent.maxSockets=tlsAgent.maxSockets=Math.max(16,nodes.reduce((sum,worker)=>sum+requestCapacity(worker),0));
      log('worker_registered', { node: node.id, context_length: node.contextLength, drained: true });
      return registry();
    } catch (e) { node.removed = true; node.probeRequest?.destroy(); node.stopTunnel?.(); throw e; }
  }
  async function inspectEndpoint(settings) {
    const candidate=makeNode(settings);candidate.drained=true;
    if(settings.ssh){
      const port=await new Promise((resolve,reject)=>{const listener=net.createServer();listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>{const value=listener.address().port;listener.close(()=>resolve(value));});});
      const url=new URL(settings.url);url.port=String(port);candidate.url=url.href.replace(/\/$/,'');
      startTunnel(candidate);
    }
    try{
      const until=Date.now()+12000;
      do{await probe(candidate);if(!candidate.probeError||!settings.ssh||candidate.probeError==='authentication_required'||candidate.probeError==='model_or_context_mismatch')break;await delay(200);}while(Date.now()<until&&!shuttingDown);
      if(!candidate.modelMatches||candidate.probeError||!validContext(candidate.contextLength))throw new Error(`Connection check failed (${candidate.probeError||'context not reported'}). Check URL, backend, authentication and context length.`);
      return candidate;
    }finally{candidate.removed=true;candidate.probeRequest?.destroy();await candidate.stopTunnel?.();}
  }
  async function checkEndpoint(input) {
    if(!input||Object.keys(input).join(',')!=='worker')throw new Error('Specify endpoint settings only');
    const settings=workerConfig(input.worker,{registration:true}),candidate=await inspectEndpoint(settings);
    return {ok:true,url:settings.url,model:candidate.probeModel,context_length:candidate.contextLength,saved:false};
  }
  async function editEndpoint(input) {
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    const fields=['url','backend','context_length','api_key_file','ssh','ssh_fallbacks','remote_port'];
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['id','expected_url','expected_settings',...fields].includes(k)))throw new Error('Specify server ID and supported endpoint settings');
    const node=nodes.find(n=>n.id===input.id);
    if(!node)throw new Error('Unknown worker');
    if(input.expected_url!==node.url||(input.expected_settings&&JSON.stringify(input.expected_settings)!==JSON.stringify(definition(node))))throw new Error('Endpoint changed; refresh before saving');
    const idle=()=>node.drained&&!node.active&&!node.queue.length&&!parkedFor(node).length&&!node.recovering;
    if(!idle())throw new Error('Pause this server and wait for its active and queued work to finish before editing its endpoint');
    const before=definition(node),raw={...before,...Object.fromEntries(fields.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]))};
    if(raw.api_key_file==='')delete raw.api_key_file;
    if(raw.ssh===null||raw.ssh===''){delete raw.ssh;delete raw.ssh_fallbacks;delete raw.remote_port;}
    const settings=workerConfig(raw);assertUniqueWorker(nodes.filter(n=>n!==node),settings);
    if(JSON.stringify(settings)===JSON.stringify(before))return registry();
    const candidate=await inspectEndpoint(settings),required=Math.max(requiredContext(node),node.contextLength??0);
    if(candidate.contextLength<required)throw new Error(`Endpoint check failed: required context at least ${required}; observed ${candidate.contextLength}. Current endpoint retained.`);
    node.endpointEditing=true;
    try{
      while(node.probing)await delay(10);
      if(shuttingDown||draining||!idle())throw new Error('Server state changed; current endpoint retained');
      if(fs.existsSync(store.filename)){const backup=`${store.filename}.endpoint-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
      const route=n=>JSON.stringify([n.url,n.ssh,n.remote_port,n.ssh_fallbacks]);
      const transportChanged=route(before)!==route(settings);
      const apply=value=>{for(const key of workerFields){if(Object.hasOwn(value,key))node[key]=value[key];else delete node[key];}};
      try{
        if(transportChanged)await node.stopTunnel?.();
        apply(settings);
        if(transportChanged){node.stopTunnel=null;node.managementPath=makeNode(settings).managementPath;startTunnel(node);}
        const until=Date.now()+12000;
        do{await probe(node,true);if(!node.probeError||!node.ssh)break;await delay(200);}while(Date.now()<until);
        if(node.probeError)throw new Error('Updated connection did not become ready');
        store.save({...store.data,workers:nodes.map(definition)});
      }catch(error){
        if(transportChanged)await node.stopTunnel?.();apply(before);
        if(transportChanged){node.stopTunnel=null;node.managementPath=makeNode(before).managementPath;startTunnel(node);}
        await probe(node,true);throw error;
      }
      observe(()=>shadow.reset(node.id));
      log('worker_endpoint_changed',{node:node.id,previous:before.url,url:node.url,drained:node.drained});return registry();
    }finally{node.endpointEditing=false;}
  }
  function setSshFallbacks(input) {
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    const next=replaceSshFallbacks(nodes.map(definition),input),updated=next.find(worker=>worker.id===input.id),node=nodes.find(worker=>worker.id===input.id);
    if(JSON.stringify(updated.ssh_fallbacks??[])===JSON.stringify(node.ssh_fallbacks??[]))return registry();
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.routes-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,workers:next});
    if(updated.ssh_fallbacks)node.ssh_fallbacks=[...updated.ssh_fallbacks];else delete node.ssh_fallbacks;
    node.managementPath={...node.managementPath,route_count:sshTargets(node).length,changed_at:new Date().toISOString()};
    log('worker_management_routes_changed',{node:node.id,route_count:sshTargets(node).length});
    return registry();
  }
  function removeWorker(id) {
    if (shuttingDown) throw new Error('Gateway is stopping');
    const node = nodes.find(n => n.id === id);
    if (!node) throw new Error('Unknown worker');
    if(parkedFor(node).length)throw new Error('Undispatched requests are waiting for this server to recover. Readmit it or cancel those requests before removing its registration.');
    if (!node.drained || node.active || node.queue.length) throw new Error('Drain this worker and wait for its admitted work to finish before removing it');
    const agentControl=agents.forgetWorker(id);
    const next = nodes.filter(n => n !== node);
    const drained = { ...store.data.drained }; delete drained[id];
    store.save({...store.data,workers:next.map(definition),drained,agent_control:agentControl});
    nodes.splice(nodes.indexOf(node), 1);
    observe(()=>shadow.remove(id));
    node.removed = true; node.probeRequest?.destroy(); node.stopTunnel?.();
    // Keep session homes. Their next request can be durably reassigned normally.
    log('worker_removed', { node: id });
    return registry();
  }
  // Presentation-only: hides an already routing-paused worker (or a script-only
  // fleet entry that is not a gateway worker at all) from the main Fleet view.
  // Never touches drain, quarantine, sessions or the model server, so an
  // archived entry keeps its registration and can be restored in place.
  function archiveWorker(input) {
    if (shuttingDown) throw new Error('Gateway is stopping');
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !['id', 'archived'].includes(k))) throw new Error('Specify a worker ID and archived state only');
    if (typeof input.id !== 'string' || typeof input.archived !== 'boolean') throw new Error('Archived state must be boolean');
    const node = nodes.find(n => n.id === input.id);
    if (node) {
      if (input.archived && (!node.drained || activeCount(node) || node.queue.length || parkedFor(node).length || node.recovering)) throw new Error('Pause this worker and wait for its admitted work to finish before archiving it');
      if (!input.archived && !node.archived) return registry();
      node.archived = input.archived;
    } else if (scriptEntries.has(input.id)) {
      // Script-only fleet entry: enrolled power scripts, never a routing worker,
      // so there is no routing state to protect.
      if (!input.archived && !(store.data.archived?.[input.id] === true)) return registry();
    } else throw new Error('Unknown worker');
    store.setArchived([input.id], input.archived);
    log(input.archived ? 'worker_archived' : 'worker_restored', { node: input.id, routed: !!node });
    return registry();
  }
  function operatorAction(ids,drained,controlChannel='in_process'){
    const channel=typeof controlChannel==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(controlChannel)?controlChannel:'unidentified_local_client';
    return {id:randomUUID(),time:new Date().toISOString(),action:drained?'pause':'resume',workers:[...ids],control_channel:channel};
  }
  function recordOperatorAction(action){
    // Keep one current decision per registered worker separately from the short
    // activity history. Otherwise pruning history could erase a pause token.
    return {operator_actions:[...(store.data.operator_actions??[]),action].slice(-256),
      operator_action_heads:Object.fromEntries(nodes.map(n=>[n.id,action.workers.includes(n.id)?action:lastOperatorAction(n.id)]).filter(([,head])=>head))};
  }
  function drainNodes(ids, drained, controlChannel='in_process') {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !nodes.some(n => n.id === id))) throw new Error('Specify known worker IDs');
    const action=operatorAction(ids,drained,controlChannel);
    store.save({...store.data,...agents.manualUpdate(ids,drained),...recordOperatorAction(action)});
    if(drained)recovery.operatorPause(ids);
    for (const n of nodes) if (ids.includes(n.id)) n.drained = drained;
    log('workers_drain_changed', { ids, drained, operator_action_id:action.id, control_channel:action.control_channel });
    return stats();
  }
  // Operator-only Unix socket: never expose lifecycle mutation on the LAN.
  const control = config.control_socket ? http.createServer((req, res) => {
    const agentRoute=req.url?.startsWith('/agent/v1/');
    const actor=agentRoute?agents.authenticate(req.headers.authorization):null;
    if(agentRoute&&!actor)return error(res,401,'unauthorized','Valid agent credential required');
    if(!agentRoute&&req.headers.authorization)return error(res,403,'wrong_ingress','Agent credentials are accepted only on the versioned agent API');
    if(req.method==='GET'&&req.url==='/agent/v1/status')return json(res,200,agents.status(actor));
    if(req.method==='GET'&&req.url==='/agents')return json(res,200,agents.adminStatus());
    if (req.method === 'GET' && req.url === '/current-jobs') return json(res,200,currentJobsStatus());
    if (req.method === 'GET' && req.url === '/workers') return json(res, 200, registry());
    if (req.method === 'POST' && req.url === '/direct-activity') {let body='';req.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>65536)req.destroy();});req.on('error',()=>{});req.on('end',()=>{try{const input=JSON.parse(body);return json(res,200,reportDirectActivity(input?.rows));}catch(e){return error(res,400,'invalid_direct_activity',e.message);}});return;}
    if(req.method==='GET'&&req.url==='/spark-services')return json(res,200,{schema:1,workers:Object.fromEntries(Object.entries(store.data.spark_services??{}).filter(([id])=>nodes.some(n=>n.id===id)).map(([id,row])=>[id,{inspection:row.inspection,recovery:true,media:Object.keys(row.media.engines)}]))});
    if(req.method==='GET'&&req.url==='/media-jobs')return json(res,200,mediaStatus());
    if(req.method==='POST'&&req.url==='/genie-media-inputs'){
      let body='';req.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>2048)req.destroy();});req.on('error',()=>{});
      req.on('end',()=>{void (async()=>{try{
        if(!capabilityStatus().inspection)throw Error('Server inspection is switched off.');
        if(!mediaJobs)throw Error('Media jobs are not configured.');
        return json(res,200,await inspectMediaJobInputs(serviceConfig,mediaJobs,JSON.parse(body)));
      }catch(e){return error(res,409,'media_input_inspection_failed',e.message);}})();});return;
    }
    if(req.method==='POST'&&['/genie-media-start','/genie-media-setup','/genie-media-repair','/genie-media-audit','/media-setup-complete'].includes(req.url)){
      let body='';req.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>2048)req.destroy();});req.on('error',()=>{});
      req.on('end',()=>{void serialize(async()=>{try{const input=JSON.parse(body);return json(res,202,await (req.url==='/genie-media-start'?mediaExecution.start(input):req.url==='/genie-media-setup'?mediaSetup.start(input):req.url==='/genie-media-repair'?mediaSetup.repair(input):req.url==='/genie-media-audit'?mediaSetup.audit(input):mediaSetup.finish(input)));}catch(e){return error(res,409,'media_start_failed',e.message);}});});return;
    }
    if (req.method !== 'POST' || !['/set-genie-thinking','/media-host-eligibility','/drain-workers', '/resume-workers', '/maintenance-lock','/release-maintenance-lock','/maintenance-receipt','/add-worker', '/edit-endpoint', '/check-endpoint', '/remove-worker', '/archive-worker', '/set-ssh-fallbacks','/set-context-limit','/set-conversation-turns','/set-queue-timeout','/set-protection','/set-job-priority','/set-worker-concurrency','/set-execution-capacity','/set-routing-margin','/set-direct-reserve','/relocate-queued','/genie-relocate-queued','/genie-capability','/recovery-policy','/recovery-handback-policy','/recover-worker','/genie-recover-worker','/recovery-canary','/recovery-recheck','/recovery-pair-permit','/enroll-pair-recovery','/enroll-omlx-recovery','/qualify-omlx-recovery','/recovery-omlx-permit','/qualify-pair-recovery','/grant-agent','/revoke-agent','/release-agent-hold','/agent/v1/drain','/agent/v1/resume','/agent/v1/receipt'].includes(req.url)) return error(res, 404, 'not_found', 'Unknown control action');
    let body = '';
    req.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 4096) req.destroy(); });
    req.on('error', () => {});
    req.on('end', () => {
      void serialize(async () => {
        try {
          const input = JSON.parse(body);
          // Actor is revalidated after waiting for the shared mutation queue.
          if(agentRoute){agents.agent(actor);if(req.url==='/agent/v1/receipt')return json(res,200,agents.receipt(actor,input));return json(res,200,await agents.act(actor,req.url.endsWith('/drain')?'drain':'resume',input));}
          if(req.url==='/set-execution-capacity')return json(res,200,setExecutionCapacity(input));
          if(req.url==='/set-routing-margin')return json(res,200,setRoutingMargin(input));
          if(req.url==='/media-host-eligibility')return json(res,200,mediaHosts.change(input));
          if(req.url==='/grant-agent')return json(res,201,agents.grant(input));
          if(req.url==='/revoke-agent')return json(res,200,agents.revoke(input));
          if(req.url==='/release-agent-hold')return json(res,200,agents.clearHold(input));
          if(req.url==='/maintenance-lock')return json(res,201,agents.maintenanceLock(input,req.headers['x-dsg-control-channel']));
          if(req.url==='/release-maintenance-lock')return json(res,200,agents.maintenanceRelease(input,req.headers['x-dsg-control-channel']));
          if(req.url==='/maintenance-receipt')return json(res,200,agents.maintenanceReceipt(input));
          if(req.url==='/qualify-omlx-recovery')return json(res,202,recovery.requestOmlxQualification(input));
          if(req.url==='/recovery-omlx-permit')return json(res,200,recovery.omlxPermit(input));
          if(req.url==='/qualify-pair-recovery')return json(res,202,recovery.request(input,'genie',{canary:true,qualification:true}));
          if(req.url==='/enroll-pair-recovery')return json(res,202,pairEnrollment.request(input));
          if(req.url==='/enroll-omlx-recovery')return json(res,202,omlxEnrollment.request(input));
          if(req.url==='/recovery-pair-permit')return json(res,200,recovery.pairPermit(input));
          if(req.url==='/recovery-recheck')return json(res,202,recovery.reconcile(input));
          if(req.url==='/genie-capability') {
            if(Object.keys(input).sort().join(',')!=='enabled,key'||![...genieCapabilityKeys,'recovery'].includes(input.key)||typeof input.enabled!=='boolean')throw new Error('Specify a known capability and boolean enabled');
            if(input.key==='recovery')recovery.setAutomatic(input.enabled);
            else store.save({...store.data,genie_capabilities:{...store.data.genie_capabilities,[input.key]:input.enabled}});
            log('genie_capability_changed',{key:input.key,enabled:input.enabled});
            return json(res,200,capabilityStatus());
          }
          if(req.url==='/recovery-policy') {
            if(Object.keys(input).length!==1 || !Object.hasOwn(input,'enabled'))throw new Error('Specify enabled only');
            return json(res,200,recovery.setAutomatic(input.enabled));
          }
          if(req.url==='/recovery-handback-policy') {
            if(Object.keys(input).length!==1 || !Object.hasOwn(input,'enabled'))throw new Error('Specify enabled only');
            return json(res,200,recovery.setProfileHandbackAutomatic(input.enabled));
          }
          if(['/recover-worker','/genie-recover-worker','/recovery-canary'].includes(req.url))return json(res,202,recovery.request(input,req.url==='/genie-recover-worker'?'genie':'operator',{canary:req.url==='/recovery-canary'}));
          if (req.url === '/set-context-limit') return json(res,200,await setContextLimit(input));
          if (req.url === '/set-conversation-turns') return json(res,200,setConversationTurns(input));
          if (req.url === '/set-queue-timeout') return json(res,200,setQueueTimeout(input));
          if (req.url === '/set-genie-thinking') return json(res,200,setGenieThinking(input));
          if (req.url === '/set-protection') return json(res,200,visionProtection.set(input));
          if (req.url === '/set-job-priority') return json(res,200,setJobPriority(input));
          if (req.url === '/relocate-queued') return json(res,200,relocateQueued(input));
          if (req.url === '/genie-relocate-queued') {
            if(!rebalanceEnabled()||!genieRelocationOffers().some(offer=>['request_id','source','destination','evidence_id'].every(key=>offer[key]===input?.[key])))throw new Error('Genie relocation evidence or policy changed; request was left in place');
            return json(res,200,relocateQueued(input,'genie'));
          }
          if (req.url === '/check-endpoint') return json(res, 200, await checkEndpoint(input));
          if (req.url === '/edit-endpoint') return json(res, 200, await editEndpoint(input));
          if (req.url === '/add-worker') return json(res, 201, await addWorker(input.worker,input.services));
          if (req.url === '/set-ssh-fallbacks') return json(res, 200, setSshFallbacks(input));
          if (req.url === '/set-worker-concurrency') return json(res,200,setWorkerConcurrency(input));
          if (req.url === '/set-direct-reserve') return json(res,200,setDirectReserve(input));
          if (req.url === '/remove-worker') return json(res, 200, removeWorker(input.id));
          if (req.url === '/archive-worker') return json(res, 200, archiveWorker(input));
          if (req.url === '/resume-workers') {
            if (!Array.isArray(input.workers) || !input.workers.length || input.workers.some(id=>!nodes.some(n=>n.id===id))) throw new Error('Specify known worker IDs');
            const selected=nodes.filter(n=>input.workers.includes(n.id));
            const checkExpectedActions=()=>{
              // Optional for existing human controls; automated handback binds
              // the observation it made before maintenance. Never replace a new
              // operator pause with an old decision to resume.
              const checks=[['expected_operator_actions',id=>lastOperatorAction(id)?.id??null,'Operator'],
                ['expected_maintenance_actions',id=>[...agents.state.maintenance_operations].reverse().find(op=>op.result.worker_id===id)?.request_id??null,'Maintenance']];
              for(const [key,current,label] of checks){
                if(!Object.hasOwn(input,key))continue;
                const expected=input[key];
                if(!expected||typeof expected!=='object'||Array.isArray(expected)||Object.keys(expected).sort().join(',')!==selected.map(n=>n.id).sort().join(',')||
                  Object.values(expected).some(id=>id!==null&&(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))))throw new Error(`Expected ${label.toLowerCase()} actions must name every selected worker and its observed action ID or null`);
                if(selected.some(n=>current(n.id)!==expected[n.id]))throw Object.assign(new Error(`${label} action changed; observe the worker again before deciding to resume`),{status:409,code:label.toLowerCase()+'_action_changed'});
              }
            };
            checkExpectedActions();
            if(selected.some(n=>n.archived))throw new Error('Restore this worker from the archive before enabling routing');
            agents.manualUpdate(input.workers,false); // Reject owned holds before probes.
            if(selected.some(n=>n.recovering))throw new Error('Recovery owns this worker; pause is allowed but wait before enabling');
            await Promise.all(selected.map(freshProbe));
            if (selected.some(n=>n.probeError || !validContext(n.contextLength) || n.contextLength<requiredContext(n))) throw new Error('Cannot enable a server without a fresh compatible model/context probe');
            const recovered=[];
            for(const n of selected.filter(n=>n.quarantine)) {
              // The readmission proof sends a real generation straight to the
              // endpoint, outside the scheduler, so it needs a free execution
              // slot rather than a completely empty worker. Requiring zero
              // active work deadlocked recovery on any continuously-loaded
              // worker: quarantine blocks new admission, so the pre-quarantine
              // work could never drain and the operator had no way back in.
              if(activeCount(n)>=dispatchCapacity(n))throw new Error('Wait for this worker to have a free execution slot before recovery verification');
              const proof=await verifyGeneration(n.url,n.probeModel ?? config.model,{worker:n,timeoutMs:config.request_timeout_ms});
              if(shuttingDown || draining)throw new Error('Gateway is draining');
              recovered.push({node:n,proof});
            }
            const quarantined={...store.data.quarantined};
            for(const {node} of recovered)delete quarantined[node.id];
            // Commit a multi-worker resume once, after every requested check
            // passes. Partial verification must not partially enable a fleet.
            checkExpectedActions();
            const action=operatorAction(input.workers,false,req.headers['x-dsg-control-channel']??'unidentified_local_client');
            store.save({...store.data,quarantined,...agents.manualUpdate(input.workers,false),...recordOperatorAction(action)});
            for(const {node,proof} of recovered){node.quarantine=null;node.inferenceFailures=0;node.transportFailures=0;node.lastFailureClass='recovered';node.healthy=true;log('worker_recovery_verified',{node:node.id,...proof});}
            for(const n of selected)n.drained=false;
            log('workers_drain_changed',{ids:input.workers,drained:false,operator_action_id:action.id,control_channel:action.control_channel});
            return json(res,200,stats());
          }
          json(res, 200, drainNodes(input.workers, req.url === '/drain-workers',req.headers['x-dsg-control-channel']??'unidentified_local_client'));
        } catch (e) { error(res, e.status??400, e.code??'invalid_control_request', e.message); }
      });
    });
  }) : null;
  control?.on('clientError',invalidHttp);
  return {
    server, nodes, stats, store, mediaJobs, drainNodes, registry,recovery,relocateQueued,visionProtection,currentJobsStatus,routingObservations,
    async start() {
      nodes.forEach(startTunnel);
      if(startup.barrier){
        const allowance=config.continuity_door.startup_probe_ms??12000;
        if(!Number.isSafeInteger(allowance)||allowance<0||allowance>120000)throw new Error('continuity_door.startup_probe_ms must be 0–120000');
        const deadline=performance.now()+allowance;
        do {
          await Promise.all(nodes.map(freshProbe));
          startup.unavailable=nodes.filter(n=>!n.healthy&&!n.drained&&!n.quarantine).map(n=>n.id);
          if(!startup.unavailable.length||performance.now()>=deadline)break;
          await delay(Math.min(250,Math.max(0,deadline-performance.now())));
        } while(performance.now()<deadline);
        startup.complete=true;startup.completed_at=new Date().toISOString();
        log('startup_probe_barrier',{unavailable:startup.unavailable,allowance_ms:allowance});
        const unvalidated=nodes.filter(n=>!n.drained&&!n.quarantine&&routingCapacity(n).unvalidated)
          .map(n=>({id:n.id,configured_capacity:requestCapacity(n)}));
        if(unvalidated.length)log('routing_capacity_unvalidated',{workers:unvalidated,
          note:'engine execution concurrency is not detectable; configured capacity needs human validation'});
      }
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(gatewayPort(config), gatewayHost(config), resolve); });
      if (control) {
        // Store ownership has already been acquired; only our stale socket may exist.
        if (fs.existsSync(config.control_socket)) {
          if (!fs.lstatSync(config.control_socket).isSocket()) throw new Error('Control path is not a socket');
          fs.unlinkSync(config.control_socket);
        }
        await new Promise((resolve, reject) => { control.once('error', reject); control.listen(config.control_socket, resolve); });
        fs.chmodSync(config.control_socket, 0o600);
      }
      if(!startup.barrier){await Promise.all(nodes.map(probe));startup.complete=true;startup.completed_at=new Date().toISOString();startup.unavailable=nodes.filter(n=>!n.healthy&&!n.drained&&!n.quarantine).map(n=>n.id);}
      healthTimer = setInterval(() => { for (const n of nodes) void probe(n); }, config.health_interval_ms ?? 5000);
      if(routingTelemetry){
        const pollRouting=()=>{routingTelemetry.sync(nodes);routingTelemetry.poll();evaluateWaiting();};
        pollRouting();routingTimer=setInterval(pollRouting,2000);routingTimer.unref?.();
      }
      waitingTimer=setInterval(pumpWaiting,1000);waitingTimer.unref?.();
      void recovery.tick();pairEnrollment.tick();omlxEnrollment.tick();recoveryTimer=setInterval(()=>{void recovery.tick();pairEnrollment.tick();omlxEnrollment.tick();},30000);
      return server.address();
    },
    drain(value = true) { draining = value; log('drain_changed', { draining }); },
    async close() {
      if (shuttingDown) return;
      shuttingDown = true; draining = true;
      for(const node of nodes)releaseTurns(node);
      clearInterval(waitingTimer);
      clearInterval(routingTimer);routingTelemetry?.close();
      for(const job of [...waiting]){detach(job);reject(job.req,job.res,503,'draining','Gateway is stopping; the waiting request was not dispatched. A compatible patient client may retry after DSG returns.',{...job,node:job.fixedHome,reason:'gateway_draining'});job.cleanup();}
      clearInterval(recoveryTimer);pairEnrollment.close();omlxEnrollment.close();await Promise.all([pairEnrollment.idle(),omlxEnrollment.idle()]);await recovery.close();
      if (control) await new Promise(resolve => control.close(resolve));
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      clearInterval(healthTimer); agent.destroy(); tlsAgent.destroy(); store.close();await dataset.close();await routingObservations.close();
      nodes.forEach(n => { n.removed = true; n.stopTunnel?.(); });
    },
  };
}

function superviseTunnel(node, stopping) {
  let child, timer,targetIndex=0,stopped=false;
  const update=(state,reason=null)=>{node.managementPath={...node.managementPath,transport:'ssh_tunnel',state,reason,changed_at:new Date().toISOString()};};
  const start = () => {
    if (stopped||stopping()) return;
    const targets=sshTargets(node);targetIndex%=targets.length;
    node.managementPath={...node.managementPath,transport:'ssh_tunnel',state:'connecting',reason:null,attempts:(node.managementPath?.attempts??0)+1,changed_at:new Date().toISOString()};
    const port = new URL(node.url).port;
    child = spawn('/usr/bin/ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${port}:127.0.0.1:${node.remote_port ?? 8000}`, targets[targetIndex]], { stdio: ['ignore', 'ignore', 'pipe'] });
    log('tunnel_started', { node: node.id, pid: child.pid });
    child.once('spawn',()=>update('ssh_process_active'));
    child.stderr.on('data', chunk => {const message=chunk.toString().trim(),reason=classifySshFailure(message);if(reason)update('ssh_error',reason);log('tunnel_message', { node: node.id, message });});
    child.on('error', e => {update('ssh_error',classifySshFailure('',e.code));log('tunnel_error', { node: node.id, error: e.message });});
    child.on('exit', (code, signal) => {
      update('retrying',node.managementPath?.reason??classifySshFailure('',null,code));
      log('tunnel_exited', { node: node.id, code, signal });
      targetIndex=(targetIndex+1)%sshTargets(node).length;
      if (!stopped&&!stopping()) timer = setTimeout(start, 3000);
    });
  };
  start();
  return async () => { stopped=true;clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');}); };
}

if (isMain(import.meta.url)) {
  const {config} = loadConfig(process.argv[2]);
  let stopping = false;
  const gateway = createGateway(config);
  const awake = config.prevent_sleep ? spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
  awake?.on('error', e => log('caffeinate_error', { error: e.message }));
  const stop = async () => {
    if (stopping) return; stopping = true;
    log('shutdown_draining');
    await gateway.close();
    awake?.kill('SIGTERM');
    log('shutdown_complete'); process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('SIGUSR1', () => gateway.drain());
  process.on('SIGUSR2', () => gateway.drain(false));
  try { const address = await gateway.start(); log('gateway_started', { address, model: config.model }); }
  catch (e) { log('startup_failed', { error: e.message }); stopping = true; gateway.nodes.forEach(n => n.stopTunnel?.()); awake?.kill('SIGTERM'); gateway.store.close(); process.exit(1); }
}
