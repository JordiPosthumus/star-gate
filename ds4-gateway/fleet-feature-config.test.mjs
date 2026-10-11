import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGenieCapabilities,genieCapabilities,genieCapabilityKeys} from './fleet-feature-config.mjs';

test('a saved key the code no longer knows is dropped, not fatal',()=>{
  const saved={media:true,hourglass:true,spark_setup:false};
  const clean=validateGenieCapabilities(saved);
  assert.deepEqual(clean,{media:true,spark_setup:false});
  assert.equal(Object.hasOwn(clean,'hourglass'),false);
});

test('a whole tree of retired keys cannot crash startup',()=>{
  const saved=Object.fromEntries(['hourglass','trial','retired_feature'].map(k=>[k,true]));
  assert.deepEqual(validateGenieCapabilities(saved),{});
});

test('a known key with a non-boolean still rejects',()=>{
  assert.throws(()=>validateGenieCapabilities({media:'true'}),/Invalid Genie capability switches/);
  assert.throws(()=>validateGenieCapabilities({spark_setup:1}),/Invalid Genie capability switches/);
});

test('a non-object saved state still rejects',()=>{
  assert.throws(()=>validateGenieCapabilities([]),/Invalid Genie capability switches/);
  assert.throws(()=>validateGenieCapabilities(null),/Invalid Genie capability switches/);
  assert.throws(()=>validateGenieCapabilities('media'),/Invalid Genie capability switches/);
});

test('the surfaced status is always exactly the known keys',()=>{
  const status=genieCapabilities({media:true,hourglass:true}, {}, false);
  assert.deepEqual(Object.keys(status).sort(),[...genieCapabilityKeys,'recovery'].sort());
  assert.equal(status.media,true);
  assert.equal(Object.hasOwn(status,'hourglass'),false);
  assert.equal(status.recovery,false);
});
