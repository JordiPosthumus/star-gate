"""Fixture tests for Genie's recovery tools. No service adapter is involved."""
import json
import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import genie_recovery  # noqa: E402

WORKER_STATUS = {
    "worker_id": "spark1",
    "configured": True,
    "adapter": "launchd",
    "transport": "ssh",
    "reason": "worker_unavailable",
    "eligible": True,
    "evidence_id": "a" * 64,
    "inspected_at": 1700000000000,
    "enrollment": {"secret": "NEVER"},
}
OPERATION = {
    "id": "8c1f4f0e-1111-4222-8333-944455556666",
    "worker_id": "spark1",
    "actor": "genie",
    "state": "queued",
    "service_action": "restart",
    "created_at": 1700000000001,
    "updated_at": 1700000000001,
    "internal": "NEVER",
}


class FakeGateway:
    def __init__(self, *, status=202, reply=None):
        self.directory = tempfile.mkdtemp(prefix="genie-recovery-")
        self.path = os.path.join(self.directory, "control.sock")
        self.status = status
        self.reply = reply if reply is not None else OPERATION
        self.calls = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen(8)
        self.running = True
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while self.running:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            try:
                raw = conn.recv(65536)
                head, _, body = raw.partition(b"\r\n\r\n")
                method, path, _ = head.split(b"\r\n")[0].decode().split(" ")
                self.calls.append((method, path, body))
                payload = self._handle(method, path, body)
                out = json.dumps(payload).encode()
                conn.sendall(
                    b"HTTP/1.1 " + str(self.status).encode() + b" X\r\nContent-Type: application/json\r\n"
                    b"Content-Length: " + str(len(out)).encode() + b"\r\n\r\n" + out
                )
            finally:
                conn.close()

    def _handle(self, method, path, body):
        if path == "/workers":
            return {
                "recovery": {
                    "configured": True,
                    "automatic": True,
                    "profile_handback_automatic": False,
                    "adapter": "launchd",
                    "workers": [WORKER_STATUS],
                    "operations": [OPERATION],
                }
            }
        return self.reply

    def close(self):
        self.running = False
        try:
            self.server.close()
        finally:
            try:
                os.unlink(self.path)
            finally:
                os.rmdir(self.directory)


class StatusTests(unittest.TestCase):
    def test_status_compacts_policy_workers_and_operations(self):
        gateway = FakeGateway()
        self.addCleanup(gateway.close)
        value = genie_recovery.recovery_status(gateway.path)
        self.assertEqual(value["policy"]["automatic"], True)
        self.assertEqual(value["workers"][0]["evidence_id"], "a" * 64)
        self.assertNotIn("enrollment", value["workers"][0])
        self.assertNotIn("internal", value["operations"][0])
        self.assertIn("scope", value)

    def test_operations_are_capped_at_five(self):
        gateway = FakeGateway()
        self.addCleanup(gateway.close)
        gateway._handle = lambda *args: {"recovery": {"workers": [], "operations": [{"id": str(i)} for i in range(9)]}}
        self.assertEqual(len(genie_recovery.recovery_status(gateway.path)["operations"]), 5)


class ActionTests(unittest.TestCase):
    def rig(self, **kwargs):
        gateway = FakeGateway(**kwargs)
        self.addCleanup(gateway.close)
        return gateway

    def test_inspection_posts_one_worker_and_reports_that_it_started(self):
        gateway = self.rig()
        value = genie_recovery.inspect_worker(gateway.path, {"worker_id": "spark1"})
        self.assertEqual(value["state"], "inspecting")
        self.assertIn(("POST", "/recovery-inspect", b'{"worker_id": "spark1"}'), gateway.calls)

    def test_recovery_posts_the_exact_evidence_and_returns_a_compact_receipt(self):
        gateway = self.rig()
        value = genie_recovery.recover_worker(gateway.path, {"worker_id": "spark1", "evidence_id": "b" * 64})
        self.assertTrue(value["accepted"])
        self.assertEqual(value["operation"]["id"], OPERATION["id"])
        self.assertNotIn("internal", value["operation"])
        posted = json.loads([body for _, path, body in gateway.calls if path == "/genie-recover-worker"][0])
        self.assertEqual(posted, {"worker_id": "spark1", "evidence_id": "b" * 64})

    def test_a_missing_or_invented_evidence_id_is_refused_before_any_request(self):
        gateway = self.rig()
        for args in ({"worker_id": "spark1"}, {"worker_id": "spark1", "evidence_id": "zz"}, {"worker_id": "spark1", "evidence_id": "short"}):
            with self.assertRaises(ValueError):
                genie_recovery.recover_worker(gateway.path, args)
        self.assertFalse(any(path == "/genie-recover-worker" for _, path, _ in gateway.calls))

    def test_a_gateway_refusal_is_reported_with_its_message(self):
        gateway = self.rig(status=409, reply={"error": "Recovery policy changed"})
        with self.assertRaises(ValueError) as caught:
            genie_recovery.recover_worker(gateway.path, {"worker_id": "spark1", "evidence_id": "c" * 64})
        self.assertIn("Recovery policy changed", str(caught.exception))

    def test_unknown_worker_ids_are_refused(self):
        gateway = self.rig()
        for worker_id in ("../x", "", "a b", 7):
            with self.assertRaises(ValueError):
                genie_recovery.inspect_worker(gateway.path, {"worker_id": worker_id})


if __name__ == "__main__":
    unittest.main()
