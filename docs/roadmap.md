# Direction

This is a direction document, not a promise or a release plan. The project is
maintained in spare time by one person; priorities change when the home fleet
does. For what actually ships today, see the [README](../README.md) and the
[simplified system overview](simplified-system.md).

## Principles

- **Continuity first.** A request that was admitted should not be silently
  replayed, reordered, or turned into a different conversation. Waiting is
  preferable to inventing certainty.
- **Measure, then place.** Routing decisions should rest on observed engine and
  gateway numbers, with explicit `unknown`/`stale`/`cold` states rather than
  guesses. Experimental estimators earn authority only by measured improvement.
- **Keep the operator in control.** Pauses, scoped agent holds and maintenance
  locks outrank every automatic path. Recovery is opt-in, per-service, and
  independently guarded.
- **Stay small.** Node standard library only for the core. No database, no
  frontend build system, no cloud dependency.
- **Do not publish the operator's life.** Deployment histories, machine
  inventories and private measurements stay out of this repository. See
  [publication policy](publication-policy.md).

## Current focus

1. **Routing v2 measurement quality.** Reject implausible or probe-sized
   samples, prefer cache-invariant engine counters, and price a suspect lane at
   its same-model peers until it re-earns its own number. The guards are in
   place; broader real-fleet evidence is still thin.
2. **Queue and handover clarity.** Keep the contract for pre-dispatch handover,
   conversation turns and priority simple enough to reason about under load.
3. **Dashboard legibility.** Show what is measured, what is stale and what is
   unknown without turning the UI into a wall of counters.
4. **Agent operability.** Keep the scoped drain/resume API and the
   machine-onboarding runbooks accurate enough for another agent to follow.
5. **Bring Gate Genie home.** Restore the first-party runtime, Genie tab and
   Hermes Gateway messaging around the identity and brain contract in
   [Genie](genie.md).

## Explicitly out of scope

- Multi-tenant authentication, billing, or hosted operation.
- Moving KV caches between machines.
- Automatic replay after an ambiguous upstream failure.
- Model training, embeddings, learned placement or a prediction service.
- A general benchmark or SLA claim.

## Retired

These were removed rather than left dormant: the bundled Hermes runtime as a
vendored copy, XGBoost/embedding experiments, Priority Lens,
Proactive Resume / Session Rescue, and the four-path cache comparator with its
calibration preflight. Some code names and historical docs remain; they do not
grant capability.

## How this changes

A roadmap item moves to "implemented" only with a fixture-based regression test,
an updated limitation note, and a real deployment check where hardware is
involved. If an item stops being useful, it is removed from this page rather than
left as aspirational prose.
