# Reasoning-loop detector — concrete design

Status: design, not implemented. Scope: the streaming path of the DS4 gateway.
Author: Gate Genie. Date: 2026-10-09.

## Problem, restated against the code

The DeepSeek-V4.1-Flash TP3 rings (`ds41f-ring`, `ds41f-ring2`) degenerate in long
agent sessions into short cycled lines inside `reasoning_content`:

    OK. / Let me go. / Let me produce. / Let me go. ... hundreds of times

Structural facts that shape the design (all verified live, 2026-10-09):

- The DS4.1 encoder hard-forces `effective_drop_thinking=False` whenever any
  message carries `tools`, so prior reasoning is re-fed every turn. The feedback
  path is structural; no template kwarg disables it.
- Effort `high` (75) is the sweet spot; `xhigh`/`max` (100) is worse. `T=0` is
  forbidden (separate empty-content loop class).
- vLLM reports the loop only at termination, via
  `finished_reason="repetition"`. The rings expose it as
  `vllm:request_success_total{finished_reason="repetition"}` — currently `0.0`,
  i.e. no early warning exists anywhere today.
- The gateway streams unbuffered: `up.pipe(res)` (`gateway.mjs:1208`) with a
  parallel `up.on('data', chunk => acceptResponseChunk(...))` (`:1204`).
- `acceptResponseChunk` (`:1094`) already runs two response-side observers on
  every chunk: `observer` (`UsageObserver`) and `faults`
  (`GenerationFaultObserver`). It already extracts per-delta phase:
  `reasoning_content` / `reasoning` / `reasoning_text` → `thinking`, `content`
  → `answering`, tool args → `tool_output` (`output-shape.mjs:11`).
