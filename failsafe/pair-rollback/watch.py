#!/usr/bin/env python3
"""pair-rollback watch — observe, maintain state, decide, dispatch repair (INERT w/o ARMED).

Run every 60s via launchd. Observe-only by construction: the ONLY thing it can
spawn is repair.sh, which refuses without runtime/pair-rollback/ARMED.
"""
import json
import os
import shlex
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from decide import decide  # noqa: E402

BASE = Path(os.environ.get("DSG_HOME", Path(__file__).resolve().parents[2]))
PR_DIR = BASE / "runtime/pair-rollback"
STATE_F = PR_DIR / "state.json"
JOURNAL_F = PR_DIR / "journal.jsonl"
LOCK_F = PR_DIR / "repair.lock"
HEARTBEAT_F = PR_DIR / "heartbeat"
ARMED_F = PR_DIR / "ARMED"
SOCK = BASE / "runtime/control.sock"
GW_LOG = BASE / "runtime/gateway.log"
MAINT_MARKER = Path("/tmp/dsg-watchdog-maintenance")
FAILSAFE_MARKER = BASE / "runtime/GENIE-FAILSAFE-ACTIVE"
CFG = json.loads((HERE / "lanes.json").read_text())

CONTAINER = CFG["container"]
MODEL_ID = CFG["model_id"]
KIT_DIR = CFG["kit_dir"]
CYCLE_S = 60
PROBE_EVERY_N = 10          # periodic heartbeat generation probe for proven lanes
ROTATION_RECENCY_H = 24.0
NOTIFY_DEDUPE_S = 3600

PROBE_BODY = json.dumps({
    "model": MODEL_ID,
    "messages": [{"role": "user", "content": "Reply with OK."}],
    "max_tokens": 16,
    "temperature": 0,
    "chat_template_kwargs": {"thinking": "off"},
})


