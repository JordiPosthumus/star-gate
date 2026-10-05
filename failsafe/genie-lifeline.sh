#!/bin/bash
# genie-lifeline.sh — Phase 2 "the hands". The ONLY mutation script in the failsafe.
# Runs every cycle, invoked by gate-keeper.sh — but does NOTHING unless
#   runtime/gate-keeper/ARMED exists (created only in the rehearsal window or after).
# Allowed mutations, entire list: genie config field-delta + genie launchctl kickstart.
# Everything else (gateway code, other profiles, docker, models) is unreachable — no
# code path exists. Kill switch (genie-failsafe-OFF) is checked before anything.
#
# pi-durable patterns: intent event written BEFORE acting; manifest-based field-delta
# restore (only fields we wrote, only if they still match what we wrote); at-most-once
# events; fsync everywhere; budget enforced from the journal.
#
# Env overrides are for FIXTURES. Production uses defaults.
#   subcommand "restore": mechanical handback, run by the awake Genie (never auto).
set -u
DSG="${DSG:-$HOME/DSG}"
DIR="${GATEKEEPER_DIR:-$DSG/runtime/gate-keeper}"
JOURNAL="$DIR/journal.jsonl"; EVENTS="$DIR/events.jsonl"
ARMED="$DIR/ARMED"; OFF="$DSG/runtime/genie-failsafe-OFF"
MARKER="$DSG/runtime/GENIE-FAILSAFE-ACTIVE"; MANIFEST="$DIR/lifeline-manifest.json"
RESTORE_READY="$DIR/RESTORE-READY"; LOCK="$DIR/.lifeline.lock"
GENIE_CONFIG="${GATEKEEPER_GENIE_CONFIG:-$DSG/runtime/hermes-home/config.yaml}"
GENIE_LABEL="${GATEKEEPER_GENIE_LABEL:-local.star-gate.hermes}"
DOOR_URL="${GATEKEEPER_DOOR_URL:-http://127.0.0.1:30000}"
THRESHOLD="${GATEKEEPER_L2_THRESHOLD:-10}"       # dark cycles (30s) before flip = 5 min
RESTORE_AFTER="${GATEKEEPER_RESTORE_AFTER:-6}"   # healthy cycles before restore-ready = 3 min
DRYRUN="${GATEKEEPER_DRYRUN:-0}"
# ladder "url|model|keyfile;..." — M3 first (local, no LAN dependency); spark lanes need no key
LADDER="${GATEKEEPER_LADDER:-http://127.0.0.1:8013/v1|GLM-5.3-Flash-oQ8e-mtp|$HOME/.dsg-secrets/glm53f-m3.key;http://127.0.0.1:38014/v1|GLM-5.3-Flash-EXL3|;http://127.0.0.1:38015/v1|GLM-5.3-Flash-EXL3|;http://127.0.0.1:38016/v1|GLM-5.3-Flash-EXL3|}"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$DIR"

ev(){ python3 - "$1" "$2" "${3:-}" <<'PY'
import json,os,sys
p=sys.argv[1]; e={"ts":os.environ.get('GK_TS'),"type":sys.argv[2]}
if len(sys.argv)>3 and sys.argv[3]:
    try: e.update(json.loads(sys.argv[3]))
    except Exception: pass
with open(p,'a') as f: f.write(json.dumps(e,separators=(',',':'))+"\n"); f.flush(); os.fsync(f.fileno())
PY
}
export GK_TS="$TS"
notify(){ [ "$DRYRUN" = "1" ] && { echo "[dryrun] notify: $1"; return; }; osascript -e "display notification \"$1\" with title \"Star Gate Lifeline\"" >/dev/null 2>&1 || true; }

streaks(){ python3 - "$JOURNAL" <<'PY'
import json,sys,os
streak=healthy=0
try: lines=[l for l in open(sys.argv[1]) if l.strip()]
except Exception: lines=[]
for l in reversed(lines):
    try: e=json.loads(l)
    except Exception: break
    lt=e.get('door',{}).get('light')
    if lt=='down':
        if healthy==0: streak+=1
        else: break
    elif lt=='200':
        if streak==0: healthy+=1
        else: break
    else: break
print(f"{streak} {healthy}")
PY
}
read STREAK HSTREAK <<< "$(streaks)"

