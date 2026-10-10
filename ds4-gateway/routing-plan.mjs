import {priorityRank} from './job-priority.mjs';
import {serviceEstimate, phaseSpeed} from './routing-estimates.mjs';
import {queueChoice} from './queue-choice.mjs';

export const DEFAULT_SWITCHING_MARGIN_SECONDS = 30;
const nonnegative = n => Number.isFinite(n) && n >= 0;
const sequenceOrder = (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id);
const usableJob = job => !job.cancelled && !job.dispatched && !job.upstream;
const unknown = reason => ({completionSeconds: null, waitingSeconds: null, reason});
const snapshotEligibility = (_job, worker) => ({eligible: worker.eligible === true,
  reason: worker.ineligibleReason ?? 'not_eligible'});

// Forecast only work already booked and the candidate; never recursively slow
// earlier jobs. Capacity and remaining running times must be explicit snapshots.
export function completionEstimate({job, worker, service, sessionReadySeconds = {}}) {
  if (!Number.isSafeInteger(worker.capacity) || worker.capacity < 1) return unknown('capacity_unavailable');
  if (!Array.isArray(worker.running) || !Array.isArray(worker.queue)) return unknown('worker_activity_unavailable');
  const turns = worker.conversationTurns ?? 1, grace = worker.turnIdleSeconds ?? 0;
  if (!Number.isSafeInteger(turns) || turns < 1 || !nonnegative(grace)) return unknown('turn_policy_unavailable');
  const running = worker.running;
  if (running.length > worker.capacity) return unknown('capacity_mismatch');
  if (running.some(active => !nonnegative(active.remainingSeconds))) return unknown('running_progress_unavailable');
  const slots = Array.from({length: worker.capacity}, () => ({ready: 0, allocation: null}));
  for (const row of worker.turnReservations ?? []) {
    if (!Number.isSafeInteger(row.slot) || !slots[row.slot] || !row.key || !Number.isSafeInteger(row.used)
      || row.used < 0 || !nonnegative(row.until) || !Number.isFinite(priorityRank(row)))
      return unknown('turn_reservations_not_normalized');
    slots[row.slot].allocation = {...row};
  }
  const occupied = new Set();
  for (const [index, active] of running.entries()) {
    const slot = active.slotIndex ?? index;
    if (!Number.isSafeInteger(slot) || !slots[slot] || occupied.has(slot)) return unknown('capacity_mismatch');
    occupied.add(slot); slots[slot].ready = active.remainingSeconds;
    if (slots[slot].allocation) slots[slot].allocation.until = slots[slot].allocation.used < turns
      ? active.remainingSeconds + grace : 0;
  }
  const intervals = running.map(active => ({start: 0, end: active.remainingSeconds}));
  const sessionReady = new Map(Object.entries(sessionReadySeconds));
  if ([...sessionReady.values()].some(value => !nonnegative(value))) return unknown('session_progress_unavailable');
  for (const active of running) if (active.key)
    sessionReady.set(active.key, Math.max(sessionReady.get(active.key) ?? 0, active.remainingSeconds));
  const pending = [...worker.queue.filter(other => other.id !== job.id && usableJob(other)), job];
  if (pending.some(item => typeof item.id !== 'string' || !item.id)) return unknown('request_identity_unavailable');
  if (new Set(pending.map(item => item.id)).size !== pending.length) return unknown('duplicate_booking');
  if (pending.some(item => !Number.isSafeInteger(item.sequence) || !Number.isFinite(priorityRank(item))))
    return unknown('queue_order_unavailable');
  pending.sort(sequenceOrder);
  const bookings = [];
  let time = 0;
  while (pending.length) {
    let booked = false;
    for (const [slot, state] of slots.entries()) {
      if (state.ready > time) continue;
      if (state.allocation?.until && state.allocation.until <= time) state.allocation = null;
      const choice = queueChoice({queue: pending, allocation: state.allocation, turns, now: time,
        blocked: item => !!item.key && ((sessionReady.get(item.key) ?? 0) > time
          || slots.some(other => other !== state && other.allocation?.key === item.key && other.allocation.used < turns))});
      if (choice.clearAllocation) state.allocation = null;
      const item = choice.job;
      if (!item) continue;
      const concurrency = 1 + intervals.filter(interval => interval.start <= time && interval.end > time).length;
      const estimate = service(item, concurrency);
      if (!nonnegative(estimate?.seconds)) return unknown('service_estimate_unavailable');
      const end = time + estimate.seconds;
      if (!nonnegative(end)) return unknown('completion_estimate_unavailable');
      bookings.push({requestId: item.id, slot, start: time, end, concurrency});
      if (item.id === job.id) return {completionSeconds: end, waitingSeconds: time, service: estimate, reason: 'estimated', bookings};
      state.ready = end; intervals.push({start: time, end});
      if (item.key) sessionReady.set(item.key, end);
      if (turns > 1 && item.key) {
        if (state.allocation?.key !== item.key) state.allocation = {key: item.key, used: 0};
        Object.assign(state.allocation, {priority: item.priority, used: state.allocation.used + 1});
        state.allocation.until = state.allocation.used < turns ? end + grace : 0;
      } else state.allocation = null;
      pending.splice(pending.indexOf(item), 1); booked = true;
    }
    // Repeat at the same instant after zero-duration work or released reservations.
    if (booked) continue;
    const next = [...slots.flatMap(slot => [slot.ready, slot.allocation?.until]), ...sessionReady.values()]
      .filter(value => nonnegative(value) && value > time);
    if (!next.length) return unknown('queue_order_unavailable');
    time = Math.min(...next);
  }
  return unknown('queue_order_unavailable');

}

