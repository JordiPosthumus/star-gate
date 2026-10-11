# Staged time-based routing

This isolated staged copy contains calculation, passive observation and active placement. Both new modes are off by default. `routing_time_observe: true` enables passive estimates under the existing placement policy; `routing_time_enabled: true` enables the new compare-and-commit path in the staged gateway. No production configuration, source, model server or service was changed by this work. Real-engine qualification and installation remain outstanding.

The policy remains `T_other + margin < T_current`, with a default margin of 30 seconds. Exactly 30 seconds of predicted saving stays. New work without a home chooses the earliest estimated completion among eligible workers. Eligibility comes from DSG's existing rules; this module does not reinterpret models or thinking settings.

## Files and responsibilities

- `routing-estimates.mjs`: shared output-length fit, bounded conditional remaining length, attributed speed rows and borrowed seeds, cache-adjusted service estimates, and request-level remaining work.
- `routing-plan.mjs`: waiting-time calculation, comparison and decision evidence. `planArrivals` is an offline sequential reservation preview; it updates a copy before evaluating the next arrival.
- `queue-choice.mjs`: shared priority, continuation-turn and grace-expiry selection for the dispatcher and forecast.
- `routing-observations.mjs`: bounded numeric history, attributable measurements, labelled cache/progress estimates and decision evidence.
- `gateway.mjs`: eligibility, durable ownership, atomic booking and forwarding; the UI exposes margin, execution capacity and actual versus hypothetical decisions.
- Unit tests exercise arithmetic; gateway tests use temporary state and fake localhost services, without model inference or production contact.

Run from the staged repository:

```sh
node --test ds4-gateway/routing-estimates.test.mjs ds4-gateway/routing-plan.test.mjs ds4-gateway/job-priority.test.mjs ds4-gateway/routing-shadow.test.mjs
```

## Input contract

Every time is seconds from the same snapshot instant. A worker has an explicit `capacity`, current `running` requests with estimated `remainingSeconds`, and a `queue`. No missing capacity defaults to one or four. Running requests may carry a conversation `key`. Cross-worker running conversations can be represented by `sessionReadySeconds`. Unknown remaining work produces unavailable timing, not a free slot.

Queued jobs retain their original `id`, `sequence`, `priority`, `geniePriority` and conversation `key`. The calculation uses existing priority ranking and preserves same-session order. A blocked conversation does not prevent independent work on a free slot. Cancelled queued jobs and the candidate's own old booking are excluded. Slots use the agreed earliest-eligible booking arithmetic. Service rates use already-running or forecast-booked work overlapping the candidate's start plus the candidate itself; later hypothetical arrivals do not retrospectively slow earlier bookings.

The caller supplies eligibility for each request and worker through a synchronous, read-only `eligibility(job, worker)` function returning `{eligible, reason}`. Alternatively, a single-request snapshot may carry explicit worker eligibility. This must include existing compatibility, ownership, ordering, maintenance and capability protections. The offline batch helper evaluates the callback again for each arrival. It is not a replacement for the gateway's durable ownership commit or cancellation handling.

Conversation-turn reservations are normalized by slot identity, use count, conversation key and grace deadline. Forecast and real dispatch use the same queue chooser, including priority override and exhausted-turn behavior. An invalid reservation yields unavailable timing. Running slot identity is retained. Cross-worker queued conversation conflicts remain part of caller eligibility.

## Measurements and small internal defaults

The shared output fit uses the latest 256 request outcomes, with at least five positive natural-completion lengths. Maximum-likelihood mean and population variance of log length give the two parameters. Tool-call stops and Genie traffic are included. The input `outputTokens` is already reasoning-inclusive: subcounts must not be added again. Limit stops, cancelled/failed requests, missing usage and zero lengths are excluded from the fit. Their original records belong to the caller's history and are not altered. Excluding censored results is a starting approximation that can bias the fit shorter.

New requests and running requests use the same fit. The output ceiling is applied inside the expectation:

```text
E[min(L, limit) - generated | L > generated]
```

An empty fit or a degenerate fit exceeded by an ongoing request can use an explicitly supplied, shared `fallbackTokens` estimate of remaining work. No arbitrary fleet output length is silently invented. If no fallback exists, timing is unavailable. Missing generated-token progress is not converted to zero. In normal finite cases the calculation uses a closed form; log-space normal survival avoids far-tail underflow. Regression values come from an independent Python `math.erfc` calculation.

Each speed observation identifies worker, model, configuration `identity`, request, phase, executing concurrency, token count and processing seconds. Only request-scoped, wait-excluded, constant-concurrency observations contribute to a row. The last ten valid observations supply its median. Aggregate engine throughput cannot become a request's speed. Callers provide samples in chronological order and must not append the same observation repeatedly.

