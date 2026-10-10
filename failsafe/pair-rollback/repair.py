#!/usr/bin/env python3
"""pair-rollback repair — the ONLY component allowed to mutate the fleet.

Invoked by watch.py as: bash repair.sh <lane_id> <token>  (ARMED must exist).
One shot, no retry loop: any abort leaves the lane drained and tells the owner.
See docs/plans/pair-rollback-tripwire.md v2/v3 — this implements the repair
procedure with fresh-verify-before-mutation, strict capacity, recipe guard,
boot patience, generation proof, and journal-as-channel state updates.
"""
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = Path(os.environ.get("DSG_HOME", HERE.parents[1]))
PR_DIR = BASE / "runtime/pair-rollback"
JOURNAL_F = PR_DIR / "journal.jsonl"
LOCK_F = PR_DIR / "repair.lock"
STATUS_F = PR_DIR / "repair-status.json"
ARMED_F = PR_DIR / "ARMED"
SOCK = BASE / "runtime/control.sock"
MARKER = Path("/tmp/dsg-watchdog-maintenance")
CFG = json.loads((HERE / "lanes.json").read_text())
BOOT_PATIENCE_S = 45 * 60
BOOT_LOG = "/tmp/pr-boot-latest.log"
KIT_HOME = "~"   # kit lives in the head's $HOME (verified 2026-10-06)


def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def journal(event, **fields):
    line = json.dumps({"time": iso(now()), "event": event, **fields})
    try:
        with open(JOURNAL_F, "a") as f:
            f.write(line + "\n")
    except OSError:
        notify("pair-rollback", "JOURNAL WRITE FAILED during repair — check disk")


def notify(title, msg):
    def esc(s):
        return str(s).replace("\\", "\\\\").replace('"', '\\"')
    subprocess.run(["osascript", "-e",
                    f'display notification "{esc(msg)[:180]}" with title "{esc(title)}" sound name "Glass"'],
                   capture_output=True)


def sh(argv, timeout=60, input_data=None):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                           input=input_data)
        return r.returncode == 0, (r.stdout or "") + (r.stderr or "")
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False, ""


def ssh_args(host, remote_argv, timeout=60):
    argv = ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", host,
            __import__("shlex").join(remote_argv)]
    return sh(argv, timeout=timeout)


def status(lane, token, phase):
    tmp = str(STATUS_F) + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"lane": lane, "token": token, "phase": phase, "ts": iso(now())}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATUS_F)


def control_cli(command, lane_id):
    """drain/resume via the gateway's own CLI (argv, no shell)."""
    return sh(["node", str(BASE / "ds4-gateway/workers.mjs"),
               "--config", str(BASE / "config.local.json"), command, lane_id],
              timeout=45)


def roster():
    ok, out = sh(["curl", "-s", "-m", "5", "--unix-socket", str(SOCK),
                  "http://localhost/workers"])
    if not ok:
        return None
    try:
        return {w["id"]: w for w in json.loads(out).get("workers", [])}
    except Exception:
        return None


def rank_image(host):
    ok, out = ssh_args(host, ["docker", "inspect", "-f", "{{.Image}}", CFG["container"]],
                       timeout=30)
    return out.strip() if ok and out.strip().startswith("sha256:") else None


def image_present(host, image_id):
    ok, out = ssh_args(host, ["docker", "image", "inspect", "--format", "{{.Id}}",
                              image_id], timeout=30)
    return bool(ok and out.strip() == image_id)


def remote_pin(host, kit):
    ok, out = ssh_args(host, ["grep", "-h", "-E", "^IMAGE=", f"{KIT_HOME}/{kit}/scripts/local.sh"],
                       timeout=30)
    return out.strip() if ok else None


def set_remote_pin(host, kit, tag):
    """Backup + sed the pin line to `tag` on the head (both ranks boot from it)."""
    ok, _ = ssh_args(host, ["bash", "-c",
        f"cd {KIT_HOME}/{kit} && cp scripts/local.sh scripts/local.sh.pre-rollback-$(date +%Y%m%d-%H%M%S) && "
        f"sed -i 's|^IMAGE=.*|IMAGE={tag}|' scripts/local.sh && grep -h '^IMAGE=' scripts/local.sh"],
        timeout=30)
    return ok


def start_heartbeat(token):
    stop = threading.Event()

    def beat():
        while not stop.is_set():
            try:
                data = json.loads(LOCK_F.read_text())
                if data.get("token") == token:
                    data["heartbeat_ts"] = now().timestamp()
                    LOCK_F.write_text(json.dumps(data))
            except Exception:
                pass
            stop.wait(20)
    t = threading.Thread(target=beat, daemon=True)
    t.start()
    return stop


def release_lock(token):
    try:
        data = json.loads(LOCK_F.read_text())
        if data.get("token") == token:      # compare-and-delete
            LOCK_F.unlink()
    except Exception:
        pass


