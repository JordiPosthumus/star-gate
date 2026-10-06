#!/usr/bin/env python3
"""pair-rollback tripwire decision engine — pure function over assembled evidence.

Input: evidence JSON on stdin. Output: verdict JSON on stdout.
No I/O, no clock (all times passed in) — fixture-testable by construction.
See docs/plans/pair-rollback-tripwire.md v2 + 4-agent audit hardening (2026-10-06):
fail-closed on malformed/missing evidence, current-roster-health trip conjunct,
clock-skew guard, blacklist check, probe-veto relaxed only by sustained
real-traffic failures, budgets fail safe.
"""
import json
import sys
from datetime import datetime


def parse_ts(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:      # naive timestamps are never safely comparable
        return None
    return dt


def age_hours(now, ts):
    t = parse_ts(ts)
    n = parse_ts(now) if isinstance(now, str) else now
    if t is None or n is None:
        return None
    return (n - t).total_seconds() / 3600.0


def window_sum(hist, n=5):
    """Count of exact 1s in the LAST n entries; malformed shapes count as zero."""
    if not isinstance(hist, (list, tuple)):
        return 0
    return sum(1 for x in list(hist)[-n:] if x == 1)


def _is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _validate_roster(ro):
    """Return a reason string if the roster is untrustworthy, else None."""
    if ro is None:
        return "no_roster"
    if not isinstance(ro, dict):
        return "roster_schema_unknown"
    required = ("is_healthy", "drained", "operator_paused", "holds",
                "maintenance_locks", "direct_reserved", "recovery_waiting")
    if any(k not in ro for k in required):
        return "roster_schema_unknown"     # partial roster: carve-outs unreadable
    if not _is_int(ro["holds"]) or not _is_int(ro["recovery_waiting"]):
        return "malformed_roster"
    locks = ro["maintenance_locks"]
    if locks is not None and not isinstance(locks, (list, tuple)):
        return "malformed_roster"
    return None


def decide(ev):
    if not isinstance(ev, dict):
        return {"verdict": "no-trip", "reason": "malformed_evidence", "notify": False}
    now = ev.get("now")
    st = ev.get("state") if isinstance(ev.get("state"), dict) else {}
    ro = ev.get("roster")

    def no(reason, notify=False):
        return {"verdict": "no-trip", "reason": reason, "notify": notify}

    # --- environment sanity (fail-closed: unknown environment == inside grace)
    if not ev.get("gateway_reachable"):
        return no("gateway_unreachable")
    gup = ev.get("gateway_uptime_min")
    if not isinstance(gup, (int, float)) or isinstance(gup, bool) or gup < 10:
        return no("gateway_boot_grace")
    mup = ev.get("mac_uptime_min")
    if not isinstance(mup, (int, float)) or isinstance(mup, bool) or mup < 10:
        return no("boot_grace")
    if ev.get("maintenance_marker"):
        return no("maintenance")
    if ev.get("failsafe_active_lane") == ev.get("lane", "?"):
        return no("genie_failsafe_active")

    # --- roster trustworthiness: a confused roster must never arm the wire ---
    if ro is None:
        return no("no_roster")
    if not isinstance(ro, dict):
        return no("roster_schema_unknown")
    schema_err = _validate_roster(ro)
    if schema_err:
        return no(schema_err)

    # --- owner / gateway carve-outs (sacred) --------------------------------
    if ro.get("drained"):
        return no("carve_out_drained")
    if ro.get("operator_paused"):
        return no("carve_out_operator_paused")
    if ro["holds"] > 0:
        return no("carve_out_holds")
    own = ev.get("own_lock_id")
    if any(l != own for l in (ro["maintenance_locks"] or [])):
        return no("carve_out_maintenance_lock")
    if ro["recovery_waiting"] > 0:
        return no("carve_out_recovery")
    if ro.get("direct_reserved"):
        return no("carve_out_direct_reserved")

    # --- transport / identity sanity ---------------------------------------
    if not (ev.get("ssh_head_ok") and ev.get("ssh_worker_ok")):
        return no("no_data")          # watch resets neither streak nor clock
    ids = ev.get("rank_image_ids")
    if not isinstance(ids, dict):
        return no("no_data")
    hid, wid = ids.get("head"), ids.get("worker")
    if not hid or not wid:
        return no("no_data")
    if hid != wid:
        return no("rank_mismatch", True)
    if ev.get("containers_restarted_recently"):
        return no("rotation_in_flight")

    # --- rotation recency (the "backup image" gate) -------------------------
    rot_age = age_hours(now, st.get("rotation_at"))
    if rot_age is None:
        return no("no_rotation")
    if rot_age < 0:
        return no("rotation_clock_skew", True)   # future timestamps never count
    if rot_age > 24.0:
        unhealthy_now = (not ro.get("is_healthy", True)) or bool(ro.get("quarantined"))
        return no("rotation_stale", unhealthy_now)   # notify hourly, never auto-act

    # --- is the running image actually a regression? ------------------------
    if st.get("proven_image_id") is None:
        return no("no_proven_baseline", True)
    p_age = age_hours(now, st.get("proven_at"))
    if p_age is None:
        return no("proven_stale")
    if p_age < 0:
        return no("proven_clock_skew", True)
    if p_age > 24 * 7:
        return no("proven_stale", True)
    if hid == st.get("proven_image_id"):
        # running image IS the proven one: nothing to roll back to
        if (not ro.get("is_healthy", True)) or ro.get("quarantined"):
            return no("unhealthy_no_rotation", True)
        return no("no_regression")
    if st.get("proven_image_id") in (st.get("blacklist") or []):
        return no("proven_blacklisted", True)
    prov = ev.get("proven_image_present")
    if not (isinstance(prov, dict) and prov.get("head") and prov.get("worker")):
        return no("rollback_image_missing", True)

    # --- fleet capacity (the owner's "at least one spark serving" rule) -----
    # NB: the assembler must compute this from is_healthy && !drained &&
    # quarantine is None && !recovering on a FRESH roster read; repair.sh
    # re-verifies immediately before stopping ranks.
    if not ev.get("other_tf_lane_serving"):
        return no("systemic", True)

    # --- generation evidence -------------------------------------------------
    probe_ok = ev.get("gen_probe_ok")
    faults = ev.get("parse_faults_30m")
    faults = faults if _is_int(faults) else 0
    if probe_ok is None:
        return no("no_probe_this_cycle")
    if probe_ok is True and faults < 3:
        # passing probe + clean real-traffic window is a hard veto; >=3 real
        # failures in 30m override the 1-token probe (probe can pass on a
        # image that fails long prompts / streaming / tools)
        return no("probe_ok")
    if ro.get("is_healthy", True) and not ro.get("quarantined"):
        # condition 1 is evaluated NOW: history alone never trips a lane that
        # just recovered (probe flake at recovery must not kill the lane)
        return no("recovered_pending_confirmation", faults >= 1)
    if window_sum(st.get("unhealthy_hist")) < 3:
        return no("insufficient_evidence")
    if window_sum(st.get("genfail_hist")) < 3 and not (probe_ok is True and faults >= 3):
        return no("insufficient_evidence")
    if faults < 1:
        return no("insufficient_evidence")

    # --- budgets (fail-safe: missing/unparseable = stand down) --------------
    budget = ev.get("budget_rolling_1h")
    if not _is_int(budget) or budget >= 1:
        return no("budget")
    if ev.get("repair_in_flight"):
        return no("in_flight")

    return {"verdict": "trip", "reason": "all_conditions_met", "notify": True}


if __name__ == "__main__":
    ev = json.load(sys.stdin)
    print(json.dumps(decide(ev)))
