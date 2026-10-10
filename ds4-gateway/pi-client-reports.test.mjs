import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PiClientReports, piClientForDisplay, redactPiText, validatePiReport, PI_REPORT_STAGES} from './pi-client-reports.mjs';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const clock = () => NOW;
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reports-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
const report = over => ({
  schema: 1,
  revision: 'a'.repeat(64),
  stage: 'write',
  ok: true,
  error_code: null,
  error_message: null,
  client: {os: 'Windows 11', powershell: '5.1', pi_version: '0.85.1'},
  base_url: 'http://host.invalid:30000/v1',
  duration_ms: 1234,
  steps: [{stage: 'fetch', ok: true, detail: 'fetched'}],
  ...over,
});

test('accepts a valid report and stamps its own id and time', () => {
  const store = new PiClientReports({now: clock});
  const receipt = store.record(report());
  assert.equal(receipt.accepted, true);
  assert.match(receipt.report_id, /^[0-9a-f-]{36}$/);
  assert.equal(receipt.at, new Date(NOW).toISOString());
  const [stored] = store.snapshot().reports;
  assert.equal(stored.stage, 'write');
  assert.equal(stored.client.os, 'Windows 11');
});

test('a client report may not set its own at or report_id', () => {
  const store = new PiClientReports({now: clock});
  for (const field of ['at', 'report_id']) {
    assert.throws(() => store.record(report({[field]: 'client-supplied'})), error => error.code === 'invalid');
  }
});

test('rejects unknown fields at every level', () => {
  const store = new PiClientReports({now: clock});
  assert.throws(() => store.record(report({extra: 1})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({client: {os: 'Windows', powershell: '5.1', pi_version: null, extra: 1}})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({steps: [{stage: 'fetch', ok: true, detail: null, extra: 1}]})), error => error.code === 'invalid');
  // A credential field must be rejected outright, never stored.
  assert.throws(() => store.record(report({api_key: 'x'})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({authorization: 'Bearer x'})), error => error.code === 'invalid');
});

test('rejects a bad stage, a non-boolean ok and a bad schema', () => {
  const store = new PiClientReports({now: clock});
  assert.throws(() => store.record(report({stage: 'deploy'})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({ok: 'yes'})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({schema: 2})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({steps: [{stage: 'deploy', ok: true, detail: null}]})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({steps: [{stage: 'fetch', ok: 'yes', detail: null}]})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({steps: {}})), error => error.code === 'invalid');
});

test('caps every string and rejects control characters', () => {
  const store = new PiClientReports({now: clock});
  assert.throws(() => store.record(report({error_message: 'x'.repeat(513)})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({error_message: 'bad\u0007bell'})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({steps: [{stage: 'fetch', ok: false, detail: 'x'.repeat(513)}]})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({client: {os: '', powershell: '5.1', pi_version: null}})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({client: {os: 'Windows', powershell: '', pi_version: null}})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({base_url: 'x'.repeat(257)})), error => error.code === 'invalid');
  // Exactly at the cap is accepted.
  const ok = store.record(report({error_message: 'x'.repeat(512)}));
  assert.equal(ok.accepted, true);
});

test('client.pi_version may be null when pi is absent', () => {
  const store = new PiClientReports({now: clock});
  assert.equal(store.record(report({stage: 'pi-check', client: {os: 'Windows', powershell: '5.1', pi_version: null}})).accepted, true);
  assert.equal(store.snapshot().reports[0].client.pi_version, null);
});

test('clamps duration and rejects an out-of-range one', () => {
  const store = new PiClientReports({now: clock});
  assert.equal(store.record(report({duration_ms: 0})).accepted, true);
  assert.equal(store.record(report({duration_ms: 86400000})).accepted, true);
  assert.throws(() => store.record(report({duration_ms: -1})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({duration_ms: 86400001})), error => error.code === 'invalid');
  assert.throws(() => store.record(report({duration_ms: 'slow'})), error => error.code === 'invalid');
});

test('bounds the step count and the total step bytes', () => {
  const store = new PiClientReports({now: clock});
  const many = Array.from({length: 17}, () => ({stage: 'fetch', ok: true, detail: null}));
  assert.throws(() => store.record(report({steps: many})), error => error.code === 'invalid');
  const fat = Array.from({length: 16}, () => ({stage: 'fetch', ok: true, detail: 'y'.repeat(400)}));
  assert.throws(() => store.record(report({steps: fat})), error => error.code === 'invalid');
});