def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def sh(cmd, timeout=30):
    """Run a command (argv list = no shell parsing, str = legacy), return (ok, stdout)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, r.stdout
    except subprocess.TimeoutExpired:
        return False, ""
    except FileNotFoundError:
        return False, ""


def journal(event, **fields):
    line = json.dumps({"time": iso(now()), "event": event, **fields})
    try:
        with open(JOURNAL_F, "a") as f:
            f.write(line + "\n")
    except OSError:
        # loud local notification; journaling is the tripwire's memory
        notify("pair-rollback", "JOURNAL WRITE FAILED — tripwire blind, check disk")


def notify(title, msg):
    # escape for AppleScript source (audit T2: a stray quote kills all alerts)
    def esc(s):
        return str(s).replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(["osascript", "-e",
                    f'display notification "{esc(msg)[:180]}" with title "{esc(title)}" sound name "Glass"'],
                   capture_output=True)


def atomic_write(path, data):
    tmp = str(path) + ".tmp"
    with open(tmp, "w") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def load_state():
    """Returns (state, corrupt_flag). Never silently resets a corrupt state."""
    PR_DIR.mkdir(parents=True, exist_ok=True)
    if not STATE_F.exists():
        return {"lanes": {}}, False
    try:
        st = json.loads(STATE_F.read_text())
        if not isinstance(st, dict) or "lanes" not in st:
            raise ValueError("schema")
        return st, False
    except Exception:
        return {"lanes": {}}, True


def save_state(st):
    atomic_write(STATE_F, json.dumps(st, indent=1, sort_keys=True))


def lane_state(st, lane):
    return st["lanes"].setdefault(lane, {
        "proven_image_id": None, "proven_image_tag": None, "proven_at": None,
        "proven_had_traffic": False, "proven_completed_base": None, "proving_since": None,
        "proving_completed_base": None,
        "last_observed_image_id": None, "rotation_at": None,
        "rotation_from": None, "rotation_to": None,
        "blacklist": [], "unhealthy_hist": [], "genfail_hist": [],
        "cycle_count": 0, "last_notify": {}, "repair_pending_resume": False,
        "repair_booting": False, "last_gen_ok": None,
    })


def push(hist, val, cap=10):
    hist.append(1 if val else 0)
    del hist[:-cap]


def dedupe_ok(st_lane, key, seconds=NOTIFY_DEDUPE_S):
    last = st_lane.get("last_notify", {}).get(key)
    n = now()
    if last and (n - datetime.fromisoformat(last.replace("Z", "+00:00"))).total_seconds() < seconds:
        return False
    st_lane.setdefault("last_notify", {})[key] = iso(n)
    return True


def control_get(path):
    ok, out = sh(["curl", "-s", "-m", "5", "--unix-socket", str(SOCK), f"http://localhost{path}"])
    if not ok:
        return None
    try:
        return json.loads(out)
    except Exception:
        return None


def control_post(path, body):
    """POST JSON to the control socket via stdin (no shell interpolation)."""
    try:
        r = subprocess.run(["curl", "-s", "-m", "15", "--unix-socket", str(SOCK), "-X", "POST",
                            f"http://localhost{path}", "-H", "Content-Type: application/json"],
                           input=json.dumps(body), capture_output=True, text=True, timeout=20)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"raw": r.stdout}


def gateway_uptime_min():
    ok, out = sh(["pgrep", "-f", "gateway.mjs.*config.local.json"])
    if not ok or not out.strip():
        return None
    pid = out.strip().splitlines()[0]
    # macOS ps has no etimes keyword; etime= gives [[dd-]hh:]mm:ss
    ok, out = sh(["ps", "-p", pid, "-o", "etime="])
    if not ok or "-" not in out and ":" not in out:
        return None
    try:
        total = 0
        rest = out.strip()
        if "-" in rest:
            days, rest = rest.split("-", 1)
            total += int(days) * 86400
        parts = [int(p) for p in rest.split(":")]
        if len(parts) == 3:
            total += parts[0] * 3600 + parts[1] * 60 + parts[2]
        elif len(parts) == 2:
            total += parts[0] * 60 + parts[1]
        else:
            return None
        return total / 60.0
    except Exception:
        return None


def mac_uptime_min():
    ok, out = sh(["sysctl", "-n", "kern.boottime"])
    if not ok:
        return None
    import re
    m = re.search(r"sec = (\d+)", out)
    if not m:
        return None
    return (now().timestamp() - int(m.group(1))) / 60.0


def rank_inspect(host):
    """(ok, image_id, started_recently, restart_count) — docker inspect the rank."""
    ok, out = _ssh_args(host, ["docker", "inspect", "-f",
                               "{{.Image}}|{{.State.StartedAt}}|{{.RestartCount}}",
                               CONTAINER], timeout=20)
    if not ok or "|" not in out:
        return False, None, False, 0
    try:
        img, started, restarts = out.strip().split("|", 2)
        # docker emits nanosecond timestamps; python <3.11 fromisoformat only
        # accepts ≤6 fractional digits — truncate to microseconds
        head_ts, _, frac = started.partition(".")
        if frac:
            frac_digits = "".join(c for c in frac if c.isdigit())
            started = f"{head_ts}.{frac_digits[:6]}{frac[len(frac_digits):]}"
        st = datetime.fromisoformat(started.replace("Z", "+00:00"))
        recent = (now() - st).total_seconds() < 600  # 10 min
        try:
            rc = int(restarts)
        except ValueError:
            rc = 0
        return True, img, recent, rc
    except Exception:
        return True, None, False, 0


def _ssh_args(host, remote_argv, stdin_data=None, timeout=40):
    """Run ssh with argv semantics for the REMOTE command.

    ssh concatenates post-host args with spaces and the REMOTE shell parses
    that string — so metacharacters (|, spaces) in e.g. docker templates would
    be misread as shell syntax. Passing shlex.join(remote_argv) as ONE ssh
    argument makes the remote shell re-parse it back into exactly remote_argv.
    Returns (ok, stdout).
    """
    argv = ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", host,
            shlex.join(remote_argv)]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                           input=stdin_data)
        return r.returncode == 0, r.stdout
    except subprocess.TimeoutExpired:
        return False, ""
    except FileNotFoundError:
        return False, ""


# curl -w suffix: newline then http_code, so body and code split cleanly
_CURL_MARK = "\n%{http_code}"


def gen_probe(host):
    """Real generation probe direct to the head's :8888. Returns (ok, reason).

    Body is piped via ssh stdin (never interpolated into a command line);
    curl appends the http_code as the final line; validation happens locally.
    """
    stdin = PROBE_BODY + "\n"
    remote_argv = ["curl", "-s", "-m", "25", "-w", _CURL_MARK,
                   "-X", "POST", "http://127.0.0.1:8888/v1/chat/completions",
                   "-H", "Content-Type:application/json", "--data-binary", "@-"]
    ok, out = _ssh_args(host, remote_argv, stdin_data=stdin, timeout=45)
    if not ok:
        return False, "ssh_or_curl_failed"
    out = out.strip()
    if "\n" not in out:
        return False, "no_response"
    body, code = out.rsplit("\n", 1)
    if code.strip() != "200":
        return False, f"http_{code.strip() or 'none'}"
    try:
        d = json.loads(body)
        content = (d.get("choices") or [{}])[0].get("message", {}).get("content")
        return (bool(content), "" if content else "empty_content")
    except Exception:
        return False, "malformed_body"


def parse_faults_30m(lane):
    """Count this lane's parse faults + upstream errors in the last 30 min.

    Tails only the last ~2 MiB of the gateway log (today's jam log was ~1 GiB;
    reading it whole every 60s cycle would hammer the disk).
    """
    try:
        with open(GW_LOG, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 2 * 1024 * 1024))
            chunk = f.read().decode("utf-8", errors="ignore")
        lines = chunk.splitlines()
    except OSError:
        return 0
    count = 0
    cutoff = now().timestamp() - 1800
    oldest_ts = None
    for line in reversed(lines):
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = d.get("time", "")
        try:
            ts = datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        oldest_ts = ts
        if ts < cutoff:
            break
        if d.get("node") != lane:
            continue
        if d.get("event") == "upstream_parse_fault" or \
           (d.get("event") == "request_finished" and d.get("outcome") in (
               "upstream_error", "upstream_engine_error", "upstream_stream_error",
               "upstream_aborted", "connection_closed", "incomplete_sse")):
            count += 1
    if oldest_ts is not None and oldest_ts > cutoff:
        # tail window doesn't even reach 30 min back — treat as "no evidence"
        # rather than a clean zero (log may be rotating); conservative: return
        # what we counted, decide() demands >=1, so absence of evidence still
        # blocks a trip. Acceptable: a real regression produces constant faults.
        pass
    return count


def failsafe_active_lane():
    try:
        txt = FAILSAFE_MARKER.read_text(errors="ignore")
    except OSError:
        return None
    for lane in (l["id"] for l in CFG["lanes"]):
        if lane in txt:
            return lane
    return None


def lock_in_flight():
    try:
        lk = json.loads(LOCK_F.read_text())
    except Exception:
        return False
    pid, hb = lk.get("pid"), lk.get("heartbeat_ts", 0)
    if not pid:
        return False
    ok, _ = sh(["ps", "-p", str(pid), "-o", "comm="])
    if not ok:
        return False
    return (now().timestamp() - hb) < 180


def budget_rolling_1h():
    if not JOURNAL_F.exists():
        return 0
    try:
        lines = JOURNAL_F.read_text(errors="ignore").splitlines()
    except OSError:
        return 0
    count = 0
    cutoff = now().timestamp() - 3600
    for line in lines:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("event") != "rollback_start":
            continue
        t = datetime.fromisoformat(d["time"].replace("Z", "+00:00")).timestamp()
        if t >= cutoff:
            count += 1
    return count


def resolve_tag_id(host, tag):
    ok, out = _ssh_args(host, ["docker", "image", "inspect", "--format",
                               "{{.Id}}", tag], timeout=20)
    return out.strip() if ok and out.strip().startswith("sha256:") else None


def other_tf_lane_serving(lane_id, roster_all):
    """True iff at least one OTHER TF lane can actually serve.

    Strict per audit: stale is_healthy with a live quarantine/recovery must
    NOT count — the 45-min rollback boot would otherwise leave zero sparks.
    Scoped to TF lanes only (the M3/qwen never make a TF rollback systemic-safe).
    """
    for lc in CFG["lanes"]:
        if lc["id"] == lane_id:
            continue
        w = (roster_all or {}).get(lc["id"])
        if w and w.get("is_healthy") and not w.get("drained") \
                and w.get("quarantine") is None and not (w.get("recovery_waiting") or 0):
            return True
    return False


def image_id_present(host, image_id):
    """True iff the exact image ID exists in docker's store on host."""
    ok, out = _ssh_args(host, ["docker", "image", "inspect", "--format",
                               "{{.Id}}", image_id], timeout=20)
    return bool(ok and out.strip() == image_id)


