#!/usr/bin/env python3
"""Fixture suite for the pair-rollback decision engine (design doc v2, cases 1-17).

Pure-function tests: no ssh, no sockets, no clock — all evidence is synthetic.
Run: python3 fixtures.py   → prints PASS/FAIL per case, exit 1 on any fail.
"""
import copy
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from decide import decide  # noqa: E402

T0 = "2026-10-05T12:00:00.000Z"


def base_ev(**over):
    """A fully-healthy evidence dict; tests mutate from here."""
    ev = {
        "lane": "glm53exl3-56",
        "now": T0,
        "gateway_reachable": True,
        "gateway_uptime_min": 500.0,
        "mac_uptime_min": 500.0,
        "maintenance_marker": False,
        "failsafe_active_lane": None,
        "own_lock_id": None,
        "roster": {
            "is_healthy": True, "quarantined": False, "drained": False,
            "operator_paused": False, "holds": 0, "maintenance_locks": [],
            "direct_reserved": False, "recovery_waiting": 0, "completed": 100,
        },
        "ssh_head_ok": True, "ssh_worker_ok": True,
        "rank_image_ids": {"head": "sha256:aaa", "worker": "sha256:aaa"},
        "rank_mismatch": False,
        "containers_restarted_recently": False,
        "gen_probe_ok": True, "gen_probe_reason": "",
        "parse_faults_30m": 0,
        "other_tf_lane_serving": True,
        "proven_image_present": {"head": True, "worker": True},
        "state": {
            "proven_image_id": "sha256:aaa", "proven_image_tag": "tensorfold-glm53:proven-x",
            "proven_at": "2026-10-04T12:00:00.000Z",
            "rotation_at": "2026-10-05T06:00:00.000Z",  # 6h ago, within 24h
            "rotation_from": "sha256:bbb", "rotation_to": "sha256:ccc",
            "unhealthy_hist": [1, 1, 1, 1, 1],
            "genfail_hist": [1, 1, 1, 1, 1],
            "blacklist": [], "cycle_count": 99,
        },
        "budget_rolling_1h": 0,
        "repair_in_flight": False,
    }
    ev.update(over)
    return ev


def trip_image(st=None):
    """Evidence where the RUNNING image differs from proven (regression present)."""
    ev = base_ev()
    ev["rank_image_ids"] = {"head": "sha256:ccc", "worker": "sha256:ccc"}
    ev["state"]["last_observed_image_id"] = "sha256:ccc"
    ev["state"]["rotation_to"] = "sha256:ccc"
    if st is not None:
        ev["state"].update(st)
    return ev


CASES = []


def case(name, expect_verdict, expect_reason=None, expect_notify=None):
    def deco(fn):
        CASES.append((name, expect_verdict, expect_reason, expect_notify, fn))
        return fn
    return deco


# 1. Healthy lane
@case("1 healthy lane → no-trip", "no-trip")
def c1():
    return base_ev()


# 2. Quarantined but direct probe OK → tunnel-only failure, no trip
@case("2 quarantined + probe OK → no-trip (probe_ok)", "no-trip", "probe_ok")
def c2():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["roster"]["quarantined"] = True
    return ev


# 3. Down, image == proven → nothing to roll back to
@case("3 down, image==proven → no-trip (unhealthy_no_rotation, notify)", "no-trip",
      "unhealthy_no_rotation", True)
def c3():
    ev = base_ev()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    return ev


# 4. THE trip: down, regression image, all evidence, other lane serving
@case("4 down+regression+evidence → TRIP", "trip", "all_conditions_met", True)
def c4():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    return ev


# 5. Rotation stale (>24h) → notify-only
@case("5 rotation 48h ago → no-trip (rotation_stale, notify)", "no-trip",
      "rotation_stale", True)
def c5():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["rotation_at"] = "2026-10-03T12:00:00.000Z"
    return ev


# 6. All TF lanes down → systemic
@case("6 all lanes down → no-trip (systemic, notify)", "no-trip", "systemic", True)
def c6():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["other_tf_lane_serving"] = False
    return ev


# 7. Proven image missing on worker
@case("7 proven image missing → no-trip (rollback_image_missing, notify)", "no-trip",
      "rollback_image_missing", True)
def c7():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["proven_image_present"] = {"head": True, "worker": False}
    return ev


# 8. Owner-drained → carve-out
@case("8 owner-drained → no-trip (carve_out_drained)", "no-trip", "carve_out_drained")
def c8():
    ev = trip_image()
    ev["roster"]["drained"] = True
    return ev


