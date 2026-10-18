// Routing v2 — a load balancer that measures with a stopwatch and decides with
// one rule. Born from the 2026-10-13/14 audits and the owner's direction to
// replace the completion-time simulator: every "untimeable reason" class in the
// legacy planner (routing-plan/routing-estimates/routing-observations) came from
// needing engine cooperation the fleet's engines do not provide. v2 needs
// nothing from any engine:
//
//   Measurement — the gateway times every request it dispatches anyway
//   (dispatch→finish, actual usage tokens). Per lane: an EWMA of
//   solo-equivalent COMPUTE tokens/second — (prompt−cached+completion)/seconds,
//   the reviewed Design C v2 definition — normalized to concurrency 1 with the
//   approved 0.9-per-level default curve, plus measured slowdown factors per
//   observed concurrency level. Since 2026-10-16 the rate is TWO-PHASE: per
//   lane, prefill and decode throughput are fit separately from the sample
//   ring (seconds = input/prefill + output/decode, least squares) — a blended
//   rate let cold-prefill-heavy history crown one identical twin 2.2x over the
//   other. A model/engine swap resets the lane (identity
//   change); samples older than the staleness horizon read as cold; the first
//   finished request re-measures it. NOTE: lane identity inherits the legacy
//   routingIdentity (served model, context length, capacity, profile digest),
//   so an operator edit to an admission knob (e.g. max_concurrent_requests)
//   resets that lane to cold by design — tokens/sec is not an admission-knob
//   property, but the reset keeps measurements from outliving an engine swap.
//   No probes, no synthetic load, no engine
//   self-reports: zero marginal compute beyond one multiply.
//
//   Decision — score every eligible lane by the incoming request's estimated
//   finish (Design C v2, reviewed offline in docs/reports/lb-design-c2-offline.mjs):
//   pending work decays as running requests finish, a spare slot starts at zero
//   delay, and an empty lane scores work/speed so fast empty machines win.
//   Work is priced as a COLD placement (full input + expected output): the
//   destination's prefill for this request is inside its finish estimate, and
//   the one-time re-home cost prices the conversation's next-turn re-prefill.
//   Move the queued head only when a destination beats the current home by more
//   than that threshold — except when the home is FULL, where any measured peer
//   that actually finishes sooner takes the overflow (a full home cannot serve
//   the head at all, so no margin is owed). Cold lanes (no fresh measurement)
//   are never ranked by
//   an invented number: they receive work only when no measured lane has a
//   spare slot, or as probe-priority after the idle threshold — and a failed
//   probe re-arms instead of starving. evaluate() is side-effect-free; the
//   committing caller (the gateway's reconsiderRouting) latches probe choices.
//
//   The structural fix: a lane estimate can never be null. Unknown input sizes
//   fall back to zero input plus a measured output median; unknown speeds make
//   a lane cold, which is a separate selection rule — not a poison that
//   discards the whole comparison like legacy `completionSeconds: null`.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const DEFAULT_SLOWDOWN_PER_LEVEL = 0.9;
// Bump when the MEANING of recorded phase state changes, so stale state does
// not masquerade as measurement: v2 (2026-10-16) — phase samples restricted to
// level-1 and thinking tokens added to completion counts; pre-fix decode EWMAs
// carried 25-73 tok/s poison (49% weight on ring2) and two-phase placement
// activated on it. On mismatch, phase classes are dropped and re-measured;
// solo/slowdown/output history survives (their semantics did not change).
// Bumped whenever a stored number stops meaning what it used to. A mismatch
// voids the traffic-derived history instead of re-ranking on it: the pre-guard
// file held 46 453 t/s for a machine whose engine reports 31.7.
const MEASUREMENT_VERSION = 3;
export {MEASUREMENT_VERSION};

const slowdownDefault = c => Math.pow(DEFAULT_SLOWDOWN_PER_LEVEL, c - 1);
const positive = x => Number.isFinite(x) && x > 0;
const nonnegative = x => Number.isFinite(x) && x >= 0;
const count = x => Number.isSafeInteger(x) && x >= 0;
const ewma = (previous, value, alpha) => previous === null ? value : previous + alpha * (value - previous);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
};

export const DEFAULT_MEDIAN_OUTPUT_TOKENS = 800;
// The move threshold is a noise floor, not a cache policy: the destination's
// cold prefill is already priced into its finish estimate, and the one-time
// cost of re-homing a conversation (its context re-prefilled on the next turn)
// is added separately, scaled to the job's own input size. A fixed large
// margin here was measured to re-create the exact stay-forever bias v2 exists
// to remove: small jobs on a crowded home show small absolute savings.
export const DEFAULT_HYSTERESIS_SECONDS = 10;
export const DEFAULT_PROBE_AFTER_SECONDS = 20;
export const DEFAULT_SAMPLE_ALPHA = 0.3;
export const DEFAULT_SAMPLE_TTL_SECONDS = 7 * 24 * 3600;
// Measurement plausibility guards. A lane is a machine, not a traffic diary:
// a reading outside physical bounds, or a brand-new lane reading far above its
// peers, is evidence about the SAMPLE, not about the machine. Such samples are
// rejected (counted, never averaged in) and a lane left with no honest number is
// priced at its peers' median — "assume average speed" — instead of winning or
// losing every comparison on a corrupt value. Thresholds are configurable
// because the right ceiling is a property of the fleet's hardware.
export const MIN_PLAUSIBLE_TPS = 1;
export const DEFAULT_MIN_PROMPT_TOKENS = 200;
export const DEFAULT_MIN_SAMPLE_SECONDS = 0.25;
// Gross-sanity ceiling for the BLENDED rate. Deliberately loose: with prefix
// caching a prompt can be "read" at tens of thousands of tokens/second, and
// that is real work, not a lie. This bound exists to reject the physically
// absurd (the 31k-44k readings this fleet produced while cached_tokens was
// unreported), not to judge which machine is faster. The tight bound is the
// decode ceiling below, where the physics is unambiguous.
export const DEFAULT_MAX_PLAUSIBLE_TPS = 20000;
// Autoregressive decode is a serial token loop. These rings measure ~32
// tokens/second per sequence from the engine's own decode_time counters
// (2026-10-17: 549,839 generation tokens / 16,864 s = 32.6 on :18091,
// 1,349,910 / 42,019 s = 32.1 on :18092). A decode-dominated sample an order
// of magnitude above that is a prompt-side artifact, not a fast machine.
export const DEFAULT_MAX_PLAUSIBLE_DECODE_TPS = 200;
// How far above the same-model peer median a lane may read before its number
// is treated as traffic mix rather than machine speed. Loose enough for real
// heterogeneous hardware; tight enough that the 3.9x and 5.2x divergences seen
// on 2026-10-17 are caught.
export const DEFAULT_PEER_RATIO = 3;
export const DEFAULT_NEW_LANE_SAMPLES = 5;
export const DEFAULT_SUSPECT_AFTER = 3;
// Engine counters are scraped every ~2 s; five minutes of silence means the
// reading is history, not a measurement of the machine as it stands now.
export const DEFAULT_ENGINE_TTL_SECONDS = 300;
const MAX_CONCURRENCY_LEVEL = 16;
const OUTPUT_SAMPLE_WINDOW = 32;

