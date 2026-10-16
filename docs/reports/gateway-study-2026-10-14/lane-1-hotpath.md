> Lane `hotpath-review` · read-only reviewer · 2026-10-13/14 · file:line evidence against the working tree at commit 666b827.
> Consolidated synthesis: [../gateway-maintenance-study-2026-10-14.md](../gateway-maintenance-study-2026-10-14.md)

All assigned files have been read end-to-end, cross-referenced against the four docs, tests, and the changelog. Here is the review.

---

## Review — Request hot path of the Star Gate gateway core

### 1) System understanding

The Door (`door.mjs`) is a byte-transparent front proxy: it authenticates, classifies (inference/model_discovery/status/other), optionally holds new requests during core changes (with 102-Processing heartbeats), and pipes raw bytes to the core — it never parses bodies or replays. The core (`gateway.mjs`) authenticates again, allowlists only 5 routes, hashes session headers into a durable `AffinityStore` (atomic replace + fsync + stale-lock takeover), and admits each POST as a `job` with a priority, monotonic sequence and chained queue deadline. `pumpWaiting` (1s tick + event-driven) places jobs at their durable home or picks a worker via `placementChoice`; `schedule` books jobs into per-worker slots honoring conversation-turn allocations (`queue-choice.mjs`); `dispatch` strips DSG/auth headers, applies model-alias/profile rewrites (byte-scanner with exact Content-Length when possible), and pipes the body through observers (`RequestedThinkingObserver`, vision capture) to the engine. Responses stream through `UsageObserver`/`JsonUsageObserver`/`GenerationFaultObserver`; `finish()` maps outcomes to quarantine counters (engine vs transport evidence arbitrated by ssh state), records dataset evidence, releases the slot/turns, and re-pumps. Vision protection can buffer a 400, prove JPEG/GIF/image-limit rejections, repair once on the same server, or emit a synthetic guidance turn.

### 2) Strengths

- **Failure attribution is unusually rigorous.** `ENGINE_FAILURE_OUTCOMES`/`AMBIGUOUS_FAILURE_OUTCOMES`/`TRANSPORT_DEAD_STATES` (gateway.mjs:57-63) plus the tunnel-state arbitration in `finish()` (gateway.mjs:1171-1182) is a genuinely hard problem solved with clear reasoning, and tests cover all three sides (gateway.test.mjs:1136,1155,1165).
- **`upstream-agent.mjs` documents measured production invariants** (engine idle-close ~4s, agent `timeout` hoisting, "no 'timeout' listener on pooled upstream requests") — rare, excellent module-level documentation.
- **UsageObserver's strict terminal contract** (single-choice finish, CR/CRLF split handling, bounded 1MiB lines, ambiguity retained rather than invented — gateway.mjs:229-338) is exactly the right shape for "never claim completion from partial evidence", and tests hammer chunk-boundary framing.
- **Relocation persists before mutating queues** with full-state rollback on fsync failure (gateway.mjs:752-761) — matches `docs/queued-handover.md`'s commit contract precisely.
- **`request-auth.mjs`** compares the full `Bearer <key>` string timing-safely and trusts only the TCP peer, never forwarded headers.
- **The model-alias byte scanner** (model-alias.mjs) avoids re-serializing uploads and the exact-length rewrite exists for a real, documented engine defect (CHANGELOG 2026-10-05).
- Test coverage for this class of system (SSE framing, quarantine, relocation, door forwarding, byte preservation) is far above average.

### 3) Findings

