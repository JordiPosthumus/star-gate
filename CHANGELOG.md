# Changelog

Notable, user-facing changes. This is a small project without long-term support
releases; configuration field names may still change between revisions.

## Unreleased — publication cleanup

- Rewrote the README around the current gateway-only build, with explicit
  limitations and a docs map.
- Added `AGENTS.md` for coding agents (commands, invariants, privacy rules).
- Removed internal work logs, dated study reports, incident notes, kanban files
  and the stale Genie setup page from the public tree.
- Added measurement guards to routing v2: implausible or probe-sized samples are
  rejected and counted, a lane far above its same-model peers is priced at their
  median until it re-earns its own number, and engine-reported decode/prefill
  rates take precedence over stopwatch estimates.
- Fixed CI to stop calling a test script that no longer exists.

## 2026-10-17

- Documented the engine cache-telemetry contract: an engine that caches without
  reporting `prompt_tokens_details` is read as cold, and `scripts/cache-telemetry.mjs`
  detects the mismatch.
- Routing v2 lane measurement is available behind `routing_v2_enabled`.

## 2026-10-15

- Routing v2: measurement-driven placement, with a legacy planner retained as a
  fallback and a passive shadow comparison.

## Earlier

The repository's Git history contains the full pre-publication development
record. It is intentionally not reproduced here.
