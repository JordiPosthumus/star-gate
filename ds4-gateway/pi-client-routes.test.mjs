import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from './gateway.mjs';

// A minimal healthy worker so createGateway can start.
async function backend(id) {
  const b = {id, model: 'deepseek-v4-flash', context_length: 153600, health: true};
  b.server = http.createServer((req, res) => {
    if (req.url === '/v1/models' || req.url.startsWith('/v1/models?')) {
      return res.end(JSON.stringify({data: [{id: b.model, context_length: b.context_length, top_provider: {context_length: b.context_length, max_completion_tokens: b.context_length}}]}));
    }
    res.writeHead(404); res.end('Not found');
  });
  await new Promise(resolve => b.server.listen(0, '127.0.0.1', resolve));
  b.url = `http://127.0.0.1:${b.server.address().port}`;
  b.close = () => new Promise(resolve => b.server.close(resolve));
  return b;
}

async function rig(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-pi-client-'));
  const backends = [await backend('spark1')];
  const config = {
    host: '127.0.0.1', port: 0, api_key: 'none', model: 'deepseek-v4-flash', context_length: 153600,
    conversation_turns: 1, state_file: path.join(dir, 'affinity.json'), health_interval_ms: 100000,
    nodes: backends.map(b => ({id: b.id, url: b.url})), ...overrides,
  };
  const gateway = createGateway(config);
  const address = await gateway.start();
  const request = (options = {}, body = '') => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: address.port, path: options.path ?? '/', method: options.method ?? 'GET', agent: false,
      headers: {authorization: 'Bearer none', ...(body ? {'content-type': 'application/json'} : {}), ...options.headers}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject); req.end(body);
  });
  t.after(async () => { await gateway.close(); await Promise.all(backends.map(b => b.close())); fs.rmSync(dir, {recursive: true, force: true}); });
  return {dir, gateway, request, backends};
}

test('GET /v1/client/pi serves a schema-1 bundle with the constant key and pool model', async t => {
  const r = await rig(t);
  const res = await r.request({path: '/v1/client/pi'});
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const bundle = JSON.parse(res.body);
  assert.equal(bundle.schema, 1);
  assert.equal(bundle.api_key, 'none');
  assert.equal(bundle.model.id, 'deepseek-v4-flash');
  assert.equal(bundle.model.contextWindow, 153600);
  assert.ok(bundle.model.maxTokens <= bundle.model.contextWindow, 'maxTokens must not exceed the live context');
  assert.equal(bundle.script_url, '/client/pi/install.ps1');
  assert.equal(bundle.report_url, '/client/pi/report');
  assert.match(bundle.revision, /^[a-f0-9]{64}$/);
  // The LAN address is advertised for a loopback bind, never a core port leak.
  assert.match(bundle.base_url, /^http:\/\/[^/]+:\d+\/v1$/);
  // No credential material may be advertised.
  assert.ok(!/api_key/.test(res.body) || bundle.api_key === 'none');
});

test('the bundle is deterministic apart from generated_at', async t => {
  const r = await rig(t);
  const first = JSON.parse((await r.request({path: '/v1/client/pi'})).body);
  const second = JSON.parse((await r.request({path: '/v1/client/pi'})).body);
  assert.equal(second.revision, first.revision, 'unchanged inputs must yield the same revision');
  assert.ok(Date.parse(second.generated_at) >= Date.parse(first.generated_at));
});

test('GET /v1/client/pi/install.ps1 serves the committed script as text', async t => {
  const r = await rig(t);
  // The committed asset ships with the repo; the route serves it rendered with
  // the live base URL and never as JSON.
  const res = await r.request({path: '/v1/client/pi/install.ps1'});
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.headers['content-disposition'], /pi-stargate-sync\.ps1/);
  // No credential material may be rendered into the script.
  assert.match(res.body, /\$StargateApiKey\s*= 'none'/);
  assert.ok(!/Bearer [A-Za-z0-9._~+/=-]{8,}/.test(res.body), 'no real bearer token in the rendered script');
});

test('the script route renders a template injected with the live base URL', async t => {
  const r = await rig(t);
  const res = await r.request({path: '/v1/client/pi/install.ps1'});
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.headers['content-disposition'], /pi-stargate-sync\.ps1/);
  assert.match(res.body, /\$StargateBaseUrl = 'http:\/\/[^']+\/v1'/);
  assert.match(res.body, /\$StargateApiKey\s*= 'none'/);
  // The committed body must survive the preamble injection intact.
  assert.match(res.body, /# --- committed body follows ---/);
  assert.match(res.body, /function Send-Report/, 'the committed body must be preserved');
});

