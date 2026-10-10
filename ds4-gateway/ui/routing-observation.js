// Plain text only. A passive recommendation is never an actual routing receipt.
export function routingObservationText(value) {
  if(value?.mode==='active'&&value.applied){
    if(value.reason==='ownership_recovery_required')return 'Waiting: assignment storage needs recovery; this request has not been moved or dispatched.';
    if(value.reason==='ownership_write_failed')return 'Stayed: saving the new assignment failed; original queue preserved.';
    if(value.action==='move')return `Moved to ${value.destination}; estimated saving ${Math.round(value.savingSeconds)}s, margin ${value.marginSeconds}s.`;
    if(value.action==='place')return `Assigned to ${value.destination}; ${value.reason==='earliest_estimated_completion'?'earliest estimated completion':'timing unavailable; existing routing order used'}.`;
    if(value.action==='reassign')return `Reassigned to ${value.destination}; previous worker was ineligible.`;
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
