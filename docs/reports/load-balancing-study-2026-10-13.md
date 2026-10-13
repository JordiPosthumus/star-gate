# Load-balancing study — Star Gate (DSG)

**Date:** 2026-10-13 (v1.1 — corrected after external review; see §8)
**Scope:** read-only audit of the live placement path in `ds4-gateway/`, triggered by owner dissatisfaction with load balancing ("too complicated and ineffective"), immediately after the `a28e537` slow-lane patch and with the current uncommitted working-tree changes present.
**Method:** five independent agents — four parallel scouts (placement flow, slow-lane root cause, model-swap resilience, config/bit-rot inventory) plus one fresh reviewer who re-verified every load-bearing citation in the working tree. Unit tests were executed (`node --test`); no files were edited, no services touched, no remote contact.

**Owner goals (the yardstick for every judgement below):**

1. No hardware sitting idle.
2. Never place work on the slowest lane when a faster lane can take it.
3. Reliability — the gateway stays up and recovers.
4. Placement keeps working when the underlying served models change — and, added later with equal weight: **the fleet is not static.** Rings reshape (two/three/four/six Sparks), hardware comes and goes; the balancer must adapt to whatever is registered, without design decisions overfit to one hardware shape.

---

## 1. Fleet reality (verified from config + runtime state)

**The live fleet is NOT what `config.local.json` says.** Once `store.data.workers` exists in the runtime state, registered workers are authoritative and `config.nodes` is ignored (`gateway.mjs:376-381`).

- `config.local.json` `nodes`: 3 stale entries (spark1, spark2, glm53f-m3 with capacity 1 — runtime says 4).
- Live registry (`runtime/affinity.json`): 10 lanes — qwen38-m3 (cap 1), glm53exl3-56/-12/-34 (cap 4), glm53f-m3 (cap 4), ds41f-ring (cap 8), ds41f-ring2 (cap 8), ds41f-m3 (cap 2), glm53-quality-ring1/ring2 (cap 4).
- **At study time, 7 of 10 lanes were drained.** Only glm53f-m3 (the M3 Mac) + the two GLM-5.3 quality rings were taking traffic. `paused` is runtime state (`drained`), not config.
- Key routing config: `routing_time_enabled:true`, `routing_shadow_enabled:true`, `routing_fast_workers:["ds41f-ring","ds41f-ring2"]` (M3 excluded), `model_agnostic:true`, `genie_load_balancing:true`, `genie_rebalance_min_wait_ms:60000`, `conversation_turns` config 5 / saved-state 10, `conversation_turn_idle_ms:2000`, 30s switching margin (default, no override).

---

## 2. Verified answers to the owner's two scenarios

### Scenario A — one lane at 4/4 capacity, another lane empty. Does the balancer move queued work there?

**Yes, by design — but four mechanisms can silently veto the move.**

The moving machinery exists and runs every second: `pumpWaiting` → `rebalanceUndispatched` (gateway.mjs:969, :2197) → up to 32 queue heads re-timed (`reconsiderRouting('waiting')`, gateway.mjs:814-817, :671-678) → `chooseRoute`. Timed case: `move/saving_exceeds_margin` when the empty lane beats home by >30s (routing-plan.mjs:142-146). Untimed case: full lane `canStartNow=false` (gateway.mjs:991) → `available_capacity_fallback`, least-loaded ready lane wins (routing-plan.mjs:126-139). Running/dispatched work can never move (`request_already_running`, routing-plan.mjs:100; `usableJob`, :8).

**The vetoes:**

| # | Veto | Where | Practical status |
|---|---|---|---|
| 1 | **Fast-pin**: if the current home is in `routing_fast_workers` and the empty lane is not, the job stays (`overflow_no_fast_lane`) | routing-plan.mjs:128-131 | **Conditional — corrected in §8.3.** The fast list only filters *eligible* candidates, so with the listed lanes drained/retired it restricts nothing today; it bites only when an eligible listed lane is the incumbent. Stale-list cleanup still recommended |
| 2 | **30s margin**: up to 30s of predicted saving per decision is deliberately discarded | routing-plan.mjs:5, :146 | Always on (default) |
| 3 | **Same-session freeze**: any running request from the same conversation makes all other lanes ineligible and aborts the commit | gateway.mjs:616-621, :643-644 | Always on |
| 4 | **One head per lane per tick**: buried queued jobs only re-time on admission/body/dispatch events | gateway.mjs:671-678 | Always on |

