// Talk to Genie from a terminal. One question, or an interactive session.
// History is private runtime state and never enters Git.
import fs from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {loadConfig} from '../ds4-gateway/config.mjs';
import {hermesHome} from '../ds4-gateway/hermes-profile.mjs';
import {createHermesProvider} from '../ds4-gateway/genie-hermes.mjs';

const MAX_HISTORY = 40;

export function historyFile(config, session) {
  if (!/^[a-zA-Z0-9][\w-]{0,31}$/.test(session)) throw new Error('Session names are 1-32 letters, digits, underscores or dashes.');
  return path.join(path.dirname(config.state_file), 'genie-chat', `${session}.json`);
}

export function readHistory(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value)) return [];
    return value
      .filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
      .slice(-MAX_HISTORY);
  } catch { return []; }
}

export function writeHistory(file, history) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(history.slice(-MAX_HISTORY), null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
}

async function ask(provider, history, message, onDelta) {
  const result = await provider.generate({message, history, sessionId: null, context: {}, onDelta});
  return result.text;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('npm run genie -- "question" [--session NAME] [--new]\n\nTalks to Gate Genie through the pinned Hermes runtime. With no question and a terminal, starts an interactive session.');
    return;
  }
  let session = 'cli';
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session' && args[i + 1]) session = args[++i];
    else if (args[i] === '--new') session = `cli-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    else words.push(args[i]);
  }
  const {config} = loadConfig();
  if (config.genie === false) throw new Error('Genie is disabled in this configuration (genie: false).');
  const provider = createHermesProvider(config, {home: hermesHome(config)});
  const file = historyFile(config, session);
  const history = readHistory(file);
  const onDelta = text => process.stdout.write(text);

  const one = words.join(' ').trim();
  if (one) {
    const text = await ask(provider, history, one, onDelta);
    process.stdout.write('\n');
    writeHistory(file, [...history, {role: 'user', content: one}, {role: 'assistant', content: text}]);
    return;
  }
  if (!process.stdin.isTTY) throw new Error('Give a question, or run this from a terminal for an interactive session.');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  console.log(`Genie (${session}). Type /exit to leave.`);
  try {
    for (;;) {
      const message = (await rl.question('You> ')).trim();
      if (!message) continue;
      if (message === '/exit' || message === '/quit') break;
      try {
        const text = await ask(provider, history, message, onDelta);
        process.stdout.write('\n');
        history.push({role: 'user', content: message}, {role: 'assistant', content: text});
        writeHistory(file, history);
      } catch (error) { console.error('\n' + error.message); }
    }
  } finally { rl.close(); }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
