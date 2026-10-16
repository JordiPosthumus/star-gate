# Lane 6 — identity & data continuity (read-only reviewer)
> Lane `identity-review` · read-only reviewer · 2026-10-13/14 · file:line evidence against the working tree at commit 666b827.
> Consolidated synthesis: [../gateway-maintenance-study-2026-10-14.md](../gateway-maintenance-study-2026-10-14.md)

# Part 1 — Main report (root-cause chain, identity map, behavior matrix, findings F1–F11, design D1–D6)

All evidence is gathered and verified. Here is the complete study.

---

# Identity & Data Continuity Study — Star Gateway telemetry stores

**Scope:** read-only. No files were edited, created, or deleted. Git-log verification requires supervisor-run commands (I have no bash tool) — flagged below as *needs verification*.

---

## 1) Verified root-cause chain for the blank FLEET HISTORY rings

Every link verified in source:

1. **The dashboard feeds the ring renderer only the currently-registered worker ids.**
   `dashboard.mjs:540`: `fleet_speed:fleetSpeed.snapshot(Date.now(),gateway?.workers?.map(worker=>worker.id)??[])`.

2. **FleetSpeed turns that roster into an allowlist and drops every interval row whose `node` is not on it.**
   - `fleet-speed.mjs:166`: `const ids=[...new Set(Array.isArray(workers)?workers.filter(value=>ID.test(value)):[])]`
   - `fleet-speed.mjs:169`: `const relevant=this.intervals.filter(row=>!ids.length||ids.includes(row.node));` — a non-empty allowlist removes all rows keyed to former ids.
   - `fleet-speed.mjs:130` (phase aggregation): `…(allowed.size&&!allowed.has(row.node))continue;`
   - `fleet-speed.mjs:148` (energy): `if(row.end<=from||row.start>=now||!allowed.has(row.node))continue;`
   - `fleet-speed.mjs:139`: `mean_tps:active>0?tokens/active:null` → `null` when every remaining row was excluded.

3. **The UI hides the arcs and prints "Awaiting samples".**
   - `ui.js:166`: `ready=speed?.status==='ready'&&…`; `ui.js:169-171`: `valid=Number.isFinite(value)&&…` → `gauge.classList.toggle('has-speed',valid&&value>0)` and `$(`fleet-${kind}-speed`).textContent=valid?fmtWhole(value):'—'`
   - `ui.css:42`: `.fleet-speed-gauge:not(.has-speed) .gauge-value,.fleet-speed-gauge:not(.has-activity) .gauge-activity{visibility:hidden}`
   - `ui.js:178`: `const coverage=observed?`${observed}/${total} profiles sampled`:'Awaiting samples';`

4. **The same filter empties per-card rolling rates.**
   `dashboard.mjs:514`: `rolling_rates:fleetSpeed.workerRates(d.id)` → `fleet-speed.mjs:229-232` (single-node allowlist) → `ui.js:721`: `known=Number.isFinite(value?.mean_tps)` → renders `6h avg — t/s`.

5. **Live proof from the owner's own runtime (hygiene evidence, read-only):**
   - `runtime/dashboard/metrics-2026-10-13.jsonl:14` — rows keyed `"node":"ds41f-ring"` (hardware + engine rows under the old id).
   - `runtime/dashboard/metrics-2026-10-14.jsonl:1-2` — `endpoint_phase` rows keyed `"node":"glm53f-m3"`; hardware rows keyed `"node":"spark4"`, `"node":"spark5"`.
   - `config.local.json` — `nodes` now contains only `glm53f-m3`; `routing_fast_workers` still names `ds41f-ring`/`ds41f-ring2`.
   - `runtime/affinity.json.before-glm-drain-ring1-20261013T152401`, `…before-glm-add-ring1-20261013T163228Z`, `…before-glm-add-ring2-…` — the server change happened 2026-10-13 (drain old ring workers, add new glm workers, context change).
   So: old id `ds41f-ring` → new id `glm53f-m3`; the 10-13 decode/prefill intervals exist on disk but are allowlist-excluded; rings show `—` / "Awaiting samples" until the new id accumulates fresh intervals. One file even mixes three key spaces (`glm53f-m3` worker, `spark4/spark5` physical hosts, old `ds41f-*`).

6. **The load-balancing "measured speed" emptiness is a second, parallel chain.**
   - Restart: `routing-observations.mjs:119,128` — saved samples are loaded then **all** parked: `this.restoredSamples = saved.samples…map(row => ({...row, parked: true}))`; live `this.samples` starts empty. Comment at 126-127: *"Preserve old speed rows without using them. A model name alone does not verify that the engine build/configuration behind an endpoint survived."*
   - Identity change while running: `routing-observations.mjs:255` — `const changed = before && (before.identity !== worker.identity || before.value?.source !== value?.source …)`; lines 264-265 move that worker's samples to `restoredSamples` and delete them from `this.samples`. `routingIdentity` (`routing-observations.mjs:38-40`) hashes `worker.id, url, backend, model, context, capacity, aliases, profile` — so **any** url/model/context/capacity/profile change invalidates the lane's whole evidence base.
   - Estimator match requires exact identity: `routing-estimates.mjs:100` — `sample.workerId === worker.id && sample.identity === worker.identity`. Parked rows are used nowhere (`speedSummary`/`phaseSpeed` read `this.samples` only).
   - UI shows the result: `ui.js:547-548,557-558` — `Speed samples in use 0`, `Parked speed samples N`, and *"No speed sample is in use yet, so completion times stay unknown and no queued request can be moved."*

7. **The exclusion is intentional and test-pinned** (not an accident): `fleet-speed.test.mjs:26` asserts `reader.snapshot(now+HOUR,['spark']).windows['1h'].decode.mean_tps===null` for an interval from another worker; `request-history.test.mjs:126-127` pins `mean_tps:null → '—'` and no `has-speed`. `docs/fleet-throughput.md`: *"Removing a worker removes its energy from current-fleet totals."*

**Verdict:** the starting diagnosis is correct and complete for the rings; the "estimator blind" half is additionally triggered by *any* config change and by *every gateway restart*, not just server changes.

---

## 2) Identity map — what each store is keyed by, where the key comes from, what survives

Key-space abbreviations: **WID** = worker id (operator-chosen at registration, `worker-config.mjs:17`, immutable per `worker-config.mjs:74-75` — there is no rename; a server change is remove + re-add with a new id); **EP** = engine process epoch; **MID** = physical machine name/hostname.

