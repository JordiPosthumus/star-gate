import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHermesTerminal} from './hermes-terminal.mjs';
import {createDashboard} from './dashboard.mjs';

function fixture(t,extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-terminal-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const project=path.join(dir,"quoted ' space $(echo unsafe)"),root=path.join(project,'vendor/hermes');
  const home=path.join(project,'runtime/hermes-home'),directory=path.join(dir,'startScripts');
  fs.mkdirSync(path.join(root,'.hermes/bin'),{recursive:true});fs.mkdirSync(home,{recursive:true});
  fs.writeFileSync(path.join(home,'config.yaml'),'agent:\n  reasoning_effort: high\n');
  fs.writeFileSync(path.join(root,'.hermes/bin/hermes'),'#!/bin/sh\nprintf "%s\\n" "$HERMES_HOME" "$PWD" "$@"\n',{mode:0o700});
  const calls=[];
  const terminal=createHermesTerminal(home,{root,directory,platform:'darwin',open:async(...args)=>{calls.push(args);},...extra});
  return {home,project,terminal,calls,directory};
}
test('Terminal launcher uses the exact native profile and forwards arguments with safe shell quoting',t=>{
  const {terminal,home,project}=fixture(t);
  assert.equal(terminal.status().installed,false);
  const status=terminal.install(),before=fs.readFileSync(path.join(home,'config.yaml'),'utf8');
  assert.equal(status.installed,true);
  assert.deepEqual(execFileSync(status.path,['--help'],{encoding:'utf8'}).trimEnd().split('\n'),[home,project,'--cli','--help']);
  assert.equal(fs.readFileSync(path.join(home,'config.yaml'),'utf8'),before);
  assert.deepEqual(terminal.install(),status);
  fs.writeFileSync(status.path,'#!/bin/sh\n# existing owner launcher\n');
  assert.throws(()=>terminal.install(),/was not replaced/);
  assert.equal(fs.readFileSync(status.path,'utf8'),'#!/bin/sh\n# existing owner launcher\n');
});
test('Terminal launch accepts no shell input and coalesces in-flight launch attempts',async t=>{
  let finish;const calls=[];
  const {terminal}=fixture(t,{open:(...args)=>{calls.push(args);return new Promise(resolve=>{finish=resolve;});}});
  for(const input of [{command:'anything'},null,[],{args:[]},'text'])await assert.rejects(terminal.launch(input),{status:400});
  const first=terminal.launch({});
  await assert.rejects(terminal.launch({}),{status:409});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/usr/bin/open');
  assert.deepEqual(calls[0][1],['-a','Terminal',terminal.status().path]);
  finish();assert.match((await first).message,/new Genie chat/);
  const unsupported=fixture(t,{platform:'linux'});assert.equal(unsupported.terminal.status().supported,false);
  await assert.rejects(unsupported.terminal.launch({}),{status:409});assert.equal(unsupported.calls.length,0);
});
test('Chat in Terminal requires POST, same origin and CSRF, and opens only the fixed launcher',async t=>{
  const {terminal,calls}=fixture(t);
  const server=createDashboard(()=>({}),{brain:{read:async()=>({settings:{},terminal:terminal.status()}),openTerminal:terminal.launch,runtime:()=>({state:'running'})}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,url=base+'/api/brain/terminal';
  const loaded=await(await fetch(base+'/api/brain')).json();
  const headers={'content-type':'application/json',origin:base,'x-dsg-csrf':loaded.csrf_token};
  assert.equal((await fetch(url)).status,405);
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,origin:'http://other.test'},body:'{}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'x-dsg-csrf':'wrong'},body:'{}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers,body:'{"command":"anything"}'})).status,400);
  assert.equal(calls.length,0);
  const opened=await fetch(url,{method:'POST',headers,body:'{}'});
  assert.equal(opened.status,200);assert.equal((await opened.json()).terminal.installed,true);assert.equal(calls.length,1);
});
