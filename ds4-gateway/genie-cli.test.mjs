import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {historyFile, readHistory, writeHistory} from '../scripts/genie.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-genie-cli-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, config: {state_file: path.join(root, 'runtime', 'affinity.json')}};
}

test('a session name cannot escape the private chat directory', t => {
  const {config} = fixture(t);
  assert.equal(historyFile(config, 'cli'), path.join(path.dirname(config.state_file), 'genie-chat', 'cli.json'));
  for (const bad of ['../escape', 'a/b', '', '-leading', 'x'.repeat(33)]) assert.throws(() => historyFile(config, bad), /Session names/);
});

test('history is written atomically with owner-only permissions and read back', t => {
  const {config} = fixture(t);
  const file = historyFile(config, 'cli');
  writeHistory(file, [{role: 'user', content: 'hi'}, {role: 'assistant', content: 'hello'}]);
  assert.deepEqual(readHistory(file), [{role: 'user', content: 'hi'}, {role: 'assistant', content: 'hello'}]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['cli.json']);
});

test('history keeps only the newest forty turns', t => {
  const {config} = fixture(t);
  const file = historyFile(config, 'cli');
  const long = Array.from({length: 60}, (_, i) => ({role: i % 2 ? 'assistant' : 'user', content: String(i)}));
  writeHistory(file, long);
  const kept = readHistory(file);
  assert.equal(kept.length, 40);
  assert.equal(kept[0].content, '20');
  assert.equal(kept.at(-1).content, '59');
});

test('malformed history is discarded instead of replayed', t => {
  const {config} = fixture(t);
  const file = historyFile(config, 'cli');
  writeHistory(file, [
    {role: 'system', content: 'not kept'},
    {role: 'user', content: 7},
    {role: 'user', content: 'kept'},
    null,
    {role: 'assistant', content: 'also kept'},
  ]);
  assert.deepEqual(readHistory(file), [{role: 'user', content: 'kept'}, {role: 'assistant', content: 'also kept'}]);
});

test('a missing or unreadable file reads as an empty conversation', t => {
  const {config} = fixture(t);
  const file = historyFile(config, 'cli');
  assert.deepEqual(readHistory(file), []);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(readHistory(file), []);
});