// Work decomposes into its two phases: computeInput (prefill) and output
// (decode). Prefill throughput is several times decode throughput on these
// engines, so a single blended tokens/sec rate conflates them — a lane that
// served cold-prefill-heavy traffic measures "faster" than its identical twin
// that served decode-heavy traffic (2026-10-16 fleet evidence: twins at 352
// vs 157 tok/s). Work parts keep the split honest end to end.
export function workParts(job, medianOutputTokens = DEFAULT_MEDIAN_OUTPUT_TOKENS) {
  const input = count(job?.inputTokens) ? job.inputTokens
    : count(job?.routingInput?.inputTokens) ? job.routingInput.inputTokens
    : 0;
  const output = count(job?.expectedOutputTokens) ? job.expectedOutputTokens : medianOutputTokens;
  return {input, output: Math.max(0, output)};
}

// Input honours the gateway's own abstention: routing metadata reports
// inputTokens for text routes and null for multimodal bodies (base64 is not
// tokens). Unknown input is zero plus the output estimate — never bytes/4 of
// an image payload, which would manufacture millions of phantom tokens.
export function workOf(job, medianOutputTokens = DEFAULT_MEDIAN_OUTPUT_TOKENS) {
  const {input, output} = workParts(job, medianOutputTokens);
  return input + output;
}

// A running entry: {id, expectedTotalTokens?, elapsedSeconds? | dispatchedMono?}.
// elapsedSeconds may be supplied directly (gateway snapshot, tests); when
// absent it is derived from dispatchedMono, which is a performance.now()
// MILLISECOND timestamp, against `at` in seconds.
function remainingSecondsOf(entry, rate, medianOutputTokens, at) {
  const total = count(entry.expectedTotalTokens) ? entry.expectedTotalTokens : workOf(entry, medianOutputTokens);
  const elapsed = nonnegative(entry.elapsedSeconds) ? entry.elapsedSeconds
    : nonnegative(entry.dispatchedMono) && nonnegative(at) ? Math.max(0, (at * 1000 - entry.dispatchedMono) / 1000)
    : 0;
  return rate > 0 ? Math.max(0, total - rate * elapsed) : null;
}

// A lane's measurement state is per-incarnation: identity, model, samples and
// suspicion reset together. Keeping the shape in one place means restore(),
// record() and checkIdentity() cannot drift apart.
const emptyLane = (id, identity = null, model = null) => ({
  id, identity, model,
  solo: null, slowdown: new Map(), levels: new Set(), outputs: [],
  prefill: null, decode: null, samples: 0, lastAt: null, lastProbeAt: null,
  rejected: {}, suspect: false, suspectReason: null, suspectAt: null, recoveryStreak: 0,
  lastAccepted: null, engine: null,
});

export class LaneSpeeds {
  // filename may be null for a purely in-memory instance (tests, previews).
  constructor(filename, {
    medianOutputTokens = DEFAULT_MEDIAN_OUTPUT_TOKENS,
    hysteresisSeconds = DEFAULT_HYSTERESIS_SECONDS,
    probeAfterSeconds = DEFAULT_PROBE_AFTER_SECONDS,
    sampleAlpha = DEFAULT_SAMPLE_ALPHA,
    sampleTtlSeconds = DEFAULT_SAMPLE_TTL_SECONDS,
    minPromptTokens = DEFAULT_MIN_PROMPT_TOKENS,
    minSampleSeconds = DEFAULT_MIN_SAMPLE_SECONDS,
    maxPlausibleTps = DEFAULT_MAX_PLAUSIBLE_TPS,
    maxPlausibleDecodeTps = DEFAULT_MAX_PLAUSIBLE_DECODE_TPS,
    peerRatio = DEFAULT_PEER_RATIO,
    newLaneSamples = DEFAULT_NEW_LANE_SAMPLES,
    suspectAfter = DEFAULT_SUSPECT_AFTER,
    engineTtlSeconds = DEFAULT_ENGINE_TTL_SECONDS,
    onSuspect = null,
    now = () => performance.now() / 1000,
    wallNow = () => Date.now() / 1000,
  } = {}) {
    if (!Number.isSafeInteger(medianOutputTokens) || medianOutputTokens < 1) throw new Error('medianOutputTokens must be a positive whole number of tokens');
    if (!nonnegative(hysteresisSeconds)) throw new Error('hysteresisSeconds must be a non-negative number of seconds');
    if (!nonnegative(probeAfterSeconds)) throw new Error('probeAfterSeconds must be a non-negative number of seconds');
    if (!positive(sampleAlpha) && sampleAlpha !== 0) throw new Error('sampleAlpha must be a number in (0,1]');
    if (sampleAlpha > 1) throw new Error('sampleAlpha must be a number in (0,1]');
    if (!nonnegative(sampleTtlSeconds)) throw new Error('sampleTtlSeconds must be a non-negative number of seconds');
    if (!Number.isSafeInteger(minPromptTokens) || minPromptTokens < 0) throw new Error('minPromptTokens must be a non-negative whole number of tokens');
    if (!nonnegative(minSampleSeconds)) throw new Error('minSampleSeconds must be a non-negative number of seconds');
    if (!positive(maxPlausibleTps)) throw new Error('maxPlausibleTps must be a positive number of tokens per second');
    if (!positive(maxPlausibleDecodeTps)) throw new Error('maxPlausibleDecodeTps must be a positive number of tokens per second');
    if (maxPlausibleDecodeTps > maxPlausibleTps) throw new Error('maxPlausibleDecodeTps must not exceed maxPlausibleTps');
    if (!positive(peerRatio) || peerRatio < 1) throw new Error('peerRatio must be a number >= 1');
    if (!Number.isSafeInteger(newLaneSamples) || newLaneSamples < 1) throw new Error('newLaneSamples must be a positive whole number');
    if (!Number.isSafeInteger(suspectAfter) || suspectAfter < 1) throw new Error('suspectAfter must be a positive whole number');
    if (!nonnegative(engineTtlSeconds)) throw new Error('engineTtlSeconds must be a non-negative number of seconds');
    if (onSuspect !== null && typeof onSuspect !== 'function') throw new Error('onSuspect must be a function or null');
    this.filename = filename;
    this.medianOutputTokens = medianOutputTokens;
    this.hysteresisSeconds = hysteresisSeconds;
    this.probeAfterSeconds = probeAfterSeconds;
    this.sampleAlpha = sampleAlpha;
    this.sampleTtlSeconds = sampleTtlSeconds;
    this.minPromptTokens = minPromptTokens;
    this.minSampleSeconds = minSampleSeconds;
    this.maxPlausibleTps = maxPlausibleTps;
    this.maxPlausibleDecodeTps = maxPlausibleDecodeTps;
    this.peerRatio = peerRatio;
    this.newLaneSamples = newLaneSamples;
    this.suspectAfter = suspectAfter;
    this.engineTtlSeconds = engineTtlSeconds;
    this.onSuspect = onSuspect;
    // Two clocks, deliberately: `now` is the gateway's monotonic performance
    // epoch in SECONDS (matches elapsedSeconds; dispatchedMono is the same
    // epoch in MILLISECONDS), `wallNow` is wall time for anything persisted —
    // performance.now() resets on restart, so a persisted timestamp from a
    // previous process must never meet this one.
    this.now = now;
    this.wallNow = wallNow;
    this.lanes = new Map();
    // The peer group for one decision: the workers actually offered to
    // evaluate(). Without it, a lane retired from config but still inside the
    // 7-day sample TTL would keep voting in every median — exactly the
    // "switched a server out" case this guard has to survive.
    this.peerPool = null;
    this.fleetOutputs = [];
    this.state = {records: 0, rejected: 0, storageError: null, notice: null};
    this.dirty = false;
    this.writing = false;
    this.closed = false;
    this.load();
  }

