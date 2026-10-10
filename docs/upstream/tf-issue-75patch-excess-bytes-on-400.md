# Validation 400 responses can carry extra bytes beyond Content-Length, corrupting keep-alive connections

## Environment

- TensorFold **0.6.0**, CUDA two-rank serving stack (GLM-5.3-Flash-EXL3 pair).
- Client: an HTTP/1.1 **keep-alive** reverse proxy in front of the lane (Node.js, strict framing).
- Two images from the same kit, same TF version, differing only in the patch set:
  - Image A — `ghcr.io/miaai-lab/glm-5.3-flash-exl3-2x-dgx-sparks-tensorfold:v0.6.0-9f73cca659a1` (70 patches): **cannot reproduce** across days of proxy traffic.
  - Image B — `...tensorfold:v0.6.0-c4cab25d2d36` (75 patches; adds 0071-glm-shared-prefix-copy, 0072-glm-display-kv, 0073-glm-queued-cancellation, 0074-glm-compact-before-evict, 0075-glm-assistant-ends): **reproduces**.

## Symptom

On a request that fails validation (here: a body whose `messages` is not a list), Image B writes the normal JSON error **plus extra bytes past the declared `Content-Length`** — an HTML error-page body with no status line of its own. Captured verbatim from the proxy's fault log (unchanged except line wrapping):

```
HTTP/1.1 400 Bad Request
Server: BaseHTTP/0.6 Python/3.12.3
Content-Type: application/json
Content-Length: 82

{"error": {"message": "messages must be a list", "type": "invalid_request_error"}}<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Error response</title>
```

The JSON is exactly the 82 declared bytes; everything after it is excess data on a keep-alive connection. A strict client must treat those bytes as the start of the *next* response, so the connection's framing is corrupted from that point on. In our setup each subsequent request on that connection then fails to parse, the lane's failure counter trips, and the lane is pulled from rotation — for a defect that is invisible to single-shot clients.

## What we checked

- `tensorfold/server/http.py`'s `_send_json` writes an exact `Content-Length`; we found no `send_error` call and no `DOCTYPE` writer anywhere in the shipped `tensorfold` package, so the write site is somewhere we could not reach by static reading (possibly an interaction with the stdlib base class under our traffic shape).
- Single-shot `curl` probes with an invalid body return a clean JSON 400 on **both** images — the defect needs the keep-alive/reuse pattern to observe.
- The 70-patch image answered the same proxy traffic pattern for a day without a single malformed response, so the trigger is new in the 5-patch delta.

## Reproduction

Stand the 75-patch image behind any strict HTTP/1.1 keep-alive client (a connection pool that reads exactly `Content-Length` bytes per response), send a request whose `messages` field is not a list, and keep using the connection; the response for the failed request (or the next one on the socket) carries the excess HTML bytes. Happy to capture a `TENSORFOLD_REQUEST_LOG` trace or a byte-exact socket dump of a full failing exchange if useful.

## Impact

Any non-curl-grade client (connection pools in Node, Go, Python `http.client` with strict framing) misframes the connection after one validation failure on this image. Validation errors are routine in a multi-tenant proxy setup, so the lane ends up effectively unusable even though the engine itself is healthy.

— filed via the Dwarf Star Gate fleet (we serve this checkpoint to a multi-agent pool)
