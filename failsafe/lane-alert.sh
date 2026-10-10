#!/bin/bash
# lane-alert.sh — Telegram-bound lane-down alerter for the Star Gate fleet.
# Reads the newest gate-keeper journal entry; prints an alert line ONLY when
# the verdict is lane_down (deduped per incident signature), silent otherwise.
# Designed for a Hermes cron job with no_agent=True, deliver=telegram:
# stdout IS the Telegram message; silence = no message. Also appends to
# alerts.log (local escalation channel).
set -u
DSG="${DSG:-$HOME/DSG}"
DIR="${GATEKEEPER_DIR:-$DSG/runtime/gate-keeper}"
JOURNAL="$DIR/journal.jsonl"
STATE="$DIR/.lane-alert-state"
ALERTS="$DIR/alerts.log"
[ -s "$JOURNAL" ] || exit 0
python3 - "$JOURNAL" "$STATE" "$ALERTS" <<'PY'
import json, os, sys
journal, state, alerts = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    last = json.loads(open(journal).read().strip().split('\n')[-1])
except Exception:
    sys.exit(0)
verdict = last.get('verdict', '') or ''
if 'lane_down' not in verdict:
    if os.path.exists(state) and open(state).read().strip():
        open(state, 'w').write('')  # incident over; re-arm
    sys.exit(0)
lanes = last.get('lanes', {}) or {}
dark = sorted(k for k, v in lanes.items() if v == 'down')
if last.get('m3') == 'down':
    dark.append('m3')
sig = ':'.join(dark) or 'unknown'
seen = ''
if os.path.exists(state):
    seen = open(state).read().strip()
if seen == sig:
    sys.exit(0)  # same incident, already alerted
open(state, 'w').write(sig)
with open(alerts, 'a') as f:
    f.write(f"{last.get('ts','')} {verdict}\n")
print(f"🚨 STAR GATE LANE DOWN — {sig} (m3 probe: {last.get('m3','-')}; gate-keeper tick {last.get('tick','?')} at {last.get('ts','?')} UTC). Restarting is automatic for glm53f-m3; this alert means it could not come back or another lane went dark. Genie has been pinged in-session too.")
PY