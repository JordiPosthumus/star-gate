import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitOutputLengths, remainingOutputTokens, outputEstimate, phaseSpeed, inputEstimate,
  serviceEstimate, remainingServiceEstimate} from './routing-estimates.mjs';

const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected}`);
const worker = (id, model = 'glm', identity = `${id}/glm/build1`) => ({id, model, identity});
const a = worker('a'), b = worker('b');
const sample = (node, phase, rate, concurrency = 1, extra = {}) => ({workerId: node.id, identity: node.identity,
  model: node.model, requestId: 'request-1', scope: 'request', phase, tokens: rate * 10, seconds: 10,
  concurrency, concurrencyStable: true, waitExcluded: true, ...extra});
const samples = [sample(a, 'prefill', 1000), sample(a, 'decode', 20)];
const fit = {mu: Math.log(1000), sigma: 1};
const natural = outputTokens => ({outputTokens, outcome: 'complete', finishReason: 'stop'});

test('log-normal mean matches independent Python erfc reference values, including the audit counterexample', () => {
  for (const [mu, sigma, generated, limit, expected] of [
    [Math.log(1000), 1, 0, 2000, 1113.8701491642353],
    [Math.log(1000), 1, 1000, 2000, 704.5837145982241],
    [Math.log(1000), 1, 1500, 2000, 422.8185728923206],
    [Math.log(1000), 1, 1999, 2000, 0.9996787049997238],
    [0, 1, 100, 1000, 24.794815760490508],
    [0, 1, 10, null, 4.915629821181019],
    [Math.log(1000), 0.1, 990, 1100, 68.9631009933496],
  ]) near(remainingOutputTokens({mu, sigma}, generated, limit), expected);
  near(remainingOutputTokens(fit), Math.exp(fit.mu + 0.5));
  near(remainingOutputTokens(fit, 1000), 1774.285957670009, 1e-6);
});

test('long-tail estimates remain finite beyond observed support and are bounded by existing limits', () => {
  for (const mu of [-40, 0, Math.log(1000), 20]) for (const sigma of [0.01, 0.1, 1, 3]) {
    for (const n of [0, 1, 10, 9999, 1000000]) {
      const m = n + 1000, actual = remainingOutputTokens({mu, sigma}, n, m);
      assert.ok(Number.isFinite(actual), JSON.stringify({mu, sigma, n, actual}));
      assert.ok(actual >= 0 && actual <= m - n);
    }
  }
  assert.equal(remainingOutputTokens(fit, 1000, 1000), 0);
  assert.equal(remainingOutputTokens(fit, 1001, 1000), 0);
  assert.equal(remainingOutputTokens(fit, null, 2000), null);
  assert.equal(remainingOutputTokens(fit, 10, -1), null);
  assert.equal(remainingOutputTokens({mu: 0, sigma: -1}), null);
});

test('fit uses one bounded natural-completion history and keeps censored/missing/zero outputs out', () => {
  const history = [1, 2, 4, 8, 16].map(natural);
  history.push(...['length', 'max_tokens', 'cancelled'].map(finishReason => ({...natural(100000), finishReason})),
    {...natural(100000), outcome: 'error'}, natural(0), natural(null));
  const fitted = fitOutputLengths(history);
  near(fitted.mu, Math.log(4)); near(fitted.sigma, Math.sqrt(2) * Math.log(2));
  assert.equal(fitted.sampleCount, 5);
  assert.equal(fitOutputLengths(history.slice(0, 4)), null);
  assert.equal(fitOutputLengths(Array.from({length: 300}, () => natural(100))).sampleCount, 256);
  const tools = Array.from({length: 5}, () => ({...natural(30), finishReason: 'tool_calls', trafficClass: 'genie', reasoningTokens: 20}));
  near(remainingOutputTokens(fitOutputLengths(tools)), 30);
});

test('empty and degenerate fits use explicit fallbacks without fabricated zero progress', () => {
  const constant = fitOutputLengths(Array.from({length: 5}, () => natural(100)));
  near(remainingOutputTokens(constant, 50), 50);
  assert.equal(remainingOutputTokens(constant, 101), null);
  assert.deepEqual(outputEstimate({fit: constant, generated: 101, limit: 150, fallbackTokens: 80}),
    {tokens: 49, evidence: 'fallback'});
  assert.deepEqual(outputEstimate({fit: null}), {tokens: null, evidence: 'unavailable'});
  assert.equal(outputEstimate({fit, generated: null, fallbackTokens: 80}).tokens, null);
  assert.deepEqual(outputEstimate({fit: null, generated: 100, limit: 100}), {tokens: 0, evidence: 'output_limit'});
});

test('observed speed rows are median of the last ten attributable measurements', () => {
  const rates = [10000, 10000, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const history = rates.map(rate => sample(a, 'decode', rate, 2));
  const result = phaseSpeed({worker: a, fleet: [a, b], samples: history, phase: 'decode', concurrency: 2});
  assert.equal(result.tokensPerSecond, 55); assert.equal(result.evidence, 'observed');
  for (const extra of [{scope: 'engine'}, {waitExcluded: false}, {concurrencyStable: false},
    {requestId: ''}, {seconds: 0}, {tokens: NaN}, {identity: 'old-build'}, {model: 'another-model'}]) {
    const bad = sample(a, 'decode', 10000, 2, extra);
    assert.equal(phaseSpeed({worker: a, fleet: [a], samples: [bad], phase: 'decode', concurrency: 2}).tokensPerSecond, null);
  }
});

test('concurrency penalty applies once and missing rows use an explicit seeded estimate', () => {
  const seeded = phaseSpeed({worker: a, fleet: [a, b], samples, phase: 'decode', concurrency: 4});
  near(seeded.tokensPerSecond, 20 * 0.9 ** 3); assert.equal(seeded.evidence, 'seeded');
  const observed = phaseSpeed({worker: a, fleet: [a, b], samples: [...samples, sample(a, 'decode', 8, 4)], phase: 'decode', concurrency: 4});
  assert.equal(observed.tokensPerSecond, 8);
  const inferred = phaseSpeed({worker: b, fleet: [a, b], samples: [sample(a, 'decode', 18, 2)], phase: 'decode', concurrency: 2});
  near(inferred.tokensPerSecond, 18); assert.equal(inferred.evidence, 'borrowed');
});

test('new workers borrow same-model fleet mean then broader fleet; changed identities cannot reuse old rows', () => {
  const c = worker('c'), d = worker('d', 'other'), fleet = [a, b, c, d];
  const history = [sample(a, 'prefill', 1000), sample(c, 'prefill', 2000), sample(d, 'prefill', 12000)];
  let result = phaseSpeed({worker: b, fleet, samples: history, phase: 'prefill', concurrency: 2});
  near(result.tokensPerSecond, 1350); assert.equal(result.donorCount, 2); assert.equal(result.donorScope, 'same_model');
  result = phaseSpeed({worker: worker('fresh', 'new-model'), fleet, samples: history, phase: 'prefill', concurrency: 1});
  near(result.tokensPerSecond, 5000); assert.equal(result.donorScope, 'fleet');
  assert.equal(phaseSpeed({worker: worker('a', 'glm', 'a/build2'), fleet: [worker('a', 'glm', 'a/build2')],
    samples, phase: 'decode', concurrency: 1}).tokensPerSecond, null);
  assert.throws(() => phaseSpeed({worker: a, fleet: [a], samples, phase: 'decode', concurrency: 0}));
});

test('cache observations require qualification and identity; unknown is a labelled cold assumption', () => {
  const job = {inputTokens: 10000, cache: {a: {identity: a.identity, reusableTokens: 9000, evidence: 'observed'}}};
  assert.deepEqual(inputEstimate(job, a), {tokens: 10000, reusableTokens: null, evidence: 'unknown', assumption: 'cold'});
  job.cache.a.qualified = true;
  assert.equal(inputEstimate(job, a).tokens, 1000);
  job.cache.a.identity = 'old-model'; assert.equal(inputEstimate(job, a).evidence, 'unknown');
  job.cache.a = {identity: a.identity, reusableTokens: 9000, evidence: 'estimated'};
  assert.equal(inputEstimate(job, a).evidence, 'estimated');
  job.cache.a.reusableTokens = 20000; assert.equal(inputEstimate(job, a).evidence, 'unknown');
  assert.equal(inputEstimate({}, a).tokens, null);
});

test('service sums phases and optional existing restoration timing without charging cache twice', () => {
  const job = {inputTokens: 10000, outputLimit: 500, cache: {a: {identity: a.identity, reusableTokens: 9000, evidence: 'observed', qualified: true}},
    restorationSeconds: {a: 2}};
  const options = {job, worker: a, fleet: [a], samples, concurrency: 1, outputModel: {fallbackTokens: 1000}};
  const result = serviceEstimate(options);
  assert.equal(result.prefillSeconds, 1); assert.equal(result.decodeSeconds, 25); assert.equal(result.seconds, 28);
  const prefill = remainingServiceEstimate({...options, progress: {phase: 'prefill', generatedTokens: 0, computedInputTokens: 500, evidence: 'observed'}});
  assert.equal(prefill.remainingInputTokens, 500); assert.equal(prefill.seconds, 25.5);
  const decode = remainingServiceEstimate({...options, outputModel: {fit}, progress: {phase: 'decode', generatedTokens: 100, evidence: 'observed'}});
  near(decode.seconds, remainingOutputTokens(fit, 100, 500) / 20); assert.equal(decode.prefillSeconds, 0);
  assert.equal(remainingServiceEstimate({...options, progress: {phase: 'decode', generatedTokens: null, evidence: 'observed'}}).seconds, null);
  assert.equal(remainingServiceEstimate({...options, progress: {phase: 'prefill', generatedTokens: 0, computedInputTokens: 9000, evidence: 'observed'}}).seconds, null);
  assert.equal(serviceEstimate({...options, samples: []}).seconds, null);
});