def evidence_for(lane_cfg, st, lane, gw_reachable, roster, roster_all, inspect):
    head, worker = lane_cfg["head"], lane_cfg["worker"]
    hok, hid, hrecent, _hrc = inspect["head"]
    wok, wid, wrecent, _wrc = inspect["worker"]
    ssh_head_ok = hok
    ssh_worker_ok = wok
    if roster and (not roster.get("is_healthy", True) or roster.get("quarantine") is not None):
        probe_ok, probe_reason = gen_probe(head)
    elif lane.get("proving_since"):
        probe_ok, probe_reason = gen_probe(head)
    elif lane.get("cycle_count", 0) % PROBE_EVERY_N == 0:
        probe_ok, probe_reason = gen_probe(head)
    else:
        probe_ok, probe_reason = None, None

    completed = roster.get("completed") if roster else None
    other_serving = other_tf_lane_serving(lane_cfg["id"], roster_all)

    prov_present = None
    if lane.get("proven_image_id"):
        # presence checked by IMAGE ID (audit: the pin tag may not exist yet;
        # an ID in docker's store is the real rollback prerequisite)
        prov_present = {"head": image_id_present(head, lane["proven_image_id"]),
                        "worker": image_id_present(worker, lane["proven_image_id"])}

    return {
        "lane": lane_cfg["id"],
        "now": iso(now()),
        "gateway_reachable": gw_reachable,
        "gateway_uptime_min": gateway_uptime_min(),
        "mac_uptime_min": mac_uptime_min(),
        "maintenance_marker": MAINT_MARKER.exists(),
        "failsafe_active_lane": failsafe_active_lane(),
        "own_lock_id": None,
        "roster": None if roster is None else {
            "is_healthy": roster.get("is_healthy", False),
            "quarantined": roster.get("quarantine") is not None,
            "drained": bool(roster.get("drained")),
            "operator_paused": bool(roster.get("operator_paused")),
            "holds": len(roster.get("holds") or []),
            "maintenance_locks": [l.get("id") for l in (roster.get("maintenance_locks") or []) if isinstance(l, dict)],
            "direct_reserved": bool(roster.get("direct_reserved")),
            "recovery_waiting": roster.get("recovery_waiting") or 0,
            "completed": completed,
        },
        "ssh_head_ok": ssh_head_ok, "ssh_worker_ok": ssh_worker_ok,
        "rank_image_ids": {"head": hid, "worker": wid},
        "rank_mismatch": bool(hid and wid and hid != wid),
        "containers_restarted_recently": bool(hrecent or wrecent),
        "gen_probe_ok": probe_ok,
        "gen_probe_reason": probe_reason,
        "parse_faults_30m": parse_faults_30m(lane_cfg["id"]),
        "other_tf_lane_serving": other_serving,
        "proven_image_present": prov_present,
        "state": lane,
        "budget_rolling_1h": budget_rolling_1h(),
        "repair_in_flight": lock_in_flight(),
    }


