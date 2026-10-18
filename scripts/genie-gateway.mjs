// Run Gate Genie's messaging gateway (Telegram and any other Hermes channel)
// against the same private profile the dashboard uses. Star Gate owns the
// launch; Hermes owns authorization, delivery and the bot tokens.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {loadConfig} from '../ds4-gateway/config.mjs';
import {hermesHome} from '../ds4-gateway/hermes-profile.mjs';
import {genieConfig} from '../ds4-gateway/genie-config.mjs';

export function gatewayStatus(config, {home = hermesHome(config)} = {}) {
  const genie = genieConfig(config);
  const chat = config?.genie_chat ?? {};
  const source = typeof chat.source === 'string' ? chat.source : null;
  const python = typeof chat.python === 'string' ? chat.python : null;
  return {
    enabled: genie.enabled,
    channels: genie.messaging.channels,
    owner_only: genie.messaging.owner_only,
    source,
    python,
    home,
    sourceReady: Boolean(source && fs.existsSync(path.join(source, 'gateway', 'run.py'))),
    interpreterReady: Boolean(python && fs.existsSync(python)),
    profileReady: Boolean(home && fs.existsSync(path.join(home, 'config.yaml'))),
    credentialsReady: Boolean(home && fs.existsSync(path.join(home, '.env'))),
  };
}

// A non-interactive module launch. The profile is the only shared state; the
// source checkout is never modified.
export function bootCode(source) {
  return `import runpy,sys; sys.path.insert(0, ${JSON.stringify(source)}); runpy.run_module("gateway.run", run_name="__main__", alter_sys=True)`;
}

export function assertRunnable(status) {
  if (!status.enabled) throw new Error('Genie is disabled in this configuration.');
  if (!status.owner_only) throw new Error('Refusing to start messaging for a non-owner audience. Set genie.messaging.owner_only to true.');
  if (!status.sourceReady) throw new Error('The pinned Hermes source is missing gateway/run.py. Run npm run genie:setup.');
  if (!status.interpreterReady) throw new Error('The configured Hermes interpreter does not exist. Run npm run genie:setup.');
  if (!status.profileReady) throw new Error('The private Hermes profile has no config.yaml. Run npm run genie:setup or native Hermes setup.');
}

export function runGateway(config, {home = hermesHome(config), spawnImpl = spawn, onExit = () => {}} = {}) {
  const status = gatewayStatus(config, {home});
  assertRunnable(status);
  const child = spawnImpl(status.python, ['-I', '-c', bootCode(status.source)], {
    cwd: status.source,
    env: {...process.env, HERMES_HOME: home, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1'},
    stdio: 'inherit',
  });
  const forward = signal => { try { child.kill(signal); } catch { /* already gone */ } };
  const onInt = () => forward('SIGINT');
  const onTerm = () => forward('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  child.on('exit', (code, signal) => {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    onExit({code, signal});
  });
  return child;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('npm run genie:gateway -- [--check] [--json]\n\nRuns the pinned Hermes messaging gateway against Genie\'s private profile. --check reports readiness without starting anything.');
    return;
  }
  const {config} = loadConfig();
  const status = gatewayStatus(config);
  if (args.includes('--check') || args.includes('--json')) {
    const value = {...status, runnable: (() => { try { assertRunnable(status); return true; } catch { return false; } })()};
    if (args.includes('--json')) console.log(JSON.stringify(value, null, 2));
    else {
      console.log(`Genie messaging: ${status.channels.length ? status.channels.join(', ') : 'no channel configured'}`);
      console.log(`  enabled: ${status.enabled ? 'yes' : 'no'}`);
      console.log(`  owner only: ${status.owner_only ? 'yes' : 'no'}`);
      console.log(`  Hermes source: ${status.sourceReady ? 'ready' : 'missing'} (${status.source ?? 'not configured'})`);
      console.log(`  profile: ${status.profileReady ? 'ready' : 'missing'} (${status.home})`);
      console.log(`  credentials: ${status.credentialsReady ? 'present' : 'missing'}`);
    }
    if (!value.runnable) process.exitCode = 1;
    return;
  }
  console.log(`Starting Genie messaging for: ${status.channels.join(', ') || 'the profile\'s configured channels'}`);
  const child = runGateway(config, {onExit: ({code}) => { process.exitCode = code ?? 0; }});
  await new Promise(resolve => child.on('exit', resolve));
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
