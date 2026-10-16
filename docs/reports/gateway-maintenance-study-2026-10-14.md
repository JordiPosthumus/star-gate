# Gateway maintenance study — Star Gate (DSG)

**Date:** 2026-10-14 · **Tree studied:** `666b827` ("Stop a missing forecast from holding independent work on a busy lane")
**Method:** six independent read-only reviewer agents (53–84 min each; ~7 h combined study), one per seam, each producing file:line-cited findings. The supervisor spot-verified the highest-impact claims against source and ran the git archaeology the agents could not. Owner steering on identity/continuity was incorporated mid-study and is reflected in the design below. **No repository file outside this report and `gateway-study-2026-10-14/` was touched.**

**Lane reports (full detail, every claim with evidence):**

| Lane | File | Focus |
|---|---|---|
| 1 | [`gateway-study-2026-10-14/lane-1-hotpath.md`](gateway-study-2026-10-14/lane-1-hotpath.md) | Request hot path, streaming, `gateway.mjs` core |
| 2 | [`gateway-study-2026-10-14/lane-2-load-balancing.md`](gateway-study-2026-10-14/lane-2-load-balancing.md) | Routing, scheduling, estimator, shadow |
| 3 | [`gateway-study-2026-10-14/lane-3-fleet-telemetry-recovery.md`](gateway-study-2026-10-14/lane-3-fleet-telemetry-recovery.md) | Telemetry, health, recovery state machines |
| 4 | [`gateway-study-2026-10-14/lane-4-supporting-subsystems.md`](gateway-study-2026-10-14/lane-4-supporting-subsystems.md) | Dashboard, media, spark, hygiene |
| 5 | [`gateway-study-2026-10-14/lane-5-architecture.md`](gateway-study-2026-10-14/lane-5-architecture.md) | Cross-cutting architecture, CI, repo |
| 6 | [`gateway-study-2026-10-14/lane-6-identity-continuity.md`](gateway-study-2026-10-14/lane-6-identity-continuity.md) | Identity & data continuity (owner-triggered) |

---

## Executive summary

The architecture is sound and the engineering culture is unusually strong: a zero-dependency core, a 3,334-line adversarial test rig for the gateway, atomic-fsync durability discipline, honest-unknown telemetry, and comments that explain *why*. The weaknesses are not rot — they are **three systemic patterns**:

1. **Evidence is destroyed instead of demoted when server identity changes.** Your rings bug is the visible tip: a worker-id allowlist (`dashboard.mjs:540` → `fleet-speed.mjs:130,148,169`) plus a config-tuple identity hash (`routing-observations.mjs:25-27`) convert *any* server change into total history erasure and estimator blindness, with no path back. The study formalizes your steer into a carry-forward design with **no deletion at all** (§T1).
2. **The dashboard's 2-second poll triggers an estimator storm.** Five independently-discovered legs multiply into O(nodes²)-plus work per poll on the hottest read path (§T2).
3. **The fracture pattern: the same small things are implemented 3–17 times.** SSH helpers, control routes, proxy plumbing, sampling guards, finish-reason whitelists, runner receipts — each copy drifts independently (§T4). Plus one crash-class bug in the hot path and a CI that is currently red (§T3, §T7).

**The five things to do first** (all S-effort, low risk): fix CI's phantom `memory:test` script; wire the 5 orphaned test files; guard the `stopReasoningLoop` write-after-end; clamp the `concurrency=0` estimator abort; and decide the two policy questions in §Decisions.

---

## Strengths worth protecting

These came up independently in multiple lanes and are the reason this codebase is worth factoring *carefully* rather than rewriting:

