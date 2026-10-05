# Star Gate Failsafe — gate-keeper + genie lifeline

The repairman lives inside the machine he repairs. If the Star Gate gateway dies,
Gate Genie (a Hermes agent riding that gateway) dies with it — and nobody is left
to repair the gate. This is the deterministic answer: a dumb watcher outside the
gate, and a lifeline that keeps the repairman's brain alive on a direct lane.

## Components

- `gate-keeper.sh` — observe-mode watchman (launchd, 30 s). READ-ONLY by
  construction: no launchctl/docker/config writes exist in it. Appends one
  JSONL line per cycle to `~/DSG/runtime/gate-keeper/journal.jsonl` (fsync per
  line; all state derived from the journal tail). Also flags stale quarantines
  (worker marked quarantined while its backend answers directly) into
  `events.jsonl`, at-most-once per state change.
- `genie-lifeline.sh` — Phase 2 "hands". The ONLY mutation script. Completely
  inert unless `~/DSG/runtime/gate-keeper/ARMED` exists. When armed and the door
  has been dark for `GATEKEEPER_L2_THRESHOLD` cycles (default 10 = 5 min), it:
  1. re-probes the door (recovers = abort),
  2. walks the fallback ladder (M3 direct first, then the Spark lanes through
     local tunnels), requiring light + real generation probe from each,
  3. writes an intent event, backs up the genie config, applies a 3-field delta
     (`model.default` / `model.base_url` / `model.api_key`) atomically with a
     manifest, neutralizing credential headers so they don't leak to lanes,
  4. re-checks the door (race guard — undoes if it returned),
  5. kickstarts the genie label, writes `GENIE-FAILSAFE-ACTIVE`, notifies.
  Budget: max 3 flips/hour (journal-counted), then notify-only.
- `lifeline-restore.py` — mechanical handback. Manifest-verified field restore:
  only restores if the config still matches what the lifeline wrote (owner
  edits elsewhere are never touched). Run by the awake Genie, never scheduled.
- `local.dwarf-star-gate.gate-keeper.plist` — the watchman's launchd agent.
- `fixtures/` — the fake-door/fake-lane servers used by the fixture suites
  (dead-gate streak escalation, wedged-door deep probe, stale-quarantine
  at-most-once, kill switch, flip, restore, owner-edit conflict refusal).

## Kill switch (works even when everything else is dead)

    touch ~/DSG/runtime/genie-failsafe-OFF     # lifeline fully inert
    rm ~/DSG/runtime/genie-failsafe-OFF        # re-enable

State: `cat ~/DSG/runtime/GENIE-FAILSAFE-ACTIVE` (absent = normal operation).

## Install

    cp local.dwarf-star-gate.gate-keeper.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.dwarf-star-gate.gate-keeper.plist

The deployed scripts live under `runtime/hermes-home/scripts/` (gitignored);
this directory is the canonical copy — keep them in sync via symlink.

## Arming (only after a supervised rehearsal)

    touch ~/DSG/runtime/gate-keeper/ARMED

Rehearsal: pick a quiet window, kill the door on purpose, watch the journal
(`door_down_streak` climb → `WOULD_ESCALATE_L2` → flip to M3 → genie returns
with `GENIE-FAILSAFE-ACTIVE`), then `genie-lifeline.sh restore` by hand.
Rollback operator present; kill switch in pocket.

## What it never does

No auto quarantine-clearing (semantic decision — the awakened Genie's job).
No Pantheon failover. No gateway code changes. No restarts while requests are
in flight (the flip only fires after minutes of continuous darkness, when no
requests can be flowing anyway). Never touches models, contexts, or caches.