test('redacts user paths, URL userinfo and bearer fragments from free text', () => {
  const store = new PiClientReports({now: clock, redactHosts: ['gateway.invalid', '192.0.2.5']});
  // Credential-shaped fixtures are assembled at run time so this source file
  // never carries a literal URL userinfo or a real-looking address.
  const userinfo = ['user', 'pass'].join(':');
  const token = ['abc', 'def-123'].join('.');
  store.record(report({
    ok: false,
    error_message: `C:\\Users\\max\\AppData\\Local failure at http://${userinfo}@gateway.invalid/v1 with Bearer ${token} and 192.0.2.5`,
    steps: [{stage: 'fetch', ok: false, detail: 'wrote C:\\Users\\max\\.pi\\agent\\models.json'}],
  }));
  const [stored] = store.snapshot().reports;
  for (const leak of ['max', userinfo, token, 'gateway.invalid', '192.0.2.5']) {
    assert.ok(!JSON.stringify(stored).includes(leak), `stored report must not retain ${leak}`);
  }
  assert.match(stored.error_message, /C:\\Users\\<user>/);
  assert.match(stored.error_message, /Bearer <redacted>/);
  assert.match(stored.steps[0].detail, /C:\\Users\\<user>/);
});

test('structured base_url is capped but not host-redacted', () => {
  const store = new PiClientReports({now: clock, redactHosts: ['gateway.invalid']});
  store.record(report({base_url: 'http://gateway.invalid:30000/v1'}));
  assert.equal(store.snapshot().reports[0].base_url, 'http://gateway.invalid:30000/v1');
});

test('redaction is applied before the cap so it cannot be truncated into a leak', () => {
  const redacted = redactPiText(`${'a'.repeat(400)}Bearer supersecrettoken`, []);
  assert.ok(!redacted.includes('supersecrettoken'));
});

test('durability: an acknowledged report survives a restart', t => {
  const file = path.join(directory(t), 'client-reports.jsonl');
  const first = new PiClientReports({now: clock, file});
  const receipt = first.record(report({stage: 'merge'}));
  const second = new PiClientReports({now: clock, file});
  const restored = second.snapshot().reports;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].report_id, receipt.report_id);
  assert.equal(restored[0].stage, 'merge');
});

test('malformed lines are counted, not thrown, when loading', t => {
  const file = path.join(directory(t), 'client-reports.jsonl');
  const store = new PiClientReports({now: clock, file});
  store.record(report());
  fs.appendFileSync(file, 'not json\n{"no_id":true}\n');
  const reloaded = new PiClientReports({now: clock, file});
  assert.equal(reloaded.snapshot().malformed_lines, 2);
  assert.equal(reloaded.snapshot().reports.length, 1);
});

test('a missing file is a clean start, not a failure', t => {
  const store = new PiClientReports({now: clock, file: path.join(directory(t), 'absent.jsonl')});
  assert.equal(store.snapshot().reports.length, 0);
  assert.equal(store.snapshot().persistence_error, null);
});

test('retention is byte-aware, not just entry-count', () => {
  const store = new PiClientReports({now: clock, maxEntries: 1000, maxBytes: 8192});
  for (let i = 0; i < 60; i++) {
    store.record(report({duration_ms: i, error_message: 'z'.repeat(300)}));
  }
  const snapshot = store.snapshot();
  assert.ok(snapshot.retention_bytes <= 8192, `retained ${snapshot.retention_bytes} bytes exceeds the limit`);
  assert.ok(snapshot.reports.length < 60, 'old reports must be dropped to stay inside the byte budget');
  // The newest report is always retained.
  assert.equal(snapshot.reports.at(-1).duration_ms, 59);
});

test('entry-count retention still applies', () => {
  const store = new PiClientReports({now: clock, maxEntries: 3, maxBytes: 1048576});
  for (let i = 0; i < 10; i++) store.record(report({duration_ms: i}));
  const reports = store.snapshot().reports;
  assert.equal(reports.length, 3);
  assert.deepEqual(reports.map(r => r.duration_ms), [7, 8, 9]);
});

test('the file stays bounded after compaction and is left valid JSONL', t => {
  const file = path.join(directory(t), 'client-reports.jsonl');
  const store = new PiClientReports({now: clock, file, maxEntries: 5, maxBytes: 4096});
  for (let i = 0; i < 40; i++) store.record(report({duration_ms: i, error_message: 'q'.repeat(200)}));
  store.flush();
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= 5, `file kept ${lines.length} lines`);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(fs.statSync(file).size <= 4096 * 2, 'the file must not grow without bound');
  // Everything retained is still loadable.
  assert.equal(new PiClientReports({now: clock, file, maxEntries: 5, maxBytes: 4096}).snapshot().reports.length, lines.length);
});

test('the store refuses to write through a symlinked file', t => {
  const dir = directory(t);
  const real = path.join(dir, 'real.jsonl');
  const link = path.join(dir, 'link.jsonl');
  fs.writeFileSync(real, '');
  fs.symlinkSync(real, link);
  const store = new PiClientReports({now: clock, file: link});
  assert.ok(store.snapshot().persistence_error !== null || store.loadFailed);
  assert.throws(() => store.record(report()), /could not be stored/);
});

