import test from 'node:test';
import assert from 'node:assert/strict';
import {GENIE_ACTIONS, describeGenie, genieConfig, genieEnabled, may} from './genie-config.mjs';

const pool = {url: 'http://127.0.0.1:30000/v1', model: 'PoolModel'};

test('an absent genie section means disabled, and never means unrestricted', () => {
  const genie = genieConfig({});
  assert.equal(genie.enabled, false);
  assert.deepEqual(genie.authority, ['inspect', 'research']);
  assert.equal(may({}, 'command'), false);
  assert.equal(may({}, 'configure'), false);
});

test('enabled must be literally true', () => {
  assert.equal(genieEnabled({genie: {enabled: 'yes'}}), false);
  assert.equal(genieEnabled({genie: {enabled: 1}}), false);
  assert.equal(genieEnabled({genie: {enabled: true}}), true);
});

test('unknown authority actions are dropped instead of granted', () => {
  const config = {genie: {enabled: true, authority: ['inspect', 'root', 'rebalance', 42, 'command']}};
  assert.deepEqual(genieConfig(config).authority, ['inspect', 'rebalance', 'command']);
  assert.equal(may(config, 'root'), false);
  assert.equal(may(config, 'recovery'), false);
});

test('a malformed authority value falls back to the conservative default', () => {
  assert.deepEqual(genieConfig({genie: {enabled: true, authority: 'all'}}).authority, ['inspect', 'research']);
  assert.deepEqual(genieConfig({genie: {enabled: true, authority: []}}).authority, []);
});

test('the brain ladder is parsed once and shared with the resolver', () => {
  const config = {genie: {enabled: true, brain: {mode: 'ladder', pool, fallback: [{url: 'http://127.0.0.1:9000/v1', model: 'x'}]}}};
  const genie = genieConfig(config);
  assert.equal(genie.brain.mode, 'ladder');
  assert.equal(genie.brain.pool.url, pool.url);
  assert.equal(genie.brain.fallback.length, 1);
  assert.equal(genie.brain.commandeer.enabled, false);
});

test('messaging records channels but never stores a credential', () => {
  const genie = genieConfig({genie: {enabled: true, messaging: {channels: ['telegram', '', 7], owner_only: false}}});
  assert.deepEqual(genie.messaging.channels, ['telegram']);
  assert.equal(genie.messaging.owner_only, false);
  assert.equal(genieConfig({genie: {enabled: true}}).messaging.owner_only, true);
});

test('every action in the published list is a known action', () => {
  assert.deepEqual([...GENIE_ACTIONS], ['inspect', 'research', 'rebalance', 'recovery', 'configure', 'command', 'maintenance']);
});

test('the diagnostic line stays short and carries no URL', () => {
  const config = {genie: {enabled: true, authority: ['inspect', 'research', 'rebalance'], brain: {pool, commandeer: {enabled: true, worker: 'spark-a'}}}};
  const line = describeGenie(config);
  assert.match(line, /^Genie: enabled, brain via pool/);
  assert.match(line, /commandeering spark-a/);
  assert.match(line, /authority inspect\/research\/rebalance/);
  assert.doesNotMatch(line, /http/);
  assert.equal(describeGenie({}), 'Genie: disabled');
});
