// Gate Genie's own inference route.
//
// Genie's brain is a fleet resource, not a privileged one. The default route is
// the ordinary pool (through the Continuity Door) with observer traffic marking,
// so his turns queue behind real work. A dedicated endpoint is preferred when
// configured and reachable. Commandeering a machine for his own brain is the
// last resort, and it is only legitimate when the fleet is not serving anyone
// else: if there is user work in flight, waiting is correct and Genie waits.

export const DEFAULT_MAX_COMMANDEER_SECONDS = 900;

const positive = value => Number.isFinite(value) && value > 0;
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;

function endpoint(value) {
  if (!value || typeof value !== 'object') return null;
  if (!text(value.url) || !text(value.model)) return null;
  return {url: value.url, model: value.model, api_key: text(value.api_key) ? value.api_key : null};
}

// A fleet snapshot is deliberately dumb: counts, not identities, so a brain
// decision cannot depend on which machine happens to be named.
export function fleetSnapshot(gateway) {
  const workers = Array.isArray(gateway?.workers) ? gateway.workers : [];
  const count = key => workers.reduce((sum, worker) => sum + (Number(worker?.[key]) || 0), 0);
  const healthy = workers.filter(worker => worker?.is_healthy === true && worker?.drained !== true).length;
  return {
    workers: workers.length,
    healthy,
    active: count('active'),
    queued: count('queued'),
  };
}

// True when the fleet cannot serve anyone: no healthy worker and no request in
// flight. Queued work does not veto commandeering -- it cannot progress until
// capacity returns, and restoring capacity is exactly what Genie is for. A
// draining request still counts as someone being served.
export function fleetIsStranded(snapshot) {
  return snapshot.healthy === 0 && snapshot.active === 0;
}

export function brainPolicy(config) {
  const brain = config?.genie?.brain;
  const mode = ['pool', 'dedicated', 'ladder'].includes(brain?.mode) ? brain.mode : 'pool';
  const commandeer = brain?.commandeer;
  return {
    mode,
    pool: endpoint(brain?.pool),
    dedicated: endpoint(brain?.dedicated),
    fallback: Array.isArray(brain?.fallback) ? brain.fallback.map(endpoint).filter(Boolean) : [],
    commandeer: {
      enabled: commandeer?.enabled === true && text(commandeer?.worker),
      worker: text(commandeer?.worker) ? commandeer.worker : null,
      max_seconds: positive(commandeer?.max_seconds) ? commandeer.max_seconds : DEFAULT_MAX_COMMANDEER_SECONDS,
      // An operator may pre-authorize commandeering while the fleet is degraded
      // but still serving. Off by default; never inferred.
      allow_while_serving: commandeer?.allow_while_serving === true,
    },
  };
}

// Resolve one route. `attempts` is the ordered list of endpoints already tried
// this turn, so a retry does not loop back onto a known-dead endpoint.
export function resolveBrainRoute(config, fleet, {attempts = [], now = Date.now()} = {}) {
  const policy = brainPolicy(config);
  const tried = new Set(attempts.filter(Boolean));
  const candidates = [];
  if (policy.mode !== 'dedicated' && policy.pool) candidates.push({kind: 'pool', ...policy.pool});
  if (policy.mode !== 'pool' && policy.dedicated) candidates.push({kind: 'dedicated', ...policy.dedicated});
  for (const fallback of policy.fallback) candidates.push({kind: 'fallback', ...fallback});

  for (const candidate of candidates) {
    if (tried.has(candidate.url)) continue;
    return {
      route: candidate.kind,
      url: candidate.url,
      model: candidate.model,
      api_key: candidate.api_key,
      observer: candidate.kind === 'pool',
      commandeering: false,
      release_at: null,
      reason: candidate.kind === 'pool'
        ? 'Pool route: observer traffic yields to real work.'
        : `${candidate.kind} endpoint selected from the configured ladder.`,
    };
  }

  const stranded = fleetIsStranded(fleet);
  const commandeer = policy.commandeer;
  if (commandeer.enabled && (stranded || commandeer.allow_while_serving)) {
    return {
      route: 'commandeer',
      worker: commandeer.worker,
      url: null,
      model: null,
      api_key: null,
      observer: false,
      commandeering: true,
      release_at: now + commandeer.max_seconds * 1000,
      reason: commandeer.allow_while_serving
        ? `Commandeering ${commandeer.worker} under the owner's standing authorization.`
        : `No worker is healthy and nothing is in flight; commandeering ${commandeer.worker} to get the brain and the fleet back.`,
    };
  }

  const refused = commandeer.enabled
    ? `${fleet.healthy} healthy worker(s), ${fleet.active} active and ${fleet.queued} queued: user work outranks the brain.`
    : 'No configured route and commandeering is not enrolled.';
  return {
    route: 'unavailable',
    url: null,
    model: null,
    api_key: null,
    observer: false,
    commandeering: false,
    release_at: null,
    reason: refused,
  };
}
