import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HERMES_REVISION, HERMES_UPSTREAM, UV_VERSION, installHermes, installerEnvironment, run, runtimePaths, runtimeTarget, verifyRuntime} from '../scripts/genie-runtime.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-genie-rt-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

// A recorded install that passes every structural check, with the pinned import
// step stubbed out so no network or real Python is involved.
function readyRuntime(t, root, {revision = HERMES_REVISION} = {}) {
  const paths = runtimePaths(root, {revision});
  fs.mkdirSync(path.join(paths.source, '.git'), {recursive: true});
  fs.writeFileSync(paths.receipt, JSON.stringify({revision, uv: UV_VERSION}));
  return paths;
}

const cleanExec = async (command, args) => {
  if (command === 'git' && args[0] === 'rev-parse') return HERMES_REVISION;
  if (command === 'git' && args[0] === 'status') return '';
  return '';
};

test('the pinned runtime is one revision of one upstream', () => {
  assert.equal(HERMES_UPSTREAM, 'https://github.com/NousResearch/hermes-agent.git');
  assert.match(HERMES_REVISION, /^[a-f0-9]{40}$/);
  assert.match(UV_VERSION, /^\d+\.\d+\.\d+$/);
});

test('supported platforms are explicit and everything else is refused', () => {
  assert.deepEqual(runtimeTarget('darwin', 'arm64'), ['aarch64-apple-darwin', 'c729adb365114e844dd7f9316313a7ed6443b89bb5681d409eebac78b0bd06c8']);
  assert.equal(runtimeTarget('win32', 'x64'), null);
  assert.equal(runtimeTarget('linux', 'ia32'), null);
});

test('runtime paths stay inside the checkout and are revision-scoped', () => {
  const paths = runtimePaths('/srv/dsg');
  assert.equal(paths.base, '/srv/dsg/runtime/genie-runtime');
  assert.match(paths.source, /hermes-[a-f0-9]{40}$/);
  assert.equal(paths.lock, '/srv/dsg/runtime/genie-runtime/.install-lock');
  assert.notEqual(runtimePaths('/srv/dsg', {revision: 'a'.repeat(40)}).source, paths.source);
});

test('the installer environment never inherits a personal HOME or Git config', () => {
  const env = installerEnvironment('/tmp/base');
  assert.equal(env.HOME, '/tmp/base/installer-home');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.UV_NO_CONFIG, '1');
});

test('an absent runtime is reported as absent rather than guessed ready', async t => {
  const root = fixture(t);
  assert.deepEqual(await verifyRuntime(runtimePaths(root)), {state: 'absent'});
});

test('a recorded, clean, pinned checkout is ready', async t => {
  const root = fixture(t), paths = readyRuntime(t, root);
  assert.deepEqual(await verifyRuntime(paths, {exec: cleanExec}), {state: 'ready', revision: HERMES_REVISION});
});

test('a different recorded revision refuses reuse', async t => {
  const root = fixture(t), paths = readyRuntime(t, root, {revision: 'b'.repeat(40)});
  const result = await verifyRuntime(paths, {exec: cleanExec});
  assert.equal(result.state, 'mismatch');
  assert.match(result.reason, /is not/);
});

test('a checkout at the wrong commit refuses reuse', async t => {
  const root = fixture(t), paths = readyRuntime(t, root);
  const exec = async (command, args) => command === 'git' && args[0] === 'rev-parse' ? 'c'.repeat(40) : '';
  const result = await verifyRuntime(paths, {exec});
  assert.equal(result.state, 'mismatch');
  assert.match(result.reason, /not the pinned revision/);
});

test('a locally modified runtime refuses reuse', async t => {
  const root = fixture(t), paths = readyRuntime(t, root);
  const exec = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return HERMES_REVISION;
    if (command === 'git' && args[0] === 'status') return ' M gateway/run.py';
    return '';
  };
  const result = await verifyRuntime(paths, {exec});
  assert.equal(result.state, 'modified');
});

test('an unreadable record refuses reuse instead of reinstalling', async t => {
  const root = fixture(t), paths = runtimePaths(root);
  fs.mkdirSync(paths.source, {recursive: true});
  fs.writeFileSync(paths.receipt, 'not json');
  const result = await verifyRuntime(paths);
  assert.equal(result.state, 'invalid');
});

test('a ready runtime is reused without downloading anything', async t => {
  const root = fixture(t), paths = readyRuntime(t, root);
  let downloads = 0;
  const result = await installHermes(root, {exec: cleanExec, fetchImpl: async () => { downloads++; throw new Error('no network'); }, log: () => {}});
  assert.equal(result.reused, true);
  assert.equal(downloads, 0);
});

test('a mismatched runtime is refused rather than overwritten', async t => {
  const root = fixture(t), paths = runtimePaths(root);
  fs.mkdirSync(path.join(paths.source, '.git'), {recursive: true});
  fs.writeFileSync(paths.receipt, JSON.stringify({revision: 'd'.repeat(40), uv: UV_VERSION}));
  await assert.rejects(
    installHermes(root, {exec: cleanExec, log: () => {}, fetchImpl: async () => { throw new Error('no network'); }}),
    /cannot be reused.*Nothing was replaced/s);
  assert.ok(fs.existsSync(paths.receipt));
});

test('an interrupted install leaves a lock that blocks a second run', async t => {
  const root = fixture(t), paths = runtimePaths(root);
  fs.mkdirSync(paths.base, {recursive: true});
  fs.mkdirSync(paths.lock);
  await assert.rejects(installHermes(root, {exec: cleanExec, log: () => {}}), /already running or was interrupted/);
});

test('an unsupported platform fails before touching the filesystem', async t => {
  const root = fixture(t);
  await assert.rejects(installHermes(root, {platform: 'win32', arch: 'x64', log: () => {}}), /supports macOS and glibc Linux/);
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
});

test('a failed command surfaces its output instead of a bare exit code', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']), /failed \(3\).*boom/s);
});
