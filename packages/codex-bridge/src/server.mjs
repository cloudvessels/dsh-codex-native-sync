import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import http from 'node:http';
import {bridgeHealth,RUNTIME_VERSION} from './activation.mjs';
import {collectDsh,atomicJson,readJson} from '../history.mjs';

const configPath=process.env.DSH_SYNC_CONFIG;
if(!configPath)throw Error('DSH_SYNC_CONFIG_REQUIRED');
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const multi=!config.threadId&&!config.sessionId&&Array.isArray(config.bindings);
if(!multi&&(!config.threadId||!config.sessionId))throw Error('INCOMPLETE_BOUND_CHAT_CONFIG');
const project=process.env.DSH_SYNC_PROJECT??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const data=process.env.DSH_SYNC_DATA;
if(!data)throw Error('DSH_SYNC_DATA_REQUIRED');
fs.mkdirSync(data,{recursive:true});
const mirrorFile=path.join(data,'mirror.json'),statusFile=path.join(data,'status.json');
const controlFile=config.pluginControlFile??path.join(data,'control.json');
const state={version:1,mode:multi?'multi':'bound',pid:process.pid,startedAt:new Date().toISOString(),startupId:crypto.randomUUID(),threadId:config.threadId,sessionId:config.sessionId,publicMessages:0,lastSyncAt:null,lastError:null,nativeHistoryWrite:false,modelRequests:0};
let closed=false,chain=Promise.resolve(),debounce,watcher,owner=false,election;
const servicePort=config.pluginPort??19390;
const serviceToken=fs.readFileSync(config.dshTokenFile,'utf8').trim();
const save=()=>atomicJson(statusFile,state);
const readControl=()=>readJson(controlFile,{enabled:true});
const viewState=()=>{const bridge=bridgeHealth(project,config.statusFile);return{...state,pluginVersion:RUNTIME_VERSION,paused:readControl().enabled===false,bridge,requiresNewBootstrap:bridge.available&&bridge.runtimeVersion!==RUNTIME_VERSION,nativeHistoryWrite:false};};
async function sync(){
 if(closed||!owner||readControl().enabled===false)return;
 try{
  if(multi){
   const bridge=bridgeHealth(project,config.statusFile);
   state.publicMessages=(bridge.bindings??[]).reduce((sum,binding)=>sum+(binding.committedMessages??0),0);
   state.lastSyncAt=new Date().toISOString();state.lastError=null;save();return;
  }
  const token=fs.readFileSync(config.dshTokenFile,'utf8').trim();
  const response=await fetch(config.dshUrl+'/snapshot?sessionId='+encodeURIComponent(config.sessionId),{method:'POST',headers:{authorization:'Bearer '+token},body:'{}',signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw Error('DSH_SNAPSHOT_'+response.status);
  const view=await response.json();
  if(view.agentStatus==='running'){save();return;}
  const source=readJson(config.publicSnapshotFile,{messages:[]});
  // Multi-chat snapshots also contain forward-imported text and retired operation rows.
  const incoming=collectDsh({...view,messages:view.messages.filter(m=>!String(m.id??'').startsWith('shared-chat-'))},source.messages,config.threadId,config.sessionId);
  const mirror=readJson(mirrorFile,{version:1,threadId:config.threadId,sessionId:config.sessionId,messages:[]});
  if(mirror.threadId!==config.threadId||mirror.sessionId!==config.sessionId)throw Error('BINDING_MISMATCH');
  const known=new Map(mirror.messages.map(m=>[m.id,m]));
  for(const message of incoming){
   const old=known.get(message.id);
   if(old&&(old.role!==message.role||old.text!==message.text))throw Error('MESSAGE_ID_CONFLICT');
   if(!old){mirror.messages.push(message);known.set(message.id,message);}
  }
  atomicJson(mirrorFile,mirror);state.publicMessages=mirror.messages.length;state.lastSyncAt=new Date().toISOString();state.lastError=null;
 }catch(error){state.lastError=error.message;}
 save();
}
const enqueue=()=>{chain=chain.then(sync,sync);return chain;};
const service=http.createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.headers.origin||req.method!=='POST'||req.headers.authorization!=='Bearer '+serviceToken){res.statusCode=403;res.end('{}');return;}
 if(!['/status','/sync','/pause','/resume'].includes(req.url)){res.statusCode=404;res.end('{}');return;}
 if(req.url==='/pause'||req.url==='/resume')atomicJson(controlFile,{...readControl(),enabled:req.url==='/resume',changedAt:new Date().toISOString()});
 if(req.url==='/sync')atomicJson(controlFile,{...readControl(),syncRequestedAt:new Date().toISOString()});
 if(req.url==='/sync')await enqueue();
 res.end(JSON.stringify(viewState()));
});
async function elect(){
 if(owner||closed)return;
 if(election)return election;
 election=new Promise(resolve=>{
  const onError=()=>{service.off('listening',onListen);resolve();};
  const onListen=()=>{service.off('error',onError);owner=true;save();void enqueue();resolve();};
  service.once('error',onError);service.once('listening',onListen);service.listen(servicePort,'127.0.0.1');
 });
 try{await election;}finally{election=null;}
}
async function sharedStatus(action='status'){
 await elect();if(owner){
  if(action==='pause'||action==='resume')atomicJson(controlFile,{...readControl(),enabled:action==='resume',changedAt:new Date().toISOString()});
  if(action==='sync')atomicJson(controlFile,{...readControl(),syncRequestedAt:new Date().toISOString()});
  if(action==='sync'||action==='resume')await enqueue();return viewState();
 }
 const response=await fetch('http://127.0.0.1:'+servicePort+'/'+action,{method:'POST',headers:{authorization:'Bearer '+serviceToken},signal:AbortSignal.timeout(3000)});
 if(!response.ok)throw Error('SYNC_WORKER_UNAVAILABLE');const value=await response.json();
 if(value.mode!==(multi?'multi':'bound')||value.threadId!==config.threadId||value.sessionId!==config.sessionId)throw Error('SYNC_WORKER_BINDING_MISMATCH');
 return value;
}
const schedule=()=>{clearTimeout(debounce);debounce=setTimeout(()=>void enqueue(),300);};
const output=message=>process.stdout.write(JSON.stringify(message)+'\n');
const schema={type:'object',properties:{},additionalProperties:false};
const tools=[{name:'sync_status',description:'Read the bound chat sync state, native bridge state, queued message count, and errors. Does not call a model.',inputSchema:schema,annotations:{readOnlyHint:true}}, {name:'sync_now',description:'Refresh the bound DSH public-text mirror and signal the compatibility bridge. The bridge imports native history only when the target is idle; no model is started.',inputSchema:schema},{name:'sync_pause',description:'Pause automatic receipt of the bound DSH conversation. Existing messages remain saved.',inputSchema:schema},{name:'sync_resume',description:'Resume automatic receipt of the bound DSH conversation. Does not invoke either model.',inputSchema:schema}];
async function handle(request){
 if(request.id===undefined)return;
 try{
  let result;
  if(request.method==='initialize')result={protocolVersion:request.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'dsh-chat-sync',version:RUNTIME_VERSION},instructions:'Synchronizes one bound Codex/DSH public text conversation. The companion bridge persists native history and adapts visible turns. Check bridge state separately; a local mirror alone is not proof of native insertion. Receipt never starts model generation.'};
  else if(request.method==='ping')result={};
  else if(request.method==='tools/list')result={tools};
  else if(request.method==='tools/call'&&tools.some(t=>t.name===request.params?.name)){
   const action={sync_status:'status',sync_now:'sync',sync_pause:'pause',sync_resume:'resume'}[request.params.name];const shared=await sharedStatus(action);
   result={content:[{type:'text',text:JSON.stringify(shared)}],isError:shared.lastError!==null};
  }else{output({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}});return;}
  output({jsonrpc:'2.0',id:request.id,result});
 }catch(error){output({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:error.message}});}
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{try{void handle(JSON.parse(line));}catch{}});
const poll=setInterval(()=>{void sharedStatus().then(()=>owner?enqueue():undefined).catch(()=>{});},2000);
if(!multi)try{watcher=fs.watch(config.dshArtifact,schedule);}catch{}
await elect();
function close(){if(closed)return;closed=true;clearInterval(poll);clearTimeout(debounce);watcher?.close();if(owner)service.close();chain.finally(()=>process.exit(0));}
input.on('close',close);process.on('SIGTERM',close);process.on('SIGINT',close);
