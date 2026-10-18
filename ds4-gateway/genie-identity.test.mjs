import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {IDENTITY_FILES, identityStatus, seedGenieHome} from './genie-identity.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-genie-id-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

test('both identity files are seeded into hermes-home with owner-only permissions', t => {
  const root = fixture(t);
  const {home, seeded} = seedGenieHome(root);
  assert.equal(home, path.join(root, 'hermes-home'));
  assert.deepEqual(seeded, ['SOUL.md', 'AGENTS.md']);
  for (const name of IDENTITY_FILES) {
    const file = path.join(home, name);
    assert.ok(fs.existsSync(file), `${name} should exist`);
    assert.match(fs.readFileSync(file, 'utf8'), /Gate Genie/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('an owner edit is never overwritten, and a second seed reports nothing new', t => {
  const root = fixture(t);
  const {home} = seedGenieHome(root);
  fs.writeFileSync(path.join(home, 'SOUL.md'), 'My own Genie.\n');
  const second = seedGenieHome(root);
  assert.deepEqual(second.seeded, []);
  assert.equal(fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8'), 'My own Genie.\n');
});

test('an empty owner file stays empty instead of being re-seeded', t => {
  const root = fixture(t);
  const {home} = seedGenieHome(root);
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '');
  seedGenieHome(root);
  assert.equal(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), '');
});

test('status distinguishes missing, edited and default identity files', t => {
  const root = fixture(t);
  const {home} = seedGenieHome(root);
  assert.deepEqual(identityStatus(root), [
    {name: 'SOUL.md', present: true, matchesDefault: true},
    {name: 'AGENTS.md', present: true, matchesDefault: true},
  ]);
  fs.writeFileSync(path.join(home, 'SOUL.md'), 'edited\n');
  fs.rmSync(path.join(home, 'AGENTS.md'));
  assert.deepEqual(identityStatus(root), [
    {name: 'SOUL.md', present: true, matchesDefault: false},
    {name: 'AGENTS.md', present: false, matchesDefault: false},
  ]);
});

test('a missing profile directory is reported, not created by a read', t => {
  const root = fixture(t);
  assert.deepEqual(identityStatus(root).map(row => row.present), [false, false]);
  assert.equal(fs.existsSync(path.join(root, 'hermes-home')), false);
});

test('a missing versioned identity file is an error rather than a silent skip', t => {
  const root = fixture(t), source = path.join(root, 'empty-source');
  fs.mkdirSync(source);
  assert.throws(() => seedGenieHome(root, {source}), {code: 'ENOENT'});
});
