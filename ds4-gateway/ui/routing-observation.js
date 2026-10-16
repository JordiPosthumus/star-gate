// Plain text only. A passive recommendation is never an actual routing receipt.
export function routingObservationText(value) {
  if(value?.mode==='active'&&value.applied){
    if(value.reason==='ownership_recovery_required')return 'Waiting: assignment storage needs recovery; this request has not been moved or dispatched.';
    if(value.reason==='ownership_write_failed')return 'Stayed: saving the new assignment failed; original queue preserved.';
    if(value.planner==='v2'){
      if(value.action==='reassign'){
        if(value.reason==='saving_exceeds_hysteresis')return `Reassigned to ${value.destination}; measured estimated saving ${Math.round(value.savingSeconds)}s beyond the re-home cost.`;
        if(value.reason==='available_capacity_fallback')return `Reassigned to ${value.destination}; previous worker had no free slot.`;
        if(value.reason==='measured_finish_estimate')return `Reassigned to ${value.destination}; fastest measured estimated finish.`;
        if(value.reason==='cold_probe_bounded')return `Reassigned to ${value.destination}; unmeasured worker given one bounded trial to earn measurements.`;
        if(value.reason==='cold_only_capacity')return `Reassigned to ${value.destination}; no measured worker had a free slot.`;
        return `Reassigned to ${value.destination}.`;
      }
      if(value.action==='place'){
        if(value.reason==='measured_finish_estimate')return `Assigned to ${value.destination}; fastest measured estimated finish.`;
        if(value.reason==='cold_probe_bounded')return `Assigned to ${value.destination}; unmeasured worker given one bounded trial to earn measurements.`;
        if(value.reason==='cold_only_capacity')return `Assigned to ${value.destination}; no measured worker had a free slot.`;
        return `Assigned to ${value.destination}; fastest measured estimated finish.`;
      }
      if(value.reason==='cache_affinity_keep_home')return 'Stayed: this conversation\u2019s cache lives on the assigned worker; no measured faster route was available.';
      // saving_exceeds_hysteresis only ever occurs on reassign/place; a stay
      // with that reason is impossible by construction (round-2 dead-line fix).
      if(value.reason==='no_eligible_worker')return value.action==='unavailable' ? 'Unassigned: no eligible worker is available.' : 'Stayed: no eligible worker has a free slot; the request waits on its current worker.';
      if(value.reason==='no_capacity')return 'Stayed: no lane has a free slot right now.';
      if(value.reason==='cold_probe_bounded')return "Stayed: this conversation's home is unmeasured; serving it there measures the lane without destroying its cache.";
      if(value.reason==='cold_only_capacity')return 'Stayed: an unmeasured worker was chosen by available capacity; it earns measurements as it serves.';
      return 'Stayed: the assigned worker has the best measured estimated finish.';
    }
    if(value.reason==='no_eligible_worker')return 'Unassigned: no eligible worker is available.';
    if(value.action==='move')return `Moved to ${value.destination}; estimated saving ${Math.round(value.savingSeconds)}s, margin ${value.marginSeconds}s.`;
    if(value.action==='place')return `Assigned to ${value.destination}; ${value.reason==='earliest_estimated_completion'?'earliest estimated completion':'timing unavailable; existing routing order used'}.`;
    if(value.action==='reassign')return value.reason==='idle_lane_home_timing_unavailable'
      ? `Reassigned to ${value.destination}; previous worker had running work but no usable completion estimate.`
      : `Reassigned to ${value.destination}; previous worker was ineligible.`;
    if(value.reason==='cache_affinity_keep_home')return 'Stayed: this conversation\u2019s cache lives on the assigned worker; no measured faster route was available.';
    if(value.reason==='same_session_keep_home')return 'Stayed: earlier requests of this conversation are still ahead of it; order is preserved.';
    if(value.reason==='saving_does_not_exceed_margin')return `Stayed: estimated saving does not exceed ${value.marginSeconds}s.`;
    return 'Stayed: no sufficiently faster eligible route is established.';
  }
  if (value?.mode !== 'observation_only') return '';
  const prefix = 'Observation only: ';
  if (value.action === 'move' && Number.isFinite(value.savingSeconds))
    return `${prefix}would move to ${value.destination}; estimated saving ${Math.round(value.savingSeconds)}s, margin ${value.marginSeconds}s.`;
  if (value.reason === 'saving_does_not_exceed_margin')
    return `${prefix}would stay; estimated saving does not exceed ${value.marginSeconds}s.`;
  if (value.reason === 'current_worker_ineligible')
    return `${prefix}would reassign; current worker is ineligible.`;
  if (value.reason === 'no_eligible_worker') return `${prefix}no eligible worker.`;
  return `${prefix}comparison unavailable; more timing or queue information is needed.`;
}