def main():
    once = "--once" in sys.argv
    state, corrupt = load_state()
    if corrupt:
        # keep forensics: the corrupt bytes are the only record of the baseline
        try:
            os.replace(str(STATE_F), str(PR_DIR / f"state.json.corrupt-{now().strftime('%Y%m%d-%H%M%S')}"))
        except OSError:
            pass
        notify("pair-rollback", "state.json corrupt — reinitialized; proving windows reset")
        journal("state_corrupt_reinit")
    HEARTBEAT_F.write_text(iso(now()))

    # single-instance guard: a manual --once while launchd runs, or a duplicate
    # label, must never double-dispatch repairs (audit T2)
    global _LOCK_FH
    _LOCK_FH = open(PR_DIR / "watcher.lock", "w")
    import fcntl
    try:
        fcntl.flock(_LOCK_FH, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return  # another watcher instance holds the lock; do nothing

    # repair progress channel (audit T2: the ready_to_resume safety net was
    # dead because the watcher had no way to learn repair phase)
    repair_status = None
    try:
        repair_status = json.loads((PR_DIR / "repair-status.json").read_text())
    except Exception:
        repair_status = None

    gw_reachable = control_get("/workers") is not None
    roster_all = control_get("/workers") if gw_reachable else None
    roster_map = {}
    if isinstance(roster_all, dict):
        roster_map = {w["id"]: w for w in roster_all.get("workers", [])}

    for lane_cfg in CFG["lanes"]:
        lane_id = lane_cfg["id"]
        lane = lane_state(state, lane_id)
        lane["cycle_count"] = lane.get("cycle_count", 0) + 1
        roster = roster_map.get(lane_id)

        # fold repair-published blacklist additions (journal is the race-free
        # channel — audit T2: direct state.json writes would race the watcher)
        try:
            for line in JOURNAL_F.read_text(errors="ignore").splitlines()[-200:]:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("event") == "blacklist_add" and d.get("lane") == lane_id \
                        and d.get("image") and d["image"] not in lane["blacklist"]:
                    lane["blacklist"].append(d["image"])
                    del lane["blacklist"][:-20]
        except OSError:
            pass

        # ---- observe image identity on both ranks (reused as evidence) ----
        inspect = {"head": rank_inspect(lane_cfg["head"]),
                   "worker": rank_inspect(lane_cfg["worker"])}
        hok, hid, _, hrc = inspect["head"]
        wok, wid, _, wrc = inspect["worker"]
        if hok and wok and hid and wid:
            if hid == wid:
                if lane["last_observed_image_id"] is None:
                    lane["last_observed_image_id"] = hid
                elif hid != lane["last_observed_image_id"]:
                    lane["rotation_from"] = lane["last_observed_image_id"]
                    lane["rotation_to"] = hid
                    lane["rotation_at"] = iso(now())
                    lane["last_observed_image_id"] = hid
                    lane["proving_since"] = iso(now())
                    lane["proving_completed_base"] = (roster or {}).get("completed")
                    lane["proven_had_traffic"] = False
                    lane["repair_booting"] = False
                    journal("rotation_observed", lane=lane_id, to=hid)
            else:
                if dedupe_ok(lane, "rank_mismatch"):
                    journal("rank_mismatch", lane=lane_id, head=hid, worker=wid)
                    notify("pair-rollback", f"{lane_id}: head/worker image IDs differ — investigate")
        else:
            push(lane.setdefault("nodata_hist", []), True)

        # ---- proving window: promote after 60 min + validated traffic ----
        # Window stays OPEN until promotion or failure evidence (audit T2:
        # closing it unpromoted meant idle lanes never formed a baseline).
        if lane.get("proving_since"):
            since = datetime.fromisoformat(lane["proving_since"].replace("Z", "+00:00"))
            healthy = roster is not None and roster.get("is_healthy") \
                and roster.get("quarantine") is None
            if healthy and (lane.get("last_gen_ok") is True):
                mins = (now() - since).total_seconds() / 60
                base = lane.get("proving_completed_base")
                cur = (roster or {}).get("completed")
                had_traffic = lane.get("proven_had_traffic") or (
                    base is not None and cur is not None and cur > base)
                lane["proven_had_traffic"] = had_traffic
                if mins >= 60 and had_traffic and hok and wok and hid and wid and hid == wid:
                    # pin by ID (tags drift); create the tag on BOTH ranks so
                    # repair can re-pin by tag and presence checks pass
                    tag = f"tensorfold-glm53:proven-{hid[7:19]}"
                    tagh = _ssh_args(lane_cfg["head"], ["docker", "tag", hid, tag], timeout=20)
                    tagw = _ssh_args(lane_cfg["worker"], ["docker", "tag", hid, tag], timeout=20)
                    lane["proven_image_id"] = hid
                    lane["proven_image_tag"] = tag
                    lane["proven_at"] = iso(now())
                    journal("proven_promoted", lane=lane_id, image=hid, tag=tag,
                            tagged_head=bool(tagh[0]), tagged_worker=bool(tagw[0]))
                    lane["proving_since"] = None   # cleared ONLY on promotion
            elif (roster is not None) and (not healthy) and lane.get("last_gen_ok") is False:
                # failure evidence during proving: reset the clock
                lane["proving_since"] = iso(now())
                lane["proven_had_traffic"] = False
                journal("proving_reset", lane=lane_id)

        ev = evidence_for(lane_cfg, state, lane, gw_reachable, roster, roster_map, inspect)
        lane["unhealthy_hist"] = lane.get("unhealthy_hist", [])
        lane["genfail_hist"] = lane.get("genfail_hist", [])
        # no-data cycles push NOTHING (audit T2: an outage must not flush
        # accumulated persistence evidence)
        if ev["roster"] is not None:
            push(lane["unhealthy_hist"],
                 (not ev["roster"]["is_healthy"]) or bool(ev["roster"]["quarantined"]))
        if ev["gen_probe_ok"] is not None:
            lane["last_gen_ok"] = ev["gen_probe_ok"]
            push(lane["genfail_hist"], not ev["gen_probe_ok"])

        # rolling re-attestation of the proven baseline (audit T1: a static
        # proven_at permanently disarms the wire after 7 quiet days)
        ids_now = ev.get("rank_image_ids") or {}
        if lane.get("proven_image_id") and ids_now.get("head") == lane["proven_image_id"] \
                and ev["roster"] and ev["roster"].get("is_healthy") \
                and not ev["roster"].get("quarantined") and ev.get("gen_probe_ok") is True:
            lane["proven_at"] = iso(now())

        # crash-loop detection: rising docker RestartCounts = churn, distinct
        # from a single boot-in-progress (audit T1 FN: RestartCount was parsed
        # then discarded, so a segfault-looping image hid behind the 10-min guard)
        if hok and wok:
            counts = {"head": inspect["head"][3], "worker": inspect["worker"][3]}
            prev = lane.get("restart_counts")
            if prev and any(counts[k] > prev.get(k, counts[k]) for k in counts):
                lane["churn_cycles"] = lane.get("churn_cycles", 0) + 1
            else:
                lane["churn_cycles"] = 0
            lane["restart_counts"] = counts
            if lane.get("churn_cycles", 0) >= 3 and dedupe_ok(lane, "crash_loop", 1800):
                journal("crash_loop_suspected", lane=lane_id, counts=counts)
                notify("pair-rollback",
                       f"{lane_id}: containers crash-looping (restart counts rising 3 cycles) — NOT auto-repaired, investigate")

        v = decide(ev)
        journal("cycle", lane=lane_id, verdict=v["verdict"], reason=v["reason"],
                gen=ev.get("gen_probe_ok"), img=(ev.get("rank_image_ids") or {}).get("head"))

        if v["verdict"] == "trip":
            if ARMED_F.exists() and not lock_in_flight():
                if not (HERE / "repair.sh").exists():
                    # fail LOUD, never consume budget on a missing mutator
                    journal("repair_script_missing", lane=lane_id)
                    notify("pair-rollback", f"{lane_id}: TRIP conditions met but repair.sh missing — tripwire misconfigured")
                else:
                    token = str(uuid.uuid4())
                    try:
                        subprocess.Popen(["bash", str(HERE / "repair.sh"), lane_id, token],
                                         stdout=open(PR_DIR / "repair.out", "a"),
                                         stderr=subprocess.STDOUT,
                                         start_new_session=True)
                        journal("rollback_start", lane=lane_id, token=token, reason=v["reason"])
                    except OSError as e:
                        journal("rollback_spawn_failed", lane=lane_id, error=str(e))
                        notify("pair-rollback", f"{lane_id}: repair spawn FAILED: {e}")
            else:
                journal("trip_suppressed", lane=lane_id, reason="inert_or_in_flight")
        elif v.get("notify") and dedupe_ok(lane, v["reason"]):
            journal("notify", lane=lane_id, reason=v["reason"])
            notify("pair-rollback", f"{lane_id}: {v['reason']}")

        # safety net: boot finished but lane still drained by us
        rs_lane = (repair_status or {}).get("lane") == lane_id and repair_status or None
        if rs_lane:
            phase = rs_lane.get("phase")
            lane["repair_booting"] = phase in ("draining", "stopping", "booting")
            lane["repair_pending_resume"] = phase in ("booted", "ready_to_resume")
        if lane.get("repair_booting") and ev["roster"] and ev["roster"].get("drained"):
            if ev.get("gen_probe_ok") is True and lane.get("repair_pending_resume") and \
               dedupe_ok(lane, "ready_to_resume"):
                journal("ready_to_resume", lane=lane_id)
                notify("pair-rollback", f"{lane_id}: rollback boot complete, lane ready to resume (owner decides)")

        save_state(state)

    if once:
        journal("single_cycle_complete")


if __name__ == "__main__":
    main()