- **Zero-dependency core** with pinned Node ≥22.22.2 and a CI matrix to match — rare discipline at this size (lane 5).
- **The test suite is adversarial, not decorative.** `gateway.test.mjs` asserts security boundaries ("DSG ingress credentials never cross the unauthenticated stock-DS4 boundary"), byte preservation, no-replay; `dashboard.test.mjs` evaluates the browser bundle in a VM and verifies every `src/href` is served (lanes 1, 4, 5).
- **Forecast/dispatch parity is provable.** The time-router forecasts with the *same* `queueChoice` the dispatcher uses, including the subtle exhausted-turn reset — traced line-by-line and test-pinned (lane 2).
- **Correct conditional estimator math.** `remainingOutputTokens` computes E[min(L,limit)−generated | L>generated] in log space, regression-tested against independent Python `erfc` values (lane 2).
- **Failure attribution is rigorous.** Engine vs transport vs ambiguous quarantine arbitration (`gateway.mjs:57-63`, `:1171-1182`) is a genuinely hard problem solved with clear reasoning and three-sided tests (lane 1).
- **Durability discipline:** atomic temp+rename+fsync (incl. directory fsync), persist-before-relocation with rollback ("Persist first. A failed write cannot strand the client between queues."), PID+process-start state locks, corrupt-history preserved without overwrite (lanes 1, 2, 5).
- **Fail-closed telemetry arithmetic:** counter regressions and epoch changes produce `null`/abstain, never invented numbers; energy extrapolated only at ≥80 % coverage; duplicate samples rejected by content hash (lanes 2, 3, 6).
- **Recovery never replays uncertain commands:** durable state write *before* command issue; lost ack → reconcile-by-observation (lane 3).
- **Security hygiene is consistent:** timing-safe CSRF, cursor validated by regex before shell use (with an injection test), `O_NOFOLLOW`/FIFO rejection, 0600 config, `esc()`/`textContent` everywhere in the UI (lane 4).
- **Anti-fabrication posture:** unknown stays unknown; surplus engine work never becomes free capacity; the 0.9-per-level guess is always outranked by measurement — evidence *tiers*, not booleans (lanes 2, 6).
- **`upstream-agent.mjs` documents measured production invariants** (engine idle-close ≈4 s; "no 'timeout' listener on pooled upstream requests") — module-level documentation of the rarest kind (lane 1).

---

## T1 — Identity & data continuity: the rings disease *(owner-triggered; lane 6)*

**Verified root-cause chain for the blank FLEET HISTORY rings** (live-corroborated against your own `runtime/` files from the 2026-10-13 `ds41f-ring` → `glm53f-m3` drain-and-re-add):

1. `dashboard.mjs:540` — `fleetSpeed.snapshot(Date.now(), gateway?.workers?.map(w=>w.id) ?? [])` — only *currently registered* ids are passed.
2. `fleet-speed.mjs:130,148,169` — every stored interval keyed to another `node` is skipped: history keyed to the old id still **exists on disk** but is invisible.
3. `mean_tps` → `null` → `ui.js:170` never sets `has-speed` → `ui.css:42` hides the arcs → "Awaiting samples".
4. Same fracture in the estimator: `routing-observations.mjs:128` parks *all* restored samples on gateway restart; `:255,:264-265` park live samples on any identity change; `routing-estimates.mjs:100` requires exact identity match; **nothing ever unparks**.
5. The behavior is intentional and test-pinned (`fleet-speed.test.mjs:26`) — a design decision, not an accident.

**The overfit, quantified.** Four ad-hoc identity schemes coexist: bare worker id (FleetSpeed, Activity, HardwareTelemetry), transport fingerprint (`EndpointTelemetry.workerKey`, `MonitoringHistory` fingerprint — a URL/key change deletes restored 15-min evidence), config-content hash (`routingIdentity` hashes id+url+backend+model+context+capacity+aliases+profile — *any* tweak mints a stranger), and process epoch (per-process `run_id`; cache-continuity pairs abstain across every restart). Plus **hardcoded worker→machine→script tables in source** (`fleet-machines.mjs:3-20`, `power-scripts.mjs:20-28`, still naming retired machines), and current config drift: hardware telemetry declared for `ds41f-ring`/`ds41f-ring2` (pinned `worker_not_registered`) while the real machine has no entry — the machine panel has nothing to show.

**Damage matrix (store × change-event):** rings blank up to ~2 days (only the newest 2 metric files are read; 24 h prune — while ~45 days exist on disk); estimator evidence resets to zero and needs ~10 fresh rows per lane×phase×concurrency ("no arrival is promised" on a quiet fleet — observed on the GLM rings); monitoring strips deleted on transport-only changes; performance lights grey out. Fully immune: exactly three stores (RatePeaks, AffinityStore, cache inventory).

