import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const bridgeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const PLUGIN_ID='dsh-chat-sync@dsh-local-sync';
export const RUNTIME_VERSION='0.2.0';
export function pluginEnabled(text,id=PLUGIN_ID){
 const sections=text.replace(/^\uFEFF/,'').split(/\r?\n/);let inside=false,result=false;
 for(const line of sections){
  const header=line.trim().match(/^\[\s*plugins\s*\.\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\]\s]+))\s*\]\s*(?:#.*)?$/);
  if(header){inside=(header[1]??header[2]??header[3])===id;continue;}
  if(/^\s*\[/.test(line)){inside=false;continue;}
  if(inside){const enabled=line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);if(enabled)result=enabled[1]==='true';}
 }
 return result;
}
export function activationState(project,home=process.env.CODEX_HOME??path.join(process.env.USERPROFILE??'','.codex'),controlFile=path.join(bridgeRoot,'data','control.json')){
 let control={enabled:true};
 if(fs.existsSync(controlFile))control=JSON.parse(fs.readFileSync(controlFile,'utf8'));
 const configFile=path.join(home,'config.toml');
 return{enabled:fs.existsSync(configFile)&&pluginEnabled(fs.readFileSync(configFile,'utf8'))&&control.enabled!==false,configFile,controlFile,paused:control.enabled===false};
}
export function bridgeHealth(project,statusFile){
 let file=statusFile??path.join(bridgeRoot,'data/status.json');
 const multi=path.join(bridgeRoot,'data/status-v2.json');
 if(!statusFile&&fs.existsSync(multi)){try{const v=JSON.parse(fs.readFileSync(multi,'utf8'));if(v.recordedAt&&Date.now()-Date.parse(v.recordedAt)<30000)file=multi;}catch{}}
 if(!fs.existsSync(file))return{available:false,reason:'not_started'};
 try{const value=JSON.parse(fs.readFileSync(file,'utf8'));const heartbeat=Date.parse(value.recordedAt??'');
  return{available:true,version:value.runtimeVersion??'legacy',heartbeatFresh:Number.isFinite(heartbeat)?Date.now()-heartbeat<30000:null,...value};
 }catch(error){return{available:false,reason:error.message};}
}
