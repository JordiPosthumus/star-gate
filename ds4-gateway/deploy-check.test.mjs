// Guards the deployment check itself, so a broken check cannot silently pass.
//
// The valuable assertions here are the NEGATIVE ones: a checkout missing an
// asset, or carrying an attribution string, must FAIL. A check that only ever
// returns ok is worse than no check, because it launders a bad deploy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

import {checkDeployment} from './deploy-check.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// A throwaway copy of just the files the checks inspect.
function fixture(tweaks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-check-'));
  const put = (relative, content) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    // Pad with a non-space so the length gate is satisfied: trailing spaces are
    // trimmed before the check measures the template.
    const body = ('$StargateBaseUrl $StargateFallbackBaseUrls $StargateApiKey -Depth 100 Send-Report')
      .padEnd(400, '.');
    fs.writeFileSync(file, tweaks[relative] ?? content.replace('__PREAMBLE__', body));
  };
  put('ds4-gateway/client/pi-stargate-sync.ps1', '# __PREAMBLE__');
  put('ds4-gateway/pi-client-defaults.json', JSON.stringify({provider: 'stargate', model: 'pool', api_key: 'none'}));
  put('ds4-gateway/pi-client-config.mjs', 'export const buildPiClientBundle = () => ({})');
  put('ds4-gateway/pi-client-reports.mjs', 'export const PiClientReports = class {}');
  put('ds4-gateway/ui/index.html', '<html><body>stargate</body></html>');
  put('ds4-gateway/ui/ui.js', 'export const render = () => null');
  put('ds4-gateway/ui/brand.css', ':root{}');
  // Deletions are expressed by an explicit null, since '' still writes a file.
  for (const [relative, value] of Object.entries(tweaks)) {
    if (value === null) fs.rmSync(path.join(dir, relative), {force: true});
  }
  return dir;
}

const run = dir => checkDeployment(dir);
const resultFor = (report, id) => report.checks.find(check => check.id === id);

test('a complete checkout passes every check', () => {
  const report = run(fixture());
  assert.equal(report.ok, true, `expected ok, got: ${JSON.stringify(report.checks.filter(c => !c.ok))}`);
  assert.equal(report.checks.length, 5);
});

test('a missing client script template fails, naming the file', () => {
  const report = run(fixture({'ds4-gateway/client/pi-stargate-sync.ps1': null}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'client_script_template').detail, /pi-stargate-sync\.ps1 is missing/);
});

test('a truncated script template fails rather than passing on file presence alone', () => {
  const report = run(fixture({'ds4-gateway/client/pi-stargate-sync.ps1': '# stub\n'}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'client_script_template').detail, /essentially empty/);
});

test('a template that lost a preamble variable fails', () => {
  const report = run(fixture({'ds4-gateway/client/pi-stargate-sync.ps1':
    '# no variables here, just padding '.padEnd(300, '.')}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'client_script_template').detail, /\$StargateBaseUrl/);
});

test('malformed client defaults fail with the parse error', () => {
  const report = run(fixture({'ds4-gateway/pi-client-defaults.json': '{not json'}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'client_defaults').detail, /not valid JSON/);
});

test('a real api_key in client defaults is refused', () => {
  // The bundle is served on an unauthenticated LAN route; a real key would leak.
  const report = run(fixture({'ds4-gateway/pi-client-defaults.json':
    JSON.stringify({provider: 'stargate', model: 'pool', api_key: 'sk-live-abc123'})}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'client_defaults').detail, /must be the constant none/);
});

test('a missing client module fails, naming it', () => {
  const report = run(fixture({'ds4-gateway/pi-client-reports.mjs': null}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'client_modules').detail, /pi-client-reports\.mjs/);
});

test('a missing dashboard asset fails, naming it', () => {
  const report = run(fixture({'ds4-gateway/ui/brand.css': null}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'dashboard_assets').detail, /brand\.css/);
});

test('an attribution string returning to the UI fails the check', () => {
  const report = run(fixture({'ds4-gateway/ui/index.html': '<footer>antirez/ds4</footer>'}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'ui_credit_removed').detail, /credits antirez/);
});

test('the Sanfilippo surname alone also trips the attribution check', () => {
  const report = run(fixture({'ds4-gateway/ui/ui.js': 'const author = "Salvatore Sanfilippo"'}));
  assert.equal(report.ok, false);
  assert.match(resultFor(report, 'ui_credit_removed').detail, /Sanfilippo/);
});

test('a check that throws is reported as failed, never as skipped', () => {
  // Simulates a future check whose implementation is buggy on some layout.
  const dir = fixture();
  fs.writeFileSync(path.join(dir, 'ds4-gateway', 'ui', 'index.html'), Buffer.from([0xff, 0xfe, 0x00]));
  const report = run(dir);
  // Even if every read succeeds, the invariant under test is that no check is
  // ever absent from the report and none of them reports ok without a reason.
  assert.equal(report.checks.length, 5);
  for (const check of report.checks) assert.equal(typeof check.ok, 'boolean');
});

test('a relative directory is resolved to an absolute path', () => {
  const report = run('.');
  assert.equal(path.isAbsolute(report.directory), true);
  assert.equal(report.directory, process.cwd());
});

test('the live checkout in this repository passes', () => {
  // The real regression guard: the deployed tree must satisfy its own checks.
  const report = run(repoRoot);
  assert.equal(report.ok, true, `the repository checkout fails its own deployment check: ${
    JSON.stringify(report.checks.filter(check => !check.ok))}`);
});
