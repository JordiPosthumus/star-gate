#!/usr/bin/env python3
"""Fixture: unix-socket server imitating the control socket. Serves /workers with one
quarantined worker whose backend url points at args: fix_socket.py SOCKET_PATH BACKEND_URL"""
import socketserver, sys, json, os
SOCK, BACKEND = sys.argv[1], sys.argv[2]
BODY = json.dumps({"workers":[
  {"id":"glm-fake","quarantine":{"reason":"test-quarantine"},"is_healthy":False,
   "url":BACKEND,"load":0},
  {"id":"glm-fine","quarantine":None,"is_healthy":True,"url":BACKEND,"load":1}
]}).encode()
class H(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.recv(65536)
        self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                             + str(len(BODY)).encode() + b"\r\n\r\n" + BODY)
class S(socketserver.UnixStreamServer):
    allow_reuse_address = True
if os.path.exists(SOCK): os.remove(SOCK)
S(SOCK, H).serve_forever()
