# Engine cache telemetry

**The rule: an engine behind DSG that caches prefixes must report the hits in
`usage.prompt_tokens_details.cached_tokens`. Caching without reporting is worse
than not caching, because DSG and every client will read the engine as cold.**

DSG forwards upstream response bytes verbatim and records
`usage.prompt_tokens_details.cached_tokens` for both JSON and streamed usage
chunks. DSH's pi-ai adapter falls back through
`prompt_tokens_details.cached_tokens` → `prompt_cache_hit_tokens` →
`cached_tokens`, and otherwise records zero. There is no third source: if none of
those fields is present, the cache-hit pill and the DSG dataset both say 0%.

## Why this matters beyond a wrong percentage

`gateway.mjs` subtracts the cached prefix to estimate compute tokens for routing
v2 (`tokens = prompt - cached + completion`). When the field is absent it
subtracts nothing, so a node is priced as if it prefilled the whole prompt on
every request. The resulting "tokens/sec" is dominated by cache-hit rate rather
than machine speed — routinely thousands of tokens/sec, which is impossible for
decode. Placement then sends more traffic to whichever node happens to have the
warmer cache, which warms it further: a self-reinforcing measurement artefact.
Fixing the field fixes the lane speeds at the same time.

## vLLM: the flag

`--enable-prefix-caching` turns caching on. It does **not** make hits visible.
The usage field is gated separately by `FrontendArgs.enable_prompt_tokens_details`,
which defaults to `False`; with it off, `_make_prompt_tokens_details()` returns
`None` and the response carries `"prompt_tokens_details": null`.

Both flags are required:

```text
--enable-prefix-caching
--enable-prompt-tokens-details
```

This applies to the vLLM 0.29.x/Rust-frontend build used by the DS41F rings and
to upstream vLLM releases that carry `FrontendArgs`.

## Where the DS41F rings keep it

The serve arguments live in host-local (git-ignored) site configs:

- `ds41f-ring` (Spark4/5/6, head Spark6):
  `~/inference-fleet/config/site-ring1.local.json`
- `ds41f-ring2` (Spark1/2/3, head Spark):
  `~/inference-fleet/config/site-ring2.local.json`

Add `"--enable-prompt-tokens-details"` to `serve_args`, next to
`"--enable-prefix-caching"`.

`spark cluster start --replace` re-renders the container command from
`serve_args`, so the flag survives ordinary restarts and `--replace` rebuilds.
It does **not** survive a regenerated site config (`spark topology prepare`) or a
fresh host checkout. Re-check the rendered plan after any topology or site-config
rebuild — this is the durability limit of a `*.local.json` fix.

## Verify a ring

Direct warm pair — the first response should carry `created_cache_tokens`, the
second a non-zero `cached_tokens`:

```sh
curl -s http://127.0.0.1:18091/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Say OK."}],"max_tokens":1}'
```

Gateway view:

```sh
grep '"event":"request_finished"' runtime/gateway.log | tail -200 | grep ds41f-ring
```

A healthy record contains `"cached_tokens":<number>`; a broken one omits the key
entirely (or logs `null`).

Engine view:

```sh
curl -s http://127.0.0.1:18091/metrics | grep prefix_cache
ssh Spark6 "sudo docker logs --tail 30 dsv41-karmic-kraken 2>&1 | grep 'Prefix cache hit rate'"
```

Fleet check (read-only; exits 1 when a node caches but reports zero):

```sh
node scripts/cache-telemetry.mjs --hours 2
```

Allow ~15 minutes after a restart before judging: the window still contains the
cold-cache period, so a just-restarted ring can look misreported until real
traffic and hits accumulate.

## Restart procedure (one ring at a time)

1. Drain the ring so in-flight work finishes instead of failing:
   `./workers.sh drain ds41f-ring`
2. Wait until no `request_finished` for that node has appeared for ~30 seconds.
3. Patch the site config. **Put backups outside the repository**
   (`~/dsg-config-backups/`): `cluster start` refuses a dirty repo, and a file
   named `*.local.json.bak-*` is not matched by the `*.local.json` ignore rule.
4. Dry-run and confirm the flag appears once per node (3 for a TP3 ring):
   `./bin/spark --cluster-config config/site-ring1.local.json cluster start --replace`
5. Apply: append `--apply`. The CLI stops the old containers, launches the new
   command, waits for API readiness and rolls back automatically on failure.
6. Resume routing: `./workers.sh resume ds41f-ring`
7. Verify the warm pair and the first gateway records; re-run the fleet check
   after the cold-cache window has passed.

Do **not** synthesize cached tokens from `vllm:prefix_cache_*` metric deltas in
the gateway. Those counters are process-wide; they cannot be attributed to one
request and would corrupt the per-request dataset.

## Incident history

**2026-10-18 — reported cache hits collapsed from >90% to 5.9%.** The DS41F rings
had run without `--enable-prompt-tokens-details` since 2026-10-08. Traffic moved
from the GLM quality rings (which reported ~96%) to the DS41F rings at
2026-10-17T16:19Z. Reported hits fell 90.0% (15:00Z) → 1.9% (16:00Z) → 0.0%,
while the engines reported 96.8% (ring) and 92.2% (ring2). Lane speeds read
6,875 t/s and 3,233 t/s against 109 t/s on the M3 lane. Fixed by adding the flag
to both site configs and restarting ring2, then ring1, after draining. First warm
ring2 record after the fix: 150,528 cached of 159,903 prompt tokens (94.1%).
