# Gateway restart runbook — the agent's brain rides through this gateway

Operational companion to the pi skill `dsg-gateway-restart` (~/.pi/agent/skills/).
Written 2026-10-16 after three of five gateway restarts that day severed the
agent's own session mid-turn.

## Dependency map (verified from configs)

```
pi sessions (agent "brain", subagents, any chat)
    │  provider dsg-pool → baseUrl http://127.0.0.1:30000/v1
    ▼
gateway.mjs (launchd: local.dwarf-star-gate.gateway, KeepAlive, port 30000)
    │  routes per config.local.json model_routes / affinity
    ▼
model engines on the LAN (LM Studio / oMLX :18093 etc.)
```

- `door.mjs` (Continuity Door) and `dashboard.mjs` run as separate processes
  and survive gateway restarts. Never restart them as part of a gateway bounce.
- The gateway reads config **once at boot** (`routing_v2_enabled` etc.).
  Config edits do nothing until a restart.

## Evidence from 2026-10-16

| Time (local) | Change shipped | Active at kill | Agent session survived? |
|---|---|---|---|
| ~06:43 | Routing v2 cutover | 1 | yes |
| ~07:30 | starvation fix v1 | 2 | yes (100s graceful wait) |
| ~08:05 | starvation fix v2 | 2 | yes |
| ~08:33 | probe-gate fix | 2 | **NO — owner revived** |
| ~08:52 | two-phase rates | 2 | yes |
| ~09:35 | thinking-token fix | 1 | (pending at writing) |

Conclusion: survival is timing luck (whether an inference of the agent session
is in flight at the kill instant). Treat EVERY restart as potentially fatal to
your own session and follow the checklist.

## Non-negotiables

1. Announce before the kill; owner present and ready to revive.
2. One restart ships all pending changes — never serial bounces.
3. `kill -TERM` the launchd job's PID only; wait out the graceful window
   (ExitTimeOut is 360000 ms in the plist — be patient, do NOT kill -9).
4. Never touch door.mjs / dashboard.mjs / their launchd jobs / stop-dsg.sh.
5. Verify after: status endpoint fields + door PID + lane-speeds.json intact.
6. Under Mac memory pressure: no subagent runners (30s startup-ack timeouts —
   observed 4 consecutive failures after the owner killed oMLX for memory).

Full procedure and commands: the `dsg-gateway-restart` pi skill.
