#!/usr/bin/env python3
"""Fixture server: GET /v1/models answers 200 instantly; POST /chat/completions hangs.
Threading so later GETs still answer. Usage: fix_wedged_door.py PORT"""
import http.server, socketserver, sys, time
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(b'{"data":[]}')
    def do_POST(self):
        time.sleep(60)
    def log_message(self,*a): pass
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