  load() {
    if (!this.filename) return;
    let raw;
    try {raw = fs.readFileSync(this.filename, 'utf8');}
    catch {return;} // absent: a cold start is the honest start
    let data;
    try {data = JSON.parse(raw);}
    catch {
      // A corrupt file must not block startup. Preserve it for inspection and
      // start cold — the fleet re-measures itself from live traffic.
      const backup = `${this.filename}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {fs.renameSync(this.filename, backup); this.state.notice = `Previous lane-speed history was unreadable and was preserved at ${path.basename(backup)}.`;}
      catch {this.state.notice = 'Previous lane-speed history was unreadable and could not be preserved.';}
      return;
    }
    const lanes = data?.version === 1 && data.lanes && typeof data.lanes === 'object' ? data.lanes : null;
    if (!lanes) {this.state.notice = 'Previous lane-speed history had an unknown format and was ignored.';return;}
    this.fleetOutputs = Array.isArray(data.fleetOutputs) ? data.fleetOutputs.filter(count).slice(-OUTPUT_SAMPLE_WINDOW * 2) : [];
    // Sample semantics changed with MEASUREMENT_VERSION; older EWMAs are poison
    // (different token accounting, no plausibility fence, probe-sized samples),
    // not data. This is what makes a restart self-cleaning: the poisoned numbers
    // cannot survive it, and engine rates refill the lanes within a poll.
    const historyValid = data.measurementVersion === MEASUREMENT_VERSION;
    const phasesValid = historyValid;
    if (!historyValid && data.lanes && Object.keys(data.lanes).length)
      this.state.notice = 'Measurement semantics changed; previous speed history was discarded and lanes will re-measure.';
    for (const [id, lane] of Object.entries(lanes)) {
      if (!lane || typeof lane !== 'object' || typeof id !== 'string' || !id) continue;
      const stored = historyValid ? this.restoreSample(lane.solo) : null;
      // A subnormal persisted value is corruption, not a slow machine: it would
      // otherwise divide the finish estimate into a null and drag the peer
      // median down with it (round-2 hostile-trace case).
      const solo = stored && stored.value >= MIN_PLAUSIBLE_TPS ? stored : null;
      const lastProbeAt = nonnegative(lane.lastProbeAt) ? lane.lastProbeAt : null;
      // A solo-less entry is still worth restoring when it carries a probe
      // latch: the latch spaces out probe attempts across restarts. With
      // neither a solo nor a latch there is nothing usable — skip the lane.
      if (!solo && lastProbeAt === null) continue;
      const slowdown = new Map();
      if (solo) for (const [level, sample] of Object.entries(lane.slowdown ?? {})) {
        const restored = this.restoreSample(sample);
        if (restored && Number.isSafeInteger(+level) && +level >= 1 && +level <= MAX_CONCURRENCY_LEVEL) slowdown.set(+level, restored);
      }
      const levels = solo && Array.isArray(lane.levels) ? lane.levels.filter(value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_CONCURRENCY_LEVEL) : [];
      const restored = emptyLane(id, typeof lane.identity === 'string' ? lane.identity : null,
        typeof lane.model === 'string' ? lane.model : null);
      restored.solo = solo;
      restored.slowdown = slowdown;
      restored.levels = solo ? new Set(levels.length ? levels : [1]) : new Set();
      restored.outputs = solo && Array.isArray(lane.outputs) ? lane.outputs.filter(count).slice(-OUTPUT_SAMPLE_WINDOW) : [];
      restored.prefill = solo && phasesValid ? this.restoreSample(lane.prefill) : null;
      restored.decode = solo && phasesValid ? this.restoreSample(lane.decode) : null;
      restored.samples = solo ? (count(lane.samples) ? lane.samples : 1) : 0;
      restored.lastAt = solo && nonnegative(lane.lastAt) ? lane.lastAt : null;
      restored.lastProbeAt = lastProbeAt;
      restored.lastAccepted = historyValid && solo && positive(lane.lastAccepted) && lane.lastAccepted <= this.maxPlausibleTps
        ? lane.lastAccepted : (solo && solo.value <= this.maxPlausibleTps ? solo.value : null);
      // A persisted number above the physical ceiling was already wrong when it
      // was written. Do not re-rank on it: start suspect and let the peer
      // fallback price the lane until three clean samples arrive.
      if (solo && solo.value > this.maxPlausibleTps) {
        restored.suspect = true;
        restored.suspectReason = 'implausible_history';
        restored.solo = null; // the number is not evidence; re-earn it from traffic
        restored.prefill = null;
        restored.decode = null;
      }
      restored.suspect = lane.suspect === true;
      restored.suspectReason = typeof lane.suspectReason === 'string' ? lane.suspectReason : null;
      restored.suspectAt = nonnegative(lane.suspectAt) ? lane.suspectAt : null;
      this.lanes.set(id, restored);
    }
    // Re-judge every restored lane now that the whole peer set exists. A
    // persisted value that no longer looks like its peers must not be adopted
    // just because it survived a restart; a persisted conviction is not
    // trusted blindly either — it has to survive this same test.
    for (const lane of this.lanes.values()) if (lane.solo) this.assessLane(lane, false);
  }

  restoreSample(sample) {
    return sample && positive(sample.value) && count(sample.samples) ? {value: sample.value, samples: sample.samples, updatedAt: nonnegative(sample.updatedAt) ? sample.updatedAt : null} : null;
  }

  // Reset the lane when its identity changed (engine rebuild, model swap behind
  // the same endpoint) — every number it earned is invalid. Called from both
  // record() and the evaluate() candidate pass, so a swap demotes a lane to
  // cold before it is next scored, not only after its first new completion.
  checkIdentity(id, identity, model = null) {
    const lane = this.lanes.get(id);
    if (!lane) return null;
    if (model) lane.model = model;
    if (identity && lane.identity && lane.identity !== identity) {
      lane.identity = identity;lane.solo = null;lane.slowdown = new Map();lane.levels = new Set();
      lane.outputs = [];lane.prefill = null;lane.decode = null;lane.samples = 0;lane.lastAt = null;lane.lastProbeAt = null;
      lane.rejected = {};lane.suspect = false;lane.suspectReason = null;lane.suspectAt = null;lane.recoveryStreak = 0;
    }
    return lane;
  }

  lane(id, identity = null, model = null) {
    let lane = this.lanes.get(id);
    if (!lane) {
      lane = emptyLane(id, identity, model);
      this.lanes.set(id, lane);
    } else if (identity) this.checkIdentity(id, identity, model);
    else if (model && !lane.model) lane.model = model;
    if (identity && !lane.identity) lane.identity = identity;
    return lane;
  }

  // One finished request. tokens = COMPUTE tokens (prompt−cached+completion;
  // the gateway subtracts the cached prefix), outputTokens = completion tokens
  // (drives the per-lane output-size estimate), seconds = gateway-measured
  // service seconds, concurrency = the lane's executing count while it ran.
  record({worker, tokens, promptTokens, outputTokens, seconds, concurrency, at = this.wallNow()}) {
    if (this.closed) return;
    const id = worker?.id;
    if (typeof id !== 'string' || !id || !positive(tokens) || !positive(seconds) || !count(concurrency) || concurrency < 1) return;
    const level = Math.min(concurrency, MAX_CONCURRENCY_LEVEL);
    const lane = this.lane(id, typeof worker.identity === 'string' ? worker.identity : null,
      typeof worker.model === 'string' ? worker.model : null);
    const rate = tokens / seconds;
    // Plausibility fence. These bounds are about physics and the fleet's own
    // hardware class, not about "slow" or "fast": a reading above the ceiling
    // cannot be a throughput measurement on this fleet, and a sub-1 t/s reading
    // cannot be a working lane. Decode-dominated samples get the tighter
    // decode ceiling: a blended 5,000 t/s with 1,250 output tokens in 0.25 s is
    // physically impossible for autoregressive decode, and only a prompt-side
    // artifact can produce it. Rejecting the sample is deliberately different
    // from clamping it — a silent clamp turns nonsense into a plausible-looking
    // number that still steers placement. Rejections are counted and visible.
    //
    // The size floor is on the PROMPT, not on compute tokens (2026-10-17). A
    // 31-prompt/1-completion health probe takes ~0.2-2.5 s to stream, so it
    // measures 12-124 t/s — a 100x-low sample at full EWMA weight. One probe
    // moves a lane 30% toward "broken" (alpha 0.3), and the 19:20Z collapse
    // coincides exactly with probe-sized requests landing on ring2. A compute
    // floor cannot express this: once cached tokens are reported correctly a
    // genuinely large cached request also has few compute tokens, and rejecting
    // it would throw away the best samples. Prompt size is the honest proxy for
    // "this request was big enough for seconds to mean throughput".
    const outputPart = count(outputTokens) && outputTokens > 0 ? outputTokens : 0;
    const inputPart = Math.max(0, tokens - outputPart);
    const decodeDominant = outputPart > 0 && inputPart * 4 <= outputPart;
    const ceiling = decodeDominant ? Math.min(this.maxPlausibleTps, this.maxPlausibleDecodeTps) : this.maxPlausibleTps;
    const prompt = count(promptTokens) && promptTokens > 0 ? promptTokens : null;
    const rejection = prompt !== null && prompt < this.minPromptTokens ? 'prompt_below_floor'
      : seconds < this.minSampleSeconds ? 'seconds_below_floor'
      : rate < 1 ? 'implausible_rate'
      : rate > ceiling ? 'implausible_rate' : null;
    if (rejection) {
      lane.rejected[rejection] = (lane.rejected[rejection] ?? 0) + 1;
      this.state.rejected++;
      // A lane that has produced nothing but impossible readings must not stay
      // "cold and harmless" while it waits: if it has no honest number at all,
      // price it at the fleet average so it neither dominates nor starves.
      const rejected = Object.values(lane.rejected).reduce((sum, value) => sum + value, 0);
      if (!lane.solo && rejected >= this.suspectAfter) this.markSuspect(lane, 'implausible_samples');
      return;
    }
    // Normalize every sample to solo-equivalent with the default curve, then
    // refine the curve itself from measured ratios. A lane measured only at
    // concurrency 3 still yields a usable solo estimate on day one.
    // A persisted number above the ceiling is not evidence the machine is
    // fast, it is evidence the old measurement was broken. Do not carry it
    // forward through the EWMA (that would need ~10 honest samples to dilute);
    // restart the estimate from this first in-band sample instead.
    const poisoned = !!lane.solo && lane.solo.value > this.maxPlausibleTps;
    const previousSolo = poisoned ? null : (lane.solo?.value ?? null);
    const soloEquivalent = rate / slowdownDefault(level);
    lane.solo = {value: ewma(previousSolo, soloEquivalent, this.sampleAlpha), samples: (lane.solo?.samples ?? 0) + 1, updatedAt: at};
    lane.levels.add(level);
    if (level > 1) {
      const reference = previousSolo ?? soloEquivalent;
      const observed = rate / (reference > 0 ? reference : soloEquivalent);
      const previous = lane.slowdown.get(level)?.value ?? slowdownDefault(level);
      lane.slowdown.set(level, {value: ewma(previous, observed, this.sampleAlpha), samples: (lane.slowdown.get(level)?.samples ?? 0) + 1, updatedAt: at});
    }
    if (count(outputTokens) && outputTokens > 0) {
      lane.outputs.push(outputTokens);
      if (lane.outputs.length > OUTPUT_SAMPLE_WINDOW) lane.outputs.shift();
      this.fleetOutputs.push(outputTokens);
      if (this.fleetOutputs.length > OUTPUT_SAMPLE_WINDOW * 2) this.fleetOutputs.shift();
    }
    // Two-phase rates, classified not fitted: prefill is several times faster
    // than decode on these engines, and one blended rate let cold-prefill-heavy
    // history crown one identical twin 2.2x over the other (2026-10-16 fleet
    // evidence). A sample updates only the phase it dominates — input >= 4x
    // output is prefill-dominated, output >= 4x input is decode-dominated.
    // A least-squares fit was tried first and overfit sparse mixed rings.
    //
    // Level-1 samples ONLY (2026-10-16 fleet evidence): a phase sample taken
    // while the lane juggles c>1 jobs needs a slowdown correction, and both
    // available corrections are untrustworthy — the default curve understates
    // real degradation 2-6x (measured c3/c4 = 0.12-0.55 vs 0.73-0.81 default),
    // and the measured curve is itself derived from the solo EWMA, which
    // concurrent samples drag down (feedback loop: measured c2 > 1 observed).
    // At level 1 the raw rate IS the solo phase rate — no correction, no loop.
    // Known bias kept deliberately: at the k=4 dominance gate a boundary
    // sample's blended rate reads ~20-40% off the true phase rate (exact math:
    // blended/phase = (k+1)/(k + r) for hardware ratio r); both twins share
    // the bias, so placement comparisons survive it.
    if (level === 1) {
      if (outputPart === 0 || inputPart >= 4 * outputPart) {
        lane.prefill = {value: ewma(lane.prefill?.value ?? null, rate, this.sampleAlpha), samples: (lane.prefill?.samples ?? 0) + 1, updatedAt: at};
      } else if (inputPart * 4 <= outputPart) {
        lane.decode = {value: ewma(lane.decode?.value ?? null, rate, this.sampleAlpha), samples: (lane.decode?.samples ?? 0) + 1, updatedAt: at};
      }
    }
    lane.samples++;
    lane.lastAt = at;
    this.state.records++;
    this.assessLane(lane);
    this.save();
  }

  // The engine's own numbers, when it publishes them. These are the only
  // cache-INVARIANT machine measurements available: decode_tps is
  // generation_tokens summed over decode_time summed, and prefill_tps is
  // kv-computed tokens over prefill seconds. Both are properties of the
  // hardware, not of which conversations happened to arrive that hour, so they
  // outrank anything derived from gateway stopwatches. A nonsense engine report
  // is ignored (bounded like any other sample) rather than trusted because it
  // came from the engine.
  observeEngine(workerId, {decodeTps, prefillTps, at = this.wallNow()} = {}) {
    if (this.closed || typeof workerId !== 'string' || !workerId) return;
    const decode = positive(decodeTps) && decodeTps <= this.maxPlausibleDecodeTps ? decodeTps : null;
    const prefill = positive(prefillTps) && prefillTps <= this.maxPlausibleTps && prefillTps >= MIN_PLAUSIBLE_TPS ? prefillTps : null;
    if (decode === null && prefill === null) return;
    const lane = this.lane(workerId);
    lane.engine = {decode: decode ?? lane.engine?.decode ?? null,
      prefill: prefill ?? lane.engine?.prefill ?? null, at};
    // Engine evidence supersedes a stopwatch conviction: the lane's traffic
    // sample may have been probe-sized, but the engine is reporting the whole
    // session. Clear the flag so the lane is ranked on the honest number.
    if (lane.suspect) this.clearSuspect(lane);
  }

  engineFresh(lane) {
    return !!lane?.engine && lane.engine.at !== null && (this.wallNow() - lane.engine.at) <= this.engineTtlSeconds
      && positive(lane.engine.decode);
  }

  // Cross-check one lane against its peers (same served model). The test is
  // deliberately ONE-SIDED and HIGH-ONLY: cache inflation can only make a lane
  // look faster than the machine is, and a two-sided test would let a liar that
  // happens to report first convict the honest lane for being "too slow". A
  // reading more than peerRatio above the peer median is not trustworthy as a
  // MACHINE property, so the lane is priced at the peer median until it has
  // produced suspectAfter consecutive in-band samples. A lane with no trusted
  // peer (single-lane fleet, one lane per model) is never convicted by this
  // test — only by the absolute ceiling — so the guard cannot deadlock.
  assessLane(lane, persist = true) {
    const value = lane.solo?.value;
    if (!positive(value)) return;
    const peer = this.peerMedian(lane);
    const implausible = value > this.maxPlausibleTps;
    const outlier = positive(peer) && value > peer * this.peerRatio;
    if (implausible || outlier) {
      lane.recoveryStreak = 0;
      this.markSuspect(lane, implausible ? 'implausible_rate' : 'peer_outlier', persist);
    } else if (lane.suspect) {
      lane.recoveryStreak = (lane.recoveryStreak ?? 0) + 1;
      if (lane.recoveryStreak >= this.suspectAfter) this.clearSuspect(lane, persist);
    }
    // The last value this lane earned while nothing objected. It is the
    // fallback of last resort when a lane turns suspect with no trusted peer
    // (a single-lane fleet, one lane per model): better a stale-but-honest
    // number from this very machine than a fleet-wide cold switch.
    if (!lane.suspect && positive(value)) lane.lastAccepted = value;
  }

  markSuspect(lane, reason, persist = true) {
    const changed = !lane.suspect || lane.suspectReason !== reason;
    lane.suspect = true;
    lane.suspectReason = reason;
    lane.suspectAt = lane.suspectAt ?? this.wallNow();
    lane.recoveryStreak = 0;
    if (!changed) return;
    const state = this.measurementState(lane);
    try {this.onSuspect?.(lane, state);} catch {}
    if (persist) this.save();
  }

  clearSuspect(lane, persist = true) {
    if (!lane.suspect) return;
    lane.suspect = false;
    lane.suspectReason = null;
    lane.suspectAt = null;
    lane.recoveryStreak = 0;
    const state = this.measurementState(lane);
    try {this.onSuspect?.(lane, state);} catch {}
    if (persist) this.save();
  }

  // Median solo speed of the OTHER trusted lanes serving the same model. A
  // suspect lane is never its own reference, and a bad peer never becomes the
  // fleet average (suspect peers are excluded). The pool is the set of workers
  // actually offered to this decision: a lane retired from config but still
  // inside the sample TTL must not keep voting in every median. Returns null
  // when there is no honest peer — the caller then falls back to cold rather
  // than inventing a number.
  peerMedian(lane, pool = this.peerPool) {
    const values = [];
    for (const other of this.lanes.values()) {
      if (other.id === lane.id || other.suspect) continue;
      if (pool && !pool.has(other.id)) continue;
      if (!other.solo || !positive(other.solo.value)) continue;
      if (other.solo.value < MIN_PLAUSIBLE_TPS || other.solo.value > this.maxPlausibleTps) continue;
      // Require a positive match. A legacy lane whose model is unknown must not
      // vote on a lane that serves something else: with the pre-guard state file
      // this pooled Apple-silicon GLM lanes with the rings and priced a broken
      // ring at 305 t/s.
      if (!lane.model || !other.model || lane.model !== other.model) continue;
      if (other.lastAt === null || (this.wallNow() - other.lastAt) > this.sampleTtlSeconds) continue;
      values.push(other.solo.value);
    }
    return median(values);
  }

  measurementState(lane) {
    if (!lane) return {suspect: false, reason: null, observed: null, fallback: null};
    const peer = lane.suspect ? this.peerMedian(lane) : null;
    return {suspect: lane.suspect === true, reason: lane.suspectReason ?? null,
      observed: lane.solo?.value ?? null, fallback: peer};
  }

  // The lane's expected blended tokens/second at a concurrency level, with an
  // honest evidence label. Cold (null) is a state, never a fabricated number:
  // no measurement, or a measurement older than the staleness horizon.
  // A lane under measurement suspicion is priced at its peers' median instead
  // of its own reading (evidence 'fleet_average') — the owner's rule for a
  // server that reports nonsense: assume it runs at the fleet's average speed.
  speedAt(workerId, concurrency) {
    const lane = this.lanes.get(workerId);
    if (this.engineFresh(lane)) return {tokensPerSecond: lane.engine.decode, evidence: 'engine_measured',
      soloTokensPerSecond: lane.engine.decode, soloSamples: lane.solo?.samples ?? 0, engine: true};
    // Suspicion is checked BEFORE the cold test: a lane condemned by its own
    // rejected samples never earned a solo value, and it must still be priced
    // at its peers rather than silently treated as unmeasured.
    const suspect = !!lane && (lane.suspect === true || (!!lane.solo && lane.solo.value > this.maxPlausibleTps));
    if (suspect) {
      const peer = this.peerMedian(lane);
      const fallback = positive(peer) ? peer : (positive(lane.lastAccepted) ? lane.lastAccepted : null);
      const base = {suspect: true, suspectReason: lane.suspectReason ?? 'implausible_rate',
        soloSamples: lane.solo?.samples ?? 0, observedTokensPerSecond: lane.solo?.value ?? null};
      return positive(fallback)
        ? {...base, tokensPerSecond: fallback, evidence: 'fleet_average', soloTokensPerSecond: fallback}
        : {...base, tokensPerSecond: null, evidence: 'suspect_unmeasured', soloTokensPerSecond: null};
    }
    if (!lane?.solo || !positive(lane.solo.value)) return {tokensPerSecond: null, evidence: 'cold'};
    if (lane.lastAt === null || (this.wallNow() - lane.lastAt) > this.sampleTtlSeconds) return {tokensPerSecond: null, evidence: 'stale'};
    const level = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY_LEVEL));
    if (level === 1) return {tokensPerSecond: lane.solo.value,
      evidence: lane.levels.has(1) ? 'measured' : 'measured_normalized',
      soloTokensPerSecond: lane.solo.value, soloSamples: lane.solo.samples};
    const measured = lane.slowdown.get(level);
    const factor = measured && positive(measured.value) ? measured.value : slowdownDefault(level);
    return {tokensPerSecond: lane.solo.value * factor,
      evidence: measured ? 'measured_slowdown' : 'default_curve',
      soloTokensPerSecond: lane.solo.value, soloSamples: lane.solo.samples};
  }

  // Output-size estimate for work on this lane: the lane's own recent median
  // completion size, else the fleet's, else the labelled cold-start constant.
  // Self-calibrating from real traffic — a ring that serves 80k-token turns is
  // not priced as if it served 800-token chats.
  medianOutput(workerId) {
    const laneMedian = median(this.lanes.get(workerId)?.outputs ?? []);
    if (laneMedian !== null) return laneMedian;
    const fleetMedian = median(this.fleetOutputs);
    return fleetMedian ?? this.medianOutputTokens;
  }

  // Pending seconds until the lane's current work drains, running decay first.
  // excludeId: the evaluated request is often still in the source queue; it
  // must not be counted twice (it is added back separately by finishEstimate).
  pendingSeconds(worker, at, excludeId = null) {
    const rate = this.speedAt(worker.id, Math.max(1, worker.running?.length ?? 0)).tokensPerSecond;
    if (!positive(rate)) return null;
    const outputEstimate = this.medianOutput(worker.id);
    const runningLeft = (worker.running ?? []).reduce((sum, entry) => sum + (remainingSecondsOf(entry, rate, outputEstimate, at) ?? 0), 0);
    const queuedWork = (worker.queue ?? []).reduce((sum, entry) => sum + (excludeId != null && entry?.id === excludeId ? 0 : workOf(entry, outputEstimate)), 0);
    return (runningLeft + queuedWork) / rate;
  }

  // Estimated finish seconds for `job` placed on `worker`. Never null for a
  // measured lane; null exactly when the lane is cold or stale.
  // Two-phase rates from classified samples: prefill and decode throughput
  // measured by the samples each phase dominates (see record). Both classes
  // need a minimum of evidence before the estimate is trusted; otherwise the
  // blended solo rate is used. Rates are solo-equivalent (same normalization
  // as the solo EWMA), so finishEstimate scales them with the same factor.
  phaseRates(workerId) {
    const lane = this.lanes.get(workerId);
    // Engine counters first: decode from the engine is cache-invariant, and
    // pairing it with the lane's traffic-measured prefill is strictly better
    // than either alone. Fall back to two classified traffic classes.
    if (this.engineFresh(lane)) {
      const prefill = positive(lane.engine.prefill) ? lane.engine.prefill : (lane.prefill?.samples >= 3 ? lane.prefill.value : null);
      if (positive(prefill)) return {prefill, decode: lane.engine.decode, source: 'engine'};
    }
    const prefill = lane?.prefill, decode = lane?.decode;
    if (!prefill || !decode || prefill.samples < 3 || decode.samples < 3) return null;
    if (!positive(prefill.value) || !positive(decode.value)) return null;
    // The same plausibility ceiling applies to phase rates: a prefill reading
    // above the fleet's physical ceiling is a cache artifact, and mixing it
    // into a finish estimate reintroduces exactly the corruption the blended
    // fence rejects. A suspect lane's phase history is not used at all.
    if (lane.suspect) return null;
    if (prefill.value > this.maxPlausibleTps || decode.value > this.maxPlausibleTps) return null;
    return {prefill: prefill.value, decode: decode.value};
  }

  finishEstimate(worker, job, at) {
    const capacity = count(worker.capacity) && worker.capacity > 0 ? worker.capacity : 1;
    const running = worker.running ?? [];
    const spare = capacity - running.length;
    let startDelay = 0;
    if (spare <= 0) {
      const busy = this.pendingSeconds(worker, at, job?.id);
      if (busy === null) return null;
      startDelay = busy;
    }
    // The incoming request executes as the (running+1)-th concurrent request on
    // this lane — an empty lane runs it solo at the measured solo rate, not at
    // some imagined full-lane rate.
    const concurrency = Math.max(1, Math.min(capacity, running.length + 1));
    const speed = this.speedAt(worker.id, concurrency);
    if (!positive(speed.tokensPerSecond)) return null;
    const parts = workParts(job, this.medianOutput(worker.id));
    const phases = this.phaseRates(worker.id);
    // Phase split when the lane's sample ring supports it (solo-equivalent
    // times, scaled back up to the join concurrency); blended otherwise.
    // The factor is a concurrency correction ONLY. When speedAt substituted a
    // fleet average the ratio is 1 by construction, and a nonsense ratio
    // (0, Infinity, NaN) must degrade to 1 rather than price a job at 0 s or
    // 665 s — the round-2 "wins by finishing instantly" bug in a new disguise.
    const solo = speed.soloTokensPerSecond;
    const rawFactor = positive(solo) && positive(speed.tokensPerSecond) ? speed.tokensPerSecond / solo : 1;
    const factor = Number.isFinite(rawFactor) && rawFactor > 0 ? rawFactor : 1;
    const serviceSeconds = phases
      ? (parts.input / phases.prefill + parts.output / phases.decode) / factor
      : (parts.input + parts.output) / speed.tokensPerSecond;
    const estimate = startDelay + serviceSeconds;
    return nonnegative(estimate) ? estimate : null;
  }

  // The decision. Same receipt shape as the legacy planner's summary so the
  // durable commit path, decision records and dashboard consume it unchanged.
  // SIDE-EFFECT-FREE: probe choices are reported, not latched — the committing
  // caller latches them via markProbed() only when a request will really go.
  evaluate({job, workers, currentWorkerId = null, eligibility, homeIsWarmCache = false, at = this.now()}) {
    // The peer group for THIS decision is the fleet actually offered to it.
    // Reading this.lanes directly would let a worker the owner switched out —
    // still inside the 7-day sample TTL — vote in every median, which both
    // hides a liar and convicts an honest lane.
    const previousPool = this.peerPool;
    this.peerPool = new Set((workers ?? []).map(worker => worker?.id).filter(id => typeof id === 'string' && id));
    try {
      return this.decide({job, workers, currentWorkerId, eligibility, homeIsWarmCache, at});
    } finally {
      this.peerPool = previousPool;
    }
  }

  decide({job, workers, currentWorkerId = null, eligibility, homeIsWarmCache = false, at = this.now()}) {
    const candidate = worker => {
      if (typeof worker?.identity === 'string') this.checkIdentity(worker.id, worker.identity);
      const allowed = eligibility ? eligibility(job, worker) : {eligible: true, reason: null};
      const eligible = allowed?.eligible === true;
      const cold = this.speedAt(worker.id, 1).tokensPerSecond === null;
      const capacity = count(worker.capacity) && worker.capacity > 0 ? worker.capacity : 1;
      const spare = capacity - (worker.running?.length ?? 0);
      return {workerId: worker.id, eligible, cold, spare,
        completionSeconds: eligible && !cold ? this.finishEstimate(worker, job, at) : null,
        waitingSeconds: eligible && !cold && spare <= 0 ? this.pendingSeconds(worker, at, job?.id) : 0,
        reason: eligible ? (cold ? 'lane_unmeasured' : 'estimated') : (allowed?.reason ?? 'not_eligible'),
        speedTokensPerSecond: this.speedAt(worker.id, Math.max(1, (worker.running?.length ?? 0) + 1)).tokensPerSecond,
        runningCount: worker.running?.length ?? 0,
        capacity: worker.capacity};
    };
    const candidates = (workers ?? []).map(candidate);
    const base = {mode: 'active', planner: 'v2', at: Math.round(this.wallNow() * 1000), marginSeconds: this.hysteresisSeconds, candidates, currentWorkerId};
    if (job?.cancelled || job?.dispatched || job?.upstream) return {...base, action: 'unchanged', workerId: currentWorkerId, destination: currentWorkerId, reason: 'request_not_queued', savingSeconds: null};
    const eligible = candidates.filter(row => row.eligible);
    if (!eligible.length) return {...base, action: currentWorkerId ? 'stay' : 'unavailable', workerId: currentWorkerId, destination: currentWorkerId, reason: 'no_eligible_worker', savingSeconds: null};
    const home = eligible.find(row => row.workerId === currentWorkerId) ?? null;
    // Placement ranks only measured lanes with a spare slot: queueing new work
    // behind a full measured lane while a lane idles is what left boxes cold.
    // A measured lane whose estimate is non-finite (e.g. a value-corrupted
    // persistence file yielding a subnormal rate) cannot be scored honestly —
    // it is excluded rather than ranked, because null would coerce to 0 and
    // win the sort (round-2 hostile-trace finding).
    const peers = eligible.filter(row => !row.cold && row.spare > 0 && row.workerId !== home?.workerId
      && Number.isFinite(row.completionSeconds))
      .sort((a, b) => a.completionSeconds - b.completionSeconds || a.workerId.localeCompare(b.workerId));
    const best = peers[0] ?? null;
    // One-time re-home cost: if this request moves, the conversation's next
    // turn re-prefills its context on the destination. Scale with the job's
    // own input estimate; the destination's cold prefill for THIS request is
    // already inside its finish estimate and must not be counted twice.
    const rehomeCost = destId => {
      const input = count(job?.inputTokens) ? job.inputTokens
        : count(job?.routingInput?.inputTokens) ? job.routingInput.inputTokens : 0;
      const solo = this.speedAt(destId, 1).tokensPerSecond;
      return positive(solo) ? input / solo : 0;
    };
    const moveThreshold = destId => Math.max(this.hysteresisSeconds, rehomeCost(destId));
    // Stickiness with a priced hysteresis: the warm home wins ties and small
    // deltas, but never holds work against a materially better peer.
    if (home && !home.cold) {
      if (best && best.completionSeconds + moveThreshold(best.workerId) < home.completionSeconds)
        return {...base, action: currentWorkerId ? 'reassign' : 'place', workerId: best.workerId, destination: best.workerId,
          reason: 'saving_exceeds_hysteresis', savingSeconds: home.completionSeconds - best.completionSeconds};
      // Probe-priority, reachable on ANY traffic: while the measured home is
      // busy (>=1 running), an armed cold lane earns ONE request. Gating on
      // crowding alone starves the probe under light traffic — the exact
      // 2026-10-16 failure (two concurrent on ring1, twin idle for an hour).
      // Cost is bounded and honest: one turn of unknown-lane latency per
      // re-arm window; a failing request disarms the lane for probeAfterSeconds.
      const armed = home.runningCount >= 1 ? this.armedColdLane(eligible, home.workerId) : null;
      if (armed) return {...base, action: currentWorkerId ? 'reassign' : 'place', workerId: armed, destination: armed,
        reason: 'cold_probe_bounded', savingSeconds: null};
      if (home.spare > 0) return {...base, action: 'stay', workerId: home.workerId, destination: home.workerId,
        reason: homeIsWarmCache ? 'cache_affinity_keep_home' : 'home_finish_estimate',
        savingSeconds: best && Number.isFinite(home.completionSeconds - best.completionSeconds)
          ? Math.max(0, home.completionSeconds - best.completionSeconds) : null};
      // The home is full: overflow only to a measured peer that actually
      // finishes this request sooner — never sideways into something worse.
      if (best && best.completionSeconds < home.completionSeconds)
        return {...base, action: currentWorkerId ? 'reassign' : 'place', workerId: best.workerId, destination: best.workerId,
          reason: 'available_capacity_fallback', savingSeconds: Number.isFinite(home.completionSeconds - best.completionSeconds)
            ? Math.max(0, home.completionSeconds - best.completionSeconds) : null};
      // Full home, every measured alternative worse or absent: stay and drain
      // — unless a cold lane has a slot, in which case the cold rule below
      // applies (a full home must not dead-end while an idle twin exists).
      if (!eligible.some(row => row.cold && row.spare > 0 && row.workerId !== home.workerId))
        return {...base, action: 'stay', workerId: home.workerId, destination: home.workerId,
          reason: 'home_finish_estimate', savingSeconds: null};
      // fall through to the cold-lane selection
    }
    // A cold home with a spare slot keeps its own warm conversation: staying
    // MEASURES the lane at zero cache cost. Dragging cold-home jobs onto the
    // single measured lane is how the twin starved while its caches were
    // destroyed (2026-10-16: 90 relocations, every one onto the same ring —
    // including the one probe job, dragged back before it could complete).
    // A broken cold lane stays bounded: every stay-commit latches the probe,
    // a failing request disarms it for probeAfterSeconds, and quarantine
    // handles repeated engine failures.
    if (home && home.cold && home.spare > 0)
      return {...base, action: 'stay', workerId: home.workerId, destination: home.workerId,
        reason: 'cold_probe_bounded', savingSeconds: null};
    if (best) return {...base, action: currentWorkerId ? 'reassign' : 'place', workerId: best.workerId, destination: best.workerId,
      reason: 'measured_finish_estimate', savingSeconds: null};
    // Only cold lanes are eligible. They are never ranked by invented numbers:
    // capacity first, then probe priority. Probe priority re-arms: a probe
    // whose request failed or never dispatched is retried after the idle
    // threshold instead of starving the lane's measurement forever.
    const withSlot = eligible.filter(row => row.spare > 0)
      .sort((a, b) => a.workerId.localeCompare(b.workerId));
    if (!withSlot.length) return {...base, action: currentWorkerId ? 'stay' : 'unavailable', workerId: currentWorkerId, destination: currentWorkerId, reason: 'no_capacity', savingSeconds: null};
    const wall = this.wallNow();
    const probed = withSlot.find(row => row.cold
      && ((this.lanes.get(row.workerId)?.lastProbeAt ?? -Infinity) <= wall - this.probeAfterSeconds));
    const chosen = probed ?? withSlot[0];
    const staying = chosen.workerId === currentWorkerId;
    return {...base, action: staying ? 'stay' : currentWorkerId ? 'reassign' : 'place', workerId: chosen.workerId, destination: chosen.workerId,
      reason: probed ? 'cold_probe_bounded' : 'cold_only_capacity', savingSeconds: null};
  }

  // Committing callers only (gateway reconsiderRouting): latch a probe choice
  // so probe priority does not repeatedly select the same lane, while a failed
  // probe re-arms after probeAfterSeconds instead of starving the lane.
  markProbed(workerId, at = this.wallNow()) {
    if (typeof workerId !== 'string' || !workerId) return;
    this.lane(workerId).lastProbeAt = at;
    this.save();
  }

  // Cold lanes with a spare slot whose probe priority is armed (never probed,
  // or idle past the re-arm threshold), id-first for determinism. This is the
  // fleet's self-measurement bootstrap: one bounded request per idle window.
  armedColdLane(eligible, homeId) {
    const wall = this.wallNow();
    const rows = eligible.filter(row => row.cold && row.spare > 0 && row.runningCount === 0 && row.workerId !== homeId
      && ((this.lanes.get(row.workerId)?.lastProbeAt ?? -Infinity) <= wall - this.probeAfterSeconds))
      .sort((a, b) => a.workerId.localeCompare(b.workerId));
    return rows[0]?.workerId ?? null;
  }

  // Report which registered lanes have never produced a measurement, so the
  // fleet's blindness is visible instead of silent. A suspect lane reports the
  // value it was priced at (effective) next to the reading it was caught with
  // (solo) and the peer median that replaced it, so an operator can see the
  // guard working rather than infer it from placement.
  status(registeredIds = []) {
    const wall = this.wallNow();
    const lanes = registeredIds.map(id => {
      const lane = this.lanes.get(id);
      const solo = lane?.solo ?? null;
      const fresh = !!solo && lane.lastAt !== null && (wall - lane.lastAt) <= this.sampleTtlSeconds;
      const suspect = !!lane && (lane.suspect === true || (solo && solo.value > this.maxPlausibleTps));
      const peer = suspect && lane ? this.peerMedian(lane) : null;
      const effective = suspect ? (positive(peer) ? peer : null) : (fresh ? solo.value : null);
      const rejectedByReason = lane ? {...lane.rejected} : {};
      const engine = this.engineFresh(lane) ? lane.engine : null;
      return {workerId: id, measured: fresh && !suspect, samples: lane?.samples ?? 0,
        measurement: suspect && !engine ? 'suspect' : engine ? 'engine' : !solo ? 'cold' : !fresh ? 'stale' : 'measured',
        suspectReason: suspect ? (lane.suspectReason ?? 'implausible_rate') : null,
        suspectSince: suspect ? (lane.suspectAt ?? null) : null,
        effectiveTokensPerSecond: engine ? engine.decode : effective,
        engineDecodeTokensPerSecond: engine ? engine.decode : null,
        enginePrefillTokensPerSecond: engine ? engine.prefill : null,
        engineSampleAgeSeconds: engine ? Math.max(0, wall - engine.at) : null,
        peerMedianTokensPerSecond: peer,
        rejectedSamples: Object.values(rejectedByReason).reduce((sum, value) => sum + value, 0),
        rejectedByReason,
        soloTokensPerSecond: fresh ? solo.value : null, soloSamples: solo?.samples ?? 0,
        prefillTokensPerSecond: fresh && !suspect && lane.prefill && lane.prefill.samples >= 3 && positive(lane.prefill.value) && lane.prefill.value <= this.maxPlausibleTps ? lane.prefill.value : null,
        decodeTokensPerSecond: fresh && !suspect && lane.decode && lane.decode.samples >= 3 && positive(lane.decode.value) && lane.decode.value <= this.maxPlausibleTps ? lane.decode.value : null,
        outputMedianTokens: this.medianOutput(id),
        measuredConcurrency: lane ? [...lane.slowdown.keys()].sort((a, b) => a - b) : [],
        soloLevels: lane ? [...lane.levels].sort((a, b) => a - b) : [],
        sampleAgeSeconds: lane?.lastAt != null ? Math.max(0, wall - lane.lastAt) : null,
        lastSampleAt: lane?.lastAt ?? null};
    });
    return {planner: 'v2', median_output_tokens: this.medianOutputTokens,
      hysteresis_seconds: this.hysteresisSeconds, probe_after_seconds: this.probeAfterSeconds,
      sample_ttl_seconds: this.sampleTtlSeconds, fleet_output_median_tokens: median(this.fleetOutputs),
      min_prompt_tokens: this.minPromptTokens, min_sample_seconds: this.minSampleSeconds,
      max_plausible_tps: this.maxPlausibleTps, peer_ratio: this.peerRatio,
      records: this.state.records, rejected_samples: this.state.rejected,
      storage_error: this.state.storageError, notice: this.state.notice,
      suspect_lanes: lanes.filter(lane => lane.measurement === 'suspect').map(lane => lane.workerId),
      unmeasured_lanes: lanes.filter(lane => !lane.measured).map(lane => lane.workerId), lanes};
  }

  save() {
    if (!this.filename || this.closed) return;
    this.dirty = true;
    if (this.writing) return;
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const lanes = Object.fromEntries([...this.lanes.values()].map(lane => [lane.id, {
          identity: lane.identity, model: lane.model, samples: lane.samples, lastAt: lane.lastAt, lastProbeAt: lane.lastProbeAt,
          lastAccepted: lane.lastAccepted,
          suspect: lane.suspect, suspectReason: lane.suspectReason, suspectAt: lane.suspectAt,
          solo: lane.solo, levels: [...lane.levels], outputs: [...lane.outputs], prefill: lane.prefill, decode: lane.decode,
          slowdown: Object.fromEntries([...lane.slowdown.entries()])}]));
        const data = JSON.stringify({version: 1, measurementVersion: MEASUREMENT_VERSION, fleetOutputs: [...this.fleetOutputs], lanes});
        const temporary = `${this.filename}.${randomUUID()}.tmp`;
        try {
          await fsp.mkdir(path.dirname(this.filename), {recursive: true, mode: 0o700});
          const handle = await fsp.open(temporary, 'wx', 0o600);
          try {await handle.writeFile(data); await handle.sync();} finally {await handle.close();}
          await fsp.rename(temporary, this.filename);
          this.state.storageError = null; // a later transient failure must not cost history forever
        } catch (error) {
          this.state.storageError = `Lane speeds could not be saved (${error.code ?? error.message}); measurement continues in memory and the next write retries.`;
          return;
        } finally {await fsp.rm(temporary, {force: true}).catch(() => {});}
      }
    })().catch(() => {this.state.storageError = 'Lane speeds could not be saved; measurement continues in memory.';})
      .finally(() => {this.writing = false; if (this.dirty && !this.closed) this.save();});
  }

  // Resolves when the current coalesced write (if any) has landed. Tests and
  // graceful shutdown use this; the hot path never awaits it.
  flush() {return Promise.resolve(this.writing);}

  close() {
    if (this.closed) return Promise.resolve();
    this.dirty = true; // flush whatever is pending, then stop
    this.save();
    // Wait out every in-flight write cycle INCLUDING its .finally re-save
    // before declaring closed: setting the flag earlier would suppress the
    // finally's dirty re-save and silently drop the final batch (round-2 fix).
    return (async () => {
      while (this.writing) await this.writing;
      this.closed = true;
    })();
  }
}
