#!/usr/bin/env bash
# pair-rollback repair wrapper — thin shim so the watcher's Popen contract
# (bash repair.sh <lane> <token>) holds while all logic lives in repair.py.
# caffeinate -is keeps this Mac awake for the whole repair (design v2 #8).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
exec caffeinate -is python3 "$DIR/repair.py" "$@"