########## RESTORE-READY (gate came back while lifeline active) ##########
if [ -f "$MARKER" ]; then
  if [ "$HSTREAK" -ge "$RESTORE_AFTER" ] && [ ! -f "$RESTORE_READY" ]; then
    python3 - "$RESTORE_READY" <<'PY'
import json,os,sys
m={"ts":os.environ.get('GK_TS'),"note":"Door healthy again. Run: genie-lifeline.sh restore (fields only, manifest-verified), remove marker, restart self at END OF TURN."}
with open(sys.argv[1],'w') as f: f.write(json.dumps(m)); f.flush(); os.fsync(f.fileno())
PY
    ev "$EVENTS" "restore-ready" "{\"healthy_streak\":$HSTREAK}"
    notify "Gate is back. Lifeline restore-ready — Genie should hand back."
  fi
  echo "lifeline: active (marker present), healthy_streak=$HSTREAK"; exit 0
fi

########## FLIP GATE ##########
[ -f "$ARMED" ] || { echo "lifeline: not armed (no ARMED flag)"; exit 0; }
[ -f "$OFF" ] && { echo "lifeline: failsafe OFF"; exit 0; }
[ "$STREAK" -ge "$THRESHOLD" ] || { echo "lifeline: wait (streak=$STREAK/$THRESHOLD)"; exit 0; }

# portable lock (macOS has no flock): atomic mkdir, self-heals stale locks >120s
if ! mkdir "$LOCK.d" 2>/dev/null; then
  AGE=$(( $(date +%s) - $(stat -f%m "$LOCK.d" 2>/dev/null || echo 0) ))
  if [ "$AGE" -gt 120 ]; then rmdir "$LOCK.d" 2>/dev/null; mkdir "$LOCK.d" 2>/dev/null || { echo "lifeline: busy"; exit 0; }
  else echo "lifeline: busy"; exit 0; fi
fi
trap 'rmdir "$LOCK.d" 2>/dev/null' EXIT

# budget: max 3 flips/hour, counted from journal
NB=$(python3 - "$EVENTS" <<'PY'
import json,sys,datetime
now=datetime.datetime.utcnow(); n=0
try: lines=[l for l in open(sys.argv[1]) if l.strip()]
except Exception: lines=[]
for l in lines:
    try: e=json.loads(l)
    except Exception: continue
    if e.get('type')=='lifeline-intent':
        try: t=datetime.datetime.strptime(e['ts'],"%Y-%m-%dT%H:%M:%SZ")
        except Exception: continue
        if (now-t).total_seconds()<3600: n+=1
print(n)
PY
)
if [ "${NB:-0}" -ge 3 ]; then ev "$EVENTS" "budget-exhausted"; notify "Lifeline budget exhausted (3/hr). No flip."; echo "lifeline: budget exhausted"; exit 0; fi

# fresh door check — recovered since journal? then no flip
c=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$DOOR_URL/v1/models" 2>/dev/null) || c=000
if [ "$c" = "200" ]; then ev "$EVENTS" "door-recovered"; echo "lifeline: door recovered, no flip"; exit 0; fi

# lane ladder: first lane passing light AND generation probe wins
LANE_URL=""; LANE_MODEL=""; LANE_KEY=""
IFS=';' ; for entry in $LADDER; do
  unset IFS
  [ -z "$entry" ] && continue
  IFS='|' read -r url model keyfile <<< "$entry"
  c=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$url/models" 2>/dev/null) || c=000
  [ "$c" = "000" ] && continue
  AUTH=(); [ -n "$keyfile" ] && [ -f "$keyfile" ] && AUTH=(-H "Authorization: Bearer $(cat "$keyfile")")
  g=$(curl -s -m 8 ${AUTH[@]+"${AUTH[@]}"} -H 'Content-Type: application/json' \
      -d "{\"model\":\"$model\",\"max_tokens\":1,\"chat_template_kwargs\":{\"thinking\":\"off\"},\"messages\":[{\"role\":\"user\",\"content\":\".\"}]}" \
      -o "$DIR/.genprobe.json" -w '%{http_code}' "$url/chat/completions" 2>/dev/null) || g=000
  if [ "$g" = "200" ] && python3 -c "
import json,sys
try: r=json.load(open('$DIR/.genprobe.json')); sys.exit(0 if r.get('choices') else 1)
except Exception: sys.exit(1)"; then
    LANE_URL="$url"; LANE_MODEL="$model"; LANE_KEY=""
    [ -n "$keyfile" ] && [ -f "$keyfile" ] && LANE_KEY="file:$keyfile"
    break
  fi
