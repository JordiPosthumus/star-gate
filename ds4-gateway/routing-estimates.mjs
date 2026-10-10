// Offline routing arithmetic. Inputs are normalized observations, never engines
// or gateway objects. No I/O, timers, configuration changes or live reservations.
const nonnegative = x => Number.isFinite(x) && x >= 0;
const positive = x => Number.isFinite(x) && x > 0;
const count = x => Number.isSafeInteger(x) && x >= 0;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};

// One recent fleet history, including Genie requests and tool-call stops.
// Output tokens are the backend's inclusive total: do not add reasoning twice.
export function fitOutputLengths(history) {
  const usable = history.slice(-256).filter(row => row.outcome === 'complete'
    && ['stop', 'tool_calls', 'function_call', 'end_turn', 'tool_use'].includes(row.finishReason)
    && count(row.outputTokens) && row.outputTokens > 0);
  if (usable.length < 5) return null;
  let mu = 0, squared = 0, n = 0;
  for (const row of usable) {
    const value = Math.log(row.outputTokens), delta = value - mu;
    mu += delta / ++n; squared += delta * (value - mu);
  }
  return {mu, sigma: Math.sqrt(Math.max(0, squared / n)), sampleCount: n};
}

// Log P(Z > z). Use the integrated exponential series in the centre and the
// Mills-ratio continued fraction in the tail, without subtracting CDF from one.
function logNormalSurvival(z) {
  if (z === Infinity) return -Infinity;
  if (z === -Infinity) return 0;
  if (z < 0) return Math.log1p(-Math.exp(logNormalSurvival(-z)));
  if (z > 2) {
    let fraction = 0;
    for (let k = 80; k >= 1; k--) fraction = k / (z + fraction);
    return -z * z / 2 - Math.log(Math.sqrt(2 * Math.PI)) - Math.log(z + fraction);
  }
  let term = z, integral = term;
  for (let k = 1; k <= 32; k++) {
    term *= -z * z / (2 * k) * (2 * k - 1) / (2 * k + 1);
    integral += term;
  }
  return Math.log(0.5 - integral / Math.sqrt(2 * Math.PI));
}
const logDifference = (a, b) => b === -Infinity ? a
  : a <= b ? -Infinity : a + Math.log(-Math.expm1(b - a));

// E[min(L, limit) - generated | L > generated], not a clipped unbounded mean.
// Null means unavailable; neither an absent count nor an invalid fit is zero.
export function remainingOutputTokens(fit, generated = 0, limit = null) {
  if (!count(generated) || (limit !== null && !count(limit))) return null;
  if (limit !== null && generated >= limit) return 0;
  if (!fit || !Number.isFinite(fit.mu) || !nonnegative(fit.sigma)) return null;
  const {mu, sigma} = fit;
  if (sigma === 0) {
    const length = Math.exp(mu);
    // Surviving beyond a degenerate fit has zero probability. Let the caller
    // use its explicit fallback instead of declaring a still-running job done.
    if (!Number.isFinite(length) || generated >= length) return null;
    return Math.max(0, Math.min(length, limit ?? Infinity) - generated);
  }
  const meanLog = mu + sigma * sigma / 2;
  const z = x => (Math.log(x) - mu) / sigma;
  const logS = x => x === 0 ? 0 : logNormalSurvival(z(x));
  const logA = x => x === 0 ? meanLog : meanLog + logNormalSurvival(z(x) - sigma);
  const survival = logS(generated);
  if (!Number.isFinite(survival)) return null;
  let result;
  if (limit === null) {
    const conditionalLogMean = logA(generated) - survival;
    result = generated > 0 ? generated * Math.expm1(conditionalLogMean - Math.log(generated))
      : Math.exp(conditionalLogMean);
  } else {
    const truncated = Math.exp(logDifference(logA(generated), logA(limit)) - survival);
    const capped = limit * Math.exp(logS(limit) - survival);
    result = truncated + capped - generated;
    result = Math.min(limit - generated, Math.max(0, result));
  }
  return nonnegative(result) ? result : null;
}

export function outputEstimate({fit, generated = 0, limit = null, fallbackTokens = null}) {
  if (count(generated) && count(limit) && generated >= limit) return {tokens: 0, evidence: 'output_limit'};
  const tokens = remainingOutputTokens(fit, generated, limit);
  if (tokens !== null) return {tokens, evidence: 'log_normal'};
  if (!count(generated) || (limit !== null && !count(limit)) || !positive(fallbackTokens))
    return {tokens: null, evidence: 'unavailable'};
  // A fallback is estimated remaining work, never a measured progress count.
  return {tokens: Math.min(fallbackTokens, limit === null ? Infinity : Math.max(0, limit - generated)), evidence: 'fallback'};
}

function validSample(sample, worker, phase) {
  // An engineAggregate row is a mean of completed requests read from the
  // engine's own per-request histograms, so it is a real measurement even when
  // the executing count varied during the interval. Constant-concurrency rows
  // keep the stricter requirement; an aggregate row carries its own label so
  // the display can distinguish it from a single clean one-request window.
  const stability = sample.concurrencyStable === true || sample.engineAggregate === true;
  return typeof worker.identity === 'string' && worker.identity.length > 0
    && typeof worker.model === 'string' && worker.model.length > 0
    && sample.workerId === worker.id && sample.identity === worker.identity
    && sample.model === worker.model && sample.phase === phase
    && typeof sample.requestId === 'string' && sample.requestId.length > 0
    && sample.scope === 'request' && sample.waitExcluded === true && stability
    && Number.isSafeInteger(sample.concurrency) && sample.concurrency >= 1
    && positive(sample.tokens) && positive(sample.seconds)
    && positive(sample.tokens / sample.seconds);
}
function ownRows(worker, phase, samples) {
  const rows = new Map();
  for (const sample of samples) {
    if (!validSample(sample, worker, phase)) continue;
    const values = rows.get(sample.concurrency) ?? [];
    values.push(sample.tokens / sample.seconds);
    rows.set(sample.concurrency, values.slice(-10));
  }
  return new Map([...rows].map(([c, values]) => [c, median(values)]));
}

