import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {brainConfig, setupGenie} from '../scripts/genie-setup.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-genie-setup-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const configFile = path.join(root, 'config.local.json');
  fs.writeFileSync(configFile, JSON.stringify({state_file: path.join(root, 'runtime', 'affinity.json'), nodes: []}, null, 2));
  const install = async () => ({source: path.join(root, 'runtime', 'genie-runtime', 'hermes-pinned'), python: '/fake/python', reused: false});
  return {root, configFile, install};
}

test('setup enables Genie, installs the runtime and seeds both identity files', async t => {
  const {root, configFile, install} = fixture(t);
  const result = await setupGenie({options: {}, root, configFile, install, log: () => {}});
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.genie.enabled, true);
  assert.equal(saved.genie.brain.mode, 'pool');
  assert.equal(saved.genie.brain.pool.model, 'PoolModel');
  assert.deepEqual(saved.genie.authority, ['inspect', 'research', 'rebalance', 'recovery', 'configure']);
  assert.deepEqual(result.profile, path.join(root, 'runtime', 'hermes-home'));
  assert.ok(fs.existsSync(path.join(result.profile, 'SOUL.md')));
  assert.ok(fs.existsSync(path.join(result.profile, 'AGENTS.md')));
});

test('the written configuration is owner-only', async t => {
  const {root, configFile, install} = fixture(t);
  await setupGenie({options: {}, root, configFile, install, log: () => {}});
  if (process.platform !== 'win32') assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
});

test('a dedicated endpoint becomes the ladder mode and keeps its key out of stdout', async t => {
  const {root, configFile, install} = fixture(t);
  const connectionFile = path.join(root, 'connection.json');
  fs.writeFileSync(connectionFile, JSON.stringify({url: 'http://127.0.0.1:8000/v1', model: 'genie-local', api_key: 'secret-value'}));
  const lines = [];
  const result = await setupGenie({options: {'--connection': connectionFile}, root, configFile, install, log: line => lines.push(line)});
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.genie.brain.mode, 'ladder');
  assert.equal(saved.genie.brain.dedicated.model, 'genie-local');
  assert.equal(saved.genie.brain.dedicated.api_key, 'secret-value');
  assert.equal(result.brain.dedicated.url, 'http://127.0.0.1:8000/v1');
  assert.doesNotMatch(lines.join('\n'), /secret-value/);
});

test('commandeering is only written when a worker is named', async t => {
  const {root, configFile, install} = fixture(t);
  await setupGenie({options: {'--commandeer': 'spark-a'}, root, configFile, install, log: () => {}});
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved.genie.brain.commandeer, {enabled: true, worker: 'spark-a', max_seconds: 900, allow_while_serving: false});
  const plain = brainConfig();
  assert.equal(plain.commandeer, undefined);
});

test('an existing authority list is preserved instead of widened', async t => {
  const {root, configFile, install} = fixture(t);
  fs.writeFileSync(configFile, JSON.stringify({state_file: path.join(root, 'runtime', 'affinity.json'), genie: {authority: ['inspect']}}, null, 2));
  await setupGenie({options: {}, root, configFile, install, log: () => {}});
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).genie.authority, ['inspect']);
});

test('an existing SOUL is preserved on a second setup', async t => {
  const {root, configFile, install} = fixture(t);
  const first = await setupGenie({options: {}, root, configFile, install, log: () => {}});
  fs.writeFileSync(path.join(first.profile, 'SOUL.md'), 'Mine.\n');
  const second = await setupGenie({options: {}, root, configFile, install, log: () => {}});
  assert.equal(fs.readFileSync(path.join(second.profile, 'SOUL.md'), 'utf8'), 'Mine.\n');
});

test('setup refuses without a gateway configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-genie-none-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  await assert.rejects(setupGenie({root, configFile: path.join(root, 'missing.json'), install: async () => ({}), log: () => {}}), /Run npm run setup first/);
});

test('a partial model flag pair is refused before installing anything', async t => {
  const {root, configFile} = fixture(t);
  let installed = false;
  await assert.rejects(
    setupGenie({options: {'--model-url': 'http://127.0.0.1:8000/v1'}, root, configFile, install: async () => { installed = true; }, log: () => {}}),
    /both --model-url and --model/);
  assert.equal(installed, false);
});

test('an embedded credential in a model URL is refused', async t => {
  const {root, configFile, install} = fixture(t);
  const connectionFile = path.join(root, 'connection.json');
  const credentials = ['user', 'pass'].join(':');
  fs.writeFileSync(connectionFile, JSON.stringify({url: `http://${credentials}@127.0.0.1:8000/v1`, model: 'x'}));
  await assert.rejects(setupGenie({options: {'--connection': connectionFile}, root, configFile, install, log: () => {}}), /without embedded credentials/);
});