// Eligibility is supplied by the existing gateway's capability/ownership rules.
// This module must not infer model equivalence or replace those protections.
export function chooseRoute({job, workers, currentWorkerId = null, samples = [], outputModel = {},
  marginSeconds = DEFAULT_SWITCHING_MARGIN_SECONDS, sessionReadySeconds = {}, eligibility = snapshotEligibility}) {
  if (!nonnegative(marginSeconds)) throw new Error('Switching margin must be a finite, non-negative number of seconds.');
  if (workers.some(worker => typeof worker.id !== 'string' || !worker.id)
    || new Set(workers.map(worker => worker.id)).size !== workers.length)
    throw new Error('Routing requires unique worker identities.');
  if (!usableJob(job)) return {action: 'unchanged', workerId: currentWorkerId, reason: 'request_not_queued', marginSeconds, candidates: []};
  const executing = workers.find(worker => worker.running?.some(active => active.id === job.id));
  if (executing) return {action: 'unchanged', workerId: executing.id, reason: 'request_already_running', marginSeconds, candidates: []};
  const speeds = new Map();
  const speedLookup = (worker, phase, concurrency) => {
    const key = JSON.stringify([worker.id, phase, concurrency]);
    if (!speeds.has(key)) speeds.set(key, phaseSpeed({worker, fleet: workers, samples, phase, concurrency}));
    return speeds.get(key);
  };
  const candidates = workers.map(worker => {
    const allowed = eligibility(job, worker);
    return {workerId: worker.id, eligible: allowed?.eligible === true,
    ...(allowed?.eligible !== true ? unknown(allowed?.reason ?? 'not_eligible')
      : completionEstimate({job, worker, sessionReadySeconds,
        service: (queued, concurrency) => serviceEstimate({job: queued, worker, fleet: workers,
          samples, concurrency, outputModel, speedLookup})}))};
  });
  const home = candidates.find(candidate => candidate.workerId === currentWorkerId);
  const eligible = candidates.filter(candidate => candidate.eligible);
  const timed = eligible.filter(candidate => candidate.completionSeconds !== null)
    .sort((a, b) => a.completionSeconds - b.completionSeconds || a.workerId.localeCompare(b.workerId));
  const base = {marginSeconds, candidates, currentWorkerId};
  if (!eligible.length) return {...base, action: 'unavailable', workerId: null, reason: 'no_eligible_worker'};
  if (home?.eligible) {
    if (home.completionSeconds === null) return {...base, action: 'stay', workerId: home.workerId, reason: 'current_timing_unavailable'};
    const other = timed.find(candidate => candidate.workerId !== home.workerId);
    if (other && other.completionSeconds + marginSeconds < home.completionSeconds)
      return {...base, action: 'move', workerId: other.workerId, reason: 'saving_exceeds_margin',
        savingSeconds: home.completionSeconds - other.completionSeconds};
    return {...base, action: 'stay', workerId: home.workerId, reason: other ? 'saving_does_not_exceed_margin' : 'no_timed_alternative',
      savingSeconds: other ? home.completionSeconds - other.completionSeconds : null};
  }
  // Input order is the incumbent's fallback order, not a newly invented policy.
  // Eligibility recovery is explicit and is not a claim of a 30-second saving.
  const best = timed[0] ?? eligible[0];
  return {...base, action: currentWorkerId ? 'reassign' : 'place', workerId: best.workerId,
    reason: currentWorkerId ? 'current_worker_ineligible' : timed.length ? 'earliest_estimated_completion' : 'timing_unavailable_existing_order'};
}

// Offline transaction preview: every choice immediately updates the COPY seen
// by the next arrival. Production commit/persistence remains with the gateway.
export function planArrivals({jobs, workers, ...options}) {
  const snapshot = workers.map(worker => ({...worker, queue: [...(worker.queue ?? [])]}));
  const decisions = [];
  for (const {job, currentWorkerId = null} of jobs) {
    const decision = chooseRoute({...options, job, currentWorkerId, workers: snapshot});
    decisions.push({requestId: job.id, ...decision});
    if (decision.workerId === null || decision.action === 'unchanged') continue;
    for (const worker of snapshot) worker.queue = worker.queue.filter(other => other.id !== job.id);
    snapshot.find(worker => worker.id === decision.workerId).queue.push(job);
  }
  return {decisions, workers: snapshot};
}
