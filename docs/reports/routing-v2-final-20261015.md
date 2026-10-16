# Routing v2 — final audit report and cutover decision (2026-10-15)

**Change:** replace the gateway's completion-time load balancer with Routing v2
(`ds4-gateway/routing-v2.mjs`) — passive stopwatch measurement per lane (EWMA of
solo-equivalent COMPUTE tokens/sec = (prompt−cached+completion)/seconds, 0.9-per-level
default curve with measured refinements, per-lane/fleet output-size medians) and one
decision rule (Design C v2, `docs/reports/lb-design-c2-offline.mjs`): score lanes by
estimated finish of the incoming request; move the queued head only beyond
max(hysteresis, one-time re-home cost); full home overflows to any measured peer that
finishes sooner; cold lanes get capacity work or re-armable probe priority. No probes,
no synthetic load, no engine cooperation required. Dormant behind
`routing_v2_enabled: false`.

## Audit trail

**Round 1** (3 independent reviewers — core, integration, adversarial):
all returned SHIP-AFTER-FIXES. One P0 (persistence froze after the first write batch)
and six P1s (dead ms/seconds decay, cached tokens counted as compute, image bytes
priced as phantom tokens, no output-size signal, shadow path consuming probe state,
missing staleness horizon). All fixed and regression-tested.

**Round 2** (3 fresh reviewers — fix verification, blind adversarial sweep, full
cutover rehearsal): all returned **READY-FOR-CUTOVER**. All seven round-1 P0/P1 fixes
verified present, correct, and complete; no new blocking bug introduced. Six residual
P2s found and fixed in this pass:

- measured-but-unestimable lane could rank first via null→0 sort coercion — now excluded, falls to the honest cold rule
- `close()` microtask race could drop the final dirty batch — close now drains every write cycle before declaring closed
- fleet output window silently halved on every restart (32 vs 64) — restore window fixed
- solo-less probe latches now survive restarts (spaces probes across restarts)
- cached tokens clamped to prompt (engine misreports can't inflate a lane's rate)
- dispatch-time concurrency stamped on the job (the last finisher of a crowd no longer records a crowd-slowed rate as solo)
- probe latch moved below the commit guards (an aborted commit no longer suppresses a lane's probe priority)
- shadow tally restricted to decision points, once per point per request (offers/diagnostics/double-admission no longer drown the signal)
- UI receipts: v2 `no_eligible_worker` renders correctly; dead stay-line removed
- header/doc aligned with shipped semantics (full-home overflow, re-armable probes, identity-reset-on-admission-knob-edit)

## Verification

- `node --test` (full suite): **1,446 tests — 1,429 pass, 3 fail** — the same 3
  pre-existing failures proven unrelated before this work began
  (launchd-removal-audit, recovery, state-lock). Zero regressions.
- `node --test ds4-gateway/routing-v2.test.mjs`: **25/25**, including round-1 and
  round-2 regression tests for every fixed bug.
- `node docs/reports/lb-design-c2-offline.mjs`: ALL CHECKS PASSED.
- Reviewer reports: `docs/reports/lb-v2-review-20261015/` (round 1),
  `docs/reports/lb-v2-review-20261015-r2/` (round 2).

## Verdict

**GO.** Enable tomorrow morning:

1. In `config.local.json`: set `"routing_v2_enabled": true`.
2. Restart the gateway (normal stop/start; queued-but-undispatched requests are
   rejected 503 at shutdown — pick a quiet moment).
3. Verify: `/gateway/status` → `placement_policy: "completion_time_v2"`,
   `routing_v2.decisions_enabled: true`, `storage_error: null`.
4. Rollback = set the flag false + restart. `runtime/lane-speeds.json` persists
   through rollback and is never read by the legacy planner.

## Day-one expectations (from the cutover rehearsal)

- Both rings start cold (no `lane-speeds.json` exists yet). The first requests go to
  `glm53-quality-ring1` (id-first cold rule) until it fills; the next queued head then
  overflows/probes ring2, whose first completion converts it. Both rings measured
  within the first handful of concurrent requests. Strictly sequential traffic keeps
  ring2 unmeasured — expected, not broken.
- Expect a small relocation burst on the very first request (up to 3 hops before first
  dispatch, converging deterministically). Bounded, harmless.
- 262k-context turns stay warm-homed by design (full-input pricing); the case that
  started this project — output-dominated work piling on a 3/4-busy ring while the
  twin idles — now spreads. Break-even for equal machines: move iff output > 1.69 × input.
- `routing_v2.unmeasured_lanes` will always list the 8 drained workers — filter to the
  live rings when reading.
- The shadow tally freezes once v2 is enabled (it only compares while legacy is
  authoritative) — not a fault.
- The dashboard UI has no v2 panel yet; read `routing_v2` in the status JSON.
  `/set-routing-margin` edits the legacy margin only and is inert under v2
  (v2 hysteresis = `routing_v2_hysteresis_seconds`, config-file only).
- Watch-list for silent failure: `records` flatlining while requests complete (usage
  not parsed); `storage_error` set; a `notice` about a preserved corrupt file;
  per-ring samples stuck at 1–2 (identity flapping — avoid editing
  `max_concurrent_requests`/serving profiles mid-window); solo divergence ≥2× between
  twins (one ring throttling — v2 will feed it only overflow).

## Known residuals (accepted, non-blocking)

- No dashboard panel for `routing_v2` status yet (read the JSON).
- No gateway-seam rig test for the finish-hook formula (module-side formula is fully
  tested; the one-line seam was hand-verified by two review rounds).
- Blended-rate model over-stays giant-context turns somewhat (no measured prefill/decode
  split yet) — conservative direction, revisit after a week of data.
- Identity hash includes admission knobs: editing a worker's capacity/context/profile
  resets that lane to cold (documented; one completion re-measures it).
- Pre-existing (untouched): `/set-execution-capacity` idle-guard divergence (adversarial P2-11),
  the 3 unrelated suite failures.