# 9. Maintenance marker
@case("9 maintenance marker → no-trip", "no-trip", "maintenance")
def c9():
    ev = trip_image()
    ev["maintenance_marker"] = True
    return ev


# 10. Gateway unreachable
@case("10 gateway unreachable → no-trip (gateway_unreachable)", "no-trip",
      "gateway_unreachable")
def c10():
    ev = trip_image()
    ev["gateway_reachable"] = False
    ev["roster"] = None
    return ev


# 11. Budget exhausted
@case("11 budget exhausted → no-trip (budget)", "no-trip", "budget")
def c11():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["budget_rolling_1h"] = 1
    return ev


# 12. Rollback in flight
@case("12 repair in flight → no-trip (in_flight)", "no-trip", "in_flight")
def c12():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["repair_in_flight"] = True
    return ev


# 13. Mac just booted
@case("13 mac uptime 3 min → no-trip (boot_grace)", "no-trip", "boot_grace")
def c13():
    ev = trip_image()
    ev["mac_uptime_min"] = 3.0
    return ev


# 14. Split ranks → rank_mismatch
@case("14 split ranks → no-trip (rank_mismatch, notify)", "no-trip", "rank_mismatch",
      True)
def c14():
    ev = trip_image()
    ev["rank_image_ids"] = {"head": "sha256:ccc", "worker": "sha256:ddd"}
    ev["rank_mismatch"] = True
    return ev


# 15. No generation probe this cycle → insufficient evidence, never trip blind
@case("15 no probe this cycle → no-trip (no_probe_this_cycle)", "no-trip",
      "no_probe_this_cycle")
def c15():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["parse_faults_30m"] = 2
    ev["gen_probe_ok"] = None
    return ev


# 16. Insufficient persistence: 2 of last 5 unhealthy
@case("16 weak persistence (2/5) → no-trip (insufficient_evidence)", "no-trip",
      "insufficient_evidence")
def c16():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["unhealthy_hist"] = [1, 0, 1, 0, 0]
    return ev


# 17. Probe OK despite roster-down (tunnel flake only) → probe_ok
@case("17 down roster but probe OK → no-trip (probe_ok)", "no-trip", "probe_ok")
def c17():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    return ev


# 18. No proven baseline yet → notify, never trip
@case("18 no proven baseline → no-trip (no_proven_baseline, notify)", "no-trip",
      "no_proven_baseline", True)
def c18():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["proven_image_id"] = None
    return ev


# 19. Failsafe active on this lane → stand down
@case("19 genie failsafe active → no-trip (genie_failsafe_active)", "no-trip",
      "genie_failsafe_active")
def c19():
    ev = trip_image()
    ev["failsafe_active_lane"] = "glm53exl3-56"
    return ev


# 20. Operator paused → carve-out
@case("20 operator paused → no-trip (carve_out_operator_paused)", "no-trip",
      "carve_out_operator_paused")
def c20():
    ev = trip_image()
    ev["roster"]["operator_paused"] = True
    return ev


# 21. Foreign maintenance lock → carve-out
@case("21 foreign maintenance lock → no-trip (carve_out_maintenance_lock)", "no-trip",
      "carve_out_maintenance_lock")
def c21():
    ev = trip_image()
    ev["roster"]["maintenance_locks"] = ["someone-else"]
    return ev


# 22. Containers restarted <10 min ago → rotation in flight (NCCL boot guard)
@case("22 container just restarted → no-trip (rotation_in_flight)", "no-trip",
      "rotation_in_flight")
def c22():
    ev = trip_image()
    ev["containers_restarted_recently"] = True
    return ev


# 23. Direct reserved → carve-out
@case("23 direct reserved → no-trip (carve_out_direct_reserved)", "no-trip",
      "carve_out_direct_reserved")
def c23():
    ev = trip_image()
    ev["roster"]["direct_reserved"] = True
    return ev


# 24. Recovery waiting → carve-out
@case("24 recovery waiting → no-trip (carve_out_recovery)", "no-trip",
      "carve_out_recovery")
def c24():
    ev = trip_image()
    ev["roster"]["recovery_waiting"] = 2
    return ev


# ===== audit hardening (2026-10-06, 4-agent red-team) — hole-fixes 29-39 =====

# 29. Lane just recovered: history says down, roster healthy NOW — never trip
@case("29 recovered lane + probe flake → no-trip (recovered_pending_confirmation)",
      "no-trip", "recovered_pending_confirmation")