**The design that won (owner-steered, formalized):** *carry-forward with dating/flagging + demote-and-reverify.* Deletion disappears entirely. On any detected change every quantity enters one of two states:

- **Carried forward** — re-labeled `migrated_from`/`recorded_at`, ranked in the existing evidence machinery as **observed(3) > seeded(2) > migrated(~1.5) > borrowed(1)**: your own machine's dated prior beats a cross-model donor guess and loses to fresh samples, which displace it mechanically through the existing last-10 medians. Applies to: phase rates, concurrency scaling, energy (key by machine — power is a machine property), output-length fit (already identity-free), fleet-history display, rolling rates, operator-attested capacity (currently parked `manual_stale` → carry-with-flag).
- **Verify-on-use** — warm-cache/KV-residency claims only (claims about *physical* state): kept dated, load-bearing only after one verified hit via the existing `qualified`/cold-assumption gates (`routing-estimates.mjs:196-206`). Verify, don't delete.
- **Contradicted** (engine source/epoch changed under the same name — the one real risk the old design guarded) — demoted to display-only `superseded_engine`, never silently current.

Cost symmetry (from lane 6, §2): a stale-but-dated prior costs at most one margin-gated suboptimal move, self-correcting within the first fresh samples; blindness costs *guaranteed* zero-evidence routing for days. The constraints it preserves: **C1** a stale number is never silently presented as current (date + label is the safety mechanism); **C2** a detected change never empties the evidence base. Blanking the rings has zero safety benefit even under the strongest reading — they are display-only (verified by grep), and the codebase already keeps dated-stale display in five other places (`ui.js:807-810` "Last measurement … not a promise of current speed", machine-heat, hardware, rolling rates).

**Enabling work:** `machine_id` minted at enrollment as the join key (D1); a re-verification handshake (engine self-report: source + model_ids + epoch/uptime already collected) that *promotes* instead of parks (D2′); one durable continuity receipt per change event `{at, old, new, machine, per-store disposition}` — replacing today's only continuity trail, the pile of hand-made `.bak` files (D3); one IdentityService owning the `(machine_id, worker_id, config_fingerprint, engine_epoch, run_id)` tuple so stores subscribe instead of rolling their own (D4 — the stores don't disagree about semantics, they just each re-derive keys); UI vocabulary *measuring now / carried forward under prior identity (dated) / re-verified as of X / superseded (display) / no history* (D5′); raise `retainedFiles` toward the validated 8 and expose `excluded_by_identity` counts (D6).

**Archaeology (supervisor-run):** the id-allowlist shipped with the feature's founding commit `a41a3a6` ("Add calibrated fleet speed and energy pulse"); parking came with `ed4b086`. `runtime/routing-estimates.json` currently holds 4,096 active samples and **0** parked rows on disk.