def abort(lane, token, step, reason, marker_created):
    journal("rollback_aborted", lane=lane, step=step, reason=reason)
    notify("pair-rollback", f"{lane}: rollback ABORTED at {step}: {reason} — lane left drained, owner decides")
    status(lane, token, "aborted")
    if marker_created:
        try:
            MARKER.unlink()
        except OSError:
            pass
    release_lock(token)
    sys.exit(1)


def main():
    if len(sys.argv) != 3:
        print("usage: repair.sh <lane_id> <token>")
        sys.exit(2)
    lane_id, token = sys.argv[1], sys.argv[2]
    if not ARMED_F.exists():
        journal("repair_refused_inert", lane=lane_id)
        print("INERT: no ARMED file — refusing to mutate")
        sys.exit(1)

    lane_cfg = next((l for l in CFG["lanes"] if l["id"] == lane_id), None)
    if lane_cfg is None:
        print(f"unknown lane {lane_id}")
        sys.exit(2)

    LOCK_F.write_text(json.dumps({"pid": os.getpid(), "token": token,
                                  "heartbeat_ts": now().timestamp()}))
    hb_stop = start_heartbeat(token)
    marker_created = False
    head, worker, glass = lane_cfg["head"], lane_cfg["worker"], lane_cfg["glass"]
    kit = CFG["kit_dir"]
    try:
        # ---- 1. announce BEFORE mutating ------------------------------------
        journal("rollback_step", lane=lane_id, step="announce", token=token)
        notify("pair-rollback", f"{lane_id}: AUTO-ROLLBACK STARTING (proven image restore) — {token[:8]}")

        # ---- 2. fresh re-verification (conditions may have cleared) --------
        rs = roster()
        if rs is None:
            abort(lane_id, token, "reverify", "gateway_unreachable", marker_created)
        assert rs is not None  # narrowing for type-checkers; abort() exits
        me = rs.get(lane_id)
        if me is None:
            abort(lane_id, token, "reverify", "lane_missing_from_roster", marker_created)
        if me.get("drained"):
            abort(lane_id, token, "reverify", "owner_drained", marker_created)
        if me.get("is_healthy") and me.get("quarantine") is None:
            abort(lane_id, token, "reverify", "lane_recovered", marker_created)
        serving = [w for w in rs.values()
                   if w["id"] != lane_id and w["id"].startswith("glm53exl3")
                   and w.get("is_healthy") and not w.get("drained")
                   and w.get("quarantine") is None and not (w.get("recovery_waiting") or 0)]
        if not serving:
            abort(lane_id, token, "reverify", "no_other_lane_serving", marker_created)

        st = json.loads((PR_DIR / "state.json").read_text())["lanes"].get(lane_id, {})
        proven_id, proven_tag = st.get("proven_image_id"), st.get("proven_image_tag")
        if not proven_id:
            abort(lane_id, token, "reverify", "no_proven_baseline", marker_created)

        # ---- 3. identity: what is actually running? -------------------------
        bad_h, bad_w = rank_image(head), rank_image(worker)
        if not bad_h or not bad_w:
            abort(lane_id, token, "identity", "rank_inspect_failed", marker_created)
        if bad_h != bad_w:
            abort(lane_id, token, "identity", "rank_mismatch", marker_created)
        if bad_h == proven_id:
            abort(lane_id, token, "identity", "running_is_proven", marker_created)

        # ---- 4. rollback target must exist on BOTH ranks --------------------
        if not (image_present(head, proven_id) and image_present(worker, proven_id)):
            abort(lane_id, token, "target", "proven_image_missing", marker_created)

        # ---- 5. recipe guard: pin must not be freshly human-edited ----------
        pin = remote_pin(head, kit)
        journal("rollback_step", lane=lane_id, step="pin_read", pin=pin)
        if pin and proven_tag and proven_tag in pin:
            journal("rollback_step", lane=lane_id, step="pin_already_proven")
        elif pin is None:
            abort(lane_id, token, "recipe", "pin_unreadable", marker_created)

        # ---- 6. drain (fresh verify done; now mutating) ---------------------
        status(lane_id, token, "draining")
        ok, out = control_cli("drain", lane_id)
        journal("rollback_step", lane=lane_id, step="drain", ok=ok)
        if not ok:
            abort(lane_id, token, "drain", f"control_cli_failed: {out[:120]}", marker_created)
        if not MARKER.exists():
            MARKER.touch()
            marker_created = True

        # ---- 7. re-pin the recipe to the proven image ------------------------
        tag = proven_tag or f"tensorfold-glm53:proven-{proven_id[7:19]}"
        # ensure the tag resolves to the proven ID on BOTH ranks (idempotent)
        ssh_args(head, ["docker", "tag", proven_id, tag], timeout=30)
        ssh_args(worker, ["docker", "tag", proven_id, tag], timeout=30)
        if not (pin and proven_tag and proven_tag in pin):
            if not set_remote_pin(head, kit, tag):
                abort(lane_id, token, "recipe", "pin_edit_failed", marker_created)
            journal("rollback_step", lane=lane_id, step="pin_edited", tag=tag)

        # ---- 8. stop both ranks (head's stop.sh handles both) ---------------
        status(lane_id, token, "stopping")
        ok, out = ssh_args(head, ["bash", "-c", f"cd {KIT_HOME}/{kit} && ./stop.sh"], timeout=240)
        journal("rollback_step", lane=lane_id, step="stop", ok=ok)
        if not ok:
            abort(lane_id, token, "stop", f"stop_failed: {out[:120]}", marker_created)

        # ---- 9. boot both ranks, detached; patience 45 min ------------------
        status(lane_id, token, "booting")
        boot_cmd = (f"cd {KIT_HOME}/{kit} && nohup setsid ./start.sh "
                    f"> {BOOT_LOG} 2>&1 < /dev/null &")
        ssh_args(head, ["bash", "-c", boot_cmd], timeout=30)
        deadline = time.time() + BOOT_PATIENCE_S
        booted = False
        while time.time() < deadline:
            time.sleep(20)
            h_run, _ = ssh_args(head, ["docker", "inspect", "-f", "{{.State.Running}}",
                                       CFG["container"]], timeout=30)
            w_run, _ = ssh_args(worker, ["docker", "inspect", "-f", "{{.State.Running}}",
                                         CFG["container"]], timeout=30)
            if h_run and w_run:
                booted = True
                break
        if not booted:
            # NOT a failure: keep drain + marker, tell the owner (v2 #7)
            journal("boot_in_progress", lane=lane_id)
            notify("pair-rollback", f"{lane_id}: rollback boot still in progress after 45 min — lane stays drained, check {BOOT_LOG} on {head}")
            status(lane_id, token, "boot_in_progress")
            release_lock(token)
            hb_stop.set()
            return
        status(lane_id, token, "booted")

        # ---- 10. routing + generation proof ---------------------------------
        ok, out = sh(["curl", "-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}",
                      f"http://127.0.0.1:{glass}/v1/models"])
        if not ok or out.strip() != "200":
            abort(lane_id, token, "routing", f"glass_{glass}_models_{out.strip()[:20]}", marker_created)
        probe = json.dumps({"model": CFG["model_id"], "max_tokens": 16, "temperature": 0,
                            "chat_template_kwargs": {"thinking": "off"},
                            "messages": [{"role": "user", "content": "Reply with OK."}]})
        # stdin-body probe (same argv discipline as the watcher):
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes", head,
                            "curl -s -m 30 -X POST http://127.0.0.1:8888/v1/chat/completions "
                            "-H 'Content-Type: application/json' --data-binary @-"],
                           input=probe + "\n", capture_output=True, text=True, timeout=45)
        proof_ok = False
        try:
            d = json.loads(r.stdout)
            proof_ok = bool((d.get("choices") or [{}])[0].get("message", {}).get("content"))
        except Exception:
            proof_ok = False
        if not proof_ok:
            abort(lane_id, token, "proof", "generation_proof_failed", marker_created)

        # ---- 11. resume (refusal is its own outcome, not a failure) ---------
        ok, out = control_cli("resume", lane_id)
        if not ok:
            journal("resume_refused", lane=lane_id, detail=out[:150])
            notify("pair-rollback", f"{lane_id}: rollback boot OK but resume REFUSED — lane stays drained, owner decides")
            status(lane_id, token, "resume_refused")
            if marker_created:
                try:
                    MARKER.unlink()
                except OSError:
                    pass
            release_lock(token)
            hb_stop.set()
            return

        # ---- 12. receipt + blacklist via journal (race-free channel) --------
        journal("blacklist_add", lane=lane_id, image=bad_h)
        journal("rollback_done", lane=lane_id, from_image=bad_h, to_image=proven_id,
                duration_s=round((now().timestamp() - LOCK_F.stat().st_mtime), 1) if LOCK_F.exists() else None)
        notify("pair-rollback", f"{lane_id}: AUTO-ROLLBACK COMPLETE — proven image restored, lane resumed")
        status(lane_id, token, "done")
    except Exception as e:
        journal("rollback_failed", lane=lane_id, error=repr(e)[:200])
        notify("pair-rollback", f"{lane_id}: repair CRASHED: {e!r} — lane state unchanged/likely drained")
        status(lane_id, token, "failed")
    finally:
        if marker_created and MARKER.exists():
            try:
                MARKER.unlink()
            except OSError:
                pass
        release_lock(token)
        hb_stop.set()


if __name__ == "__main__":
    main()
