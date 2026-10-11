// Independent feature switches, stored in the gateway's existing metadata.
export const genieCapabilityKeys=['fleet_reviews','rebalance','research','inspection','server_changes','media','spark_setup','fleet_power'];
export function validateGenieCapabilities(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Genie capability switches');
  const known={};
  for(const [key,enabled] of Object.entries(value)){
    if(!genieCapabilityKeys.includes(key))continue;
    if(typeof enabled!=='boolean')throw new Error('Invalid Genie capability switches');
    known[key]=enabled;
  }
  return known;
}
export function genieCapabilities(saved,config,recovery) {
  return {...Object.fromEntries(genieCapabilityKeys.map(key=>[key,key==='spark_setup'?config.spark_setup?.enabled===true:key==='media'?config.media_jobs?.execution_enabled===true:key==='rebalance'?config.genie_load_balancing!==false:true])),...validateGenieCapabilities(saved),recovery:recovery===true};
}
