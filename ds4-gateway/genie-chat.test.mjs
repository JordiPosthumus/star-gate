import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chatFile, createGenieChat, readMessages, writeMessages} from './genie-chat.mjs';

function fixture(t, {enabled = true} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-genie-chat-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const config = {state_file: path.join(root, 'runtime', 'affinity.json'), genie: {enabled, authority: ['inspect']}};
  return {root, config, file: chatFile(config)};
}

function fakeProvider(text = 'Hello.') {
  return {
    status: () => ({model: 'PoolModel', engine: 'Hermes'}),
    tools: {fleet: {control_socket: '/tmp/s'}},
    async generate({message, onDelta}) { onDelta('Hel'); onDelta('lo. '); return {text: message + ' ' + text}; },
  };
}

test('history round-trips with owner-only permissions and keeps forty messages', t => {
  const {file} = fixture(t);
  writeMessages(file, Array.from({length: 60}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: String(i)})));
  const kept = readMessages(file);
  assert.equal(kept.length, 40);
  assert.equal(kept[0].content, '20');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a disabled Genie reports why and refuses to send', async t => {
  const {config} = fixture(t, {enabled: false});
  const chat = createGenieChat(config);
  assert.equal(chat.status().enabled, false);
  await assert.rejects(chat.send({message: 'hi'}), {status: 409});
});

test('a turn streams deltas and appends exactly one question and answer', async t => {
  const {config, file} = fixture(t);
  const chat = createGenieChat(config, {provider: fakeProvider()});
  const deltas = [];
  const text = await chat.send({message: 'Hi', onDelta: delta => deltas.push(delta)});
  assert.equal(text, 'Hi Hello.');
  assert.deepEqual(deltas, ['Hel', 'lo. ']);
  assert.deepEqual(readMessages(file), [
    {role: 'user', content: 'Hi'},
    {role: 'assistant', content: 'Hi Hello.'},
  ]);
  assert.equal(chat.status().tools.length, 1);
});

test('only one turn may be in flight', async t => {
  const {config} = fixture(t);
  let release;
  const provider = {
    status: () => ({model: 'm', engine: 'Hermes'}), tools: {},
    generate: () => new Promise(resolve => { release = () => resolve({text: 'done'}); }),
  };
  const chat = createGenieChat(config, {provider});
  const first = chat.send({message: 'one'});
  await assert.rejects(chat.send({message: 'two'}), {status: 409});
  release();
  await first;
});

test('stop aborts the in-flight turn and the answer is not stored', async t => {
  const {config, file} = fixture(t);
  let onAbort;
  const provider = {
    status: () => ({model: 'm', engine: 'Hermes'}), tools: {},
    generate: ({signal}) => new Promise((_, reject) => { signal.addEventListener('abort', () => { onAbort?.(); reject(Object.assign(new Error('Stopped.'), {code: 'aborted'})); }); }),
  };
  const chat = createGenieChat(config, {provider});
  const running = chat.send({message: 'stop me'});
  assert.equal(chat.stop(), true);
  await assert.rejects(running, {code: 'aborted'});
  assert.deepEqual(readMessages(file), []);
  assert.equal(chat.stop(), false);
});

test('a missing chat configuration is reported without breaking the status call', t => {
  const {config} = fixture(t);
  const chat = createGenieChat(config, {home: '/nonexistent-home'});
  const status = chat.status();
  assert.equal(status.enabled, true);
  assert.equal(status.ready, false);
  assert.match(status.error, /Genie chat needs/);
});

test('an over-long question is refused before it reaches the model', async t => {
  const {config} = fixture(t);
  const chat = createGenieChat(config, {provider: fakeProvider()});
  await assert.rejects(chat.send({message: 'x'.repeat(8001)}), {status: 413});
});