def c29():
    ev = trip_image()
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["roster"]["is_healthy"] = True
    ev["state"]["unhealthy_hist"] = [1, 1, 1, 0, 0]
    return ev


# 30. Partial roster disables every carve-out → stand down
@case("30 partial roster → no-trip (roster_schema_unknown)", "no-trip",
      "roster_schema_unknown")
def c30():
    ev = trip_image()
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["roster"] = {"is_healthy": False}
    return ev


# 31. Missing budget evidence = stand down, never fail-open
@case("31 missing budget → no-trip (budget)", "no-trip", "budget")
def c31():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    del ev["budget_rolling_1h"]
    return ev


# 32. Future rotation timestamp (clock skew) never counts as recent
@case("32 future rotation_at → no-trip (rotation_clock_skew, notify)", "no-trip",
      "rotation_clock_skew", True)
def c32():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["rotation_at"] = "2026-10-05T18:00:00.000Z"
    return ev


# 33. Naive timestamp must degrade to no_rotation, never crash
@case("33 naive rotation_at → no-trip (no_rotation)", "no-trip", "no_rotation")
def c33():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["rotation_at"] = "2026-10-05T06:00:00"
    return ev


# 34. String-typed roster counter → malformed, never crash
@case("34 holds as string → no-trip (malformed_roster)", "no-trip",
      "malformed_roster")
def c34():
    ev = trip_image()
    ev["roster"]["holds"] = "2"
    return ev


# 35. String budget → stand down, never crash or trip
@case("35 budget as string → no-trip (budget)", "no-trip", "budget")
def c35():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["budget_rolling_1h"] = "1"
    return ev


# 36. Malformed hist entries → read as no evidence, never crash
@case("36 string hist entries → no-trip (insufficient_evidence)", "no-trip",
      "insufficient_evidence")
def c36():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["unhealthy_hist"] = ["1", "1", "1", "1", "1"]
    return ev


# 37. Scalar rank_image_ids → no_data, never crash
@case("37 scalar rank_image_ids → no-trip (no_data)", "no-trip", "no_data")
def c37():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["rank_image_ids"] = "sha256:ccc"
    return ev


# 38. Blacklisted proven image is never a rollback target
@case("38 blacklisted proven image → no-trip (proven_blacklisted, notify)",
      "no-trip", "proven_blacklisted", True)
def c38():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["blacklist"] = ["sha256:aaa"]
    return ev


# 39. Missing gateway uptime keeps boot grace (fail-closed)
@case("39 missing gateway uptime → no-trip (gateway_boot_grace)", "no-trip",
      "gateway_boot_grace")
def c39():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    del ev["gateway_uptime_min"]
    return ev


# ===== behavior pins 40-56 (refactor resistance) =====

# 40. Sliding window: flapping 3-of-5 trips (not a consecutive streak)
@case("40 flapping 3-of-5 → TRIP (sliding window)", "trip", "all_conditions_met",
      True)
def c40():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["unhealthy_hist"] = [1, 0, 1, 0, 1]
    ev["state"]["genfail_hist"] = [1, 0, 1, 0, 1]
    return ev


# 41. Window uses the LAST 5 entries (old failures age out)
@case("41 old failures age out → no-trip (insufficient_evidence)", "no-trip",
      "insufficient_evidence")
def c41():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["unhealthy_hist"] = [1, 1, 1, 0, 0, 0, 0, 0]
    ev["state"]["genfail_hist"] = [1, 1, 1, 0, 0, 0, 0, 0]
    return ev


# 42. genfail_hist is an independent conjunct
@case("42 weak genfail hist → no-trip (insufficient_evidence)", "no-trip",
      "insufficient_evidence")
def c42():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["unhealthy_hist"] = [1, 1, 1, 1, 1]
    ev["state"]["genfail_hist"] = [0, 0, 1, 0, 0]
    return ev


# 43. The repair's own lock must not carve itself out (self-wedge guard)
@case("43 own lock in roster → TRIP", "trip", "all_conditions_met", True)
def c43():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["own_lock_id"] = "watch-56"
    ev["roster"]["maintenance_locks"] = ["watch-56"]
    return ev


# 44. Failsafe on a DIFFERENT lane must not wedge all lanes
@case("44 foreign-lane failsafe → TRIP", "trip", "all_conditions_met", True)
def c44():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["failsafe_active_lane"] = "glm53exl3-12"
    return ev


