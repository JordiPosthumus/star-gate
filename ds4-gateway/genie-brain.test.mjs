import test from 'node:test';
import assert from 'node:assert/strict';
import {brainPolicy, fleetIsIdle, fleetSnapshot, resolveBrainRoute, DEFAULT_MAX_COMMANDEER_SECONDS} from './genie-brain.mjs';

const pool = {url: 'http://127.0.0.1:30000/v1', model: 'PoolModel'};
const dedicated = {url: 'http://127.0.0.1:8000/v1', model: 'genie-local'};
const down = {workers: 3, healthy: 0, active: 0, queued: 0};
const busy = {workers: 3, healthy: 2, active: 1, queued: 4};

test('the pool is the default route and is marked as observer traffic', () => {
  const route = resolveBrainRoute({genie: {brain: {pool}}}, busy);
  assert.equal(route.route, 'pool');
  assert.equal(route.url, pool.url);
  assert.equal(route.observer, true);
  assert.equal(route.commandeering, false);
});

test('a dedicated endpoint is preferred only in dedicated or ladder mode', () => {
  const config = {genie: {brain: {mode: 'dedicated', pool, dedicated}}};
  assert.equal(resolveBrainRoute(config, busy).route, 'dedicated');
  assert.equal(resolveBrainRoute({genie: {brain: {mode: 'pool', pool, dedicated}}}, busy).route, 'pool');
  assert.equal(resolveBrainRoute({genie: {brain: {mode: 'ladder', pool, dedicated}}}, busy).route, 'pool');
});

test('a known-dead endpoint is not retried in the same turn', () => {
  const config = {genie: {brain: {mode: 'ladder', pool, dedicated}}};
  const route = resolveBrainRoute(config, busy, {attempts: [pool.url]});
  assert.equal(route.route, 'dedicated');
});

test('the configured fallback ladder is walked in order', () => {
  const third = {url: 'http://127.0.0.1:9000/v1', model: 'last-resort'};
  const config = {genie: {brain: {mode: 'ladder', pool, dedicated, fallback: [third]}}};
  const route = resolveBrainRoute(config, busy, {attempts: [pool.url, dedicated.url]});
  assert.equal(route.route, 'fallback');
  assert.equal(route.url, third.url);
  assert.equal(route.observer, false);
});

test('commandeering is refused while anyone is served or waiting', () => {
  const config = {genie: {brain: {pool, commandeer: {enabled: true, worker: 'spark-a'}}}};
  const route = resolveBrainRoute(config, busy, {attempts: [pool.url]});
  assert.equal(route.route, 'unavailable');
  assert.match(route.reason, /user work outranks the brain/);
});

test('commandeering a machine is allowed when the fleet serves nobody', () => {
  const config = {genie: {brain: {pool, commandeer: {enabled: true, worker: 'spark-a'}}}};
  const route = resolveBrainRoute(config, down, {attempts: [pool.url], now: 1000});
  assert.equal(route.route, 'commandeer');
  assert.equal(route.worker, 'spark-a');
  assert.equal(route.commandeering, true);
  assert.equal(route.release_at, 1000 + DEFAULT_MAX_COMMANDEER_SECONDS * 1000);
});

test('a draining request still counts as someone being served', () => {
  const config = {genie: {brain: {pool, commandeer: {enabled: true, worker: 'spark-a'}}}};
  assert.equal(resolveBrainRoute(config, {workers: 2, healthy: 0, active: 1, queued: 0}, {attempts: [pool.url]}).route, 'unavailable');
});

test('commandeering while serving needs an explicit owner opt-in', () => {
  const config = {genie: {brain: {pool, commandeer: {enabled: true, worker: 'spark-a', allow_while_serving: true}}}};
  const route = resolveBrainRoute(config, busy, {attempts: [pool.url]});
  assert.equal(route.route, 'commandeer');
  assert.match(route.reason, /standing authorization/);
});

test('an unenrolled commandeering worker is never invented', () => {
  const policy = brainPolicy({genie: {brain: {commandeer: {enabled: true, worker: '   '}}}});
  assert.equal(policy.commandeer.enabled, false);
  assert.equal(policy.commandeer.worker, null);
  assert.equal(resolveBrainRoute({genie: {brain: {pool, commandeer: {enabled: true}}}}, down, {attempts: [pool.url]}).route, 'unavailable');
});

test('a malformed endpoint is dropped instead of being used', () => {
  const policy = brainPolicy({genie: {brain: {pool: {url: 'not-a-url'}, dedicated}}});
  assert.equal(policy.pool, null);
  assert.equal(resolveBrainRoute({genie: {brain: {pool: {url: 'not-a-url'}}}}, busy).route, 'unavailable');
});

test('the brain has no route and no authority when nothing is configured', () => {
  const route = resolveBrainRoute({}, busy);
  assert.equal(route.route, 'unavailable');
  assert.equal(route.commandeering, false);
  assert.equal(route.release_at, null);
  assert.equal(route.reason, 'No configured route and commandeering is not enrolled.');
});

test('fleet snapshots count only undrained healthy workers and ignore unknown numbers', () => {
  const snapshot = fleetSnapshot({workers: [
    {is_healthy: true, active: 2, queued: 1},
    {is_healthy: true, drained: true, active: 5},
    {is_healthy: false, active: 'x'},
  ]});
  assert.deepEqual(snapshot, {workers: 3, healthy: 1, active: 7, queued: 1});
  assert.equal(fleetIsIdle(snapshot), false);
  assert.equal(fleetIsIdle({workers: 0, healthy: 0, active: 0, queued: 0}), true);
});
