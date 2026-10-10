#!/bin/bash
# gate-keeper.sh — Star Gate watchman, Phase 1 OBSERVE MODE.
# READ-ONLY BY CONSTRUCTION: this script contains no launchctl, no docker, no
# config writes. Worst case = it writes a wrong line to its own journal.
# Journal: append-only JSONL, fsync per line (pi-durable pattern).
# State (tick, streaks, stale-dedupe) is derived from the journal tail — no
# separate state file to corrupt.
# Env overrides exist for fixture testing only; production uses defaults.
set -u
DSG="${DSG:-$HOME/DSG}"
DIR="${GATEKEEPER_DIR:-$DSG/runtime/gate-keeper}"
JOURNAL="$DIR/journal.jsonl"; EVENTS="$DIR/events.jsonl"
OFF_SWITCH="$DSG/runtime/genie-failsafe-OFF"
DOOR_URL="${GATEKEEPER_DOOR_URL:-http://127.0.0.1:30000}"
CORE_URL="${GATEKEEPER_CORE_URL:-http://127.0.0.1:30001}"
M3_URL="${GATEKEEPER_M3_URL:-http://127.0.0.1:8013}"
LANES="${GATEKEEPER_LANES:-38014 38015 38016}"
SOCKET="${GATEKEEPER_SOCKET:-$DSG/runtime/control.sock}"
KEYJSON="${GATEKEEPER_KEY_JSON:-$DSG/config.local.json}"
mkdir -p "$DIR"
# rotate at 2MB, keep one generation
if [ -f "$JOURNAL" ] && [ "$(stat -f%z "$JOURNAL" 2>/dev/null || echo 0)" -gt 2097152 ]; then
  mv "$JOURNAL" "$JOURNAL.1"; [ -f "$EVENTS" ] && mv "$EVENTS" "$EVENTS.1"
fi
TICK=$(( $( [ -f "$JOURNAL" ] && wc -l < "$JOURNAL" || echo 0 ) + 1 ))
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
OFF=false; [ -f "$OFF_SWITCH" ] && OFF=true

probe(){ # $1=base-url; remaining args passed to curl (e.g. auth header)
  local url="$1"; shift || true
  local c; c=$(curl -s -m 2 "$@" -o /dev/null -w '%{http_code}' "$url" 2>/dev/null); local rc=$?
  if [ $rc -ne 0 ] || [ -z "$c" ] || [ "$c" = "000" ]; then echo down; else echo "$c"; fi
}
KEY=$(python3 -c "import json;print(json.load(open('$KEYJSON')).get('api_key',''))" 2>/dev/null || echo "")
AUTH=(); [ -n "$KEY" ] && AUTH=(-H "Authorization: Bearer $KEY")

if [ "$OFF" = "true" ]; then
  # sacred kill switch: log one line, touch nothing, exit.
  python3 - "$JOURNAL" "$EVENTS" <<'PY'
import json,os,sys
j,ev=sys.argv[1],sys.argv[2]
e={"ts":os.environ.get('GK_TS'),"off":True,"verdict":"failsafe_off"}
with open(j,'a') as f: f.write(json.dumps(e,separators=(',',':'))+"\n"); f.flush(); os.fsync(f.fileno())
print("failsafe_off")
PY
  exit 0
fi

DOOR=$(probe "$DOOR_URL/v1/models" "${AUTH[@]+${AUTH[@]}}")
DEEP="skipped"
if [ "${GATEKEEPER_FORCE_DEEP:-0}" = "1" ] || [ $((TICK % 10)) -eq 0 ]; then
  BODY='{"model":"PoolModel","max_tokens":1,"messages":[{"role":"user","content":"."}]}'
  RC=$(curl -s -m 8 "${AUTH[@]}" -H 'Content-Type: application/json' -d "$BODY" \
       -o "$DIR/.deep.json" -w '%{http_code}' "$DOOR_URL/v1/chat/completions" 2>/dev/null) || RC=timeout
  [ "$RC" = "000" ] && RC=timeout
  DEEP="$RC"
fi
CORE=$(probe "$CORE_URL/health")
M3KEY=$(cat "$HOME/.dsg-secrets/glm53f-m3.key" 2>/dev/null || echo "")
M3=$(probe "$M3_URL/v1/models" -H "Authorization: Bearer $M3KEY")
LANES_CSV=""
for p in $LANES; do r=$(probe "http://127.0.0.1:$p/v1/models"); LANES_CSV="$LANES_CSV,$p:$r"; done
LANES_CSV=${LANES_CSV#,}

WORKERS=""
STALE_CSV=""
if curl -s -m 3 --unix-socket "$SOCKET" http://localhost/workers -o "$DIR/.workers.json" 2>/dev/null; then
  WORKERS=$(cat "$DIR/.workers.json")
  # quarantined workers -> probe each backend directly (staleness check)
  QUAR_LINES=$(python3 - <<PY
import json
try: ws=json.loads(open("$DIR/.workers.json").read())
except Exception: ws=[]
if isinstance(ws,dict): ws=ws.get('workers',[])
for w in (ws if isinstance(ws,list) else []):
    if w.get('quarantine'): print(w.get('id','?'), w.get('url',''))
PY
)
  while read -r qid qurl; do
    [ -z "${qid:-}" ] && continue
    case "$qurl" in */v1) B="$qurl/models";; *) B="$qurl/v1/models";; esac
    r=$(probe "$B"); STALE_CSV="$STALE_CSV,$qid:$r"
  done <<EOF2