(Also: `routingInputPending` freezes comparisons while a body is still streaming — gateway.mjs:605. Legacy non-timeRouting mode is far more restrictive: destination must be completely idle, plus a 300s affinity wait — gateway.mjs:717, :418.)

### Scenario B — the served models change. Does the balancer go out of commission?

**No — it degrades gracefully; placement quality drops, availability does not.**

Sequence on a model swap (verified in code): the engine's `model_ids` change is detected within one 2s telemetry poll (gateway.mjs:2194-2196; endpoint-telemetry.mjs:122) → `routingIdentity` flips (the hash includes model, aliases, profile, capacity — routing-observations.mjs:25-27) → `observeNative` wipes that lane's prompt-cache history and parks all its speed samples (routing-observations.mjs:203-219) → its speed rows go dormant (`validSample` demands matching identity+model, routing-estimates.mjs:69-81).

What keeps working during the cold window: the lane stays **scoreable** via borrowed donor speeds, cross-model donors allowed, scaled `0.9^(c−1)` (routing-estimates.mjs:87-110); the fleet-wide output-length fit is not keyed by model and survives (routing-estimates.mjs:13-27); `model_agnostic:true` keeps the lane eligible with alias auto-rebind (endpoint.mjs:30-47); a passing test proves homes/capacity survive a discovered model replacement (gateway.test.mjs:2954-2963). Re-warm requires a first valid sample per (lane, phase, concurrency) — oMLX engine rows can land immediately, vLLM needs one busy window meeting the ≤15s acceptance condition — but no arrival is promised: a lane that never serves qualifying traffic never re-measures (observed on the GLM rings; see §8.4). Median-of-10 quality after ~10 samples.

**The honest cost is accuracy, not availability:** for ~1–10 requests the swapped lane's speed is a guess, and guessed rankings are how "wrong lane wins" episodes start after every model change.

Sharp edges found:

- **`model_agnostic` is misnamed.** It toggles only *eligibility/discovery* (endpoint.mjs:32, :44-47). The estimator itself still hashes the model and goes cold per lane on every swap. The name promises more than it delivers.
- **Multi-model server, alias target vanishes:** alias is deleted, the literal `PoolModel` name is forwarded, upstream errors, and dispatch has no cross-model retry (endpoint.mjs:36; gateway.mjs:1037ff). Semi-hard until a manual alias fix.
- **Non-agnostic `ds4` backend with stale aliases:** lane goes offline until config updated (endpoint.mjs:44-45).
- **In-place engine upgrade behind an unchanged endpoint keeps stale speed rows** — identity does not cover engine build (routing-observations.mjs:115-127). Latent stale-data risk.

---

## 3. Why it keeps needing patches (root causes, ranked)

1. **All-or-nothing timing.** There are 20+ distinct "untimeable" reasons across routing-plan.mjs/routing-estimates.mjs (`capacity_mismatch`, `running_progress_unavailable`, `session_progress_unavailable`, `service_estimate_unavailable`, `basis_identity_mismatch`, `engine_waiting_untracked`, …). **A single unknown on a single eligible lane discards ALL timing for the entire comparison** and drops placement to load-count/incumbent heuristics (routing-plan.mjs:126-140). One poisoned lane poisons the decision. This is the structural flaw that generated the patch whack-a-mole.
2. **Asymmetric measurement crowned the slow lane.** vLLM lanes publish no per-request activity rows → never timeable; oMLX did → `best = timed[0] ?? eligible[0]` (routing-plan.mjs:153) handed the win to the only timed lane — the M3. 43 ring2→M3 relocations recorded on Oct 11 (docs/plans/load-balancing-m3-investigation-2026-10-12.md §3).
3. **Long jobs are precisely the untimed ones.** Bodies >8MiB / multimodal / compressed never produce routing input → no dispatch basis; 7.3% of sized requests and 18.1% of >60s requests (DG-15 counters).
4. **Overfitting to a specific fleet shape.** The newest anti-slow-lane mechanism is a hand-typed ID list (`routing_fast_workers`); the estimator branches on engine-specific reporting quirks (vLLM id-keyed rows vs oMLX engine-named rows, positional pairing); `model_routes`/`serving_profiles`/`machine_groups` name machines that rot on every topology change. Every hardware or engine change left debris behind (see §6).
5. **Two placement policies run in parallel.** Legacy load-ratio `placementChoice` (gateway.mjs:841-848, counts requests not seconds) still makes the *first* placement; the completion-time router must later undo it.
6. **Patch timeline confirms the pattern** (Sept→Oct): shadow collector (no authority) → turn reservations → slot/idle-capacity controls → direct-reserve avoidance → completion-time router lands (Oct 10) → slow-lane fix a28e537 (Oct 10) → oMLX positional pairing (Oct 11) → uncommitted fast-workers + attribution counters. Each patch plugged one leak of the same structural flaw.

