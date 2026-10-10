// Upstream connection-pool options for the gateway's engine agents.
//
// Engines close idle keep-alive connections on their own schedule. Measured on
// the live DeepSeek rings 2026-10-09 (independent probe, 4 reps/lane): the rings
// held an idle socket to ~4.0-4.6s and the door/core to ~5.6s, matching
// uvicorn's 5s default -- the gateway's agent pooled sockets with no idle expiry
// at all. The agent therefore handed the next request to a socket the engine had
// already closed: the request died with ECONNRESET/EPIPE before any bytes moved
// and the caller saw a 502 "upstream_error" on a lane whose /v1/models answered
// 200.
//
// `timeout` is the fix -- but NOT for the reason this comment used to claim.
// Node hoists the agent's `timeout` into the connect options of EVERY new socket
// (_http_agent.js createSocket -> net.js connect -> socket.setTimeout), so it
// also arms sockets carrying a live request. It is harmless only because:
//   1. the agent's own onTimeout destroys a socket solely when it sits in the
//      agent's free pool, never a socket in flight; and
//   2. nothing in ds4-gateway/ attaches a 'timeout' listener to an upstream
//      request -- one such listener turns this into a live-request aborter.
// Treat both as invariants: adding a 'timeout' listener on the pooled chat path
// would abort long prefills and SSE gaps.
//
// Keep this below the engines' measured close floor (~4s) or the failure class
// returns. 1000ms keeps a 4x margin; both the ring engines and the Mac-local
// vLLM lanes share the 5s uvicorn default.

export const DEFAULT_UPSTREAM_IDLE_MS = 1000;

/**
 * Options for a pooling upstream agent with a bounded free-socket idle window.
 * @param {number} maxSockets admission capacity across all workers
 * @param {number} idleMs idle window for a socket parked in the free pool
 */
export function upstreamAgentOptions(maxSockets, idleMs = DEFAULT_UPSTREAM_IDLE_MS) {
  if (!Number.isSafeInteger(idleMs) || idleMs <= 0) {
    throw new Error('upstream idle window must be a positive integer number of milliseconds');
  }
  return { keepAlive: true, maxSockets, timeout: idleMs };
}
