"""Fixture tests for Genie's drain/resume tools. No gateway process involved."""
import json
import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import genie_actions  # noqa: E402


class FakeGateway:
    """A Unix-socket mini-gateway with mutable worker state."""

    def __init__(self, workers):
        self.directory = tempfile.mkdtemp(prefix="genie-actions-")
        self.path = os.path.join(self.directory, "control.sock")
        self.workers = workers
        self.calls = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen(8)
        self.running = True
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while self.running:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            try:
                raw = conn.recv(65536)
                head, _, body = raw.partition(b"\r\n\r\n")
                line = head.split(b"\r\n")[0].decode()
                method, path, _ = line.split(" ")
                self.calls.append((method, path, body))
                payload = self._handle(method, path, body)
                out = json.dumps(payload).encode()
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    b"Content-Length: " + str(len(out)).encode() + b"\r\n\r\n" + out
                )
            finally:
                conn.close()

    def _handle(self, method, path, body):
        if path == "/workers":
            return {"model": "PoolModel", "workers": self.workers}
        if path == "/drain-workers":
            ids = json.loads(body or b"{}").get("workers", [])
            for worker in self.workers:
                if worker["id"] in ids:
                    worker["drained"] = True
            return {"ok": True}
        if path == "/resume-workers":
            ids = json.loads(body or b"{}").get("workers", [])
            for worker in self.workers:
                if worker["id"] in ids:
                    if worker.get("quarantine"):
                        raise AssertionError("resume should not be attempted for a quarantine")
                    worker["drained"] = False
            return {"ok": True}
        return {"error": "not found"}

    def close(self):
        self.running = False
        try:
            self.server.close()
        finally:
            try:
                os.unlink(self.path)
            finally:
                os.rmdir(self.directory)


def worker(worker_id, *, healthy=True, drained=False, **extra):
    return {"id": worker_id, "is_healthy": healthy, "drained": drained, **extra}


class DrainTests(unittest.TestCase):
    def rig(self, workers):
        gateway = FakeGateway(workers)
        self.addCleanup(gateway.close)
        return gateway

    def test_drain_reports_the_observed_state(self):
        gateway = self.rig([worker("a"), worker("b")])
        result = genie_actions.drain_worker(gateway.path, {"worker_id": "a", "reason": "maintenance"})
        self.assertTrue(result["drained"])
        self.assertEqual(result["observed"]["drained"], True)
        self.assertEqual(result["fleet"]["healthy"], 1)
        self.assertIn(("POST", "/drain-workers", b'{"workers": ["a"]}'), [(m, p, b) for m, p, b in gateway.calls])

    def test_draining_the_last_healthy_worker_is_refused_by_default(self):
        gateway = self.rig([worker("only")])
        with self.assertRaises(ValueError) as caught:
            genie_actions.drain_worker(gateway.path, {"worker_id": "only"})
        self.assertIn("last healthy worker", str(caught.exception))
        self.assertFalse(any(path == "/drain-workers" for _, path, _ in gateway.calls))

    def test_the_last_worker_may_be_drained_with_explicit_acceptance(self):
        gateway = self.rig([worker("only")])
        result = genie_actions.drain_worker(gateway.path, {"worker_id": "only", "allow_last_worker": True})
        self.assertTrue(result["drained"])

    def test_an_already_drained_worker_is_not_drained_twice(self):
        gateway = self.rig([worker("a", drained=True), worker("b")])
        result = genie_actions.drain_worker(gateway.path, {"worker_id": "a"})
        self.assertTrue(result["already"])
        self.assertFalse(any(path == "/drain-workers" for _, path, _ in gateway.calls))

    def test_unknown_and_malformed_ids_are_refused(self):
        gateway = self.rig([worker("a")])
        for args in ({"worker_id": "ghost"}, {"worker_id": "../x"}, {}, {"worker_id": 7}):
            with self.assertRaises(ValueError):
                genie_actions.drain_worker(gateway.path, args)

    def test_an_over_long_reason_is_refused(self):
        gateway = self.rig([worker("a"), worker("b")])
        with self.assertRaises(ValueError):
            genie_actions.drain_worker(gateway.path, {"worker_id": "a", "reason": "x" * 201})


class ResumeTests(unittest.TestCase):
    def rig(self, workers):
        gateway = FakeGateway(workers)
        self.addCleanup(gateway.close)
        return gateway

    def test_resume_reports_the_observed_state(self):
        gateway = self.rig([worker("a", drained=True), worker("b")])
        result = genie_actions.resume_worker(gateway.path, {"worker_id": "a"})
        self.assertFalse(result["drained"])
        self.assertEqual(result["fleet"]["healthy"], 2)

    def test_a_quarantined_worker_is_not_resumed(self):
        gateway = self.rig([worker("a", drained=True, quarantine={"reason": "fault"})])
        result = genie_actions.resume_worker(gateway.path, {"worker_id": "a"})
        self.assertTrue(result["refused"])
        self.assertEqual(result["drained"], True)
        self.assertFalse(any(path == "/resume-workers" for _, path, _ in gateway.calls))

    def test_an_already_serving_worker_is_left_alone(self):
        gateway = self.rig([worker("a")])
        result = genie_actions.resume_worker(gateway.path, {"worker_id": "a"})
        self.assertTrue(result["already"])
        self.assertFalse(any(path == "/resume-workers" for _, path, _ in gateway.calls))


if __name__ == "__main__":
    unittest.main()