1. **HIGH — bug — `gateway.mjs:1187-1201`, `:1227-1237`, `:1334-1346` — `stopReasoningLoop` ends `res` mid-pipe; the attached pipe immediately writes the in-flight chunk.**
   Evidence: `forwardResponse` attaches the manual listener *before* piping — `up.on('data',chunk=>acceptResponseChunk(up,chunk,isSSE)); … up.pipe(res);` — and `acceptResponseChunk` calls `stopReasoningLoop` mid-stream (`gateway.mjs:1235`), which synchronously does `res.write('data: [DONE]\n\n'); res.end();` (`:1195-1197`). The pipe's `ondata` for the *same* chunk then calls `dest.write(chunk)` after `end()`. There is **no `res.on('error', …)` anywhere in the inference path** (verified by grep: only `res.once('drain')`, `res.once('close')`, `res.on('close', cancel)` exist). Depending on the Node version's `ServerResponse.write`-after-`end` behavior, this either emits `ERR_STREAM_WRITE_AFTER_END` on `res` with no listener (uncaught exception → process crash) or appends bytes after the chunked terminator (protocol corruption after `[DONE]`). The changelog proves this crash class already killed the gateway once (CHANGELOG.md:30-35, "uncaught ERR_HTTP_HEADERS_SENT killed the process… guards every late response write") — the reasoning-loop stop is the one late write *not* among those guards. Needs verification of the exact observable: the existing test (`gateway.test.mjs:401-443`) only regex-matches the stop marker/`[DONE]` and cannot see extra trailing bytes.
   Remedy: in `stopReasoningLoop`, detach the pipe before ending (`up.unpipe(res)` or a `stopped` flag checked by a single guarded write path), and/or add a defensive `res.on('error', () => {})`; strengthen the loop test to assert `response.body.endsWith('data: [DONE]\n\n')`.

2. **MEDIUM — bug — `gateway.mjs:1546-1552` vs `:1676-1678`, with `upstream-agent.mjs:16-29` — the `/v1/models` probe attaches a `timeout` listener on a *pooled* upstream request, violating the module's documented invariant and re-opening the dead-socket race it fixed.**
   Evidence: `const probe = endpointTransport(modelsUrl).get(modelsUrl, upstreamOptions(node,modelsUrl), …); probe.setTimeout(config.health_timeout_ms ?? 5000, () => probe.destroy());` — `upstreamOptions` selects the shared keep-alive `agent`/`tlsAgent`, and `request.setTimeout` both registers a `'timeout'` listener and raises the socket's idle timeout to 5s. The health probe deliberately uses `{...upstreamOptions(...),agent:false}` with the comment "A full inference connection pool must not delay the health request…" (`:1675-1678`), and `upstream-agent.mjs` states: "nothing in ds4-gateway/ attaches a 'timeout' listener to an upstream request -- one such listener turns this into a live-request aborter" and "Keep this below the engines' measured close floor (~4s)". A models-probe socket returned to the free pool with a 5s idle timeout expires *after* the engine's ~4.0–4.6s close, so the next chat request reusing it can hit ECONNRESET → 502 `upstream_error` — the exact failure the agent module was written to eliminate (needs verification of the listener interplay on your Node version, but the invariant breach is direct).
   Remedy: use `agent:false` for the models probe exactly like the health probe (metadata requests are infrequent; pooling buys nothing).

3. **MEDIUM — efficiency (unbounded growth) — `gateway.mjs:170-195`, `:845-853`, `:552-562` — `AffinityStore.sessions` is never evicted, and `store.count()` is O(total sessions) inside a sort comparator.**
   Evidence: `set(key,node)` only adds (`sessions:{ …this.data.sessions, [key]: … }`); nothing in the repo ever deletes a session (grep across `ds4-gateway/*.mjs` confirms). `placementChoice` sorts with `store.count(a.id) - store.count(b.id)` (`:853`), where `count(node)` is `Object.values(this.data.sessions).filter(...).length` — O(N) per comparison, O(N·log N) per placement. `stats()`/`registry()` call `store.count` per worker per dashboard poll (`:562`, `:696`). Each new conversation also rewrites the whole state file with two fsyncs (`:173-195`). The docs instruct clients to use unique per-attempt conversation IDs (`docs/conversation-turns.md:44-46`), so benchmark usage grows `sessions` without bound: state file size, stringify cost, fsync cost, and every count/poll all degrade linearly forever.
   Remedy: cache per-node counts (invalidate on `set`), and bound the session map (LRU by `assigned_at` with a configurable cap, or a compacted append-log); document session retention like the dataset budget is documented.

