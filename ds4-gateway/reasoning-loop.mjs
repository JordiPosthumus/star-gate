// Reasoning-loop detection for the streaming path.
//
// A DeepSeek TP3 ring degrades into re-emitting the same few short lines
// ("OK. / Let me go. / Let me produce.") inside `reasoning_content` until the
// engine's own repetition guard fires. The gateway sees those lines as they
// stream, so it can stop the turn itself instead of waiting for the engine.
//
// Scope: detect + stop. The gateway never repairs a model and never re-asks on
// the owner's behalf; a caught loop ends the turn with a visible reason so the
// client can tell a loop-cut from a network fault.
//
// Privacy: this observer keeps only a bounded window of cheap hashes of
// normalized lines. It never retains or reports the line text itself, which is
// the same rule the other response observers follow.

import { createHash } from 'node:crypto';
export const LOOP_DEFAULTS = {
  enabled: true,
  // Identical consecutive normalized lines before the turn is stopped.
  repeats: 20,
  // A short cycle of 2..cycleMax distinct lines repeated this many times also
  // counts. Kept below `repeats` because a cycle is stronger evidence per line.
  cycleRepeats: 6,
  cycleMax: 10,
  // Long lines are prose, not the degenerate short-line loop, and are the main
  // source of false positives. Lines above this are never considered.
  maxLineLength: 80,
  // Only reasoning is inspected: code, tables and lists land in `content`, so
  // leaving it out removes most of the false-positive territory for free.
  includeAnswer: false,
};

const FENCE = /^\s*(?:`{3,}|~{3,})/;

// Normalize so "OK.", "OK" and "ok." collide. Returns null for lines that must
// never participate: blank, fenced-code delimiters and over-long prose.
export function normalizeLoopLine(line, maxLineLength) {
  if (typeof line !== 'string') return null;
  if (FENCE.test(line)) return null;
  const normalized = line.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?"'`)\]}]+$/g, '').trim();
  if (!normalized) return null;
  if (normalized.length > maxLineLength) return null;
  return normalized;
}

function hashLine(normalized) {
  // Truncated digest: collision risk is irrelevant next to a 20x window and it
  // keeps the retained window tiny.
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

// Finds the smallest period p in [2, cycleMax] such that the tail is exactly
// `cycleRepeats` repeats of a p-line cycle. Period 1 (one line repeated) is the
// owner's `repeats` threshold and is checked separately, so it is excluded here:
// a multi-line cycle is stronger evidence per line and may fire sooner. The
// period must be minimal and contain at least two distinct lines, otherwise a
// single repeated line would masquerade as a 2-line cycle.
export function detectCycle(hashes, { cycleRepeats, cycleMax }) {
  if (!Number.isFinite(cycleRepeats) || cycleRepeats < 2) return null;
  for (let period = 2; period <= cycleMax; period++) {
    const needed = period * cycleRepeats;
    if (hashes.length < needed) continue;
    const tail = hashes.slice(hashes.length - needed);
    const block = tail.slice(0, period);
    if (new Set(block).size < 2) continue;
    if (isPeriodic(block)) continue;
    let cycles = 0, matched = true;
    for (let i = 0; i < needed; i++) {
      if (tail[i] !== tail[i % period]) { matched = false; break; }
      if (i % period === 0) cycles++;
    }
    if (matched && cycles === cycleRepeats) return { period, repeats: cycleRepeats };
  }
  return null;
}

// True when a block is itself a repeat of a smaller period (so `period` is not
// the true cycle length).
function isPeriodic(block) {
  for (let d = 1; d < block.length; d++) {
    if (block.length % d) continue;
    if (block.every((value, i) => value === block[i % d])) return true;
  }
  return false;
}

export class ReasoningLoopObserver {
  constructor(options = {}) {
    const config = { ...LOOP_DEFAULTS, ...options };
    // A malformed config must never crash startup or silently disable itself.
    // Clamp each numeric option back to a sane integer; anything unusable
    // falls back to the documented default.
    const count = (value, fallback, min) => Number.isInteger(value) && value >= min ? value : fallback;
    config.repeats = count(config.repeats, LOOP_DEFAULTS.repeats, 2);
    config.cycleRepeats = count(config.cycleRepeats, LOOP_DEFAULTS.cycleRepeats, 2);
    config.cycleMax = count(config.cycleMax, LOOP_DEFAULTS.cycleMax, 2);
    config.maxLineLength = count(config.maxLineLength, LOOP_DEFAULTS.maxLineLength, 1);
    config.includeAnswer = config.includeAnswer === true;
    this.config = config;
    this.enabled = config.enabled !== false;
    // Ring buffer of normalized-line hashes, oldest first.
    this.hashes = [];
    this.seen = 0;
    this.detected = null;
    // Code fences are skipped entirely: fenced content is code, not a loop.
    this.inFence = false;
    this.fenced = false;
  }

  get limit() { return Math.max(this.config.repeats ?? 20, (this.config.cycleMax ?? 10) * (this.config.cycleRepeats ?? 6)); }

  // Accept one complete reasoning line (already extracted from the SSE delta).
  acceptLine(line) {
    if (!this.enabled || this.detected) return this.detected;
    const raw = typeof line === 'string' ? line : '';
    if (FENCE.test(raw)) { this.inFence = !this.inFence; this.fenced = true; return null; }
    if (this.inFence) return null;
    const normalized = normalizeLoopLine(raw, this.config.maxLineLength ?? 80);
    if (!normalized) {
      // Real content between repeats (an over-long prose line) breaks the run;
      // blank lines and fence delimiters are formatting and do not.
      const trimmed = raw.trim();
      if (trimmed && trimmed.length > (this.config.maxLineLength ?? 80)) {
        this.hashes.push(`\u0000${this.seen}`);
        if (this.hashes.length > this.limit) this.hashes.shift();
      }
      return null;
    }
    this.hashes.push(hashLine(normalized));
    if (this.hashes.length > this.limit) this.hashes.shift();
    this.seen++;
    // A single line repeated `repeats` times is the owner's definition of a loop.
    const repeats = this.config.repeats ?? 20;
    if (this.hashes.length >= repeats) {
      const tail = this.hashes.slice(this.hashes.length - repeats);
      if (tail.every(h => h === tail[0])) {
        this.detected = { kind: 'repeat', period: 1, repeats, lines: this.seen };
        return this.detected;
      }
    }
    const cycle = detectCycle(this.hashes, { cycleRepeats: this.config.cycleRepeats ?? 6, cycleMax: this.config.cycleMax ?? 10 });
    if (cycle) this.detected = { kind: 'cycle', period: cycle.period, repeats: cycle.repeats, lines: this.seen };
    return this.detected;
  }
}