- House rule to respect: observers **never retain observed text**.
  `UsageObserver` counts lengths only (`:239` — "observed text is never retained
  for reporting").

## 1. Where the detector lives — gateway, response-side, in-process

Pick the gateway. Justification:

- **Single chokepoint.** Every client (pi, both rings, the M3, future clients)
  is proxied here. A client-side detector would only learn about itself and
  cannot help the M3 or a bare `curl`.
- **It already parses every delta.** `acceptResponseChunk` extracts the phase of
  each delta today. Adding a third observer is the smallest possible seam — no
  new parser, no new buffering of the client stream.
- **It can act.** Only the gateway holds the upstream socket, so only here can
  detection escalate to abort. A client-side detector can hang up its own
  connection but the busted upstream keeps generating and burning the ring.
- **It knows the identity.** `node.id` + served model are in scope, so a loop is
  attributable to ring1 vs ring2 vs M3 rather than being a global mystery.
- **Rejected: worker-side.** The rings run the `christopherowen/spark-ds41f` vLLM
  fork. Putting this in vLLM means a fork rebuild, redeploy of a live lane, and
  it would not cover the M3 (different engine, oMLX). Too much blast radius for
  a heuristic that is still being calibrated.
- **Rejected: client-side alone.** Cannot see other clients, cannot abort
  upstream, and pi cannot be depended on to ship the change.

Trade-off accepted: the gateway sees post-template text, not raw tokens, so
detection is on characters not token ids. For a *line-cycle* loop that is
sufficient.

## 2. Signal, thresholds, false-positive avoidance

### Signal: normalized line-cycle over the reasoning stream only

The loop is line-oriented in `reasoning_content`. Detect a repeated *cycle of
lines*, not a repeated n-gram of characters.

Normalize per reasoning line before hashing:
- trim; collapse internal whitespace runs to one space
- lowercase; strip trailing punctuation (`.,!?:;—…`)
- keep the line bound: a line > 200 chars is truncated for hashing only

State: a ring buffer of the last `W = 32` normalized reasoning lines, each entry
`{hash, len}`. **No raw text is retained** — only a 64-bit hash and a length per
line. This satisfies the house rule and bounds memory to a constant 32 entries
per in-flight request.

Cycle test, evaluated every time a reasoning line completes:

1. For period `p` in `1..8`:
2. Require at least `4` full repetitions of the trailing `p`-line block.
3. Require the repeated span to contain `>= 6` lines total.
4. Require the repeated span's total normalized length `>= 300` chars.
5. Require the repeated unit to be **short**: unit length `<= 120` chars.
6. Fire when some `p` satisfies 2–5.

`p == 1` (one line repeated) requires `>= 8` repetitions instead of 4 — the
single-line degenerate case is the loudest form and should trip fast, but not on
4 accidental repeats.

### Why this separates a true loop from verbose-but-legitimate output

- **It watches reasoning, not the answer.** Code, tables, JSON, bullet lists, and
  test fixtures land in `content` (`answering`), not `reasoning_content`. This
  single choice removes the large majority of false-positive territory the brief
  worried about.
- **Exactness after normalization.** Legitimate reasoning restates a *plan* but
  does so with varied wording and growing detail. A loop repeats the *same* short
  lines verbatim (modulo punctuation). Requiring a byte-identical normalized
  cycle is what separates them.
- **Short-unit guard.** Long verbatim repeats are usually legitimate (re-reading
  an error, quoting the user). `unit <= 120 chars` excludes those.
- **Fenced-code guard.** Lines inside a ``` fence within reasoning are skipped
  (models write pseudocode in reasoning). Track fence parity in the observer.
- **Warm-up floor.** Do not evaluate until `>= 800` normalized reasoning chars
  have been seen, so early short reasoning cannot trip it by accident.

### Helper liveness note (decision input, not a requirement)

Every cycle in Jordi's transcript contains the literal `let me`. That is a
*symptom* of this specific failure, not a definition — do **not** make it a
trigger. It would miss loops with different vocabulary and would fire on
legitimate "let me check X" reasoning. Record it as an aggregate statistic only.

## 3. Action — three tiers, only tier 0 ships first

- **Tier 0 — Observe and count. Default, ships first, no behavior change.**
  Emit one gateway event `reasoning_loop` on first detection per request:
  `{request_id, node, model, period, cycles, unit_chars, span_chars, at}`.
  Increment `reasoning_loops_total` per worker and per model. Nothing about the
  response changes; the client still gets the full stream.
  Rationale: this is the calibration data. Nobody — including us — currently
  knows the real rate, and a heuristic that acts before it is calibrated will
  cause outages of its own.

- **Tier 1 — Annotate and hand back.** Only after tier 0 shows it is precise:
  keep streaming, but add `x-dsg-reasoning-loop: detected` to the response and
  emit a gateway-synthetic SSE comment. A capable client (pi) can then choose to
  discard the turn or re-ask. No gateway-side mutation of model output.

- **Tier 2 — Bounded, client-consented abort.** Opt-in per request via a client
  header (e.g. `x-dsg-loop-action: abort`). On detection: destroy the upstream
  socket, return the reason, and let the **client** decide to re-ask. The gateway
  does not silently re-issue.

Explicitly rejected: **truncate-and-continue.** Rewriting model output behind the
client's back is a lie the client cannot detect, and it breaks tool-call/turn
accounting that agent clients depend on.

Explicitly rejected as a default: **automatic abort+retry with a jittered seed.**
An aborted stream has already started execution. Re-issuing it is a *new*
request, and this codebase's no-replay rules are strict and deliberately so —
`gateway.mjs:1229-1236` permits exactly one witnessed, never-connected
`ECONNREFUSED` replay and nothing else. A gateway-automatic retry would be a
replay class the system chose not to have. It must be the client's decision, so
it belongs in tier 2 behind an explicit header.

## 4. Minimal implementation

**Module**: new `ds4-gateway/reasoning-loop.mjs`, exporting
`ReasoningLoopObserver` with `accept(chunk) / finish() / detected`.

Wiring is three lines in `gateway.mjs`:
- construct next to `faults=responseEncoded?null:new GenerationFaultObserver(isSSE)`
  at `:1092`, gated by a config flag (default off), and null when the response is
  not SSE or the route is not `/v1/chat/completions`.
- call it in `acceptResponseChunk` (`:1094`) alongside `observer.accept(chunk)`.
- read `detected` in `finish` (`:1011`) to log/count. `finish` already routes
  every terminal outcome and is the single place outcomes are counted.

Do not touch `UsageObserver`: it is deliberately text-free. Keep the new observer
separate so the "never retain text" invariant on `UsageObserver` stays literal —
the new module's contract is "retain only hashes and lengths".

**Telemetry**: a gateway log event `reasoning_loop` (tier 0), plus
`reasoning_loops_total` surfaced per worker/model. The per-worker/per-model
aggregate is what makes the dashboard able to say "ring2 loops, ring1 does not",
which is the actionable form.

**Scope**: detect per request; aggregate per worker + per model. Do not start
with a global alarm — attribute first.

**Calibration cross-check (free)**: the rings already publish
`vllm:request_success_total{finished_reason="repetition"}` (verified live, `0.0`
today). Scrape it as an independent fleet counter. If the gateway detector fires
while that counter stays flat, the detector is over-firing — that is the tuning
loop.

## 5. Server-side complement

The cheapest real mitigation is already wired and does not need a recipe rebuild:

- **Inject a serving profile for the rings.** `servingProfileTransform`
  (`serving-profile.mjs:21`) already rewrites sampling params on the request path
  for opt-in chat-completions calls, currently only for the qwen38 lanes
  (`serving_profiles` has qwen38-sparks12/34/56, **no `ds41f-ring` entry`). A
  ring profile with a small `repetition_penalty` (~1.05–1.1) and a small
  `frequency_penalty` would apply the fix gateway-side, for every client, with no
  client change and no fork rebuild. The knobs exist and are honored — proven:
  `repetition_penalty 1.0` → `"ha ha ha ha"`, `1.8` → `"ha"` end-to-end.
  Note the profile validator currently requires the qwen38 capability block
  (`context_window 262144`, `max_output_tokens 262144`, `reasoning true`,
  `input ["text","image"]`) — a ring profile at 524288 context needs that
  validator relaxed, which is a small, contained change.
