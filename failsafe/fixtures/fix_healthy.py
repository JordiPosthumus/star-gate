#!/usr/bin/env python3
"""Fixture: fully healthy lane. GET /v1/models 200, POST /v1/chat/completions 200 valid.
Usage: fix_healthy.py PORT"""
import http.server, socketserver, json, sys
OK = json.dumps({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}]}).encode()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(b'{"data":[{"id":"GLM-5.3-Flash-EXL3"}]}')
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); self.rfile.read(n)
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(OK)
    def log_message(self,*a): pass
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
