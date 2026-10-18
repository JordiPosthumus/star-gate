"""Fixture tests for Genie's read-only fleet tool. No gateway and no network."""
import json
import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import genie_fleet  # noqa: E402


class FixtureSocket:
    """A one-shot Unix socket that answers with a fixed HTTP response."""

    def __init__(self, status=200, body=b"{}", chunked=False, headers=None):
        self.directory = tempfile.mkdtemp(prefix="genie-fleet-")
        self.path = os.path.join(self.directory, "control.sock")
        self.status = status
        self.body = body
        self.chunked = chunked
        self.headers = headers or {}
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen(1)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        try:
            conn, _ = self.server.accept()
        except OSError:
            return
        try:
            conn.recv(65536)
            if self.chunked:
                payload = b"%x\r\n%s\r\n0\r\n\r\n" % (len(self.body), self.body)
                head = "HTTP/1.1 %d OK\r\nTransfer-Encoding: chunked\r\n\r\n" % self.status
            else:
                payload = self.body
                head = "HTTP/1.1 %d OK\r\nContent-Length: %d\r\n\r\n" % (self.status, len(self.body))
            conn.sendall(head.encode() + payload)
        finally:
            conn.close()

    def close(self):
        self.server.close()
        try:
            os.unlink(self.path)
        finally:
            os.rmdir(self.directory)


class FleetStatusTests(unittest.TestCase):
    def serve(self, **kwargs):
        fixture = FixtureSocket(**kwargs)
        self.addCleanup(fixture.close)
        return fixture.path

    def test_counts_and_worker_fields_are_bounded(self):
        body = json.dumps({
            "model": "PoolModel",
            "context_length": 200000,
            "draining": False,
            "recovery": {"configured": True, "automatic": False},
            "queued_relocation": {"automatic": True, "offers": [{"id": "o1"}]},
            "workers": [
                {"id": "w1", "is_healthy": True, "active": 2, "queued": 1, "secret": "NEVER"},
                {"id": "w2", "is_healthy": False, "drained": True, "quarantine": {"reason": "fault"}},
                {"id": "w3", "is_healthy": True, "drained": True},
            ],
        }).encode()
        value = genie_fleet.fleet_status(self.serve(body=body))
        self.assertEqual(value["counts"], {"workers": 3, "healthy": 1, "active": 2, "queued": 1})
        self.assertEqual(value["queued_relocation"], {"automatic": True, "offers": 1})
        self.assertNotIn("secret", value["workers"][0])
        self.assertIn("scope", value)

    def test_chunked_responses_are_decoded(self):
        body = json.dumps({"workers": [{"id": "w1", "is_healthy": True}]}).encode()
        value = genie_fleet.fleet_status(self.serve(body=body, chunked=True))
        self.assertEqual(value["counts"]["healthy"], 1)

    def test_a_refused_request_is_an_error_not_an_empty_fleet(self):
        path = self.serve(status=500, body=b"{}")
        with self.assertRaises(ValueError) as caught:
            genie_fleet.fleet_status(path)
        self.assertIn("refused", str(caught.exception))

    def test_malformed_json_is_an_error(self):
        with self.assertRaises(ValueError):
            genie_fleet.fleet_status(self.serve(body=b"not json"))

    def test_an_unexpected_shape_is_an_error(self):
        with self.assertRaises(ValueError):
            genie_fleet.fleet_status(self.serve(body=json.dumps({"workers": "nope"}).encode()))

    def test_a_relative_or_missing_socket_is_refused_before_connecting(self):
        for path in ("relative.sock", "", None, 7):
            with self.assertRaises(ValueError):
                genie_fleet.fleet_status(path)

    def test_a_missing_socket_reports_a_failure(self):
        with self.assertRaises(OSError):
            genie_fleet.fleet_status("/tmp/genie-fleet-does-not-exist.sock")


if __name__ == "__main__":
    unittest.main()