4. **MEDIUM — efficiency — `requested-thinking.mjs:81-99`, `queued-request-body.mjs:66-73`, `gateway.mjs:1108-1120` — every request body is buffered and JSON-parsed up to twice, and vision requests buffer a third copy.**
   Evidence: `RequestedThinkingObserver` is created for **every** dispatched request (`gateway.mjs:1112`), buffers all body chunks up to 8 MiB (`accept`, `requested-thinking.mjs:83-90`) and `finish()` does `JSON.parse(Buffer.concat(this.chunks,...))` unconditionally for identity-encoded bodies. When preview or routing observation is on, `QueuedRequestBody.inspect()` parses the *same* body a second time (`queued-request-body.mjs:69-73`), and `requestUserExcerpt` then walks the messages. Vision-enabled chat requests additionally retain the whole body in `captureChunks` up to `maxRequest` (64 MiB default). The thinking result is display metadata only (`node.lastThinking`); nothing on the dispatch path requires the parse.
   Remedy: parse once — have `QueuedRequestBody` (when present) hand its parsed object to the thinking observer; when no `QueuedRequestBody` exists, gate thinking capture on whether anything consumes it (e.g., dataset enabled, model is deepseek, or `previewFromRequest`), keeping `status:'unavailable'` honesty for skipped captures.

5. **LOW — bug (defensive) — `gateway.mjs:908` — `admit()` throws on a model-route invariant, and its callers include a `setInterval` callback and upstream event handlers.**
   Evidence: `if(!allowsWorker(job.modelRoute,node))throw new Error("Model route does not allow this worker");`. `admit` is invoked from `pumpWaiting` (run by `waitingTimer=setInterval(pumpWaiting,1000)`, `:2233`) and from `finish()` (upstream events). Today the invariant holds by construction (route Sets are fixed at startup, removal is blocked while work is parked), but if it ever breaks, the throw becomes an uncaughtException that kills the gateway mid-burst rather than degrading one request.
   Remedy: replace the throw with a guarded `reject(job.req,job.res,503,'no_healthy_worker',…)` + `job.cleanup()`, mirroring the affinity-write failure path at `:912-916`.

6. **LOW — tidy/naming — `gateway.mjs:1153` — per-worker `failed` conflates client behavior with engine failures.**
   Evidence: `if (outcome === 'complete') node.completed++; else if(outcome==='vision_guidance')…else node.failed++;` — `client_cancelled` (and `connection_closed`) increment `node.failed`, surfaced as `failed: n.failed` in `stats().workers` (`:563`). The dataset already separates `client_cancelled` from `upstream_*` outcomes (dataset.mjs:34), so the Fleet headline overstates worker failures whenever clients hang up during long streams.
   Remedy: add a `cancelled` counter (or exclude `client_cancelled`) and let the dashboard keep the combined number if desired.

7. **LOW — bug (defensive) — `gateway.mjs:1269-1271` — superseded attempt's response handlers destroy `res` unconditionally.**
   Evidence: in `bufferCandidate`, `up.on('error',e=>{res.destroy();finish(…)}); up.on('aborted',()=>{res.destroy();finish(…)});` — after a vision-recovery retry calls `issue(…,true)`, the old attempt's handlers remain attached; any late event destroys the retry's in-flight response (`finish` is settled-guarded, `res.destroy()` is not). Reachability is marginal (these fire only if the old connection tears after `end`), but the file's own convention is to guard both.
   Remedy: `if(!settled)res.destroy();` in both handlers, or `up.removeAllListeners()` once the retry is issued.

8. **LOW — tidy — `gateway.mjs:1436-1440` — dead condition in the exact-length rewrite branch.**
   Evidence: `if(state.settled&&clientLength!=null){mode='exact';…} else if(state.settled||size>rewriteBufferBytes){goChunked();}` — when `clientLength==null` the code returns via `goChunked()` earlier, and `settled&&clientLength!=null` takes the first branch, so `state.settled` in the `else if` is unreachable. It implies a "settled→chunked" fallback that does not exist and will mislead the next reader of this subtle code.
   Remedy: drop `state.settled||` from the else-if.