An unmeasured row uses the worker's smallest measured concurrency as its reference, scaled by `0.9^(target-reference)`. A new worker borrows the mean of other workers' solo-rate estimates, preferring the same model. If a donor has only a loaded observation, it is normalized back to a solo estimate before applying the target penalty once. These are labelled seeded or borrowed, not observed. With no usable speeds anywhere, keep serving through the caller's existing fallback order; never estimate zero-second processing. Identity must change with relevant engine/model/configuration changes. The observer persists numeric history. Its identity hash covers gateway-visible worker, endpoint, model, profile, context and capacity configuration. It does not verify engine build or native configuration changes behind an unchanged endpoint. Saved speed rows therefore remain preserved but dormant across observer restarts; fresh request measurements rebuild current rows. Verified engine identity is still required before reusing old speed rows.

Input length is measured or estimated by the caller. Cache input names `reusableTokens`, an identity and evidence status. An observed cache answer additionally requires `qualified: true`; stored-block inventory alone is not qualification. Missing, unqualified or mismatched evidence uses a labelled cold-cost assumption, not a measured zero-hit claim. Adapter freshness and prompt/native resume parity remain adapter responsibilities. This module does not query engines or implement a cache tracker.

Remaining prefill subtracts request-level computed uncached tokens once. Running decode uses its individual generated count and the shared conditional length fit. Missing or inconsistent phase/progress produces unavailable timing. The integrator may supply explicitly estimated progress; this slice does not fabricate progress from aggregate counters, characters or SSE chunks. Use actual execution cache counts for running requests where available. An existing applicable restoration timing can be added for a new request; ongoing prefill/decode does not charge completed restoration again.

### In-flight progress and untracked engine work

A running request is timed from, in order of preference: its own fresh engine activity row, then the **dispatch basis** recorded on the job at admission. The basis is a labelled estimate (input tokens, phase speeds, and the concurrency it was dispatched at) that every request records, so an in-flight request always has something to measure from.

#### Engines that name their own requests

A vLLM-family engine publishes its per-request rows under the gateway's own request id, so a row and a request can be correlated exactly. **oMLX — the M3 lane — names every request itself**, and those ids have nothing to do with the gateway's. An id-keyed sampler therefore discarded every row that lane produced: its real measurements were displayed on the dashboard and thrown away before they reached the estimator, so the lane contributed no speed and could not be timed while busy — precisely when placement is being decided.

Such a lane is now a first-class source on its own terms:

- **Speed.** Each row carries its own token count and elapsed seconds, so it is a measurement with no gateway request to point at. Rows whose id *is* a known gateway job id stay on the exact time-delta path and ids are deduped within a poll, so nothing is counted twice. A row is accepted only when its own numbers are positive and, where the engine publishes its own rate, that rate corroborates the arithmetic. An engine that publishes no rate (oMLX reports `0.0` for prefill) is trusted on the arithmetic alone.
- **In-flight timing.** Rows are matched to the lane's running requests as a set. Requests already correlated by id are marked taken first and are never lent a row, so a borrowed row cannot displace a real correlation. Rows are lent only when both sides agree on the count; otherwise the lane abstains. The pairing is deliberately *not* treated as meaningful, because it does not need to be: a lane's estimate is the **sum of its per-slot remaining times**, and that sum is invariant under permuting which same-model request holds which row — new work is booked into whichever slot frees first, not into a named one. The pairing therefore cannot change the lane's estimate; it only stops the lane reading `running_progress_unavailable` for its whole in-flight window.

Two conditions previously suppressed the basis and left a lane unscoreable:

- **A present-but-stale row.** The basis step originally required `!row`, so any row at all — including one from a previous poll — blocked it. vLLM lanes publish no per-request activity rows whatsoever, so those lanes could never be timed, and an omlx lane could not be timed between polls. The fallback now applies whenever this request has no *fresh row of its own*.
- **Engine work the gateway cannot name.** When the engine briefly reports more running requests than the gateway tracks (a normal lifecycle race), the surplus is no longer recorded as a `null` remaining time. It is estimated from the lane's own fastest observed decode rate against the fitted remaining output, and labelled `estimated`.

Both only affect comparison; neither changes admissions or moves a dispatched request. A lane with genuinely no basis, no row and no rate still abstains rather than inventing progress. Surplus entries are capped at the lane's capacity, because the planner refuses to time a lane whose running count exceeds its capacity.

## Placement and continuity

The result retains compared times, components, evidence labels, margin and reason. Unknown home timing stays on that eligible home. If no candidate has timing, a new request preserves the supplied incumbent order. An ineligible home permits eligibility recovery without claiming a measured speed saving. Dispatched and cancelled requests cannot move.

Arrival, queued-body completion, waiting ticks and pre-dispatch checks use one synchronous compare-and-commit path. It rechecks current eligibility and reservations, saves durable ownership, then transfers the existing booking, socket, body and deadline. There is no network await in that transaction. Later arrivals see the booking immediately. Active automatic and Genie/operator handovers revalidate this same decision; the old wait-threshold rule cannot bypass it. Already dispatched streams stay where they are.

