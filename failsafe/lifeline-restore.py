#!/usr/bin/env python3
"""Field-level restore of the lifeline flip — manifest-verified, idempotent.
Run by the AWAKE Genie (never auto-scheduled): genie-lifeline.sh restore
Only restores fields if they still match what the lifeline wrote."""
import json, os, sys, yaml
DSG = os.environ.get('DSG', os.path.expanduser('~/DSG'))
DIR = os.environ.get('GATEKEEPER_DIR', f'{DSG}/runtime/gate-keeper')
GENIE_CONFIG = os.environ.get('GATEKEEPER_GENIE_CONFIG', f'{DSG}/runtime/hermes-home/config.yaml')
MANIFEST = os.environ.get('GK_MANIFEST', f'{DIR}/lifeline-manifest.json')
MARKER = os.environ.get('GK_MARKER', f'{DSG}/runtime/GENIE-FAILSAFE-ACTIVE')
EVENTS = os.environ.get('GATEKEEPER_EVENTS', f'{DIR}/events.jsonl')
TS = os.environ.get('GK_TS', '')

def ev(t):
    with open(EVENTS, 'a') as f:
        f.write(json.dumps({"ts": TS, "type": t}, separators=(',', ':')) + "\n"); f.flush(); os.fsync(f.fileno())

m = json.load(open(MANIFEST))
d = yaml.safe_load(open(GENIE_CONFIG))
cur = d.get('model') or {}
wrote = m['wrote']
if cur.get('default') != wrote['default'] or cur.get('base_url') != wrote['base_url']:
    print("CONFLICT: config does not match manifest 'wrote' state — refusing (owner edits present).")
    ev("restore-conflict"); sys.exit(2)
d['model'] = dict(m['original_model'])          # exact original fields back
d['custom_providers'] = yaml.safe_load(m['original_custom_providers'])
tmp = GENIE_CONFIG + '.restore-tmp'
with open(tmp, 'w') as f:
    yaml.safe_dump(d, f, sort_keys=False, allow_unicode=True)
chk = yaml.safe_load(open(tmp))
assert chk['model'].get('default') == m['original_model'].get('default')
os.replace(tmp, GENIE_CONFIG)
if os.path.exists(MARKER): os.remove(MARKER)
os.replace(MANIFEST, MANIFEST + '.done-' + TS.replace(':', ''))
ev("lifeline-restored")
print("restore-ok: fields returned, marker removed")
