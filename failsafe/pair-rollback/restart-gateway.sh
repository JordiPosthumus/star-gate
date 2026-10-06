#!/bin/zsh
# gateway-restart: load the staged config fixes into the running DSG gateway.
#   1. health_timeout_ms 5000 -> 15000  (sized from M3's measured probe latency)
#   2. glm53f-m3 context_length 400000 -> 262144 (matches engine reality)
#   3. request_timeout_ms back to 360000000 (running core still holds temp 1.8M)
# Owner-approved 2026-10-06. Gateway PROCESS only — never touches workers,
# tunnels, lane kit configs, or affinity state.
#
# Safety: 60s initial delay (let any in-flight agent turn finish), then waits
# for a genuinely quiet window (all 3 TF lanes load=0/queued=0, no dispatch in
# the last 15s) up to 10 minutes; aborts if /tmp/dsg-restart-STOP exists.
# One shot only — on any failure it reports and exits; no retry loop.

set -u
TS=$(date +%Y%m%d-%H%M%S)
DSG="${DSG_HOME:-$(cd "$(dirname "$0")/../.." && pwd)}"
LOG="$DSG/runtime/gateway-restart-$TS.log"
LATEST="/tmp/dsg-restart-latest.log"
STOP="/tmp/dsg-restart-STOP"
UID_N=$(id -u)
LABEL="local.dwarf-star-gate.gateway"
SOCK="$DSG/runtime/control.sock"
GWLOG="$DSG/runtime/gateway.log"
CFG="$DSG/config.local.json"

log() {
  local line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  echo "$line" >> "$LOG"
  echo "$line" >> "$LATEST"
}

log "=== gateway-restart starting (receipt: $LOG) ==="

# 0. config must parse before we commit to anything
if ! python3 -c "import json;json.load(open('$CFG'))" 2>>"$LOG"; then
  log "ABORT: config.local.json does not parse — not restarting with a broken config"
  exit 1
fi
log "config parse OK; staged values: $(grep -E 'health_timeout_ms' "$CFG" | tr -d ' '), $(grep -c '360000000' "$CFG") x360000000 refs"

# 1. initial delay — let the current agent turn end cleanly
sleep 60
log "initial 60s delay done"

# 2. quiet-window gate (STOP file honored every cycle)
QUIET=0
for i in {1..120}; do
  [ -f "$STOP" ] && { log "ABORT: $STOP present — owner/auditor stopped the restart"; exit 1; }
  Q=$(python3 - "$SOCK" "$GWLOG" <<'PYEOF'
import json, subprocess, sys, time, datetime as dt
sock, gwlog = sys.argv[1], sys.argv[2]
try:
    r = subprocess.run(["curl","-s","-m","4","--unix-socket",sock,"http://localhost/workers"],
                       capture_output=True, text=True, timeout=8)
    ws = json.loads(r.stdout).get("workers", [])
except Exception:
    print("NO"); sys.exit()
lanes = [w for w in ws if w["id"].startswith("glm53exl3")]
if len(lanes) != 3:            # vacuous-YES guard: roster must be fully populated
    print("NO"); sys.exit()
# audit T3 BLOCKER fix: ALL workers must be idle, not just lanes — the M3 runs
# 309s generations and an in-flight stream is invisible in the 15s-log check
if any((w.get("load") or 0) > 0 or (w.get("queued") or 0) > 0
       or (w.get("active_seconds") or 0) > 0 for w in ws):
    print("NO"); sys.exit()
try:
    with open(gwlog, "rb") as f:
        f.seek(0, 2); size = f.tell(); f.seek(max(0, size - 262144))
        tail = f.read().decode("utf-8", errors="ignore")
    last_disp = 0.0
    for line in reversed(tail.splitlines()):
        if '"request_dispatched"' in line:
            d = json.loads(line); last_disp = d["time"]; break
    if last_disp:
        t = dt.datetime.fromisoformat(last_disp.replace("Z", "+00:00")).timestamp()
        if time.time() - t < 15: print("NO"); sys.exit()
except Exception:
    print("NO"); sys.exit()
print("YES")
PYEOF
)
  if [ "$Q" = "YES" ]; then QUIET=1; break; fi
  sleep 5
