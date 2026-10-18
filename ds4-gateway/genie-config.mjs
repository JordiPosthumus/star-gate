// Genie configuration: one place that decides whether he exists, what serves his
// brain, and what he may do without asking. Unknown fields are ignored rather
// than guessed at, and every default is the conservative one.
import {brainPolicy} from './genie-brain.mjs';

const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export const GENIE_ACTIONS = Object.freeze([
  'inspect',      // read gateway state, logs and enrolled machines
  'research',     // search and read public sources
  'rebalance',    // request a validated pre-dispatch handover
  'recovery',     // request an enrolled service recovery
  'configure',    // propose an exact configuration change for approval
  'command',      // run an enrolled operation end to end
]);

// Standing authority is the set of actions Genie may take without asking. It is
// explicit: an absent list means "inspect and research only", never "everything".
const DEFAULT_AUTHORITY = Object.freeze(['inspect', 'research']);

export function genieConfig(config) {
  const raw = config?.genie;
  if (!object(raw)) return {enabled: false, authority: [...DEFAULT_AUTHORITY], brain: brainPolicy(config), messaging: {}};
  const authority = Array.isArray(raw.authority)
    ? raw.authority.filter(action => GENIE_ACTIONS.includes(action))
    : [...DEFAULT_AUTHORITY];
  const messaging = object(raw.messaging) ? raw.messaging : {};
  return {
    enabled: raw.enabled === true,
    authority,
    brain: brainPolicy(config),
    messaging: {
      // Hermes owns channel authorization; Star Gate only records which channels
      // the owner asked to run. No token is read or stored here.
      channels: Array.isArray(messaging.channels) ? messaging.channels.filter(text) : [],
      owner_only: messaging.owner_only !== false,
    },
  };
}

export function genieEnabled(config) {
  return genieConfig(config).enabled;
}

export function may(config, action) {
  return genieConfig(config).authority.includes(action);
}

// A single line for logs and diagnostics. Never includes a URL credential.
export function describeGenie(config) {
  const genie = genieConfig(config);
  if (!genie.enabled) return 'Genie: disabled';
  const brain = genie.brain;
  const route = brain.mode === 'dedicated' ? 'dedicated' : brain.mode === 'ladder' ? 'pool + fallback ladder' : 'pool';
  return `Genie: enabled, brain via ${route}${brain.commandeer.enabled ? `, commandeering ${brain.commandeer.worker}` : ''}, authority ${genie.authority.join('/')}`;
}
