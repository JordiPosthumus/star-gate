// Deploy-time verification: does the checkout the gateway is ABOUT to run
// actually carry every runtime artifact the code reads?
//
// The gap this closes: scripts/check.mjs validates JavaScript and shell syntax,
// and each module's own test suite proves behaviour — but neither notices when
// a committed ASSET (the Windows script template, the client defaults JSON, a
// UI file) is missing from the deployed copy. The gateway tolerates a missing
// client script by design (it answers a typed 503), so a half-synced deploy
// looks healthy right until a client tries to install.
//
// Read-only. Changes nothing, contacts nothing.
import fs from 'node:fs';
import path from 'node:path';

const readText = file => fs.readFileSync(file, 'utf8');
const exists = file => fs.existsSync(file);

// Each check is a pure function of the checkout directory.
export const DEPLOYMENT_CHECKS = [
  {
    id: 'client_script_template',
    description: 'Windows client-sync script template is present and non-trivial',
    // The gateway reads this to render /v1/client/pi/install.ps1.
    run: dir => {
      const file = path.join(dir, 'ds4-gateway', 'client', 'pi-stargate-sync.ps1');
      if (!exists(file)) return {ok: false, detail: 'ds4-gateway/client/pi-stargate-sync.ps1 is missing'};
      const source = readText(file);
      if (source.trim().length < 256) return {ok: false, detail: 'the script template is present but essentially empty'};
      for (const marker of ['$StargateBaseUrl', '$StargateFallbackBaseUrls', '$StargateApiKey', '-Depth 100', 'Send-Report']) {
        if (!source.includes(marker)) return {ok: false, detail: `the script template no longer contains ${marker}`};
      }
      return {ok: true, detail: `${source.length} bytes`};
    },
  },
  {
    id: 'client_defaults',
    description: 'Client provider defaults parse as JSON and carry the provider block',
    run: dir => {
      const file = path.join(dir, 'ds4-gateway', 'pi-client-defaults.json');
      if (!exists(file)) return {ok: false, detail: 'ds4-gateway/pi-client-defaults.json is missing'};
      let parsed;
      try {
        parsed = JSON.parse(readText(file));
      } catch (error) {
        return {ok: false, detail: `ds4-gateway/pi-client-defaults.json is not valid JSON: ${error.message}`};
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.provider || !parsed.model) {
        return {ok: false, detail: 'client defaults lack a provider or model block'};
      }
      // A real key here would be disclosed on an unauthenticated LAN route.
      if (typeof parsed.api_key === 'string' && parsed.api_key !== 'none') {
        return {ok: false, detail: 'client defaults carry an api_key; the served key must be the constant none'};
      }
      return {ok: true, detail: `provider ${parsed.provider}`};
    },
  },
  {
    id: 'client_modules',
    description: 'Client config and report modules are present',
    run: dir => {
      const missing = ['pi-client-config.mjs', 'pi-client-reports.mjs']
        .filter(name => !exists(path.join(dir, 'ds4-gateway', name)));
      return missing.length ? {ok: false, detail: `missing module(s): ${missing.join(', ')}`}
        : {ok: true, detail: 'pi-client-config.mjs, pi-client-reports.mjs'};
    },
  },
  {
    id: 'dashboard_assets',
    description: 'Dashboard UI assets are present',
    run: dir => {
      const missing = [['ui', 'index.html'], ['ui', 'ui.js'], ['ui', 'brand.css']]
        .filter(([sub, name]) => !exists(path.join(dir, 'ds4-gateway', sub, name)));
      return missing.length ? {ok: false, detail: `missing dashboard asset(s): ${missing.map(part => part.join('/')).join(', ')}`}
        : {ok: true, detail: 'index.html, ui.js, brand.css'};
    },
  },
  {
    id: 'ui_credit_removed',
    description: 'The UI carries no upstream-engine attribution',
    // A stylistic rule the owner enforced: the engine is an implementation
    // detail and does not belong on an operator screen.
    run: dir => {
      for (const [sub, name] of [['ui', 'index.html'], ['ui', 'ui.js']]) {
        const file = path.join(dir, 'ds4-gateway', sub, name);
        if (!exists(file)) continue;
        const match = readText(file).match(/antirez|Sanfilippo/i);
        if (match) return {ok: false, detail: `${sub}/${name} still credits ${match[0]}`};
      }
      return {ok: true, detail: 'no attribution strings in the UI'};
    },
  },
];

export function checkDeployment(directory) {
  if (typeof directory !== 'string' || directory.length === 0) throw new Error('A checkout directory is required');
  const dir = path.resolve(directory);
  const checks = DEPLOYMENT_CHECKS.map(({id, description, run}) => {
    let result;
    try {
      result = run(dir);
    } catch (error) {
      // A throwing check is a FAILED check, never a skipped one.
      result = {ok: false, detail: `check threw: ${error.message}`};
    }
    return {id, description, ok: result.ok === true, detail: result.detail ?? null};
  });
  return {directory: dir, ok: checks.every(check => check.ok), checks};
}

// CLI: `node ds4-gateway/deploy-check.mjs [dir]` — exits non-zero on any failure.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const report = checkDeployment(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
  for (const check of report.checks) {
    process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.id.padEnd(22)} ${check.detail ?? ''}\n`);
  }
  process.stdout.write(report.ok ? 'Deployment check passed.\n' : 'Deployment check FAILED.\n');
  process.exit(report.ok ? 0 : 1);
}
