import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {assertRunnable, bootCode, gatewayStatus, runGateway} from '../scripts/genie-gateway.mjs';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-genie-gateway-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'hermes');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(source, 'gateway'), {recursive: true});
  fs.writeFileSync(path.join(source, 'gateway', 'run.py'), '');
  fs.mkdirSync(home, {recursive: true});
  fs.writeFileSync(path.join(home, 'config.yaml'), 'gateway: {}\n');
  fs.writeFileSync(path.join(home, '.env'), 'TELEGRAM_BOT_TOKEN=not-a-real-token\n');
  const config = {genie: {enabled: true, messaging: {channels: ['telegram']}, ...(overrides.genie ?? {})}, genie_chat: {source, python: process.execPath}};
  return {root, source, home, config};
}

test('readiness reports the source, profile, credentials and channels', t => {
  const {config, home, source} = fixture(t);
  const status = gatewayStatus(config, {home});
  assert.equal(status.enabled, true);
  assert.deepEqual(status.channels, ['telegram']);
  assert.equal(status.owner_only, true);
  assert.equal(status.source, source);
  assert.equal(status.sourceReady, true);
  assert.equal(status.interpreterReady, true);
  assert.equal(status.profileReady, true);
  assert.equal(status.credentialsReady, true);
  assert.doesNotThrow(() => assertRunnable(status));
});

test('readiness is false but honest when the source or profile is missing', t => {
  const {root, config} = fixture(t);
  const status = gatewayStatus({...config, genie_chat: {source: path.join(root, 'nope'), python: process.execPath}}, {home: path.join(root, 'gone')});
  assert.equal(status.sourceReady, false);
  assert.equal(status.profileReady, false);
  assert.throws(() => assertRunnable(status), /pinned Hermes source/);
});

test('a disabled Genie or a non-owner audience is refused before spawning', t => {
  const {config, home} = fixture(t);
  assert.throws(() => assertRunnable(gatewayStatus({...config, genie: {enabled: false, messaging: {channels: ['telegram']}}}, {home})), /disabled/);
  const shared = {...config, genie: {enabled: true, messaging: {channels: ['telegram'], owner_only: false}}};
  assert.throws(() => assertRunnable(gatewayStatus(shared, {home})), /non-owner/);
});

test('the boot code runs the gateway module from the pinned source', () => {
  const code = bootCode('/tmp/hermes-source');
  assert.match(code, /runpy\.run_module\("gateway\.run"/);
  assert.match(code, /sys\.path\.insert\(0, "\/tmp\/hermes-source"\)/);
});

test('the launcher passes the profile and the isolated interpreter flags', async t => {
  const {root, source, home, config} = fixture(t);
  const recorder = path.join(root, 'python.sh');
  const argsFile = path.join(root, 'args.txt');
  const envFile = path.join(root, 'env.txt');
  fs.writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nenv > ${JSON.stringify(envFile)}\nexit 0\n`, {mode: 0o755});
  const previous = {...process.env};
  process.env.RECORD = '1';
  t.after(() => { for (const key of ['RECORD']) delete process.env[key]; });

  const child = runGateway({...config, genie_chat: {source, python: recorder}}, {home});
  await once(child, 'exit');
  const args = fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(args[0], '-I');
  assert.equal(args[1], '-c');
  assert.match(args[2], /gateway\.run/);
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, new RegExp(`^HERMES_HOME=${home}$`, 'm'));
  assert.match(env, /^PYTHONDONTWRITEBYTECODE=1$/m);
  assert.match(env, /^RECORD=1$/m);
  assert.equal(previous.RECORD, undefined);
});

test('a failed interpreter exits with its status', async t => {
  const {root, source, home, config} = fixture(t);
  const fail = path.join(root, 'fail.sh');
  fs.writeFileSync(fail, '#!/bin/sh\nexit 3\n', {mode: 0o755});
  const child = runGateway({...config, genie_chat: {source, python: fail}}, {home});
  const [code] = await once(child, 'exit');
  assert.equal(code, 3);
});
