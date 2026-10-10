// Structural guard for the committed Windows client-sync template.
//
// This asserts that ds4-gateway/client/pi-stargate-sync.ps1 still contains the
// stages, the -Depth 100 serialization, the generated-preamble contract
// variables and the safety markers the plan (sections 3.5 and 4.1) requires.
// It guards against accidental deletion or a careless rewrite.
//
// It is NOT a functional Windows test and must not be presented as one. It
// never executes PowerShell; the real merge/backup/atomic-write behavior is
// covered only by the manual checklist in docs/client-config-sync.md.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, 'client', 'pi-stargate-sync.ps1');
const template = readFileSync(templatePath, 'utf8');

// The six stage names are a frozen wire contract with pi-client-reports.mjs.
const STAGES = ['fetch', 'parse', 'merge', 'write', 'validate', 'pi-check'];

test('the template reports every frozen stage', () => {
  for (const stage of STAGES) {
    assert.ok(template.includes(`'${stage}'`), `template must reference the ${stage} stage`);
  }
});

test('every ConvertTo-Json call passes -Depth 100', () => {
  // Windows PowerShell 5.1 defaults to -Depth 2 and would stringify the nested
  // compat.chatTemplateKwargs object. There must be no unqualified call.
  assert.ok(template.includes('-Depth 100'), 'template must serialize with -Depth 100');
  const calls = template.split('\n')
    .filter(line => line.includes('ConvertTo-Json') && !line.trim().startsWith('#'));
  assert.ok(calls.length >= 1, 'template must call ConvertTo-Json');
  for (const line of calls) {
    assert.match(line, /-Depth 100/, `ConvertTo-Json without -Depth 100: ${line.trim()}`);
  }
});

test('the template consumes the generated-preamble contract variables', () => {
  for (const variable of ['$StargateBaseUrl', '$StargateFallbackBaseUrls', '$StargateApiKey']) {
    assert.ok(template.includes(variable), `template must consume ${variable}`);
  }
});

test('the template is body-only so the gateway preamble is not duplicated', () => {
  // renderPiClientScript injects these lines; a committed copy would double it.
  assert.ok(!template.includes('# Generated defaults (do not edit; re-fetch to update)'));
  assert.ok(!template.includes('# --- committed body follows ---'));
});

test('every network call carries a timeout', () => {
  const networkCalls = template.split('\n').filter(line => line.includes('Invoke-WebRequest'));
  assert.ok(networkCalls.length >= 2, 'template must fetch the bundle and post the report');
  for (const line of networkCalls) {
    assert.match(line, /-TimeoutSec \d+/, `network call without a timeout: ${line.trim()}`);
  }
});

test('safety marker: timestamped backup before mutation', () => {
  assert.ok(template.includes('.bak'), 'template must write a .bak backup');
  assert.ok(template.includes('Copy-Item'), 'template must copy the existing profile before writing');
  assert.match(template, /yyyyMMdd'T'HHmmss'Z'/);
  assert.ok(template.includes('UtcNow'), 'the backup stamp must be UTC and filename-safe');
});

test('safety marker: merge replaces only the bundle provider', () => {
  assert.match(template, /\['providers'\]\[\$bundle\.provider\]\s*=/, 'merge must assign only providers[bundle.provider]');
  assert.ok(template.includes('providers'), 'merge must target the providers block');
});

test('safety marker: atomic write via a same-directory temp and Move-Item -Force', () => {
  assert.ok(template.includes('.tmp'), 'template must write a temp file');
  assert.match(template, /Move-Item[^\n]*-Force/, 'template must move the temp over models.json with -Force');
});

test('safety marker: the report is a POST to the client report route and is non-fatal', () => {
  assert.ok(template.includes('/client/pi/report'), 'template must post to the report route');
  assert.match(template, /Invoke-WebRequest[^\n]*-Method Post/, 'report must use an HTTP POST');
  assert.ok(template.includes("ContentType 'application/json'"), 'report must declare JSON');
  assert.ok(template.includes('function Send-Report'), 'report must be isolated in Send-Report');
});

test('safety marker: failure exits non-zero with a plain message', () => {
  assert.match(template, /exit 1/, 'template must exit non-zero on failure');
  assert.match(template, /exit 0/, 'template must exit zero on success');
});

test('safety marker: post-write validation checks the nested structure', () => {
  assert.ok(template.includes('chatTemplateKwargs'), 'validation must inspect compat.chatTemplateKwargs');
  assert.match(template, /models\[0\]\.id/, 'validation must check models[0].id');
  assert.match(template, /-is \[string\]/, 'validation must assert chatTemplateKwargs is not a string');
});

test('the template adopts the served defaults only after the provider is verified', () => {
  // Pointing pi's default at a provider that failed to land would leave it
  // unable to start, so the settings write must follow the models.json verify.
  const verify = template.indexOf('nested provider structure verified');
  const adopt = template.indexOf("$settings['defaultModel']");
  assert.ok(verify !== -1 && adopt !== -1, 'both the verify step and the adopt step must exist');
  assert.ok(adopt > verify, 'settings.json must be written after models.json is verified');
  for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"]) {
    assert.ok(template.includes(key), `the adopt step must set ${key}`);
  }
  // The purge must run after the backup, or the removals are unrecoverable.
  const backup = template.indexOf("$backupPath");
  const purge = template.indexOf("Step 5b");
  assert.ok(backup !== -1 && purge !== -1 && purge > backup, 'the purge must follow the backup');
  assert.ok(!/\$\$stamp/.test(template), 'the backup stamp must not be double-escaped');
});

test('a purge only ever removes providers, and keeps the synced one', () => {
  assert.ok(template.includes('purgeProviders'), 'the template must read the purge list');
  assert.match(template, /providers'\]\.Remove\(/, 'the purge must remove entries from providers');
  assert.match(template, /-eq \[string\]\$bundle\.provider\) \{ continue \}/, 'the purge must never remove the synced provider itself');
});

test('the template stays inside the PowerShell 5.1 syntax subset', () => {
  // No PS7-only null-coalescing; the plan also bans ternary operators.
  assert.ok(!template.includes('??'), 'no PS7 null-coalescing operator');
  assert.ok(!/\$[A-Za-z_][\w:]*\s*\?[^.]/.test(template), 'no ternary expression');
});