done; IFS=' '
rm -f "$DIR/.genprobe.json"
if [ -z "$LANE_URL" ]; then
  ev "$EVENTS" "no-brain-available"; notify "Gate down and NO fallback brain answered. Needs human."; echo "lifeline: no brain available"; exit 0
fi

ev "$EVENTS" "lifeline-intent" "{\"lane\":\"$LANE_URL\",\"model\":\"$LANE_MODEL\",\"door_streak\":$STREAK}"
cp "$GENIE_CONFIG" "$GENIE_CONFIG.pre-lifeline-$TS.bak"; chmod 600 "$GENIE_CONFIG.pre-lifeline-$TS.bak"

export GK_CONFIG="$GENIE_CONFIG" GK_MANIFEST="$MANIFEST" GK_URL="$LANE_URL" GK_MODEL="$LANE_MODEL" GK_KEY="$LANE_KEY"
if ! python3 - <<'PY'
import json,os,yaml,tempfile
cfg=os.environ['GK_CONFIG']; mf=os.environ['GK_MANIFEST']
key=os.environ['GK_KEY']; api='none'
if key.startswith('file:'):
    api=open(key[5:]).read().strip()
d=yaml.safe_load(open(cfg))
manifest={"config":cfg,
 "original_model":dict(d.get('model') or {}),
 "original_custom_providers":yaml.safe_dump(d.get('custom_providers') or []),
 "wrote":{"default":os.environ['GK_MODEL'],"base_url":os.environ['GK_URL'],"api_key":api}}
m=d.setdefault('model',{})
m['default']=manifest['wrote']['default']; m['base_url']=manifest['wrote']['base_url']; m['api_key']=api
cp=d.get('custom_providers')
if isinstance(cp,list):
    for p in cp:
        if isinstance(p,dict): p['extra_headers']={}   # genie key must not leak to fallback lanes
tmp=cfg+'.lifeline-tmp'
with open(tmp,'w') as f: yaml.safe_dump(d,f,sort_keys=False,allow_unicode=True)
chk=yaml.safe_load(open(tmp))
assert chk['model']['default']==manifest['wrote']['default']
os.replace(tmp,cfg)   # atomic
with open(mf,'w') as f: json.dump(manifest,f); f.flush(); os.fsync(f.fileno())
print("flip-ok")
PY
then
  ev "$EVENTS" "flip-failed"; notify "Lifeline config edit FAILED — config restored."; echo "lifeline: flip failed"; exit 1
fi

# race guard: door back? undo immediately
c=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$DOOR_URL/v1/models" 2>/dev/null) || c=000
if [ "$c" = "200" ]; then
  GK_MANIFEST="$MANIFEST" GK_CONFIG="$GENIE_CONFIG" GATEKEEPER_DIR="$DIR" GK_TS="$TS" \
    python3 "$DSG/runtime/hermes-home/scripts/lifeline-restore.py" 2>/dev/null || true
  ev "$EVENTS" "abort-race"; echo "lifeline: door returned mid-flip, undone"; exit 0
fi

if [ "$DRYRUN" = "1" ]; then echo "[dryrun] would kickstart $GENIE_LABEL"; else
  launchctl kickstart -k "gui/$(id -u)/$GENIE_LABEL" && echo "kicked $GENIE_LABEL"
fi
python3 - "$MARKER" <<'PY'
import json,os,sys
m={"ts":os.environ.get('GK_TS'), "lane":os.environ.get('GK_URL'), "model":os.environ.get('GK_MODEL'),
   "manifest":os.environ.get('GK_MANIFEST'), "note":"Genie brain is on direct lane. Brief: docs/plans/genie-failsafe.md"}
with open(sys.argv[1],'w') as f: json.dump(m,f); f.flush(); os.fsync(f.fileno())
PY
ev "$EVENTS" "lifeline-active" "{\"lane\":\"$LANE_URL\",\"model\":\"$LANE_MODEL\"}"
notify "LIFELINE FIRED: Genie flipped to $LANE_MODEL @ $LANE_URL (door was dark ${STREAK} cycles)."
echo "lifeline: ACTIVE on $LANE_MODEL $LANE_URL"