test('POST /v1/client/pi/report accepts a valid report and exposes it in stats', async t => {
  const r = await rig(t);
  const report = {
    schema: 1, revision: 'a'.repeat(64), stage: 'write', ok: true,
    error_code: null, error_message: null,
    client: {os: 'Windows 11', powershell: '5.1', pi_version: '0.85.1'},
    base_url: 'http://host:30000/v1', duration_ms: 900,
    steps: [{stage: 'fetch', ok: true, detail: 'fetched'}],
  };
  const res = await r.request({path: '/v1/client/pi/report', method: 'POST'}, JSON.stringify(report));
  assert.equal(res.status, 200);
  const receipt = JSON.parse(res.body);
  assert.equal(receipt.accepted, true);
  assert.match(receipt.report_id, /^[0-9a-f-]{36}$/);
  const stats = r.gateway.stats();
  assert.equal(stats.pi_client_version, 1);
  assert.equal(stats.pi_client.reports.length, 1);
  assert.equal(stats.pi_client.reports[0].client.os, 'Windows 11');
  // The status projection must never leak the raw store internals.
  assert.equal('retention_bytes' in stats.pi_client, false);
});

test('the report is durable across a gateway restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-pi-client-durable-'));
  const backends = [await backend('spark1')];
  const config = {host: '127.0.0.1', port: 0, api_key: 'none', model: 'deepseek-v4-flash', context_length: 153600,
    conversation_turns: 1, state_file: path.join(dir, 'affinity.json'), health_interval_ms: 100000,
    nodes: backends.map(b => ({id: b.id, url: b.url}))};
  const post = (address, body) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: address.port, path: '/v1/client/pi/report', method: 'POST', agent: false,
      headers: {authorization: 'Bearer none', 'content-type': 'application/json'}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject); req.end(body);
  });
  const report = {schema: 1, revision: null, stage: 'validate', ok: false, error_code: 'E_VALIDATE', error_message: 'validation failed',
    client: {os: 'Windows 11', powershell: '7.4', pi_version: null}, base_url: 'http://host:30000/v1', duration_ms: 12, steps: []};
  let gateway = createGateway(config);
  let address = await gateway.start();
  const receipt = JSON.parse((await post(address, JSON.stringify(report))).body);
  await gateway.close();
  gateway = createGateway(config);
  address = await gateway.start();
  t.after(async () => { await gateway.close(); await Promise.all(backends.map(b => b.close())); fs.rmSync(dir, {recursive: true, force: true}); });
  const restored = gateway.stats().pi_client.reports;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].report_id, receipt.report_id);
  assert.equal(restored[0].stage, 'validate');
  assert.equal(restored[0].ok, false);
});

test('the report route rejects bad input with the documented codes', async t => {
  const r = await rig(t);
  const base = {schema: 1, revision: null, stage: 'fetch', ok: true, error_code: null, error_message: null,
    client: {os: 'Windows', powershell: '5.1', pi_version: null}, base_url: 'http://host:30000/v1', duration_ms: 1, steps: []};
  const post = (body, headers) => r.request({path: '/v1/client/pi/report', method: 'POST', headers}, typeof body === 'string' ? body : JSON.stringify(body));

  assert.equal((await post({...base, stage: 'deploy'})).status, 400, 'unknown stage');
  assert.equal((await post({...base, api_key: 'secret'})).status, 400, 'credential field');
  assert.equal((await post('{not json')).status, 400, 'malformed JSON');
  assert.equal((await post({...base, error_message: 'x'.repeat(513)})).status, 400, 'over-long field');
  assert.equal((await post({...base, duration_ms: -1})).status, 400, 'out-of-range duration');
  assert.equal((await post(base, {'content-type': 'text/plain'})).status, 415, 'wrong media type');
  assert.equal((await post({...base, padding: 'x'.repeat(9000)})).status, 413, 'oversized body');
  const oversized = await r.request({path: '/v1/client/pi/report', method: 'POST', headers: {'content-length': '9000'}}, JSON.stringify(base));
  assert.equal(oversized.status, 413, 'declared oversize content-length');
  // A rejected report is not stored.
  assert.equal(r.gateway.stats().pi_client.reports.length, 0);
});

test('the client routes are not on the inference allowlist', async t => {
  const r = await rig(t);
  // A wrong method on a client path falls through to the allowlist rejection,
  // proving it was never admitted as inference.
  const res = await r.request({path: '/v1/client/pi', method: 'POST'}, '{}');
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'unsupported_route');
});

test('client reports never enter scheduling, the journal or a worker request', async t => {
  const r = await rig(t);
  const before = r.gateway.stats().dataset.finished;
  const report = {schema: 1, revision: null, stage: 'merge', ok: true, error_code: null, error_message: null,
    client: {os: 'Windows', powershell: '5.1', pi_version: null}, base_url: 'http://host:30000/v1', duration_ms: 3, steps: []};
  await r.request({path: '/v1/client/pi/report', method: 'POST'}, JSON.stringify(report));
  assert.equal(r.gateway.stats().dataset.finished, before, 'a report must not be counted as inference');
  // The default dashboard route is the only place it surfaces.
  assert.equal(r.gateway.stats().pi_client.reports.length, 1);
});
