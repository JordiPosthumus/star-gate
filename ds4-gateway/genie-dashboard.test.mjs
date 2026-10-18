import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createDashboard} from './dashboard.mjs';

function fakeGenie({enabled = true} = {}) {
  const messages = [{role: 'user', content: 'Earlier question'}, {role: 'assistant', content: 'Earlier answer'}];
  return {
    enabled,
    stopped: 0,
    status: () => ({enabled, ready: enabled, model: 'PoolModel', engine: 'Hermes', tools: ['fleet'], messages, error: null}),
    async send({message, onDelta}) {
      onDelta('Hel');
      onDelta('lo.');
      return `Reply to ${message}`;
    },
    stop() { this.stopped += 1; return true; },
  };
}

async function fixture(t, genie) {
  const server = createDashboard(() => ({}), {genie});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {base, server};
}

test('the status route reports the conversation, model and granted tools', async t => {
  const {base} = await fixture(t, fakeGenie());
  const response = await fetch(`${base}/api/genie`);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.enabled, true);
  assert.equal(value.model, 'PoolModel');
  assert.deepEqual(value.tools, ['fleet']);
  assert.equal(value.messages.length, 2);
  assert.equal(typeof value.csrf_token, 'string');
});

test('a disabled Genie is visible without failing the route', async t => {
  const {base} = await fixture(t, fakeGenie({enabled: false}));
  const value = await (await fetch(`${base}/api/genie`)).json();
  assert.equal(value.enabled, false);
  assert.equal(value.messages.length, 2);
});

test('a chat request without the dashboard CSRF token is refused', async t => {
  const {base} = await fixture(t, fakeGenie());
  const response = await fetch(`${base}/api/genie/chat`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: base},
    body: JSON.stringify({message: 'hi'}),
  });
  assert.equal(response.status, 403);
});

test('an authorised turn streams deltas and a final answer', async t => {
  const {base} = await fixture(t, fakeGenie());
  const status = await (await fetch(`${base}/api/genie`)).json();
  const response = await fetch(`${base}/api/genie/chat`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: base, 'x-dsg-csrf': status.csrf_token},
    body: JSON.stringify({message: 'status?'}),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const body = await response.text();
  const events = body.split('\n\n').filter(Boolean).map(block => {
    const line = block.split('\n').find(row => row.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : null;
  }).filter(Boolean);
  assert.deepEqual(events.filter(event => event.delta).map(event => event.delta), ['Hel', 'lo.']);
  assert.deepEqual(events.at(-1), {done: true, text: 'Reply to status?'});
  assert.equal(body.includes('data: {"error"'), false);
});

test('an empty question is refused before the model is called', async t => {
  const {base} = await fixture(t, fakeGenie());
  const status = await (await fetch(`${base}/api/genie`)).json();
  const response = await fetch(`${base}/api/genie/chat`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: base, 'x-dsg-csrf': status.csrf_token},
    body: JSON.stringify({message: '   '}),
  });
  assert.equal(response.status, 400);
});

test('the stop route reaches the conversation', async t => {
  const genie = fakeGenie();
  const {base} = await fixture(t, genie);
  const status = await (await fetch(`${base}/api/genie`)).json();
  const response = await fetch(`${base}/api/genie/chat/stop`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: base, 'x-dsg-csrf': status.csrf_token},
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {stopped: true});
  assert.equal(genie.stopped, 1);
});

test('requests from another origin are refused', async t => {
  const {base} = await fixture(t, fakeGenie());
  const status = await (await fetch(`${base}/api/genie`)).json();
  const response = await fetch(`${base}/api/genie/chat`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: 'http://evil.example', 'x-dsg-csrf': status.csrf_token},
    body: JSON.stringify({message: 'hi'}),
  });
  assert.equal(response.status, 403);
});
