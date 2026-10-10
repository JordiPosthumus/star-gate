// Regression tests for the upstream pool's free-socket idle window.
//
// Defect covered: an upstream agent with keepAlive but no idle expiry reuses a
// socket the peer already closed, so a request dies with ECONNRESET/EPIPE on a
// healthy lane. Measured on the live rings 2026-10-09: engines closed idle
// keep-alive sockets between 2.0s and 3.0s while the pooled agent held them
// indefinitely.
//
// Two things must hold at once, and both are tested here against a real server:
//   1. an idle pooled socket IS expired before the engine can close it, and
//   2. a socket carrying a live request is NEVER expired, however long it is
//      silent -- this gateway deliberately allows very long prefill/decode
//      idle windows, and killing those would be far worse than the bug.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';

import { DEFAULT_UPSTREAM_IDLE_MS, upstreamAgentOptions } from './upstream-agent.mjs';

const IDLE_MS = 300;
const agents = new Set();

after(() => {
  for (const agent of agents) agent.destroy();
});

function agentFor(idleMs = IDLE_MS) {
  const agent = new http.Agent(upstreamAgentOptions(8, idleMs));
  agents.add(agent);
  return agent;
}

function makeServer(handler) {
  const state = { connections: 0 };
  const server = http.createServer(handler);
  server.on('connection', () => { state.connections++; });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

function get(port, path, agent) {
  return new Promise(resolve => {
    const started = Date.now();
    const guard = setTimeout(
      () => resolve({ status: 'NO_RESPONSE', ms: Date.now() - started }),
      10000,
    );
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', agent }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        clearTimeout(guard);
        resolve({ status: res.statusCode, body, reused: req.reusedSocket, ms: Date.now() - started });
      });
    });
    req.on('error', e => {
      clearTimeout(guard);
      resolve({ status: `ERROR ${e.code}`, ms: Date.now() - started });
    });
    req.end();
  });
}

const freeCount = agent =>
  Object.values(agent.freeSockets).reduce((n, list) => n + list.length, 0);

test('the configured idle window stays below the engines observed close point', () => {
  // Live measurement: engines closed idle keep-alive between 2.0s and 3.0s.
  // Above that floor the bug returns, so the default is a hard invariant.
  assert.ok(DEFAULT_UPSTREAM_IDLE_MS > 0);
  assert.ok(
    DEFAULT_UPSTREAM_IDLE_MS <= 2000,
    `default idle window ${DEFAULT_UPSTREAM_IDLE_MS}ms must stay below the 2s floor of the engine close window`,
  );
  const opts = upstreamAgentOptions(8);
  assert.equal(opts.keepAlive, true, 'pooling must stay enabled');
  assert.equal(opts.timeout, DEFAULT_UPSTREAM_IDLE_MS, 'the idle window must be carried into the agent');
});

test('rejects a non-positive idle window', () => {
  assert.throws(() => upstreamAgentOptions(8, 0), /positive integer/);
  assert.throws(() => upstreamAgentOptions(8, -5), /positive integer/);
  assert.throws(() => upstreamAgentOptions(8, 1.5), /positive integer/);
  assert.throws(() => upstreamAgentOptions(8, NaN), /positive integer/);
});

test('a caller-supplied idle window is carried through unchanged', () => {
  assert.equal(upstreamAgentOptions(8, 1500).timeout, 1500);
  assert.equal(upstreamAgentOptions(8, 250).timeout, 250);
});

test('an idle pooled socket is closed instead of being reused', async () => {
  const { server, port, state } = await makeServer((_req, res) => res.end('ok'));
  const agent = agentFor(IDLE_MS);
  try {
    await get(port, '/', agent);
    assert.equal(freeCount(agent), 1, 'first response should pool its socket');
    assert.equal(state.connections, 1);

    await new Promise(r => setTimeout(r, IDLE_MS * 4));

    assert.equal(freeCount(agent), 0, 'the pooled socket must expire while idle');

    const second = await get(port, '/', agent);
    assert.equal(second.status, 200);
    assert.equal(second.reused, false, 'an expired socket must never be handed to a request');
    assert.equal(state.connections, 2, 'the request must open a fresh connection');
  } finally {
    server.close();
  }
});

test('back-to-back requests still reuse a healthy pooled socket', async () => {
  const { server, port, state } = await makeServer((_req, res) => res.end('ok'));
  const agent = agentFor(5000);
  try {
    await get(port, '/', agent);
    const second = await get(port, '/', agent);
    assert.equal(second.reused, true, 'pooling must be preserved inside the idle window');
    assert.equal(state.connections, 1);
  } finally {
    server.close();
  }
});

test('a live request silent for longer than the idle window is never killed', async () => {
  // The safety property. 4s of silence before the first byte, against a 300ms
  // idle window: this must complete normally.
  const { server, port } = await makeServer((_req, res) => {
    setTimeout(() => res.end('slow-ok'), 4000);
  });
  const agent = agentFor(300);
  try {
    const result = await get(port, '/slow', agent);
    assert.equal(result.status, 200, `live request must not be aborted (got ${result.status})`);
    assert.equal(result.body, 'slow-ok');
  } finally {
    server.close();
  }
});

test('a live stream with a long gap between chunks is never killed', async () => {
  const { server, port } = await makeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 4000);
  });
  const agent = agentFor(300);
  try {
    const result = await get(port, '/sse', agent);
    assert.equal(result.status, 200, `live stream must not be aborted (got ${result.status})`);
    assert.equal(result.body, 'data: one\n\ndata: two\n\n');
  } finally {
    server.close();
  }
});