9. **LOW — tidy/doc — `gateway.mjs:498` — `rewrite_buffer_bytes` defaults to 256 MiB per in-flight rewritten upload and is undocumented.**
   Evidence: `…config.rewrite_buffer_bytes>0?config.rewrite_buffer_bytes:268435456` — the exact-length branch buffers up to this bound (`:1455-1470`) waiting for the model-string substitution; docs/ never mentions the knob (grep over docs/ finds nothing). A few concurrent large aliased uploads can pin hundreds of MB.
   Remedy: lower the default to something like 8–32 MiB (the substitution almost always lands in the first bytes of a JSON body) or document the bound and its memory profile.

10. **LOW — efficiency — `json-usage.mjs:17` — redundant per-chunk copy.**
    Evidence: `this.parts.push(Buffer.from(chunk));` — `chunk` is already a private Buffer slice whose bytes stay valid; `Buffer.from` duplicates up to the 4 MiB budget of every JSON response on the hot path.
    Remedy: `this.parts.push(chunk);`.

### 4) Top 5 proposals

1. **Single owner for the client response stream.** One helper that owns piping, guarded writes, and terminal sequences (SSE stop, guidance, error), so no path can `res.end()`/`res.destroy()` while the pipe lives. Fixes finding 1 permanently and prevents the next member of this crash family. Effort **M**, risk **M** (covered by the SSE/loop/error tests).
2. **Extract the dispatch pipeline from `createGateway`.** `dispatch` + `finish` + `sendBuffered`/`bufferCandidate`/`forwardResponse`/`issue`/`sendGuidance`/`stopReasoningLoop` (~500 lines, gateway.mjs:1041-1526) into `dispatch.mjs` behind a small context object (`nodes, store, waiting, pumpWaiting, schedule, visionProtection, dataset, log`). This is the highest-traffic, highest-subtlety block in a 2,265-line closure. Effort **M-L**, risk **M** — do it incrementally with the byte-preservation tests green.
3. **One parse per request body.** Shared parse handed from `QueuedRequestBody` to preview + requested-thinking + routing metadata; skip capture when no consumer (finding 4). Effort **M**, risk **M** (thinking/dataset tests exist and pin the metadata shape).
4. **Session store hygiene.** Per-node count cache + bounded/LRU sessions + retention documentation (finding 3). Effort **M**, risk **M** (must preserve the restart-persistence and "homes survive" contracts that tests assert).
5. **Split the control surface out of `createGateway`.** The ~40-route control-socket if-chain (gateway.mjs:2029-2210) and the worker/settings mutators (`addWorker`…`setQueueTimeout`, ~400 lines) into a route-table module; `createGateway` keeps only scheduler + server. Effort **L**, risk **L-M** (pure moves behind the existing `serialize()` executor; the agent/maintenance tests pin behavior).

### 5) Open questions / disagreements

- **Write-after-end observable (finding 1):** whether Node 20/22 turns the mid-pipe `end()` into a crash or silent post-terminator bytes is version-dependent and I could not run a repro under the read-only mandate. A one-line strengthened assertion in the existing loop test settles it.
- **Socket-timeout persistence into the agent free pool (finding 2):** the invariant breach is certain; whether the raised 5s idle timeout survives socket reuse in your Node build should be confirmed with a targeted test before changing behavior.
- **Analyzed and cleared:** the exact-length branch's `requestBody.once('end', … )` issuing a fresh `issue()` after `finish()` looks like a phantom re-dispatch, but in `mode===null` no upstream exists yet and nothing settles the job before body `end` except a client abort (which also prevents `end`), so I believe it unreachable today; a `settled` guard would still be cheap.
- **Possible intent question:** `node.failed++` for client cancels (finding 6) may be deliberate Fleet semantics ("requests that did not complete on this worker") — the fix is then a naming/label change, not a counter change.
- **Boundary note:** `routing-observations.mjs`, `routing-shadow.mjs`, `dataset.mjs`, and `agent-control.mjs` internals are adjacent seams I only verified at call sites; if per-request routing overhead matters, those modules deserve their own deep read.

No merge decision applies (read-only study; no diff on the table). The highest-priority items to act on are findings 1 and 2, both small, well-guarded fixes with existing tests to lean on.