test('a persistence failure throws without the invalid code so the route can answer 503', t => {
  const dir = directory(t);
  const store = new PiClientReports({now: clock, file: path.join(dir, 'reports.jsonl')});
  fs.rmSync(dir, {recursive: true, force: true});
  fs.writeFileSync(dir, 'not a directory');
  t.after(() => fs.rmSync(dir, {force: true}));
  assert.throws(() => store.record(report()), error => error.code !== 'invalid' && /could not be stored/.test(error.message));
});

test('a validation failure keeps the invalid code so the route answers 400', () => {
  const store = new PiClientReports({now: clock});
  assert.throws(() => store.record(report({stage: 'nope'})), error => error.code === 'invalid');
  // A rejected report is not stored and not persisted.
  assert.equal(store.snapshot().reports.length, 0);
});

test('piClientForDisplay keeps only allowlisted fields and clamps', () => {
  const store = new PiClientReports({now: clock});
  store.record(report());
  const display = piClientForDisplay(store.snapshot());
  assert.equal(display.schema, 1);
  assert.equal(display.reports.length, 1);
  const [shown] = display.reports;
  assert.deepEqual(Object.keys(shown).sort(), ['at', 'base_url', 'client', 'duration_ms', 'error_code', 'error_message', 'ok', 'report_id', 'revision', 'schema', 'stage', 'steps'].sort());
  assert.equal(shown.duration_ms, 1234);
  assert.deepEqual(Object.keys(shown.client).sort(), ['os', 'pi_version', 'powershell']);
  // An unknown field cannot survive the projection even if it reached the file.
  assert.equal('extra' in shown, false);
});

test('piClientForDisplay drops malformed entries instead of trusting them', () => {
  const raw = {
    schema: 1,
    malformed_lines: 2,
    reports: [
      {report_id: 'ok-id', at: '2026-01-01T00:00:00.000Z', stage: 'fetch', ok: true, client: {os: 'Windows', powershell: '5.1', pi_version: null}, steps: []},
      null,
      'not an object',
      {report_id: 'bad-stage', at: '2026-01-01T00:00:00.000Z', stage: 'deploy', ok: true, client: {os: 'Windows', powershell: '5.1'}},
      {report_id: 'bad-date', at: 'not-a-date', stage: 'fetch', ok: true, client: {os: 'Windows', powershell: '5.1'}},
      {report_id: 'no-client', at: '2026-01-01T00:00:00.000Z', stage: 'fetch', ok: true, client: null},
      {report_id: 'control', at: '2026-01-01T00:00:00.000Z', stage: 'fetch', ok: true, client: {os: 'Windows', powershell: '5.1'}, error_message: 'bell\u0007'},
    ],
  };
  const display = piClientForDisplay(raw);
  // Entries that are structurally unusable are dropped; a valid entry carrying
  // unusable FREE TEXT is kept with that field nulled, never rendered raw.
  assert.deepEqual(display.reports.map(r => r.report_id), ['ok-id', 'control']);
  assert.equal(display.reports[1].error_message, null);
  assert.equal(display.malformed_lines, 2);
});

test('piClientForDisplay is idempotent', () => {
  const store = new PiClientReports({now: clock});
  store.record(report());
  store.record(report({stage: 'validate', ok: false, error_code: 'E1', error_message: 'failed at C:\\Users\\max\\x'}));
  const once = piClientForDisplay(store.snapshot());
  const twice = piClientForDisplay(once);
  assert.deepEqual(twice, once);
});

test('piClientForDisplay refuses a non-schema-1 or shapeless payload', () => {
  assert.equal(piClientForDisplay(null), null);
  assert.equal(piClientForDisplay({}), null);
  assert.equal(piClientForDisplay({schema: 2, reports: []}), null);
  assert.equal(piClientForDisplay({schema: 1, reports: 'nope'}), null);
});

test('validatePiReport is exported and rejects a non-object', () => {
  assert.throws(() => validatePiReport('nope'), error => error.code === 'invalid');
  assert.throws(() => validatePiReport(null), error => error.code === 'invalid');
  assert.throws(() => validatePiReport([]), error => error.code === 'invalid');
});

test('every declared stage is accepted and survives the display projection', () => {
  const store = new PiClientReports({now: clock});
  for (const stage of PI_REPORT_STAGES) {
    store.record(report({stage, steps: [{stage, ok: true, detail: null}]}));
  }
  const display = piClientForDisplay(store.snapshot());
  assert.deepEqual([...new Set(display.reports.map(r => r.stage))].sort(), [...PI_REPORT_STAGES].sort());
});