$QUAR_LINES
EOF2
  STALE_CSV=${STALE_CSV#,}
fi
rm -f "$DIR/.workers.json" "$DIR/.deep.json"

GENIE_PID=$(launchctl print gui/$(id -u)/local.star-gate.hermes 2>/dev/null | awk -F'= ' '/pid =/{print $2; exit}')

GK_TS="$TS" GK_DOOR="$DOOR" GK_DEEP="$DEEP" GK_CORE="$CORE" GK_M3="$M3" \
GK_LANES="$LANES_CSV" GK_WORKERS="$WORKERS" GK_STALE="$STALE_CSV" \
GK_OFF="$OFF" GK_GENIE_PID="${GENIE_PID:-}" \
python3 - "$JOURNAL" "$EVENTS" <<'PY'
import json,os,sys
journal,events=sys.argv[1],sys.argv[2]; env=os.environ
def csv(s):
    d={}
    for kv in filter(None,(s or '').split(',')):
        k,v=kv.split(':',1); d[k]=v
    return d
lanes=csv(env.get('GK_LANES')); stalep=csv(env.get('GK_STALE'))
try: ws=json.loads(env.get('GK_WORKERS') or 'null')
except Exception: ws=None
if isinstance(ws,dict): ws=ws.get('workers',[])
total=0; quar=[]
if isinstance(ws,list):
    total=len(ws); quar=[w.get('id','?') for w in ws if w.get('quarantine')]
stale=sorted(i for i in quar if stalep.get(i,'down')!='down')
lines=[]; prev_stale=None; streak0=0
if os.path.exists(journal):
    lines=[l for l in open(journal) if l.strip()]
if lines:
    try:
        prev=json.loads(lines[-1]); prev_stale=prev.get('workers',{}).get('stale',[])
    except Exception: pass
    for l in reversed(lines):
        try: e=json.loads(l)
        except Exception: break
        if e.get('door',{}).get('light')=='down': streak0+=1
        else: break
door=env.get('GK_DOOR','')
streak=streak0+1 if door=='down' else 0
# Lane liveness (2026-10-07): the 04:48 jetsam kill sat 3.5h dark because
# lane state never reached the verdict. A serving lane answering 'down' is
# an incident regardless of the door.
dark=[k for k,v in lanes.items() if v=='down']
if env.get('GK_M3')=='down': dark.append('m3')
verdict='ok'
if env.get('GK_OFF')=='true': verdict='failsafe_off'
elif dark: verdict='lane_down: '+','.join(sorted(dark))
elif door=='down' and streak>=3: verdict='WOULD_ESCALATE_L2 (observe-only)'
elif door=='down': verdict='door_down_suspect'
elif env.get('GK_DEEP')=='timeout': verdict='wedged_suspect (observe-only)'
elif env.get('GK_CORE')=='down': verdict='core_down (observe-only)'
entry={"ts":env.get('GK_TS'),"tick":len(lines)+1,"off":env.get('GK_OFF')=='true',
 "door":{"light":door,"deep":env.get('GK_DEEP','-')},"core":env.get('GK_CORE','-'),
 "m3":env.get('GK_M3','-'),"lanes":lanes,
 "workers":{"total":total,"quarantined":quar,"stale":stale} if ws is not None else "unavailable",
 "genie_pid":int(env['GK_GENIE_PID']) if (env.get('GK_GENIE_PID') or '').isdigit() else None,
 "door_down_streak":streak,"verdict":verdict}
def append(path,obj):
    with open(path,'a') as f:
        f.write(json.dumps(obj,separators=(',',':'))+"\n"); f.flush(); os.fsync(f.fileno())
append(journal,entry)
if ws is not None and stale!=prev_stale:   # at-most-once per state change
    if stale: append(events,{"ts":env.get('GK_TS'),"type":"stale-quarantine","workers":stale})
    elif prev_stale: append(events,{"ts":env.get('GK_TS'),"type":"stale-resolved","workers":prev_stale})
print(verdict)
PY

# Phase 2 hook — lifeline is INERT unless runtime/gate-keeper/ARMED exists (it checks itself)
bash "$DSG/runtime/hermes-home/scripts/genie-lifeline.sh" >/dev/null 2>&1 || true