Failed ownership persistence restores the previous saved state before continuing at the old worker. This includes an injected failure after rename. If that restoration also fails, the gateway enters drain mode and blocks the affected job from dispatch until state is recovered. Existing running streams continue. Cancellation and completion retain the original release path.

A waiting tick considers one eligible independent queue head per worker, up to 32. Every job also receives its own arrival/body-ready/pre-dispatch check. Phase-rate lookup is memoized only inside one synchronous comparison. No background optimizer or recursive slowdown of existing jobs is added.

Production installation, activation and rollback requiring process replacement must use the existing Door hold and full admitted-work drain, including queued work. A failed startup is recovered under the same retained hold; release it only after verifying the restored core. None of those production operations was performed by this staged work.

Before installation, qualify real per-request prediction quality, prompt/cache parity, actual cold-to-warm reuse and engine identity on the installed builds. Synthetic tests prove exercised bookkeeping and arithmetic, not fleet performance.

Source plan and audit: `stargate-routing-plan-audit-20261008T164905Z` in the shared SparkSetup workspace. The staging parent contains the timestamped baseline archive and per-file hashes.


## Gateway measurements and controls (8 October 2026)

The staged observer calculates estimates at admission, queued-body availability, waiting ticks and immediately before dispatch. Passive mode cannot mutate affinity, queues, streams or worker selection. Active mode applies eligible decisions through the gateway commit described above. It records natural-completion usage for the shared output model and samples identifiable native request progress. Calculations and storage errors remain outside the forwarding outcome. Corrupt saved history is preserved without overwrite, with an error in gateway status.

Request metadata uses the existing bounded read-ahead facility: at most 8 MiB per inspected body and 64 MiB shared. These are observation budgets, not upload/context limits; larger bodies continue unchanged. Text input tokens are explicitly estimated from serialized input/tools bytes divided by four. Multimodal input remains unavailable. Active admission allows one event-loop turn for already-arriving body bytes, without a timed upload wait. Slow, oversized or unsupported bodies can still dispatch without complete metadata; estimates then remain unavailable. Exact effective rendering, defaults and backend prompt parity are not qualified here.

Ephemeral cache history holds the last eight completed message-fingerprint sequences per worker identity for five minutes. Matching templates/prefixes supply **estimated** reuse only. Only numeric output/speed observations persist; messages, prompt hashes and output text do not. No cache probe, KV operation or inference is performed by the observer. Real cold-to-warm cache validation remains outstanding.

The oMLX activity adapter retains bounded request IDs, model IDs, phases and progress counters. Speed learning requires fresh consecutive samples with the same known gateway requests, constant executing count, no native queue, no intervening gateway dispatch/completion and unchanged native completion count. Samples measure per-request counter deltas over the polling interval. Aggregate throughput is never treated as one request's speed. Phase transitions and too-short requests produce no speed sample. Reconnection, observed source/configuration changes or counter/uptime resets retire current rows from use. When native progress is missing, a request with usable metadata and rates can use explicitly estimated elapsed-time progress from a basis captured once at dispatch (or when its body finishes observation). That basis is not slowed again by later hypothetical arrivals and never becomes a measured speed sample. Missing usable input/rates still yields unavailable remaining-time estimates.

TensorFold's fresh reported maximum stream count is engine execution capacity. Where undetected, the UI accepts an explicit manual execution limit, saved against the gateway-visible worker identity with a stale-edit guard and timestamped backup. The detected value takes precedence. This control records the engine's capacity; it does not configure the engine. Gateway admission capacity stays separate. Active dispatch uses the smaller configured admission and known execution limits; already-running jobs continue even if the limit is lowered. An unknown execution limit preserves the existing admission limit with an unverified label. Model/configuration identity changes invalidate a saved manual declaration; the UI flags it as stale.

The UI exposes a persisted switching margin, initially 30 seconds, in Manage servers → Advanced controls. Save uses a compare-against-current guard and timestamped state backup. It does not activate routing. Current Jobs distinguishes passive “would move” estimates from active assigned/moved/stayed receipts. Later stay comparisons do not overwrite a prior actual move receipt. Running and waiting engine counts are distinct from gateway active/queued counts.

The core observer polls existing read-only endpoint status every two seconds when enabled. The dashboard reuses fresh core snapshots and skips duplicate polls; after a six-second gap it resumes its standalone collector. Endpoint replacements invalidate the shared snapshot. Native request IDs are excluded from general dashboard/status telemetry. This sharing is covered with synthetic tests; real-fleet polling overhead has not been measured and no production polling was enabled by this work.

Validation uses temporary state, fake localhost backends and synthetic native telemetry. Active tests also cover close arrivals, partially occupied destinations, reservation parity, old-rule bypass prevention, manual capacity across restart, original oversized bytes, and ownership-write rollback before and after rename. It covers unchanged forwarding, oversized queued bodies, cancellation, persistence, corrupt storage, stale edits, individual concurrent speed samples, unknown native waiting work and capacity disagreement. This is not a measurement of real-fleet prediction quality. See the staging parent's integration logs and manifest for exact results.
