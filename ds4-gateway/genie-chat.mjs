// Genie's dashboard conversation: one private history file, one in-flight turn,
// and a provider that is created lazily so a broken chat config never prevents
// the gateway or the rest of the dashboard from starting.
import fs from 'node:fs';
import path from 'node:path';
import {hermesHome} from './hermes-profile.mjs';
import {genieConfig} from './genie-config.mjs';
import {createHermesProvider} from './genie-hermes.mjs';

export const MAX_MESSAGES = 40;

export function chatFile(config) {
  return path.join(path.dirname(config.state_file), 'genie-chat', 'dashboard.json');
}

export function readMessages(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value)) return [];
    return value
      .filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
      .slice(-MAX_MESSAGES);
  } catch { return []; }
}

export function writeMessages(file, messages) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(messages.slice(-MAX_MESSAGES), null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
}

export function createGenieChat(config, {provider = null, home = null, file = chatFile(config)} = {}) {
  const genie = genieConfig(config);
  let created = provider;
  let providerError = null;
  let active = null;

  function getProvider() {
    if (created) return created;
    if (providerError) throw providerError;
    try {
      created = createHermesProvider(config, {home: home ?? hermesHome(config), authority: genie.authority});
    } catch (error) {
      providerError = error;
      throw error;
    }
    return created;
  }

  return {
    get enabled() { return genie.enabled; },
    status() {
      const messages = readMessages(file);
      if (!genie.enabled) return {enabled: false, ready: false, messages, error: null, tools: []};
      try {
        const running = getProvider();
        return {enabled: true, ready: true, model: running.status().model, engine: running.status().engine, tools: Object.keys(running.tools), messages, error: null};
      } catch (error) {
        return {enabled: true, ready: false, messages, error: error.message, tools: []};
      }
    },
    send({message, onDelta = () => {}, signal} = {}) {
      if (!genie.enabled) return Promise.reject(Object.assign(new Error('Genie is disabled in this configuration.'), {status: 409}));
      if (active) return Promise.reject(Object.assign(new Error('Genie is already answering. Stop that turn first.'), {status: 409}));
      if (typeof message !== 'string' || !message.trim()) return Promise.reject(Object.assign(new Error('A question is required.'), {status: 400}));
      if (message.length > 8000) return Promise.reject(Object.assign(new Error('That question is too long.'), {status: 413}));
      const controller = new AbortController();
      active = controller;
      const history = readMessages(file);
      const running = getProvider();
      return running.generate({message: message.trim(), history, sessionId: null, context: {}, signal: controller.signal, onDelta})
        .then(result => {
          writeMessages(file, [...history, {role: 'user', content: message.trim()}, {role: 'assistant', content: result.text}]);
          return result.text;
        })
        .finally(() => { if (active === controller) active = null; });
    },
    stop() {
      if (!active) return false;
      active.abort();
      return true;
    },
  };
}