Mechanism overlap inventory (the "too many cooks" list): legacy load-ratio admission; completion-time estimator + margin; dispatch basis (open-loop, never corrected); engine activity rows + positional pairing; synthetic surplus/waiting entries (still push nulls in two branches — LB-16/19); seeded/borrowed speeds with invented 0.9^Δ penalty; `routing_fast_workers` as a second policy; Genie rebalance offers (offer-generator only — moves nothing); queued handover (destination must be completely idle; 5-min affinity window); shadow mode (zero authority); turn reservations (5 turns + 2s grace, also simulated in forecasts); parked `waiting[]` with wait reasons; relocation evidence ids. **~12–27 interacting concepts across 3,472 audited lines** (gateway 2,261; observations 667; estimates 219; plan 172; queued-body 91; priority 34; queue-choice 28; plus dashboard/UI on top).

---

## 4. Recommendation — Design C: "one number per lane"

Candidate designs stress-tested against the four owner goals:

| Design | Description | Goals 1/2 (idle/slow-lane) | Goal 3 (reliability) | Goal 4 (model/topology change) | Verdict |
|---|---|---|---|---|---|
| **A** | Keep the estimator, keep fixing edge cases | Fails — null-poisoning is structural; fast-pin and mixed-evidence fallbacks remain | Moderate; machinery keeps growing | Worst — per-model identity, every swap is a cold lane | Rejected |
| **B** | Delete the estimator; simple measured-speed tier + fewest-load + stickiness only for cache | Good by construction, but "will soon have capacity" needs residual-time judgment or fast lanes idle mid-drain | Best (least code) | Good if the tier is a per-lane EWMA | Fallback position |
| **C** | **Hybrid: per-lane `remainingSeconds ≈ (running + queued) × EWMA(service_ms at current concurrency)`; rank lanes by it; move the queued head iff `destination + hysteresis < source`** | v1 claim "empty lanes all score ~0" was wrong (§8.1); v2 scores an empty lane by the incoming request's work ÷ measured lane speed, so a fast empty machine sorts before a slow one | Durable booking/ownership, quarantine, drain, priorities kept byte-for-byte; ~1,000+ lines removed | Trivial — no identity hashes, no per-model rows, no engine-name branches; a swap just resets that lane's average, re-warmed by its next finished request | **Recommended (v2 formula — see §8.1/§8.2 and the offline demo)** |