// Samples are chronological. The owner of history persists them; this function
// neither changes history nor turns aggregate throughput into a measured row.
export function phaseSpeed({worker, fleet, samples, phase, concurrency}) {
  if (!['prefill', 'decode'].includes(phase) || !Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Specify a phase and positive execution concurrency.');
  const own = ownRows(worker, phase, samples);
  if (own.has(concurrency)) return {tokensPerSecond: own.get(concurrency), evidence: 'observed', concurrency};
  if (own.size) {
    const reference = Math.min(...own.keys());
    const rate = own.get(reference) * 0.9 ** (concurrency - reference);
    return {tokensPerSecond: positive(rate) ? rate : null, evidence: 'seeded', concurrency, referenceConcurrency: reference};
  }
  const donors = fleet.filter(peer => peer.id !== worker.id).map(peer => {
    const rows = ownRows(peer, phase, samples);
    if (!rows.size) return null;
    const reference = Math.min(...rows.keys());
    return {model: peer.model, solo: rows.get(reference) / 0.9 ** (reference - 1)};
  }).filter(row => row && positive(row.solo));
  const sameModel = donors.filter(row => row.model === worker.model);
  const selected = sameModel.length ? sameModel : donors;
  if (!selected.length) return {tokensPerSecond: null, evidence: 'unavailable', concurrency};
  const solo = selected.reduce((sum, row) => sum + row.solo / selected.length, 0);
  const rate = solo * 0.9 ** (concurrency - 1);
  return {tokensPerSecond: positive(rate) ? rate : null, evidence: 'borrowed', concurrency,
    donorScope: sameModel.length ? 'same_model' : 'fleet', donorCount: selected.length};
}

export function inputEstimate(job, worker) {
  if (!count(job.inputTokens)) return {tokens: null, evidence: 'unavailable'};
  const cache = job.cache?.[worker.id];
  const usable = cache && typeof worker.identity === 'string' && worker.identity.length > 0
    && cache.identity === worker.identity && count(cache.reusableTokens)
    && cache.reusableTokens <= job.inputTokens
    && (cache.evidence === 'estimated' || (cache.evidence === 'observed' && cache.qualified === true));
  return {tokens: job.inputTokens - (usable ? cache.reusableTokens : 0),
    reusableTokens: usable ? cache.reusableTokens : null,
    evidence: usable ? cache.evidence : 'unknown', assumption: usable ? null : 'cold'};
}

function workEstimate({job, worker, fleet, samples, concurrency, outputModel, speedLookup}, progress = null) {
  const input = inputEstimate(job, worker);
  const output = outputEstimate({...outputModel, generated: progress?.generatedTokens ?? 0, limit: job.outputLimit ?? null});
  const prefill = speedLookup?.(worker, 'prefill', concurrency) ?? phaseSpeed({worker, fleet, samples, phase: 'prefill', concurrency});
  const decode = speedLookup?.(worker, 'decode', concurrency) ?? phaseSpeed({worker, fleet, samples, phase: 'decode', concurrency});
  const restorationSeconds = progress ? 0 : job.restorationSeconds?.[worker.id] ?? 0;
  const secondsFor = (tokens, speed) => tokens === 0 ? 0
    : tokens === null || !positive(speed) ? null : tokens / speed;
  const remainingInput = progress?.phase === 'decode' ? 0
    : input.tokens === null ? null : Math.max(0, input.tokens - (progress?.computedInputTokens ?? 0));
  const prefillSeconds = secondsFor(remainingInput, prefill.tokensPerSecond);
  const decodeSeconds = secondsFor(output.tokens, decode.tokensPerSecond);
  const seconds = prefillSeconds === null || decodeSeconds === null || !nonnegative(restorationSeconds)
    ? null : prefillSeconds + decodeSeconds + restorationSeconds;
  return {seconds: nonnegative(seconds) ? seconds : null, concurrency, input, output, prefill, decode,
    remainingInputTokens: remainingInput, prefillSeconds, decodeSeconds, restorationSeconds};
}

export const serviceEstimate = options => workEstimate(options);

// Progress must refer to this request. Unknown/mixed phases or missing counters
// remain unknown; the integrator may supply a clearly labelled estimated value.
export function remainingServiceEstimate(options) {
  const {progress} = options;
  if (!progress || !['observed', 'estimated'].includes(progress.evidence)
    || !['prefill', 'decode'].includes(progress.phase) || !count(progress.generatedTokens)
    || (progress.phase === 'prefill' && !count(progress.computedInputTokens)))
    return {seconds: null, reason: 'request_progress_unavailable'};
  const input = inputEstimate(options.job, options.worker);
  if (progress.phase === 'prefill' && (input.tokens === null || progress.computedInputTokens > input.tokens))
    return {seconds: null, reason: 'request_progress_inconsistent'};
  return {...workEstimate(options, progress), progressEvidence: progress.evidence};
}
