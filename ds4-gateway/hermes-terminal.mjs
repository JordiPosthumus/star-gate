import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const quote=value=>"'"+String(value).replaceAll("'", "'\\''")+"'";

// A fixed launcher for the dashboard's native profile. No browser-supplied
// command, profile, working directory, or shell arguments are accepted.
export function createHermesTerminal(home,{root,directory=path.join(os.homedir(),'startScripts'),platform=process.platform,open=exec}={}){
  const script=path.join(directory,'chat-genie.command');
  const launcher=path.join(root,'.hermes/bin/hermes');
  const cwd=path.resolve(root,'../..');
  const source=`#!/bin/sh\n# Gate Genie: a new terminal conversation with the existing native profile.\nset -eu\nexport HERMES_HOME=${quote(home)}\ncd ${quote(cwd)}\nexec ${quote(launcher)} --cli "$@"\n`;
  const command=directory===path.join(os.homedir(),'startScripts')?'~/startScripts/chat-genie.command':quote(script);
  function installed(){
    try{return fs.lstatSync(script).isFile()&&fs.readFileSync(script,'utf8')===source&&(fs.statSync(script).mode&0o100)!==0;}catch{return false;}
  }
  function install(){
    if(platform!=='darwin')throw Object.assign(Error('Chat in Terminal is available on the Mac running Stargate.'),{status:409});
    fs.accessSync(launcher,fs.constants.X_OK);
    fs.accessSync(path.join(home,'config.yaml'),fs.constants.R_OK);
    fs.mkdirSync(directory,{recursive:true});
    try{fs.writeFileSync(script,source,{flag:'wx',mode:0o700});}
    catch(error){if(error.code!=='EEXIST')throw error;}
    if(!installed())throw Object.assign(Error('A different or non-executable chat-genie.command already exists in startScripts. It was not replaced.'),{status:409});
    return status();
  }
  const status=()=>({supported:platform==='darwin',installed:installed(),command,path:script});
  let opening=false;
  async function launch(input){
    if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length)throw Object.assign(Error('This button only opens the saved Genie launcher; no commands or arguments are accepted.'),{status:400});
    if(opening)throw Object.assign(Error('Terminal is already opening.'),{status:409});
    opening=true;
    try{
      const terminal=install();
      await open('/usr/bin/open',['-a','Terminal',script],{timeout:10000});
      return {terminal,message:'Opening a new Genie chat in Terminal on this Mac. Uses saved settings; Telegram stays separate.'};
    }finally{opening=false;}
  }
  return {status,install,launch};
}