**The key fact that makes C cheap:** `service_ms` is *already recorded on every request finish* (gateway.mjs:1163). The one number C needs is already being measured; everything around it is machinery that can go. No per-request output-length fits, no slot simulation, no dispatch basis, no margins — the entire "one unknown poisons the comparison" failure class disappears because a lane estimate can never be null (thin data degrades to Design B's tier behavior: rank by load among lanes with data, let the cold lane earn its number from its first finished request). **[v1.1: the v1 lane score is superseded by the v2 calculation in §8 — average service seconds is not machine speed, and empty lanes need a speed term.]**

C is also inherently **shape-agnostic** (the owner's added requirement): the fleet is treated as an anonymous set of workers, each with measured attributes (capacity, mean service seconds by concurrency bucket, current running/queued counts). No rule references lane IDs, engine names, or ring topology. Rings of two, three, four, six, a lone Spark — same rules. The only per-worker state kept is *what was measured*, refreshed continuously, forgotten when stale. Cache continuity is preserved the same way it works today: home stickiness for conversations + dispatch-time turn reservations (queue-choice.mjs stays for dispatch; only the *forecast-side* simulation goes).

### Concrete changes (C)

1. Replace the slot-by-slot `completionEstimate` simulation (routing-plan.mjs:14-86) with lane-level remaining-seconds from the `service_ms` EWMA (gateway.mjs:1163) + active/queued counts.
2. Replace the margin + 6-branch fallback ladder (routing-plan.mjs:126-149) with one rule — move the queued head iff `destination start-seconds + hysteresis < source` — and **delete `routing_fast_workers`** (gateway.mjs:360-363); measured ranking replaces the ID list.
3. Rebalance **all** queued heads each tick (gateway.mjs:671-678 currently caps at one per lane).
4. Delete the 100ms `ROUTING_BODY_WAIT` placement gate (queued-request-body.mjs:4; gateway.mjs:1620-1627) — placement no longer needs request bodies at all.
5. Keep untouched: eligibility/drain/quarantine/same-session gating and the durable persist-first booking/ownership commit (gateway.mjs:610-621, :650-660) — this is the part that already works and carries reliability.

**Delete outright:** the dispatch-basis machinery (routing-observations.mjs:203-260, `engineRowOrdering`:87); the fast-worker fallback branches (routing-plan.mjs:126-141); forecast-side turn-reservation normalization (routing-plan.mjs:24-32). Keep `queue-choice.mjs` for dispatch-order only.

Estimated shape: ~1,058 estimator lines + ~600 gateway placement lines collapse to roughly 150–200 lines; the maintainer concept count drops from ~27 to about 6 (capacity, running, queued, service EWMA, hysteresis, stickiness).

---

## 5. What must be preserved in any refactor

- Durable persist-first ownership commit and its failure/restore path, including drain mode on persistence failure (gateway.mjs:633-669).
- Priority ranks and same-session ordering at dispatch.
- Quarantine (20-failure threshold), drain, and worker recovery flows.
- Conversation stickiness for cache reuse (home affinity + dispatch-time turn reservations).
- The Continuity Door contract — untouched by placement changes.

---

## 6. Bit-rot and hygiene (worth doing regardless of the refactor)

1. `config.nodes` spark1/spark2 — dead entries (ignored because the registry exists). glm53f-m3 config capacity 1 vs live 4.
2. `genie: false` — wrong shape (docs show an object; code reads only `config.genie?.reasoning_effort`), silently inert.
3. `genie_load_balancing: true` — no-op (absent already means true); undocumented.
4. Several `model_routes` and `serving_profiles` (qwen38-sparks*) match no registered worker — inert.
5. `routing_fast_workers` — undocumented anywhere (0 hits in docs/, README, CHANGELOG); currently names two drained lanes.
6. `genie_rebalance_min_wait_ms` — dead in time-routing mode (only gates legacy Genie offers).
7. Triplicated rebalance-offer surfaces (gateway.mjs:684-716, :754-799, :800-812); legacy `relocateQueued` duplicates the newer commit path.
8. Shadow mode overlaps job decision records; `would_move` never authorizes anything.
9. Doc drift: `docs/routing-estimator.md:1-3` still describes time routing as a staged, off-by-default experiment while it is live in code and config.
10. Ops note: at study time 7 of 10 registered lanes were drained (runtime state). If leftover from testing rather than deliberate, un-draining is the cheapest idle-hardware win available today.

---

## 7. Confidence and caveats

- **High confidence:** placement flow, every `chooseRoute` branch, the fast-pin veto, the 4/4-vs-empty answer, the model-swap wipe/borrow/fit chain, `model_agnostic` semantics, config-vs-registry override. All read and re-verified directly in the working tree with file:line citations.
- **Tests:** routing-plan 22/22, routing-observations 44/44, gateway suite 297/297 pass on the uncommitted tree.
- **Medium confidence:** blind-window lengths (seconds to ~10 samples) and which failure branch dominates live traffic — code-derived, not measured under load; the exact build currently running was not verified.
- **Not done:** no prototype of Design C; breakage lists and code-delta estimates are judgement from read code.
- Suggested validation path if C is pursued: implement behind a flag with shadow comparison (the existing shadow/decision-record machinery can supply `would_move` evidence), qualify against real traffic per the project's delivery principles, then cut over and delete A-path machinery.

---

## 8. Corrections after external review (2026-10-13, Codex)

External review of v1 raised four findings. Verdicts, with the corrected design:

1. **The v1 formula cannot rank empty machines — ACCEPTED, formula superseded.** `(running+queued) × EWMA(service_ms)` scores every empty machine 0, ignores spare execution slots and the finished fraction of running work, and cannot support "slow lanes sort last" for the empty case. The v2 calculation scores each candidate placement by the incoming request's estimated finish: empty lane → `work ÷ measured speed`; running work decays as it completes; a spare slot starts at zero delay. Demonstrated with assertions covering unequal machine speeds, different request sizes, spare slots, a model change with no fresh measurements, and tie stability: `docs/reports/lb-design-c2-offline.mjs` (`node docs/reports/lb-design-c2-offline.mjs` — all checks pass).
2. **Average duration is not machine speed — ACCEPTED.** v2 measures size-normalized throughput per lane — blended tokens per service second, `(prompt−cached+completion)/service seconds` — not mean duration. A fast machine that happened to serve large requests is no longer punished for receiving harder work. Demo S2: a 160 tok/s machine with a 60s average duration correctly outranks a 53 tok/s machine with a 40s average.
3. **"Fast-pin is the dominant practical blocker" — RETRACTED.** The fast list only filters *eligible* candidates (`fast = eligible.filter(...)`); with the listed lanes ineligible (drained) or the list retired it restricts nothing, and fleet monitoring recorded successful relocations with no sampled stranded queues. The observed stuck case was a different veto: **an untimeable, busy home with spare capacity held independent queued work** (`keepHome` → `current_timing_unavailable`). Fixed in the working tree with an explicit regression suite:
   - `chooseRoute` now takes `homeIsWarmCache` (gateway wiring: `affinity==='existing'` + durable-home match) and moves an independent request to an eligible, completely idle, ready peer when the home forecast is missing (`idle_lane_home_timing_unavailable`).
   - Stays are labelled: `cache_affinity_keep_home` (established conversation home — a real cache reason, now explicit instead of masquerading as missing timing) and `same_session_keep_home` (same-conversation confinement; session safety preserved).
   - Tests: routing-plan.test.mjs — 'a missing home forecast alone cannot hold independent work on a busy home while a peer idles', 'same-session confinement and cache warmth keep the home with explicit reasons', 'a warm home that cannot start still yields to a ready peer despite missing timing'; gateway.test.mjs — 'an untimeable busy home keeps an established conversation only for an explicit cache reason' (end-to-end through admission, decision record and dispatch). One pre-existing expectation was updated deliberately: a usable-but-untimeable busy home no longer holds work when an idle ready peer exists ('capacity fallback preserves immediately usable homes…' lost its first case, which contradicted this requirement). Full suites green: routing-plan 25/25, routing-observations 44/44, gateway 232/232.
4. **Model-change recovery overstated — ACCEPTED.** The ≤15s figure is an acceptance condition on a sampling window, not a promise that fresh measurements arrive; a lane that never serves qualifying traffic never re-measures (consistent with the GLM rings acquiring no own speed rows during monitoring). §2's re-warm wording is corrected above. The v2 cold-lane policy is explicit and honest: no invented numbers — a cold lane only serves when no measured lane has a spare slot, or as one bounded probe after a configurable idle threshold, and its first completed request converts it to measured (demo S5).

The §4 deletion recommendations are deferred until the v2 calculation passes shadow qualification against live traffic, per the project's delivery principles.

### 8.1 Post-review polish (three fresh reviewers, all verdicts OK WITH NOTES, no P0/P1)

Applied after the regression landed and the fleet restart: the dashboard's reassign copy now states the actual cause for the new reason ("previous worker had running work but no usable completion estimate") instead of "previous worker was ineligible" (P1, `ui/routing-observation.js`), and the two labelled stays render their true causes in Current Jobs instead of a generic margin message. The idle-peer search is now documented as pool-scoped (fast-list-bounded, incumbent-order tie-break, measured ranking deferred to the v2 calculation) with a pinned test (`the idle-peer rescue is scoped to the configured pool`).

Accepted limitations, recorded deliberately: no end-to-end pin exists for the move itself — a live `reassigned`/independent job is normally placed onto the idle peer at admission by the ordinary placement path, so a faithful e2e would be contrived; the unit tests pin the rule and the existing `available_capacity_fallback` e2e exercises the reassign commit machinery. Shadow records do not receive `homeIsWarmCache` and can diverge from live decisions in this rule's domain (shadow is passive evidence only). `homeBusy` treats any untimeable home forecast as busy-evidence, so telemetry glitches can produce labelled hops. The shadow and coverage gaps fold into the v2 redesign rather than the current fix.

---

*Background: five agent reports (placement flow, slow-lane root cause, model-swap resilience, config/bit-rot inventory, design stress-test) were produced during this study; their substance is merged above with citations intact.*