done
if [ "$QUIET" != "1" ]; then
  log "ABORT: no quiet window in 10 min — config stays staged, nothing touched"
  exit 1
fi
log "quiet window confirmed — all 3 lanes idle, no dispatch in last 15s"

# 3. pre-state snapshot (no backslash-escapes in f-strings: host python is 3.9)
log "PRE: $(curl -s -m 4 --unix-socket $SOCK http://localhost/workers | python3 -c 'import json,sys; ws=json.load(sys.stdin)["workers"]; print(" | ".join("{0}: h={1} load={2}".format(w["id"],w["is_healthy"],w["load"]) for w in ws))' 2>>"$LOG")"
log "PRE: gateway pid $(pgrep -f 'gateway.mjs.*config.local.json' | head -1), started $(ps -p $(pgrep -f 'gateway.mjs.*config.local.json' | head -1) -o lstart= 2>/dev/null)"

# 4. the restart — kill + launchd KeepAlive resurrects with the new config
[ -f "$STOP" ] && { log "ABORT: STOP appeared at the gate"; exit 1; }
launchctl kickstart -k "gui/$UID_N/$LABEL" >>"$LOG" 2>&1
RC=$?
log "kickstart rc=$RC"
if [ "$RC" != "0" ]; then
  log "FAIL: kickstart failed rc=$RC — check launchctl print gui/$UID_N/$LABEL"
  exit 1
fi

# 5. wait for the OLD pid to exit (graceful drain can take minutes — audit T3),
# then wait for the control socket (90s)
OLDPID=$(pgrep -f 'gateway.mjs.*config.local.json' | head -1)
for i in {1..200}; do
  [ -f "$STOP" ] && { log "ABORT: STOP appeared during drain wait"; exit 1; }
  pgrep -f 'gateway.mjs.*config.local.json' | grep -qv "^$OLDPID$" && break
  pgrep -f 'gateway.mjs.*config.local.json' | grep -q "^$OLDPID$" || break
  sleep 2
done
UP=0
for i in {1..45}; do
  if curl -s -m 3 --unix-socket "$SOCK" http://localhost/workers >/dev/null 2>&1; then UP=1; break; fi
  sleep 2
done
if [ "$UP" != "1" ]; then
  log "FAIL: control socket not back — old process may still be draining or crashed. Check gateway.log for startup_failed BEFORE touching config or re-kicking. Rollback (only after confirming crash loop): cp $CFG.pre-m3-probe-fix-bak $CFG && launchctl kickstart -k gui/$UID_N/$LABEL"
  exit 1
fi
log "gateway control socket is back"

# 6. post-verify: lanes healthy + M3 context correct (180s patience for probes)
POST=""
for i in {1..36}; do
  POST=$(curl -s -m 4 --unix-socket "$SOCK" http://localhost/workers 2>/dev/null | python3 -c '
import json,sys
try: ws=json.load(sys.stdin)["workers"]
except Exception: print("PENDING"); sys.exit()
lanes={w["id"]:(w.get("is_healthy"),w.get("load"),w.get("queued")) for w in ws if w["id"].startswith("glm53exl3")}
m3=[w for w in ws if w["id"]=="glm53f-m3"]
ok={"glm53exl3-12","glm53exl3-34","glm53exl3-56"} <= set(lanes) and all(h is True for h,_,_ in lanes.values())
ctx=m3[0].get("context_length") if m3 else None
print(f"LANES_OK={ok} M3_CTX={ctx} | "+" | ".join(f"{k}: h={v[0]} load={v[1]} q={v[2]}" for k,v in lanes.items()))' 2>>"$LOG")
  case "$POST" in
    LANES_OK=True*262144*) break ;;
  esac
  sleep 5
done
log "POST: $POST"

case "$POST" in
  LANES_OK=True*262144*)
    log "PASS: gateway restarted on new config; all 3 TF lanes healthy; M3 context=262144 live"
    log "ROLLBACK (if ever needed): cp $CFG.pre-m3-probe-fix-bak $CFG && launchctl kickstart -k gui/$UID_N/$LABEL"
    exit 0 ;;
  *)
    log "INCOMPLETE: gateway up but verification not confirmed within 180s (lanes may still be probing). State logged above; do NOT re-run blindly — inspect first."
    exit 1 ;;
esac