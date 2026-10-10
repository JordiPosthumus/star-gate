import {priorityIndex, priorityRank} from './job-priority.mjs';

// Shared by dispatch and prediction. The caller applies any reservation release;
// this function neither mutates a queue nor owns a timer.
export function queueChoice({queue, allocation, turns, now, blocked = () => false, release = false}) {
  const eligible = queue.filter(job => !job.cancelled && !blocked(job));
  let index = priorityIndex(eligible);
  let clearAllocation = release || !!(allocation?.until && allocation.until <= now);
  if (clearAllocation) allocation = null;
  if (index < 0) return {job: null, clearAllocation};
  const highest = priorityRank(eligible[index]);
  if (allocation && priorityRank(eligible.find(job => job.key === allocation.key) ?? allocation) < highest) {
    clearAllocation = true; allocation = null;
  }
  if (allocation) {
    if (allocation.used < turns) {
      const next = eligible.findIndex(job => job.key === allocation.key);
      if (next >= 0) index = next;
      else if (allocation.until > now) return {job: null, clearAllocation};
      else clearAllocation = true;
    } else {
      const next = priorityIndex(eligible.map(job => job.key === allocation.key ? {...job, cancelled: true} : job));
      if (next >= 0 && priorityRank(eligible[next]) === highest) index = next;
      clearAllocation = true;
    }
  }
  return {job: eligible[index], clearAllocation};
}