| Store (file) | Record key | Key source | Persisted? | Identity-change behavior |
|---|---|---|---|---|
| FleetSpeed intervals (`fleet-speed.mjs`) | `node` = WID on each row (`dashboard.mjs:386,308-309`) | gateway roster (`/gateway/status` workers) | Yes, daily `metrics-*.jsonl`, 2 files read, 24 h prune (`fleet-speed.mjs:166-167`) | Rows survive on disk but are **excluded** from every aggregate by the allowlist (130, 148, 169) |
| Routing speed samples (`routing-observations.mjs`) | `workerId` + `identity` hash (WID+url+backend+model+context+capacity+aliases+profile, :38-40) + model + phase + concurrency | gateway registration content | Yes, `routing-estimates.json` | On any identity change or engine restart: samples **parked** (128, 255, 264-265); no unpark path exists |
| Routing cache evidence (`routing-observations.mjs:213-218`) | `worker.identity` (config hash) | registration content | No (5-min ephemeral, 8 rows) | Deleted on identity change (`:259-260`) |
| EndpointTelemetry (`endpoint-telemetry.mjs`) | `worker.id`; identity = `[id,url,api_key_file]` (`:7`) | registration | No (in-memory, 15-min `HISTORY_MS`) | `sync()` deletes state/history on key change (`:60-70`); engine `source` switch resets rate history (`:193`) |
| DeviceTelemetry (`telemetry.mjs`) | `worker.id`; engine process = `backend_epoch` (systemd invocation/boot+pid digest, `:8-21`) | journal self-report | No (in-memory) | Epoch change resets phase/series/cache/costs but keeps the device (`observeEpoch`, `:135-152`) — the best pattern in the repo; device deleted when id leaves roster (`dashboard.mjs:398`) |
| HardwareTelemetry (`hardware-telemetry.mjs`) | WID from `config.hardware_telemetry.workers` (config, operator-maintained) | config + roster | Rows persisted with `node`=WID; in-memory series 15 min | Unregistered id without its own ssh: sources closed, `worker_not_registered` (`:187`); new machine unobserved until config gains an entry |
| MonitoringHistory (`monitoring-history.mjs`) | WID + fingerprint hash of `[id,backend,url,api_key_file,ssh,telemetry_service,file]` (`:11-14`) | registration + collector config | Yes, `monitoring-history.json` | Fingerprint mismatch **deletes** activity history, markers, rate history (`:41-44`); restore only on exact match (45-58) — a transport-only change wipes 15-min evidence |
| RatePeaks (`rate-peaks.mjs`) | phase only (global `prefill`/`decode` peaks) | none (derived) | Yes, `rate-peaks.json` | **Immune** to identity change; survives restarts |
| Cache continuity evidence (`cache-continuity-evidence.mjs`, audit `cache-continuity-audit.mjs`) | `node` string (WID); pairs joined by `run_id:request_id`; per-session | journal rows written by gateway (`dataset.mjs:90` — `run_id=randomUUID()` **per process**) | In-memory projection rebuilt from 2 daily files | Worker change: per-worker buckets split (new id starts at 0); pairs abstain `worker_changed` (`audit:53`) and `gateway_run_changed` (`audit:138`); window/gap resets the projection (`request-history.mjs` poll) |
| Cache inventory (`cache-inventory.mjs`) | WID → directory (`cache_directories` config) + installation HMAC key (`runtime/dashboard/cache-inventory.key`) | config | Live scan; refs stable via durable key | Follows the new id only if the owner edits `cache_directories`; otherwise `not_configured`. No history to lose |
| AffinityStore (`gateway.mjs:127+`) | session digest → node id | client conversation header | Yes, `affinity.json` (atomic, locked) | **Graceful**: homes kept on removal (`gateway.mjs:1979-1980`), reassignment on rename; survives restarts |
| Request history (handovers/throughput/generation, `request-history.mjs`, `throughput.mjs`, `generation-evidence.mjs`) | `run_id:request_id`; `node` retained as attribute | gateway process | 2 daily files | Node change: rows keep old id; aggregates are fleet-wide, not per-id; daily-window/file-replacement resets readers |
| Attribution (`attribution.mjs`) | engine `start` rows by `node`+`sample_id`+epoch joined to gateway requests by `request_id`+`node` | journal + gateway log | Emitted rows persisted; joins in-memory (15 min/7-day) | Node mismatch → abstain (`candidateWindows` filters `request.node===start.node`); graceful abstention, no discard |
| Performance lights (`performance-lights.mjs`) | `node` + `backend_epoch` + operator-attested profile digest (`:26-35`) | journal + config `performance_lights.worker_profiles` | 8 daily files (7-day history) | Rename: no baseline for new id → grey `insufficient_matched_history`; engine restart: recent window epoch-filtered → grey until re-qualified |
| Machine/power maps (`fleet-machines.mjs:3-20`, `power-scripts.mjs:20-28`) | **hardcoded WID → machine-group → script tables in source** | source code edits | — | Every server change requires editing source; stale ids accumulate (spark1-4, ds41-*, mimo-m3, qwen-image vs today's `glm53f-m3`, `qwen38-*`) |

---

## 3) Behavior matrix — store × change-event

Events: **(a)** server renamed/re-registered with new id · **(b)** model/profile change on same hardware · **(c)** engine restart, same id · **(d)** machine re-paired/re-enrolled · **(e)** gateway restart · **(f)** worker offline→returns. Legend: ✅ keeps serving evidence · 🅿 parked/quarantined (retained, unused) · ❌ discarded/excluded · ➖ not applicable.

| Store | (a) rename | (b) profile change | (c) engine restart | (d) re-pair | (e) gateway restart | (f) offline→return |
|---|---|---|---|---|---|---|
| FleetSpeed rings/energy | ❌ excluded (130,148,169) — *the reported bug* | ❌ same (id unchanged but intervals are keyed by id, so they survive if id stays; excluded only when id changes) | ✅ epoch reset handled (`fleet-speed.mjs:181-186`) | ❌ if id changed | ✅ files re-read | ✅ gaps >60 s not bridged (`fleet-speed.mjs:109`) |
| Routing speed samples | 🅿 parked (264-265) | 🅿 parked (255: identity hash covers model/context/capacity/profile) | 🅿 parked (255: uptime/metrics_epoch change) | 🅿 if id/url changed | 🅿 **all** samples parked (128) | ✅ retained while identity stable |
| Routing cache/serial state | ❌ deleted (259-260) | ❌ deleted | ❌ deleted | ❌ deleted | ❌ lost (in-memory) | ✅ |
| EndpointTelemetry | ❌ state+15-min history deleted (`:60-70`) | ❌ if url/key changes; ✅ if only model aliases change | ✅ epoch-gated deltas (`:14-15`) | ❌ if url/key changes | ❌ lost | ✅ (≤30 s windows, `:13`) |
| DeviceTelemetry | ❌ device deleted (`dashboard.mjs:398`) | ➖ | ✅ epoch reset of baselines, device kept | ❌ if id changed | ❌ lost | ✅ |
| HardwareTelemetry | ❌ unobserved (`worker_not_registered`, `:187`) | ➖ | ✅ | ❌ until config entry updated | ❌ in-memory series lost | ✅ |
| MonitoringHistory | ❌ deleted (`:41-44`) | ❌ if url/service/file changed | ✅ (phase rows) | ❌ if id changed | ✅ restore if fingerprint matches | ✅ 'unknown' gap rows inserted |
| RatePeaks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cache continuity | ❌/🅿 per-worker bucket split; pairs abstain `worker_changed` (audit:53) | ➖ (profile in candidates) | ✅ | ❌ if id changed | 🅿 pairs abstain `gateway_run_changed` (audit:138) | ✅ |
| Cache inventory | ➖ live scan; ❌ until config re-pointed | ✅ | ✅ | ✅ (durable HMAC key) | ✅ | ✅ |
| AffinityStore | ✅ homes kept, reassigned (`gateway.mjs:1979`) | ✅ | ✅ | ✅ | ✅ durable | ✅ patient wait/reassign |
| Attribution | 🅿 abstains (node mismatch) | ✅ | ✅ epoch recorded | ❌ if id changed | ❌ in-memory window lost; rows persisted | ✅ |
| Performance lights | ❌ grey `insufficient_matched_history` | ❌ profile filter splits cohorts (`:137-139`) | ❌ epoch filter → grey until 3 requests/60 s | ❌ if id changed | ✅ re-reads 8 files | ✅ |
| Machine/power maps | ❌ requires source edit | ➖ | ➖ | ➖ | ✅ | ✅ |

**Quantified damage:** rings blank until a new id accrues intervals (bounded by the 24 h prune and 2-file read window, so up to ~2 days of the owner's real measurements are unreachable per change); estimator evidence resets to zero and needs real traffic to rebuild per-concurrency median windows (10 rows per level, `routing-estimates.mjs:117-119`); per-card 6 h rates show `—`; energy drops to `awaiting_power_data`; 15-minute phase strips for a transport-only change are deleted; performance lights grey out. The only fully immune stores are RatePeaks, AffinityStore, and cache inventory.

---

## 4) Strengths worth keeping

- **backend_epoch is the right primitive and already exists.** `telemetry.mjs:8-21` derives a strong engine-process identity from the systemd invocation id (boot/PID fallback bounded); `DeviceTelemetry.observeEpoch` resets *measurement baselines* while keeping the device's history lanes. This is exactly the "quarantine the measurement, keep the machine" behavior the hardening design should generalize.
- **Fail-closed arithmetic everywhere.** Counter regressions, epoch changes, and outages produce `null`/abstain, never invented numbers (`fleet-speed.mjs:90-96`, `endpoint-telemetry.mjs:14-15`, `attribution.mjs` `result()`).
- **Durable, atomic state writes.** AffinityStore's atomic replace + fsync + lock (`gateway.mjs:127-170`); every save path uses tmp-file + rename; symlink/O_NOFOLLOW discipline is consistent.
- **Honest labeling is already half-built.** The parked counter is surfaced, not hidden (`ui.js:548,558`); "Missing history is excluded, not treated as zero" (`docs/fleet-throughput.md`; `ui.js:183`); zero-vs-missing distinction is test-pinned (`request-history.test.mjs:126-127`).
- **Evidence tiers, not booleans.** `routing-estimates.mjs` observed/seeded/borrowed/unavailable ranking is the vocabulary a migration label should reuse.
- **The safety rationale is real and worth preserving.** `routing-observations.mjs:126-127` and `docs/routing-estimator.md` (*"Verified engine identity is still required before reusing old speed rows"*) guard against cross-engine poisoning; the bug is that **no verification path ever exists**, so quarantine is permanent.

---

## 5) Findings

**F1 — P1 · Continuity/UX · `dashboard.mjs:540` + `fleet-speed.mjs:130,148,169`.**
The fleet-history allowlist converts every worker-id change into total history erasure from the operator's view, while the data remains on disk. Evidence: §1 links 1-5, live `metrics-2026-10-13/14` files. *Smallest fix:* pass a continuity map (old ids with evidence → current id/machine) into `snapshot()` and aggregate per machine identity; at minimum surface `excluded_by_identity` counts and a "history retained under prior identity" state instead of "Awaiting samples".

**F2 — P1 · Continuity/estimator · `routing-observations.mjs:128,255,264-265` + `routing-estimates.mjs:100`.**
Speed evidence is parked on every gateway restart and every identity-hash change, and there is no re-verification handshake that ever re-attaches it — quarantine is a one-way door. The docs explicitly require "verified engine identity" before reuse, but no verification mechanism exists. *Fix:* the handshake in D2 below; until verified keep parked (safety preserved), after verification migrate rows with a `migrated` label and new identity.

**F3 — P1 · Identity design · `routing-observations.mjs:38-40` (`routingIdentity`).**
One hash conflates transport (`url`), credentials-adjacent config (`api_key_file` is in the sibling fingerprints), and serving configuration (`context/capacity/aliases/profile`) with engine identity. A port change or capacity edit on unchanged hardware invalidates all speed evidence; conversely an unchanged hash proves nothing about the engine build (documented gap, `docs/routing-estimator.md`). *Fix:* split into durable machine identity (D1) + configuration fingerprint (advisory, per-change re-verify).

**F4 — P2 · Retention · `fleet-speed.mjs` reader (default `retainedFiles=2`, prune 24 h).**
~45 daily `metrics-*.jsonl` files exist (2026-09-02 → 2026-10-14) but only the newest 2 are read and rows are pruned to 24 h, so deep history is unreachable even without any identity change; this amplifies every blank-out. *Fix:* consider raising `retainedFiles` toward the validated maximum of 8 and/or make the window visible in the tile ("history retained under a changed identity" cannot show what was never kept).

**F5 — P2 · Consistency · `monitoring-history.mjs:11-14,41-44`.**
The restore fingerprint includes `url`, `api_key_file`, `telemetry_service` and the collector file path, so a transport-only change deletes restored 15-minute monitoring evidence even though the worker id and engine are unchanged — an identity change with no identity meaning. *Fix:* key restore on worker id + engine epoch; treat transport fields as advisory.

**F6 — P2 · Overfit · `fleet-machines.mjs:3-20` + `power-scripts.mjs:20-28`.**
Worker-id → machine-group → script tables are hardcoded in source; each server change requires a code edit and stale ids accumulate (spark1-4, ds41-\*, mimo-m3, qwen-image vs today's fleet). This is the clearest code-level confirmation of the owner's "overfit" diagnosis. *Fix:* move to a config/data machine registry (workers bind to machines; scripts hang off machines).

**F7 — P2 · Config drift · `config.local.json` (hardware_telemetry) + `hardware-telemetry.mjs:187`.**
Current config still declares telemetry workers `ds41f-ring`/`ds41f-ring2` that no longer exist (status pinned to `worker_not_registered`) while the actual current worker `glm53f-m3` has no hardware entry; `physicalMachineIds` is empty, so the machine panel has nothing to show. Registration/removal flows do not carry hardware/cache-directory config along. *Fix:* enrollment should create/retire hardware-telemetry and `cache_directories` entries with the worker; add a config lint for orphaned ids.

**F8 — P2 · Process-scoped run identity · `dataset.mjs:75-76` + `cache-continuity-audit.mjs:138`.**
`run_id=randomUUID()` per gateway process makes every restart a new identity for the request journal; the cache-continuity pair audit abstains (`gateway_run_changed`) across restarts, and all readers are bounded to 2 daily files. *Fix:* a durable installation/run-identity chain (e.g., a persisted gateway instance id recorded per row) so restarts are visible but joins can span them where evidence permits.

**F9 — P2 · UX semantics · `ui.js:166-191,178,721` + `ui.css:42`.**
One visual state ("—" + "Awaiting samples") covers three different situations: never-measured, measuring-now, and history-exists-but-excluded-by-identity. The owner cannot distinguish data loss from data hiding. *Fix:* D5 status vocabulary.

**F10 — P2 · Dead weight · `routing-observations.mjs:128,264-265,419-431` (+ observed 1.5 MB `runtime/routing-estimates.json`).**
Parked rows are appended, capped at 4096, and rewritten on every save, but never re-validated, migrated, or expired; they also count toward the 4 MB load limit after which the whole file is abandoned as `storageError` (`:118`) and new evidence stops persisting. *Fix:* handshake-driven migrate-or-expire with a parked-at timestamp.

**F11 — Note · Verification gap (needs verification, supervisor must run).**
I could not run git. To date the allowlist and the parking change and find the motivating incident:
`git log -S "allowed.has(row.node)" -- ds4-gateway/fleet-speed.mjs`;
`git log -S "parked: true" -- ds4-gateway/routing-observations.mjs`;
`git log -S "fleet_speed:fleetSpeed.snapshot" -- ds4-gateway/dashboard.mjs`;
`git diff --no-index runtime/routing-observations.mjs.original-HEAD.bak ds4-gateway/routing-observations.mjs`.
Circumstantial dating from the repo itself: `docs/routing-estimator.md` "Gateway measurements and controls (8 October 2026)" documents the parking rationale; the fleet-speed allowlist behavior is test-pinned in `fleet-speed.test.mjs:26`; the server change itself is visible in `runtime/affinity.json.before-glm-*` (2026-10-13).

---

## 6) Hardening design proposal (no code)

**Goal:** server changes must never again look like data loss, and stale measurements from a genuinely different engine must still never silently poison estimates. Quarantine stays the default; what is added is a *verifiable way out*.

**D1 — Durable machine identity (M, risk low-med).**
Introduce a first-class `machine_id`, minted once per physical machine at first enrollment and stored durably (the recovery-enrollment records already bind ssh + service identity — the same place). Worker id becomes a *label* bound to `(machine_id, engine slot)`; removal/archive keeps the machine record. All metric rows gain an optional `machine_id` alongside `node` (append-only, backward compatible). Mitigation for shared hardware (Spark pairs): machine_id is operator-confirmed at enrollment, consistent with the existing operator-attestation pattern (`performanceProfile`, `server-records`).

**D2 — Re-verification handshake (M, risk med — the safety-critical piece).**
When a new/changed worker identity appears, the gateway checks whether a prior identity maps to the same `machine_id` **and** the engine self-report corroborates continuity (source, model_ids, metrics_epoch/uptime semantics already collected in `endpoint-telemetry.mjs`, `omlxSnapshot` uptime; vLLM build/version where exposed). Three outcomes:
- **verified** → prior rows are re-labeled to the current identity with `evidence: 'migrated'` (a new, lowest-but-nonzero tier in the existing `SPEED_EVIDENCE_RANK`) and re-enter the estimator;
- **unverified** → rows stay quarantined (parked), exactly today's behavior;
- **contradicted** (different engine/source/epoch) → rows are expired with a recorded reason.
Safety guarantee preserved: nothing re-enters any estimator without the verification probe passing; migrated rows are always labeled and rank below fresh observed rows.

**D3 — Explicit continuity/migration record (S-M, risk low).**
One durable receipt per identity-change event: `{at, old_identity, new_identity, machine_id, per-store disposition: carried|quarantined|discarded, verification evidence, actor}` — written by the gateway on registration change, consumed by the dashboard and Genie. This mirrors the existing relocation-receipt pattern (`gateway.mjs:667-668,811-813`) and replaces today's only continuity trail: a pile of hand-made `.bak` files (`affinity.json.before-glm-drain-ring1-20261013T152401`, …).

**D4 — One identity/continuity service (M-L, risk med).**
Test of the owner's belief: **substantially confirmed, with nuance.** There are four different ad-hoc identity derivations today — pure worker id (`FleetSpeed`, `Activity`, `HardwareTelemetry`), transport fingerprint (`EndpointTelemetry` `workerKey`, `MonitoringHistory` `fingerprint`), config-content hash (`routingIdentity`), and process epoch (`backend_epoch`) — plus a per-process `run_id` and hardcoded id tables in source (F6). However, the stores do *not* disagree about semantics; every key in use is derivable from one tuple: `(machine_id, worker_id, config_fingerprint, engine_epoch, run_id)`. A single IdentityService that owns this tuple and exposes `identityFor(worker)` + `continuityFor(old,new)` lets each store subscribe instead of rolling its own hash — F3/F5/F6/F8 collapse into one definition. Incremental adoption: adapter per store, FleetSpeed and RoutingObservations first (they carry the reported damage).

**D5 — UI continuity vocabulary (S, risk low).**
Replace the single "Awaiting samples" state with: *measuring now* (new id accumulating), *history retained under a prior identity — verification pending* (quarantined count shown), *history restored under a changed identity as of \<date\>* (migrated, labeled), *no history*. In the load-balancing panel, split "Parked speed samples" into *quarantined (awaiting verification)* vs *migrated (in use, labeled)*. Keep the zero-vs-missing distinction that is already test-pinned.

**D6 — Retention and explainability (S, risk low).**
Raise `FleetSpeedReader` `retainedFiles` toward the validated 8 and/or extend the 24 h prune deliberately; add `excluded_by_identity: {node, intervals, watts_seconds}` to `snapshot()` so a blank ring is self-explaining ("N intervals excluded — worker id not currently registered; see continuity record").

---

## 7) Open questions

1. Which commit introduced the fleet-speed allowlist and the parking rule, and what incident motivated each — *needs verification* (commands in F11). The owner's `runtime/routing-observations.mjs.original-HEAD.bak` suggests a local modification worth diffing.
2. Was the 2026-10-13 change a rename/re-register (new ids) or also a URL/port change on a kept id? Runtime baks suggest drain-and-re-add; owner confirmation needed.
3. How many parked rows exist right now in `runtime/routing-estimates.json` (~1.5 MB) — *needs verification*: `grep -o '"parked":true' runtime/routing-estimates.json | wc -l`.
4. Does any Genie briefing path consume `fleet_speed` (grep found dashboard-only consumers in `ds4-gateway/*.mjs`; hermes/client not fully audited) — *needs verification*.
5. Whether D1's machine_id can be derived automatically from existing recovery-enrollment bindings for all machine classes (Spark pairs, docker containers, the M3), or must be operator-confirmed everywhere.

---

## Review

- **Correct:** Starting diagnosis verified end-to-end with file:line evidence and live runtime corroboration (metrics files keyed `ds41f-ring` → `glm53f-m3` across the 2026-10-13 change); the deeper disease (four ad-hoc identity schemes, per-process run_id, hardcoded id tables in source, permanent parking) is documented with evidence; safety rationale and existing strengths identified; hardening design keeps quarantine-by-default and adds the missing verification path.
- **Fixed:** none — read-only mandate; no files touched.
- **Finding:** see F1-F11 above (3×P1, 7×P2, 1 note requiring supervisor-run git commands).
- **Merge verdict:** OK (findings-only study; no diff to merge).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only study completed as assigned: verified root-cause chain, identity map across 15 stores, behavior matrix, strengths, 11 findings, hardening proposal with effort/risk, and open questions — no files edited, created, moved, or deleted; no tests or servers run; no state-changing commands."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Every claim cites file:line with a short quote (dashboard.mjs:540; fleet-speed.mjs:130,148,166,169; routing-observations.mjs:126-128,255,264-265; routing-estimates.mjs:100; ui.js:166-178,547-558,721; ui.css:42; monitoring-history.mjs:11-14,41-44; telemetry.mjs:8-21; cache-continuity-audit.mjs:53,138; dataset.mjs:75-76; fleet-machines.mjs:3-20; power-scripts.mjs:20-28), plus live runtime corroboration (runtime/dashboard/metrics-2026-10-13.jsonl vs metrics-2026-10-14.jsonl; runtime/affinity.json.before-glm-* baks; config.local.json roster). Unverified items are explicitly labeled 'needs verification' with the exact supervisor-run commands."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "none (no bash tool available to reviewer; all inspection via read/grep/find/ls)",
      "result": "not-run",
      "summary": "Git history attribution deferred: supervisor should run git log -S for 'allowed.has(row.node)', 'parked: true', 'fleet_speed:fleetSpeed.snapshot' and git diff --no-index against runtime/routing-observations.mjs.original-HEAD.bak"
    }
  ],
  "validationOutput": [
    "Starting diagnosis verified: dashboard.mjs:540 allowlist -> fleet-speed.mjs:130/148/169 row exclusion -> mean_tps:null -> ui.js:169-171 has-speed false -> ui.css:42 arcs hidden -> ui.js:178 'Awaiting samples'.",
    "Live corroboration: 2026-10-13 metric rows keyed node:ds41f-ring; 2026-10-14 rows keyed node:glm53f-m3 and hardware nodes spark4/spark5; config.local.json nodes=[glm53f-m3]; affinity baks dated 2026-10-13 (drain/add glm ring workers).",
    "Estimator blindness verified: routing-observations.mjs:128 (restart parks all samples), :255/:264-265 (identity change parks), routing-estimates.mjs:100 (exact identity match required), no unpark path exists.",
    "Exclusion behavior is intentional and test-pinned: fleet-speed.test.mjs:26, request-history.test.mjs:126-127, docs/fleet-throughput.md."
  ],
  "residualRisks": [
    "Git-commit dating of the allowlist/parking changes is unverified (no bash tool); circumstantial dating only (docs/routing-estimator.md 2026-10-08, fleet-speed.test.mjs pin).",
    "Exact count of parked rows in runtime/routing-estimates.json (~1.5MB single line) not enumerated.",
    "Genie/hermes consumers of fleet_speed outside ds4-gateway/*.mjs not exhaustively audited."
  ],
  "noStagedFiles": true,
  "diffSummary": "No diff — findings-only read-only study per the absolute read-only authority boundary.",
  "reviewFindings": [
    "P1: dashboard.mjs:540 + fleet-speed.mjs:130,148,169 — worker-id change erases all fleet-history rings/energy from view while data remains on disk; surface excluded_by_identity and machine-keyed aggregation.",
    "P1: routing-observations.mjs:128,255,264-265 — speed evidence parked permanently on restart/identity change with no re-verification handshake; add verified migration path.",
    "P1: routing-observations.mjs:38-40 — routingIdentity conflates transport/config with engine identity; split machine identity from config fingerprint.",
    "P2: fleet-speed.mjs reader (2 files, 24h prune), monitoring-history.mjs:11-14 (transport fields in restore fingerprint), fleet-machines.mjs:3-20 + power-scripts.mjs:20-28 (hardcoded worker-id tables), config.local.json hardware_telemetry drift, dataset.mjs:75-76 per-process run_id, ui.js:166-191 ambiguous blank states, parked-row dead weight in routing-estimates.json.",
    "no blockers beyond the findings listed (study-only deliverable)"
  ],
  "manualNotes": "Reviewer had no bash tool; all git commands listed in the report must be run by the supervisor. Repo-local scratch/progress files were not created per the review-only mandate."
}
```

---

# Part 2 — Addendum after owner steering (supersedes Part 1's F1/F2 remedies and design D2/D5)

Steering incorporated. I re-verified every new citation against source before folding it in, and found one more corroborating artifact: `docs/reports/load-balancing-study-2026-10-13.md` (dated the day of the server change) already documents the same disease and the owner's direction. Below is the **addendum that supersedes the affected parts of my earlier report** (identity map, behavior matrix, F3–F11 stand unchanged; F1/F2 remedies and the hardening design are revised).

---

# Addendum — Carry-forward with dating/flagging + demote-and-reverify (owner-steered working hypothesis)

## 0) Steering position, restated as the design contract

The system already defines defaults for unknowns (`phaseSpeed` seeded/borrowed tiers with the approved 0.9-per-level guess, `routing-estimates.mjs:87-110`; `inputEstimate` cold assumption, `routing-estimates.mjs:196-206`; labelled `estimated` progress bases, `routing-observations.mjs:236-242`). When a server change is *detected*, the failure today is that the system discards the one quantity it has better than any guess — its own dated measurements — instead of demoting them. **Carry-forward with dating/flagging + demote-and-reverify is the working hypothesis.** The current design is evaluated only as a set of constraints to satisfy:

- **C1 (no silent poisoning):** a stale number must never be *silently presented as current* — everywhere it is used it must be dated and evidence-labeled.
- **C2 (no blindness):** a detected identity change must never reduce the system to zero evidence when a dated prior exists.

The parking design violates C2 outright and only partially serves C1 (parked rows are *counted* in the UI, `ui.js:548,558`, but their content is unexaminable and unrecoverable). The carry-forward design satisfies both by construction: the date + label is the safety mechanism.

## 1) New evidence verified before folding in

- `routing-observations.mjs:25-27` — `routingIdentity = hash({worker: node.id, url: node.url, backend: node.backend, model, context…, capacity…, aliases…, profile})`. Any config tweak mints a fresh identity with zero history. This is the overfit the owner names. ✔
- `routing-observations.mjs:264-265` — on identity change, that worker's live samples are moved to `restoredSamples` and removed from `this.samples`. ✔
- `routing-observations.mjs:236-242` — the evidence-label machinery exists and is load-bearing: `job.routingProgressBasis={…, evidence: measured ? 'observed' : 'estimated'}`. A dated stale prior slots into this exact machinery. ✔
- Parking has **no promotion path**: `restoredSamples` is written only at restore-time (`:128`) and change-time (`:264`), counted at `:132`, and rewritten at `save()` (`:419-421`). Nothing ever unparks. ✔
- **Corroborating prior study** (`docs/reports/load-balancing-study-2026-10-13.md`, same day as the server change):
  - §2: on model swap the identity flips, samples park, rows go dormant; what keeps working is *borrowed cross-model donor speeds* and the *fleet-wide output fit which "is not keyed by model and survives"* — i.e., carry-forward is already the codebase norm for the least dangerous quantity.
  - §2/§8.4: *"no arrival is promised: a lane that never serves qualifying traffic never re-measures (observed on the GLM rings)"* — direct, observed evidence that blindness duration is traffic-dependent and unbounded on a quiet fleet.
  - :61: the inverse risk is real too — *"In-place engine upgrade behind an unchanged endpoint keeps stale speed rows — identity does not cover engine build"* — which carry-forward must answer via demote-and-reverify, not via deletion.
  - §4-C (recommended Design C): per-worker state is *"what was measured, refreshed continuously, forgotten when stale"* — consistent with the owner's steer.

## 2) Quantified cost comparison: stale-but-dated prior vs guaranteed blindness

**Cost of a stale-but-dated prior (bounded, self-correcting):**

| Property | Value | Evidence |
|---|---|---|
| Where it acts | Only queued-head move decisions, margin-gated: move only if predicted saving > 30 s default | `gateway.mjs:396` (`routingSwitchingMarginSeconds??30`); `docs/reports/load-balancing-study-2026-10-13.md` §2 (routing-plan.mjs:146) |
| Worst single-move cost | Per-request prediction error on one request; margin filters near-ties, so gross misranks need error > margin — bounded by one request's excess service time, not compounding (ownership commits are per-request, never chained) | `gateway.mjs:662,810` (per-request commit) |
| Displacement half-life | Estimator medians are last-10 per (lane, phase, concurrency) (`routing-estimates.mjs:117-119`): 10 fresh valid samples fully displace the prior; vLLM emits an engineAggregate row per completed request while running ≥ 1 (`routing-observations.mjs:299-306`); oMLX per ≤5 s stable poll (`:316-341`) | minutes-to-hours under normal traffic |
| Symmetry | All lanes keep priors → comparisons stay **symmetric**. The Oct-11 episode that crowned the slow lane (43 ring2→M3 relocations, study §3.2) was caused by *asymmetric* evidence (one lane timed, others not) — carry-forward removes exactly that failure mode | study §3.2 |
| Relevance vs today's cold path | A dated **own-machine** prior is strictly more relevant than today's cold-path substitute: cross-model **donor** rates from other machines scaled by the 0.9^k guess (`routing-estimates.mjs:87-110`) | study §2 ("scoreable via borrowed donor speeds, cross-model donors allowed") |
| Display | Rings/energy/rates show dated priors immediately; label carries the date | §4 below |

**Cost of blindness (guaranteed, unbounded on a quiet fleet):**

| Property | Value | Evidence |
|---|---|---|
| Routing | `speedSamples=0` → no timed comparisons → moves only via the untimed `available_capacity_fallback`; goal 2 ("never place work on the slowest lane when a faster lane can take it") fails silently for the entire re-warm window; shadow reports `insufficient_evidence` | `ui.js:547-558`; study §2 |
| Re-warm time | Needs first valid sample per (lane, phase, concurrency); *"no arrival is promised"* — **observed**: the GLM rings acquired no own speed rows during monitoring; median quality needs ~10 samples. On a quiet home fleet this is **days**, worst case unbounded | study §2, §8.4 |
| Fleet-history rings | Old id's intervals permanently excluded (`fleet-speed.mjs:130,148,169`); new id must re-accumulate within the 24 h-pruned, 2-file read window — blank for ≥ hours, typically a day+, and the old history never returns | §1 of main report |
| Energy panel | `awaiting_power_data` until the new id has 80 % power coverage per worker | `fleet-speed.mjs:148-158` |
| Operator trust | Already realized: the owner classifies the blanking as a major bug | task context |

**Net:** the dated prior converts a *guaranteed, unbounded* evidence outage into a *bounded, self-correcting* accuracy discount whose worst case is a few margin-gated, dated, labeled placements.

## 3) Carry-forward vs the narrow hard-reset set

**Carry forward (dated + flagged, displaced by fresh samples):**

| Quantity | Why safe to carry | Mechanism |
|---|---|---|
| Phase rates, per-concurrency rows | Materialized aggregates, not raw counters; errors bounded and displaced via last-10 medians | re-label rows `migrated_from`, `recorded_at`; map to a new evidence rank **between** `borrowed` (1) and `seeded` (2) in `SPEED_EVIDENCE_RANK` (`routing-estimates.mjs:130-131`) — a dated own-machine prior outranks a cross-model donor guess, undercuts fresh observations; no new arithmetic path (`phaseSpeed`/`basisSpeed` unchanged) |
| Concurrency-scaling knowledge | The current cold path already *guesses* scaling (0.9^k); a dated measured row beats the guess | same as above |
| Energy / power per machine | Power is a **machine** property, not an engine property; scope/sensor guards stay (`gpu_only` exclusion, 60 s gap rule) | key energy by `machine_id`; dated carry-forward; gaps still never bridged (`fleet-speed.mjs:109`) |
| Output-length fit | Already identity-free and survives swaps today — carry-forward is the status quo here; add dating metadata only | `routing-estimates.mjs:13-27`; study §2 confirms survival |
| Fleet-history display + p95 calibration | Display-only consumers only (verified: `fleet_speed` is consumed solely by `dashboard.mjs:540,514` → UI; nothing in routing reads it) | show dated prior windows; label "under prior identity, ended \<date\>" |
| Rolling 6 h card rates | Same | `fleet-speed.mjs:229-232` keyed by machine instead of id |
| Cache-continuity token accounting | Usage sums are accounting, not cache-state claims | `cache-continuity-evidence.mjs` `usageSummary` keyed by machine |
| Rate peaks | Already global | unchanged |
| Operator-attested execution capacity | Machine-level attestation; detected capacity already overrides when fresh | today it parks-with-flag (`manual_stale`, `gateway.mjs:584-590`); change to carry-with-flag: dated "unverified since \<date\>" instead of null |

**Narrow hard-reset set — and the remedy is verify-on-use, not deletion:**

| Quantity | Why not carried as current | Remedy |
|---|---|---|
| Warm-cache / KV-residency claims (routing cache evidence `this.cache.get(worker.identity)`; `homeIsWarmCache` stay reasons; disk-KV `snapshot_refs`; `restorationSeconds`) | A claim about *physical cache state*, invalidated by any engine restart/move; acting on it unverified wastes the margin or keeps work on a cold lane | **Verify-on-use**: keep the claim dated; make it load-bearing only with the existing qualification gates — `inputEstimate` already requires `evidence==='observed'&&qualified===true` for observed reuse and otherwise assumes labelled `cold` (`routing-estimates.mjs:196-206`). Extend that gate to carried claims: "claimed warm as of \<date\>, unverified → treated cold until one verified hit" |
| Raw cumulative counters across an engine restart | Arithmetic correctness, not identity: deltas across a counter reset are invalid | keep existing counter-domain resets (`FleetSpeed` `resetNode` on `process_start`, `endpoint-telemetry.mjs:14-15` epoch gating, `DeviceTelemetry.observeEpoch`) — these reset *window arithmetic*, never delete stored materialized rates |
| Serial idle-to-idle correlation state (vLLM) | Per-process-lifecycle measurement scaffolding | reset on any change (already does, `routing-observations.mjs:259-261`) |
| Dispatch-time progress bases | Per-request lifecycle; expire naturally | unchanged (`:236-242`) |
| Estimator rows whose engine **source/epoch contradicts** the current engine (in-place engine swap behind unchanged endpoint) | The study's :61 counter-risk — the strongest legitimate safety concern | demote to `superseded_engine` (retained, dated, display-only) until fresh samples re-qualify; never silently current — satisfies C1 while avoiding C2 violation |

So: **deletion disappears from the design entirely.** The only two states a quantity can enter on a detected change are *carried (dated, flagged)* or *quarantined-until-verified-on-use* (cache claims) — and contradiction demotes further rather than deleting.

## 4) The convention already exists in this codebase — blanking the rings has zero safety benefit

- **Fleet cards keep the last measurement, clearly dated, explicitly not current:** `ui.js:807-810` — `` `${staleMetric?'Last':'Latest'} measurement: ${age(m?.time,now)}. Values are engine observations, not a promise of current speed.` `` with a `metric-stale` treatment; `ui.js:870` adds "· stale" to mini-charts.
- **Hardware readings keep last samples with a stale class and age stamp:** `ui.js:109-114`.
- **Machine-heat judgments demote stale data instead of deleting it:** `ui.js:146-147` — "The newest sample is \<age\>; **not used for a heat judgement**."
- **Rolling rates show the average with an explicit trend/insufficiency label** rather than hiding history: `ui.js:721-726`.
- **The rings themselves are display-only** (no routing, admission or energy-policy consumer — verified by grep), so under even the strongest reading of C1 there is nothing to protect by blanking them. The consistent application of the codebase's own convention to `renderFleetSpeed` is: show the last window, dated "under prior identity", with the same `metric-stale` language — not `—`/"Awaiting samples" (`ui.js:166-178`, `ui.css:42`).

## 5) Revised hardening design (supersedes D2/D5; D1, D3, D4, D6 stand with edits)

**D2′ — Carry-forward with dating/flagging + demote-and-reverify (M, risk low-med — now the working hypothesis).**
On any detected identity change (new worker id, url/config tweak, or re-registration):
1. Rows are re-labeled, never dropped: `{…, machine_id, recorded_at, migrated_from: old_identity, evidence_tier: 'migrated'}`.
2. Estimator rank: `observed(3) > seeded(2) > migrated(~1.5) > borrowed(1) > unavailable(0)` — a dated own-machine prior displaces the cross-model donor guess; fresh samples displace the prior mechanically through the existing last-10 medians (`routing-estimates.mjs:117-119`). The evidence label propagates through the existing machinery (`evidence: 'observed'|'estimated'`, `routing-observations.mjs:236-242`; `speedEvidence` in decision rows, `ui.js:596`).
3. Reverify: first engine-identity corroboration (source + model_ids + epoch continuity + readiness probe) promotes fresh rows; the migrated tier ages out naturally (median windows) and can also be expired by `recorded_at` staleness.
4. Contradiction (engine source/epoch change on the same machine): demote to `superseded_engine` — retained, dated, display-only; excluded from the estimator until re-qualified. Answers the study's :61 in-place-upgrade risk without deletion.
5. Cache-state claims: quarantine → **verify-on-use** per §3 (claimed-warm-until-verified uses the existing `qualified`/`cold`-assumption gates).
6. Constraints satisfied: C1 — every carried number is dated, labeled, and ranked below fresh evidence; C2 — no detected change ever empties the evidence base.

**D5′ — UI vocabulary (S, risk low).** Ring/panel states become: *measuring now* · *carried forward under prior identity, dated \<age\>* (with the `metric-stale` convention from `ui.js:807-810`) · *re-verified as of \<date\>* · *superseded engine, retained for display* · *no history*. The load-balancing panel's "Parked speed samples" becomes "Carried forward (in use, dated)" / "Superseded (display-only)" / "Verify-on-use (cache claims)".

**D1/D3/D4/D6 amendments:** D1's `machine_id` is the join key that makes carry-forward precise (rows follow the *machine*, which is what the owner means by "that machine"). D3's continuity record now records `disposition: carried|verify-on-use|superseded` per store — it becomes the audit trail for every carry-forward decision. D4's IdentityService exposes the same tuple; D6's `excluded_by_identity` becomes `carried_under_prior_identity` counts.

## 6) Revised findings

- **F1 (P1, revised remedy):** the allowlist (`dashboard.mjs:540` + `fleet-speed.mjs:130,148,169`) must aggregate by machine identity with dated carry-forward instead of excluding; zero safety benefit is lost because the tiles are display-only (§4). Original remedy (mapping/exclusion counts) is absorbed into D2′/D5′.
- **F2 (P1, revised remedy):** parking (`routing-observations.mjs:128,264-265`) is replaced by re-labeling into the `migrated` tier with the D2′ rank; the no-promotion-path defect disappears because promotion is the default under fresh evidence, not a special handshake.
- **F3 (P1, unchanged in substance):** `routingIdentity`'s config-tuple hash (`:25-27`) remains the overfit root; under carry-forward its blast radius drops from "identity erased" to "evidence demoted and dated", but the split of machine identity from config fingerprint (D1/D4) is still required so *which* rows carry forward is decided by machine, not by config hash.
- F4–F11 unchanged, with F7 strengthened by the study's §6 bit-rot inventory (stale `config.nodes`, orphaned `model_routes`/`serving_profiles`, undocumented `routing_fast_workers` naming two drained lanes).

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Owner steering incorporated as the working hypothesis: carry-forward with dating/flagging + demote-and-reverify replaces the prior handshake proposal (D2′/D5′); stale-vs-blind cost quantified from code + the repo's own 2026-10-13 load-balancing study; narrow verify-on-use reset set (cache/KV claims, counter-domain arithmetic) separated from carry-forward quantities; current design re-evaluated strictly as constraints C1/C2, not defended; zero-safety-benefit finding for ring blanking stated with the codebase's own dated-stale convention as proof."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "All new citations verified in source before incorporation: routing-observations.mjs:25-27 (identity tuple hash), :128/:264-265 (park, no promotion path — all restoredSamples write sites enumerated), :236-242 (evidence:'observed'|'estimated' machinery); displacement math grounded in routing-estimates.mjs:117-119 (last-10 medians) and :130-131 (evidence ranks); margin grounded in gateway.mjs:396; blindness duration grounded in docs/reports/load-balancing-study-2026-10-13.md §2/§8.4 ('no arrival is promised... observed on the GLM rings'); display-only status of fleet_speed verified by grep (dashboard.mjs:540,514 are the only consumers); dated-stale convention verified at ui.js:807-810,870,146-147,721-726; manual-capacity park-with-flag precedent at gateway.mjs:584-590; identity-free output fit at routing-estimates.mjs:13-27."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "none (read-only reviewer; no bash tool; verification via read/grep/find/ls)",
      "result": "not-run",
      "summary": "Prior addendum's git-history commands for the supervisor remain outstanding (see F11 of the main report)"
    }
  ],
  "validationOutput": [
    "Cost comparison: stale prior = margin-gated, per-request-bounded, fully displaced after 10 fresh samples per (lane,phase,concurrency) via last-10 medians; blindness = guaranteed zero timed moves + observed unbounded re-warm on a quiet fleet (GLM rings acquired no own speed rows) + permanently excluded fleet history under the 24h/2-file reader window.",
    "Carry-forward set: phase rates, concurrency rows, energy/power, output fit (already identity-free today), fleet-history display, rolling rates, cache token accounting, rate peaks, operator-attested execution capacity (upgrade park-with-flag to carry-with-flag).",
    "Hard-reset set reduced to: cache/KV residency claims (verify-on-use via existing qualified/cold gates, routing-estimates.mjs:196-206), raw-counter window arithmetic across engine restarts (resetNode/epochUnchanged/observeEpoch — arithmetic, not identity), serial correlation state, dispatch bases (expire naturally), and estimator rows contradicted by engine source/epoch (demote to superseded_engine, retained and dated).",
    "Convention proof that blanking rings has zero safety benefit: ui.js:807-810 'Last measurement: <age>. Values are engine observations, not a promise of current speed.'; ui.js:146-147 stale data demoted, not deleted ('not used for a heat judgement'); fleet_speed consumed only by display paths."
  ],
  "residualRisks": [
    "D2′ migrated-tier rank insertion (~1.5) changes SPEED_EVIDENCE_RANK semantics and needs test updates plus shadow qualification consistent with the repo's delivery principles (studies defer cutover until shadow-qualified).",
    "Carry-forward widens the in-place-engine-upgrade stale-row window (study :61); mitigated by superseded_engine demotion on source/epoch contradiction, but engine-build identity remains self-reported — operator-visible dating is the compensating control.",
    "Git-commit dating of the parking/allowlist introduction still unverified (no bash tool); supervisor-run commands listed in main-report F11."
  ],
  "noStagedFiles": true,
  "diffSummary": "No diff — read-only addendum superseding the earlier report's D2/D5 and F1/F2 remedies per owner steering; all other sections (identity map, behavior matrix, F3-F11) stand.",
  "reviewFindings": [
    "P1 (revised): dashboard.mjs:540 + fleet-speed.mjs:130,148,169 — replace roster allowlist with machine-keyed, dated carry-forward aggregation; blanking is display-only damage with zero safety benefit.",
    "P1 (revised): routing-observations.mjs:128,255,264-265 — replace permanent parking with re-labeled migrated tier (rank between borrowed and seeded), fresh-sample displacement, and superseded_engine demotion on contradiction.",
    "P1 (unchanged substance): routing-observations.mjs:25-27 — config-tuple identity hash remains the overfit root; machine-identity split (D1/D4) decides which rows carry forward.",
    "no blockers beyond the revised findings (study-only deliverable)"
  ],
  "manualNotes": "Steering integrated without restarting the task, per instruction. New corroborating artifact found and folded in: docs/reports/load-balancing-study-2026-10-13.md (same-day prior study; its §2/§8.4 no-arrival-promised finding is the empirical basis for the days-long blindness estimate, and its :61 in-place-upgrade note is the strongest constraint the carry-forward design must answer — answered via superseded_engine demotion, not deletion)."
}
```