- **DSpark spec-decode**: leave it on. The loop is semantic, not a spec-decode
  artifact; disabling it would cost throughput for no proven benefit.
- **Do not** chase a vLLM `no_repeat_ngram_size` sunroof first. The gateway
  profile is reversible and observable; a server-config change on a live lane is
  not. Add it later only if the profile produces a poor precision/recall balance.

## Test matrix (must pass before tier 1)

Positive:
- the transcript from the brief (period 4, repeated 100+) → detected, `p=4`
- single-line `p=1` repeated 8+ → detected
- cycle inside `reasoning_content` while `content` stays clean → detected

Negative (each must NOT fire):
- a long, varied reasoning chain with heavy back-referencing → no fire
- a code/table/JSON answer repeating a pattern in `content` → no fire
- a fenced code block inside reasoning that repeats → no fire
- a legitimately quoted long error re-read once in reasoning → no fire
- 4 repeats of a *long* (>120 char) unit → no fire
- short reasoning under the 800-char warm-up floor → no fire
- stream ends mid-cycle (client cancel) → no fire, no false terminal

Boundary:
- cycle straddling a chunk boundary → detected (hash ring, not chunk-scoped)
- response encoded / non-SSE / non-chat route → observer is null, nothing runs
- detector never affects the bytes sent to the client in tier 0

## Recommendation

Ship tier 0 (observe + count) alone first, plus the ring serving profile as a
separate, reversible mitigation. Read the numbers for a day. Only then decide
whether tier 1 or tier 2 earns its complexity. Anything that mutates or replays
model output is the owner's call, not a heuristic's.
