import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHermesProvider, grantedTools, parseBridgeLine, providerConfig} from './genie-hermes.mjs';

function fixture(t, chat = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-hermes-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), home = path.join(root, 'home');
  fs.mkdirSync(source);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(source, 'run_agent.py'), '');
  fs.writeFileSync(path.join(home, 'SOUL.md'), '# Identity\n');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'Operate.\n');
  fs.writeFileSync(path.join(home, 'bridge.mjs'), '');
  const config = {genie_chat: {source, python: process.execPath, url: 'http://127.0.0.1:30000/v1', model: 'PoolModel', ...chat}};
  return {root, source, home, config};
}

// A tiny stand-in for the Python bridge that speaks the same JSON-lines wire.
function fakeBridge(file) {
  fs.writeFileSync(file, `
let data='';
process.stdin.on('data',c=>data+=c);
process.stdin.on('end',()=>{
  const request=JSON.parse(data);
  process.stdout.write(JSON.stringify({type:'delta',text:'Hel'})+'\\n');
  process.stdout.write(JSON.stringify({type:'ignore',kind:'progress'})+'\\n');
  process.stdout.write(JSON.stringify({type:'delta',text:'lo '})+'\\n');
  process.stdout.write(JSON.stringify({type:'done',text:'Hello '+(request.message||'')})+'\\n');
});`);
}

test('the provider config insists on a real interpreter, checkout and credential-free URL', t => {
  const {config, root} = fixture(t);
  assert.equal(providerConfig(config).model, 'PoolModel');
    const credentials = ['u', 'p'].join(':');
  assert.throws(() => providerConfig({genie_chat: {...config.genie_chat, url: `http://${credentials}@127.0.0.1:1/v1`}}), /without embedded credentials/);
  assert.throws(() => providerConfig({genie_chat: {...config.genie_chat, python: path.join(root, 'missing')}}), /interpreter does not exist/);
  assert.throws(() => providerConfig({genie_chat: {...config.genie_chat, source: root}}), /not a checkout/);
});

test('bridge events are parsed strictly and unknown kinds are ignored', () => {
  assert.deepEqual(parseBridgeLine('{"type":"delta","text":"hi"}'), {type: 'delta', text: 'hi'});
  assert.deepEqual(parseBridgeLine('{"type":"done","text":"hi"}'), {type: 'done', text: 'hi'});
  assert.deepEqual(parseBridgeLine('{"type":"error","code":"provider"}'), {type: 'error', code: 'provider'});
  assert.deepEqual(parseBridgeLine('{"type":"progress","step":1}'), {type: 'ignore'});
  assert.throws(() => parseBridgeLine('not json'), /without a usable answer/);
  assert.throws(() => parseBridgeLine('{"type":"done","text":"  "}'), /without a usable answer/);
});

test('a turn streams deltas and resolves with the final text', async t => {
  const {config, home, root} = fixture(t);
  const file = path.join(root, 'bridge.mjs');
  fakeBridge(file);
  const provider = createHermesProvider(config, {home, bridgePath: file});
  const seen = [];
  const result = await provider.generate({message: 'there', history: [], sessionId: 's1', onDelta: text => seen.push(text)});
  assert.equal(result.text, 'Hello there');
  assert.deepEqual(seen, ['Hel', 'lo ']);
});

test('an abort before the turn starts rejects without spawning', async t => {
  const {config, home} = fixture(t);
  const provider = createHermesProvider(config, {home});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.generate({message: 'x', signal: controller.signal}), {code: 'aborted'});
});

test('a missing profile refuses instead of inventing identity', t => {
  const {config, root} = fixture(t);
  assert.throws(() => createHermesProvider(config, {home: path.join(root, 'nope')}), /no private profile/);
});

test('status reports the pinned model and home without leaking a key', t => {
  const {config, home} = fixture(t, {api_key: 'secret-value'});
  const status = createHermesProvider(config, {home}).status();
  assert.equal(status.model, 'PoolModel');
  assert.equal(status.engine, 'Hermes');
  assert.doesNotMatch(JSON.stringify(status), /secret-value/);
});

test('the fleet tool is granted only with inspect authority and an absolute socket', () => {
  const config = {control_socket: '/tmp/dsg-control.sock'};
  assert.deepEqual(grantedTools(config, ['inspect']), {fleet: {control_socket: '/tmp/dsg-control.sock'}});
  assert.deepEqual(grantedTools(config, []), {});
  assert.deepEqual(grantedTools(config, ['research', 'command']), {});
  assert.deepEqual(grantedTools(config, ['inspect', 'maintenance']), {
    fleet: {control_socket: '/tmp/dsg-control.sock'},
    actions: {control_socket: '/tmp/dsg-control.sock'},
  });
  assert.deepEqual(grantedTools(config, ['maintenance']), {actions: {control_socket: '/tmp/dsg-control.sock'}});
  assert.deepEqual(grantedTools({control_socket: 'relative.sock'}, ['inspect']), {});
  assert.deepEqual(grantedTools({}, ['inspect']), {});
});

test('a provider without inspect authority exposes no tools to the runtime', t => {
  const {config, home} = fixture(t);
  assert.deepEqual(createHermesProvider(config, {home}).tools, {});
  const withSocket = {...config, control_socket: '/tmp/dsg-control.sock'};
  assert.deepEqual(createHermesProvider(withSocket, {home, authority: ['inspect']}).tools, {fleet: {control_socket: '/tmp/dsg-control.sock'}});
});