Related findings from other lanes that belong to this theme: unbounded `AffinityStore.sessions` with no eviction and O(N) `count()` in the placement comparator (`gateway.mjs:170,853` — hotpath #3 / lb #10); roster-flap deletion of restored monitoring history (`monitoring-history.mjs:40-43` — fleet #8); "couldn't inspect" mislabeled as "identity changed" in recovery refusals (`recovery.mjs:373-374` — fleet #7); parked rows re-serialized on every save and counted toward the 4 MB file-abandonment limit (`routing-observations.mjs:419-431` — lb #4 / identity F10).

## T2 — The estimator storm: poll-driven recomputation *(efficiency; lanes 1, 2, 3, 5)*

The dashboard polls every 2 s (`dashboard.mjs:555`). Independently, four lanes found the cost stack on that path:

| Leg | Cost | Source |
|---|---|---|
| `stats()` re-evaluates the router up to **3× per call** | `relocationOffers()` + `genieRelocationOffers()` (calls `timeRoutingOffers()` again) + `relocationDiagnostics()` = up to **96 full route comparisons** per poll, each rebuilding worker snapshots and re-running `completionEstimate` per worker — re-deciding what the 1 s tick just decided | lb #3, arch #5 (`gateway.mjs:550,683-696,744-746,777-779`) |
| `registry()` calls full `stats()` **once per worker** | O(nodes²) on `GET /workers` | arch #5 (`gateway.mjs:1714-1715`) |
| `store.count()` is O(all sessions) inside the placement sort comparator | per admission + per poll, growing forever (see T1) | hotpath #3, lb #10 (`gateway.mjs:139,853`) |
| The same metric files are **JSON-parsed twice every 2 s** | `FleetSpeedReader` (2 files) and `PerformanceReader` (8 files) keep independent cursors over shared `metrics-*.jsonl` (up to 4 MiB each) | fleet #1 (`dashboard.mjs:454,551`) |
| `RoutingObservations.save()` re-serializes up to 4,096 samples + parked rows **on every request finish and every engine poll batch, even with nothing new** | ~1 MB stringify+write+fsync per 2 s poll on a busy lane | lb #4 (`routing-observations.mjs:645-659,385,446`) |

Plus per-evaluation costs inside the storm: `request()` scans ≤8 cached rows × up to 512 message-hash comparisons per queued/running job per candidate (lb #9); every request body is buffered and JSON-parsed up to twice, vision a third time up to 64 MiB (hotpath #4); `performance-lights` rescans all intervals per snapshot (fleet #10, magnitude unmeasured).

**Remedy shape:** memoize `stats()` for ~250-500 ms or per state-revision; compute offers/diagnostics once per call; one shared metric-file line-pump fanning parsed rows to both accumulators; dirty-flag persistence; one parse of the request body shared by preview/thinking/routing; per-node count cache.

## T3 — Correctness bugs

Ordered by severity; all verified against source (the first two also supervisor-verified):

| # | Sev | Bug | Where | Fix shape |
|---|---|---|---|---|
| 1 | **HIGH** | `stopReasoningLoop` ends `res` mid-pipe; the listener attached *before* `up.pipe(res)` writes the in-flight chunk after `end()`; **no `res.on('error')` anywhere in the inference path** → uncaught `ERR_STREAM_WRITE_AFTER_END` (process death) or protocol corruption after `[DONE]`. The changelog shows this crash family killed the gateway once before; this is the one late write not among those guards. Existing test only regex-matches the marker | `gateway.mjs:1187-1237` | detach before end (`up.unpipe(res)` / stopped-flag single guarded write path); add `res.on('error')`; strengthen the loop test to assert `body.endsWith('data: [DONE]\n\n')` |
| 2 | MED | `/v1/models` probe attaches a 5 s `timeout` listener to a **pooled** keep-alive request — violating `upstream-agent`'s documented invariant; the returned socket can expire after the engine's ~4 s close floor → ECONNRESET on the next reused socket. The adjacent health probe correctly uses `agent:false`; this one doesn't | `gateway.mjs:1546-1552` | use `agent:false` like the health probe |
| 3 | MED | `concurrency = worker.native?.running ?? worker.running.length` passes `0` (not nullish) into `phaseSpeed`, which **throws**; the blanket catch aborts the *entire* `evaluate()` for all workers that tick | `routing-observations.mjs:491` + `routing-estimates.mjs:134-135` | `Math.max(1, …)` or prefer gateway count when native gauge reads 0 |
| 4 | MED | `engineRowOrdering`'s id-match branch requires `row.model === active.model`, but **running jobs never carry `.model`** (verified: job literal `gateway.mjs:1585`) → the "marks are never lent" guarantee can silently not hold; one request double-counted, another dropped | `routing-observations.mjs:93` | compute direct correlations first, pass pre-taken indices in |
| 5 | MED | One unreadable saved power receipt **crashes dashboard startup** (`JSON.parse` throw in `createFleetPowerService`, unguarded; save has no fsync unlike `server-operations`) → launchd KeepAlive crash loop | `fleet-power-service.mjs:37-41,59-62` | per-file try/catch + `'unreadable'` index entry; fsync on publish |
| 6 | MED | 6 h trend **silently disabled until day rotation** after any *validity* exclusion — one routine engine restart (counter reset) pins `trend:'insufficient'` for up to 24 h with complete readable history | `fleet-speed.mjs:226,232` vs `:52,56,59` | gate on unreadable signals (malformed/evicted/rescans); needs owner sign-off — see Decisions |
| 7 | LOW | `admit()` throws inside a `setInterval` callback and upstream handlers (invariant break = gateway death, not one 503) | `gateway.mjs:908` | guarded reject + cleanup, mirroring `:912-916` |
| 8 | LOW | Superseded attempt's handlers destroy `res` unconditionally — a late event can kill a vision-retry's live response | `gateway.mjs:1269-1271` | `if(!settled)res.destroy()` / `removeAllListeners()` |
| 9 | LOW | Client cancels counted as worker `failed` in Fleet headline (dataset already separates them) | `gateway.mjs:1153` | separate counter or relabel |
| 10 | LOW | Recovery `request()` mislabels failed inspection as identity change in refusal reasons | `recovery.mjs:373-374` | `if(observed.error)throw 'service_inspection_failed'` |
| 11 | LOW | Unknown genie capability keys **silently dropped** — a typo falls back to its default (often `true`) | `fleet-feature-config.mjs:5-6` | reject or log unknown keys |
| 12 | LOW | CI invokes `npm run memory:test`, which does not exist → CI red at that step (supervisor-verified) | `.github/workflows/test.yml:27` | delete the line |
| 13 | LOW | Redundant `Buffer.from` copy of every JSON chunk on the hot path; dead `state.settled` condition in the exact-length rewrite; undocumented **256 MiB default rewrite buffer** per in-flight aliased upload | `json-usage.mjs:17`, `gateway.mjs:1436-1440,498` | as listed; document or lower the buffer |
| 14 | LOW | Sequential recovery sweeps: a few powered-off Sparks (45 s × 5 SSH targets) delay recovery visibility for reachable machines behind them | `recovery.mjs:497-500` | bounded-concurrency `inspect()` (read-only, results evaluated serially) |

## T4 — Duplication & drift: the fracture pattern

The systemic weakness behind your "too fractured" observation — the same small thing implemented N times, each copy drifting:

- `quote()` re-implemented in **7 modules**; SSH option arrays copy-pasted in ~15 `.mjs` + ~10 `.py` (subsystems #1) → one `ssh-remote.mjs`.
- Control-route allowlist hand-synced in **3 places** (`gateway.mjs:2052`, `worker-client.mjs:2`, `dashboard.mjs:536-540`) — a route added to the core but missed in the client *silently breaks a dashboard action* (arch #7) → one `CONTROL_ROUTES` table (name, method, timeout, mutating?).
- Hop-header stripping + JSON responders duplicated between `gateway.mjs:87-97` and `door.mjs:15-19`; two divergent unix-socket clients (`door-client` no timeout/cap vs `worker-client` 30/90 s + 1 MiB) (arch #8) → `proxy-http.mjs` + one `control-client.mjs`.
- `RoutingObservations`' four sampling paths re-implement overlapping guard chains with drifting thresholds (freshness ≤5 s vs ≤15 s vs ≤5 s; `running>=1` in three spellings; the `slice(-4096);save();` tail five times) — the accretion seam of the LB stack (lb #6) → one interval-validator + one sample-store owner.
- Finish-reason whitelists diverge between fit and observer (`end_turn`/`tool_use` unreachable from recorded rows; censoring only implicit) (lb #8) → shared `MEASURED/CENSORED_FINISH_REASONS`.
- Attribution evidence allowlists duplicated **verbatim** between `attribution-audit.mjs:14-16` and `attribution-summary.mjs:5-13` — which already imports from it (subsystems #2).
- The safety-critical pair-lifecycle Phase-1 stop-check exists **3 different ways** (plan-driven vs two hardcoded container tables, one with an extra grep) (subsystems #3).
- Recovery guard skeleton duplicated between plain and oMLX executors with subtly different orderings (fleet #11) → shared guard-sequence helper (L, do with characterization tests).
- Four "runner" scripts re-implement atomic-receipt conventions (mode-0600, tmp+rename) (arch #12) → `runner-kit.mjs`.
- UI: 15 s freshness inlined **13×** across 3 files (a named constant already exists, unused); native-busy predicate ×4; `$()` ×5 (subsystems #6-8) → `ui/freshness.js` + `ui/dom-helpers.js`.

## T5 — Structure & layering

- **`gateway.mjs` (2,266 lines) is a module-graph hub.** Unit tests for `AffinityStore` and `UsageObserver` import the entire 57-module graph (`state-lock.test.mjs:6`, `json-usage.test.mjs:27`). First extractions (low risk, both test-covered): `state-store.mjs` (AffinityStore + lock identity) and `usage-observer.mjs`; then the ~500-line dispatch pipeline (`dispatch.mjs`, M-L); then the ~40-route control-socket chain + worker mutators (~400 lines) behind a route table (arch #6, hotpath proposals 2/5).
- **`ui/ui.js` (1,563 lines)** spans fleet/workers/media/continuity/records/power/polling; split by view after the shared-helper extractions (subsystems #6).
- **Proposed target layering** (lane 5): L0 pure utils → L1 config/stores (+ new `state-store`) → L2 transport/clients (merged `control-client`) → L3 domain families (`recovery-*`, `media-*`, `spark-*`, `routing-*`, `fleet-*`) → L4 slim servers (`gateway.mjs` = HTTP + scheduler + route table; `door.mjs`; `dashboard.mjs`) → L5 CLI/lifecycle. Deliberately deferred: the dispatch/rewrite/vision pipeline split (highest value, L effort, high risk — after the route table lands, leaning on the existing rewrite-path regression tests).
- `queue-choice.mjs` — the single chooser both dispatcher and forecast rely on — has **no direct unit test**; its subtle exhausted-turn/grace/release semantics are exactly what a dispatcher change could silently break (lb #11).

## T6 — Security & policy observations

- **Legacy Genie flexible fast-path is reachable by any bearer-authenticated client**: `x-dsg-observer: gate-genie` + `x-dsg-review-flexible: 1` (no session key) yields immediate placement via `freeGenieNode`, bypassing queue placement — the prior audit's blocker B5, retained and *tested as an entry path* (`gateway.test.mjs:2846-2849`). Queue-jumping among authorized clients only — but it contradicts the audit verdict on record (lb #5). **Decision needed.**
- Live config uses `api_key: "none"` with `host: 0.0.0.0` — documented home-LAN posture, but combined with root-level config backups carrying credential paths, the local blast radius of a stray read is larger than it looks (arch open question 5).
- Config-object mutation as an implicit cross-module registry (`config.genie_chat.inspection` written by `spark-inspection.mjs:4`, read by `media-setup`/`operation-service`) — deliberate, documented, but ownerless (subsystems #12).

## T7 — CI truthfulness, tests & repo hygiene

- CI is red-or-ignored: phantom `memory:test` script (verified). **Five core test files are wired into nothing** (supervisor-verified): `generation-health`, `reasoning-loop`, `state-lock`, `upstream-agent`, `fleet-catalogue` — quarantine, loop-kill and state-locking regressions ship with green CI. `rate-peaks.test.mjs` runs only as a side-effect import (arch #1-2).
- Remedy: fix the workflow line; switch to discovery-based test running with an "every `*.test.mjs` is wired" guard in `scripts/check.mjs`; add a link-existence check for docs (arch proposals 1/5; subsystems Q3/Q4 agree).
- Backup accumulation is partly **code-generated**: ten mutation sites in `gateway.mjs` copy the whole store to unretained `.bak` (e.g. `:1727`) → 200+ files in `runtime/`, ~100 `genie-*-backup-*` dirs, **source-code snapshots** rotting in `runtime/`, 22 root config backups. Remedy: `AffinityStore.backupBefore(kind)` with per-kind retention + `scripts/prune-runtime.mjs` (dry-run default) + `backups/config-local/` convention (arch #3).
- README advertises removed Genie surfaces (4 broken doc links; `genie:demo` doesn't exist; setup banner contradicts ~40 body lines) (arch #4). **Decision needed.**
- Portability: hardcoded `/bin/ps` in stale-lock recovery (`gateway.mjs:90-96`) — fails exactly when recovery matters; verify on a Linux distro before changing (arch #10).

---

## Decisions needed from the owner

1. **Legacy Genie flexible path (T6/lb #5):** gate `trafficClass`/`genieFlexible` promotion on `isGenieRequest` and retire the legacy headers — or document them as trusted-local legacy and mark audit B5 "accepted deviation."
2. **Trend gating (T3 #6/fleet #3):** should validity rejections (counter resets, replays) keep disabling the 6 h trend until day rotation? The test pins the malformed case; validity≠unreadable is the lane's argument.
3. **Genie docs (T7/arch #4):** rewrite README/docs for the gateway-only build, or restore the removed features the body still describes?
4. **`media-pair-direct.mjs` / `film-runner.mjs`:** maintained tools (→ consolidate the Phase-1 stop-check) or frozen protocol records (→ header-mark archival)?
5. **Lint gate:** `npm run check` is syntax-only by design — if the house style stays hand-rolled, the duplication findings (T4) have no mechanical enforcement; a minimal reuse-guard (e.g. forbid re-defining `quote(`) is cheap middle ground.

## Roadmap

**Phase 0 — stop the bleeding (S each, low risk):**
1. CI: fix `memory:test`; wire the 5 orphaned tests; add the wiring guard (T7).
2. Hot path: guard the write-after-end; `agent:false` for the models probe; `res.on('error')` defense (T3 #1-2).
3. Estimator: clamp `concurrency`; pass pre-correlated rows (T3 #3-4).
4. Fleet: per-file tolerance + fsync for power receipts (T3 #5).
5. Decide items 1-5 above.

**Phase 1 — carry-forward hardening (the rings fix; M each, low-med risk):**
6. `machine_id` + re-verification handshake + `migrated` evidence tier (D1/D2′) — FleetSpeed and RoutingObservations first.
7. UI continuity vocabulary + `excluded_by_identity` + retainedFiles 2→8 (D5′/D6).
8. Continuity receipt per change event (D3); config lint for orphaned ids (F7); machine registry out of source (F6).
9. Session-store hygiene: count cache + bounded/LRU sessions (T1/hotpath #3).

**Phase 2 — efficiency & structure:**
10. Kill the stats()/registry() storm: single computation + memoize per tick (T2); shared metric-file pump; dirty-flag persistence (T2).
11. One parse per request body (T2); concurrent recovery sweeps (T3 #14).
12. Extract `state-store.mjs` + `usage-observer.mjs`; `CONTROL_ROUTES` table + merged control client (T5).
13. Consolidate the duplication set (T4) — `ssh-remote.mjs`, sampling-guard owner, finish-reason constants, attribution allowlists, `runner-kit.mjs`, UI helpers.
14. Characterization tests for `queue-choice`, then the `RoutingObservations` per-source-sampler refactor (lb proposals 4/…); later, the dispatch-pipeline extraction from `gateway.mjs`.

**Guiding principle for sequencing:** behavior-freezing tests first, then the identity seam (it changes user-visible semantics and deserves its own receipt), then efficiency, then structure. The existing test suite is the safety net that makes this order viable.

---

## Verification status

- **Supervisor-verified against source:** T3 #1 (job literal has no `.model`; allowlist; `stats()` double-offers), T3 #12-13 (CI script, orphaned tests, test-file existence), T1 root-cause chain incl. live runtime corroboration and git archaeology (`a41a3a6`, `ed4b086`, 4,096/0 samples).
- **Agent-verified, not re-run:** everything else, each with file:line quotes in the lane reports.
- **Open verifications flagged by lanes:** Node-version behavior of the write-after-end (one-line strengthened test settles it); oMLX `total` field presence for row-sum invariance; `/bin/ps` on target Linux distros; CJK bytes/4 prefill estimate mismatch on real traffic; performance-lights snapshot cost magnitude.
