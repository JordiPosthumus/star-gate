// Genie setup: install his private runtime, seed his identity, and write the
// brain configuration. Nothing global is touched and no service is started.
import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {configPath, projectRoot} from '../ds4-gateway/config.mjs';
import {seedGenieHome} from '../ds4-gateway/genie-identity.mjs';
import {installHermes} from './genie-runtime.mjs';

const usage = `npm run genie:setup -- [--model-url URL --model ID] [--connection PRIVATE_JSON] [--commandeer WORKER] [--yes]

Installs Gate Genie's private Hermes runtime under runtime/genie-runtime/,
seeds genie/SOUL.md and genie/AGENTS.md into his profile, and writes
genie.brain into the gateway configuration. No service is started.`;

let rl, hidden = false;
async function question(prompt, {secret = false} = {}) {
  if (!process.stdin.isTTY) throw new Error('Interactive setup needs a terminal. Supply --model-url and --model, or --connection with private model settings.');
  if (!rl) {
    const output = new Writable({write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); }});
    rl = createInterface({input: process.stdin, output, terminal: true});
  }
  if (secret) {
    process.stdout.write(prompt);
    hidden = true;
    try { return (await rl.question('')).trim(); }
    finally { hidden = false; rl.history = []; process.stdout.write('\n'); }
  }
  return (await rl.question(prompt)).trim();
}

function modelURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTP(S) model API URL without embedded credentials, query or fragment.');
  url.pathname = url.pathname.replace(/\/$/, '') || '/v1';
  return url.toString().replace(/\/$/, '');
}

function privateJSON(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error('Cannot read valid ' + label + '. No configuration was overwritten.'); }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--yes', '--help'].includes(key)) options[key] = true;
    else if (['--model-url', '--model', '--connection', '--commandeer'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[key] = argv[++i];
    else throw new Error('Usage: ' + usage);
  }
  return options;
}

// A brain config is written only for the fields the owner actually supplied.
// The pool default points at the Continuity Door, which is the client port.
export function brainConfig({pool = {url: 'http://127.0.0.1:30000/v1', model: 'PoolModel'}, connection, commandeer} = {}) {
  const brain = {mode: connection ? 'ladder' : 'pool', pool};
  if (connection) brain.dedicated = {url: modelURL(connection.url), model: String(connection.model ?? '').trim(), ...(connection.api_key ? {api_key: connection.api_key} : {})};
  if (commandeer) brain.commandeer = {enabled: true, worker: commandeer, max_seconds: 900, allow_while_serving: false};
  return brain;
}

export async function setupGenie({options = {}, root = projectRoot, log = console.log, install = installHermes, ask = question, configFile = configPath()} = {}) {
  if (!fs.existsSync(configFile)) throw new Error(`No gateway configuration at ${configFile}. Run npm run setup first.`);
  const before = fs.readFileSync(configFile, 'utf8');
  const config = privateJSON(before, 'gateway configuration');

  let connection;
  if (options['--connection']) connection = privateJSON(fs.readFileSync(options['--connection'], 'utf8'), 'private connection file');
  else if (options['--model-url'] || options['--model']) {
    if (!options['--model-url'] || !options['--model']) throw new Error('Supply both --model-url and --model.');
    connection = {url: options['--model-url'], model: options['--model']};
    if (!options['--yes']) {
      const key = await ask('API key for that endpoint (leave empty for none): ', {secret: true});
      if (key) connection.api_key = key;
    }
  }

  const runtime = await install(root, {log});
  const seeded = seedGenieHome(path.dirname(config.state_file));

  const brain = brainConfig({connection, commandeer: options['--commandeer']});
  const next = {...config, genie: {...(config.genie === false ? {} : config.genie ?? {}), enabled: true, brain}};
  if (!Array.isArray(next.genie.authority)) next.genie.authority = ['inspect', 'research', 'rebalance', 'recovery', 'configure'];
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + '\n', {mode: 0o600});
  fs.chmodSync(configFile, 0o600);

  log(`Genie runtime: ${runtime.source}`);
  log(`Genie profile: ${seeded.home}${seeded.seeded.length ? ` (seeded ${seeded.seeded.join(', ')})` : ' (identity preserved)'}`);
  log('Genie is enabled. Start the dashboard and open the Genie tab; no service was started by setup.');
  return {runtime, profile: seeded.home, brain};
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options['--help']) { console.log(usage); process.exit(0); }
    await setupGenie({options});
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