# 45. Quarantined-only lane (is_healthy still true) is trip-eligible
@case("45 quarantined-only → TRIP", "trip", "all_conditions_met", True)
def c45():
    ev = trip_image()
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["roster"]["quarantined"] = True
    return ev


# 46. One-sided ssh failure is a no-data cycle, never failure evidence
@case("46 worker ssh down → no-trip (no_data)", "no-trip", "no_data")
def c46():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["ssh_worker_ok"] = False
    return ev


# 47. Missing rotation_at is no_rotation, never a phantom rotation
@case("47 missing rotation_at → no-trip (no_rotation)", "no-trip", "no_rotation")
def c47():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    del ev["state"]["rotation_at"]
    return ev


# 48. 8-day-old proven baseline → proven_stale with notify
@case("48 proven 8 days old → no-trip (proven_stale, notify)", "no-trip",
      "proven_stale", True)
def c48():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["proven_at"] = "2026-09-27T12:00:00.000Z"
    return ev


# 49. holds > 0 carve-out (the only carve-out branch with no prior fixture)
@case("49 holds > 0 → no-trip (carve_out_holds)", "no-trip", "carve_out_holds")
def c49():
    ev = trip_image()
    ev["roster"]["holds"] = 1
    return ev


# 50. Gateway up but roster None → no_roster (standalone guard)
@case("50 roster None while gateway up → no-trip (no_roster)", "no-trip",
      "no_roster")
def c50():
    ev = trip_image()
    ev["roster"] = None
    return ev


# 51. Boundary: exactly 1 parse fault is sufficient evidence
@case("51 parse_faults=1 → TRIP (boundary)", "trip", "all_conditions_met", True)
def c51():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 1
    return ev


# 52. Boundary: rotation exactly 24h old is still fresh (strict >)
@case("52 rotation exactly 24h → TRIP (boundary)", "trip", "all_conditions_met",
      True)
def c52():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["state"]["rotation_at"] = "2026-10-04T12:00:00.000Z"
    return ev


# 53. Stale rotation on a HEALTHY lane notifies nothing
@case("53 stale rotation + healthy lane → no-trip (rotation_stale, silent)",
      "no-trip", "rotation_stale", False)
def c53():
    ev = trip_image()
    ev["state"]["rotation_at"] = "2026-10-03T10:00:00.000Z"
    return ev


# 54. Live docker IDs are authoritative over state bookkeeping drift
@case("54 rank IDs drift from state → TRIP (IDs authoritative)", "trip",
      "all_conditions_met", True)
def c54():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["rank_image_ids"] = {"head": "sha256:ddd", "worker": "sha256:ddd"}
    ev["state"]["last_observed_image_id"] = "sha256:ccc"
    ev["state"]["rotation_to"] = "sha256:ccc"
    return ev


# 55. gen_probe_ok absent == None (missing key can never blind-trip)
@case("55 gen_probe_ok absent → no-trip (no_probe_this_cycle)", "no-trip",
      "no_probe_this_cycle")
def c55():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["parse_faults_30m"] = 2
    del ev["gen_probe_ok"]
    return ev


# 56. The rank_mismatch FLAG is dead code; resolved IDs rule
@case("56 rank_mismatch flag ignored, IDs equal → TRIP", "trip",
      "all_conditions_met", True)
def c56():
    ev = trip_image()
    ev["roster"]["is_healthy"] = False
    ev["gen_probe_ok"] = False
    ev["parse_faults_30m"] = 2
    ev["rank_mismatch"] = True
    return ev


def run():
    fails = 0
    for name, verdict, reason, notif, fn in CASES:
        ev = fn()
        try:
            v = decide(ev)
        except Exception as e:
            print(f"FAIL {name}: exception {e!r}")
            fails += 1
            continue
        problems = []
        if v["verdict"] != verdict:
            problems.append(f"verdict={v['verdict']} want {verdict}")
        if reason and v.get("reason") != reason:
            problems.append(f"reason={v.get('reason')!r} want {reason!r}")
        if notif is not None and bool(v.get("notify")) != notif:
            problems.append(f"notify={v.get('notify')} want {notif}")
        if verdict == "trip" and v.get("notify") is not True:
            problems.append("trip must notify")
        if problems:
            print(f"FAIL {name}: {'; '.join(problems)}")
            fails += 1
        else:
            print(f"PASS {name}")
    print(f"\n{len(CASES)-fails}/{len(CASES)} fixtures pass")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(run())