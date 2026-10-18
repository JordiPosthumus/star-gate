// The Node side of Genie's conversation: spawn the pinned Hermes runtime for one
// turn, stream deltas, and never let a provider error or credential reach the
// browser. History belongs to the caller; this module is stateless.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const bridge = fileURLToPath(new URL('./genie_hermes.py', import.meta.url));
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

const messages = {
  timeout: 'This reply reached its waiting allowance. Your conversation was kept; the request was not replayed.',
  identity: 'Genie could not load SOUL.md or AGENTS.md. Check the private identity files. Your question was kept.',
  runtime: 'The Hermes runtime could not start. Check the pinned source and its Python environment.',
  provider: 'Hermes could not finish the model request. Check the configured model connection.',
  incomplete: 'Hermes reported an unfinished reply. Your conversation was kept.',
  bridge: 'The connection to Hermes ended without a usable answer. Your conversation was kept.',
};
function failure(code) {
  return Object.assign(new Error(messages[code] ?? messages.bridge), {code});
}

export function providerConfig(config) {
  const chat = config?.genie_chat ?? {};
  for (const key of ['python', 'source', 'url', 'model'])
    if (typeof chat[key] !== 'string' || !chat[key]) throw new Error(`Genie chat needs ${key}.`);
  const url = new URL(chat.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a provider URL without embedded credentials.');
  if (!path.isAbsolute(chat.python) || !path.isAbsolute(chat.source)) throw new Error('Hermes interpreter and source paths must be absolute.');
  if (!fs.existsSync(chat.python)) throw new Error('The configured Hermes interpreter does not exist.');
  if (!fs.existsSync(path.join(chat.source, 'run_agent.py'))) throw new Error('The configured Hermes source is not a checkout.');
  return {
    python: chat.python,
    source: chat.source,
    url: chat.url,
    model: chat.model,
    max_tokens: chat.max_tokens,
    reasoning_effort: chat.reasoning_effort ?? null,
    timeout_ms: Number(chat.timeout_ms) > 0 ? Number(chat.timeout_ms) : 300000,
  };
}

// Parse one JSON line from the bridge. Unknown event kinds are ignored rather
// than trusted; a malformed line is a bridge failure.
export function parseBridgeLine(line) {
  let event;
  try { event = JSON.parse(line); }
  catch { throw failure('bridge'); }
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw failure('bridge');
  if (event.type === 'delta') {
    if (typeof event.text !== 'string') throw failure('bridge');
    return {type: 'delta', text: event.text};
  }
  if (event.type === 'done') {
    if (typeof event.text !== 'string' || !event.text.trim()) throw failure('bridge');
    return {type: 'done', text: event.text};
  }
  if (event.type === 'error') return {type: 'error', code: typeof event.code === 'string' ? event.code : 'provider'};
  return {type: 'ignore'};
}

export function createHermesProvider(config, {home, spawnImpl = spawn, now = Date.now, bridgePath = bridge} = {}) {
  const provider = providerConfig(config);
  if (!home || !fs.existsSync(path.join(home, 'SOUL.md'))) throw new Error('Genie has no private profile yet. Run npm run genie:setup.');

  return {
    status() {
      return {configured: true, engine: 'Hermes', model: provider.model, source: provider.source, home};
    },
    generate({message, history = [], sessionId, context = {}, signal, onDelta = () => {}}) {
      if (typeof message !== 'string' || !message.trim()) return Promise.reject(Object.assign(new Error('A question is required.'), {status: 400}));
      if (signal?.aborted) return Promise.reject(Object.assign(new Error('Stopped.'), {code: 'aborted'}));
      return new Promise((resolve, reject) => {
        const child = spawnImpl(provider.python, [bridgePath, provider.source], {
          cwd: home,
          env: {
            PATH: process.env.PATH ?? '', HOME: home, HERMES_HOME: home,
            HERMES_WRITE_SAFE_ROOT: home, HERMES_DISABLE_LAZY_INSTALLS: '1',
            PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', LANG: 'en_US.UTF-8',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let pending = '', bytes = 0, final = null, failed = null, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => {
          failed = failure('timeout');
          child.kill();
          setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
        }, provider.timeout_ms);
        const abort = () => {
          failed = Object.assign(new Error('Stopped.'), {code: 'aborted'});
          child.kill();
          setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
        };
        signal?.addEventListener('abort', abort, {once: true});
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_EVENT_BYTES) { failed = failure('bridge'); child.kill(); return; }
          pending += chunk;
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            try {
              const event = parseBridgeLine(line);
              if (event.type === 'delta') onDelta(event.text);
              else if (event.type === 'done') final = {text: event.text, sessionId: sessionId ?? null, at: now()};
              else if (event.type === 'error') failed = failure(event.code);
            } catch (error) { failed = error; child.kill(); }
          }
        });
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({message, history, session_id: sessionId ?? null, context, provider: {
          url: provider.url, model: provider.model, max_tokens: provider.max_tokens,
          reasoning_effort: provider.reasoning_effort, api_key: config?.genie_chat?.api_key ?? null,
        }}));
        child.on('error', () => finish(failure('runtime')));
        child.on('close', () => {
          if (failed) return finish(failed);
          if (!final) return finish(failure('bridge'));
          finish(null, final);
        });
      });
    },
  };
}
