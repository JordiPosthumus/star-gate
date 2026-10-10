import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningLoopObserver, normalizeLoopLine, detectCycle, LOOP_DEFAULTS } from './reasoning-loop.mjs';

const feed = (observer, lines) => { for (const line of lines) observer.acceptLine(line); return observer.detected; };

test('normalizeLoopLine collapses the casing and punctuation a loop varies', () => {
  assert.equal(normalizeLoopLine('OK.', 80), 'ok');
  assert.equal(normalizeLoopLine('  ok  ', 80), 'ok');
  assert.equal(normalizeLoopLine('Let  me   go!', 80), 'let me go');
  assert.equal(normalizeLoopLine('', 80), null);
  assert.equal(normalizeLoopLine('   ', 80), null);
  // Long lines are prose, not the degenerate short-line loop.
  assert.equal(normalizeLoopLine('x'.repeat(81), 80), null);
  assert.equal(normalizeLoopLine('x'.repeat(80), 80), 'x'.repeat(80));
});

test('code fences are skipped so fenced repeats never count', () => {
  const observer = new ReasoningLoopObserver({ repeats: 3 });
  const lines = ['```', ...Array.from({ length: 10 }, () => 'const a = 1'), '```'];
  assert.equal(feed(observer, lines), null);
  assert.equal(observer.seen, 0);
});

test('a single line repeated to the threshold stops the turn', () => {
  const observer = new ReasoningLoopObserver({ repeats: 20 });
  assert.equal(feed(observer, Array.from({ length: 19 }, () => 'OK.')), null, 'nineteen is not yet a loop');
  const detected = observer.acceptLine('ok');
  assert.deepEqual(detected, { kind: 'repeat', period: 1, repeats: 20, lines: 20 });
});

test('a short cycle of distinct lines is detected below the single-line threshold', () => {
  const observer = new ReasoningLoopObserver({ repeats: 20, cycleRepeats: 6, cycleMax: 10 });
  const cycle = ['Let me go.', 'Let me produce.'];
  const detected = feed(observer, Array.from({ length: 12 }, (_, i) => cycle[i % 2]));
  assert.equal(detected?.kind, 'cycle');
  assert.equal(detected.period, 2);
  assert.equal(detected.repeats, 6);
});

test('ordinary varied reasoning never fires', () => {
  const observer = new ReasoningLoopObserver();
  const lines = [
    'I need to check the configuration file first.',
    'The user asked about the deployment status.',
    'Let me look at the gateway logs.',
    'There are three workers registered.',
    'Now I should verify the health endpoint.',
    'OK',
    'The response looks correct.',
    'Let me summarize.',
  ];
  assert.equal(feed(observer, lines), null);
});

test('a long prose line breaks the consecutive run, as a loop must be consecutive', () => {
  const observer = new ReasoningLoopObserver({ repeats: 4 });
  const prose = 'a much longer line of ordinary prose that is not part of any cycle at all';
  assert.equal(feed(observer, ['ok', 'ok', prose, 'ok', 'ok', 'ok']), null, 'the prose line broke the run');
  assert.equal(observer.acceptLine('ok')?.kind, 'repeat', 'four consecutive short lines now close the run');
});

test('detection latches and stops counting further lines', () => {
  const observer = new ReasoningLoopObserver({ repeats: 3 });
  const first = feed(observer, ['ok', 'ok', 'ok']);
  assert.equal(first.kind, 'repeat');
  const seenAtDetection = observer.seen;
  assert.equal(observer.acceptLine('ok'), first, 'the same detection is returned');
  assert.equal(observer.seen, seenAtDetection, 'no further work after detection');
});

test('the window is bounded regardless of stream length', () => {
  const observer = new ReasoningLoopObserver({ repeats: 20, cycleRepeats: 6, cycleMax: 10 });
  for (let i = 0; i < 5000; i++) observer.acceptLine(`line ${i}`);
  assert.equal(observer.detected, null);
  assert.ok(observer.hashes.length <= observer.limit, `window ${observer.hashes.length} exceeds ${observer.limit}`);
});

test('disabled observer never detects', () => {
  const observer = new ReasoningLoopObserver({ enabled: false, repeats: 2 });
  assert.equal(feed(observer, ['ok', 'ok', 'ok', 'ok']), null);
});

test('detectCycle requires an exact tail cycle', () => {
  const hashes = ['a', 'b', 'a', 'b', 'a', 'b'];
  assert.deepEqual(detectCycle(hashes, { cycleRepeats: 3, cycleMax: 10 }), { period: 2, repeats: 3 });
  assert.equal(detectCycle(['a', 'b', 'a', 'b', 'a', 'c'], { cycleRepeats: 3, cycleMax: 10 }), null);
  assert.equal(detectCycle(['a', 'b'], { cycleRepeats: 3, cycleMax: 10 }), null);
});

test('a malformed config is clamped, never crashing or silently disabling', () => {
  const naked = new ReasoningLoopObserver(undefined);
  assert.equal(naked.enabled, true);
  assert.equal(naked.config.repeats, 20);
  for (const bad of [{ repeats: 'twenty' }, { repeats: -1 }, { repeats: 0 }, { cycleMax: 'x' }, 'nonsense']) {
    const observer = new ReasoningLoopObserver(bad);
    assert.equal(observer.config.repeats, 20, `repeats for ${JSON.stringify(bad)}`);
    assert.ok(observer.limit >= 20 && Number.isFinite(observer.limit));
    assert.equal(observer.enabled, true);
  }
  // An explicit off switch is still honoured, and 2 is the smallest usable run.
  assert.equal(new ReasoningLoopObserver({ enabled: false }).enabled, false);
  assert.equal(new ReasoningLoopObserver({ repeats: 1 }).config.repeats, 20, 'one line is not a loop');
  // includeAnswer must be strictly boolean, not truthy.
  assert.equal(new ReasoningLoopObserver({ includeAnswer: 'yes' }).config.includeAnswer, false);
});

test('defaults match the owner-agreed threshold', () => {
  assert.equal(LOOP_DEFAULTS.repeats, 20);
  assert.equal(LOOP_DEFAULTS.includeAnswer, false);
  assert.equal(LOOP_DEFAULTS.maxLineLength, 80);
});
