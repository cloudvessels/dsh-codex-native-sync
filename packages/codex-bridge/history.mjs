import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJson,readJson} from '../dsh-plugin/src/state.mjs';
export {atomicJson,readJson};
export const PREFIX='msg_dshlink_';
export const MAX_ID=64;
export const hash=s=>createHash('sha256').update(s).digest('hex');
export const importedDshId=(thread,id)=>'shared-chat-'+hash(thread+'\0'+id);
// Keep this prefix plus 52 hash characters within the model request's 64-character limit.
export const codexId=(session,id)=>PREFIX+hash(session+'\0'+id).slice(0,MAX_ID-PREFIX.length);
export function shrinkInjectedIds(rolloutFile,ledgerFile){
 const ledger=readJson(ledgerFile,null),map=new Map();
 if(!ledger?.batches)return {changed:0};
 for(const b of ledger.batches)for(const m of b.messages??[])if(typeof m.id==='string'&&m.id.length>MAX_ID)map.set(m.id,m.id.slice(0,MAX_ID));
 if(!map.size)return {changed:0};
 for(const b of ledger.batches)for(const m of b.messages??[])if(map.has(m.id))m.id=map.get(m.id);
 atomicJson(ledgerFile,ledger);
 let text='';
 try{text=fs.readFileSync(rolloutFile,'utf8');}catch{return {changed:map.size,rollout:false};}
 let rewritten=text;
 for(const [oldId,newId] of map)rewritten=rewritten.split(oldId).join(newId);
 if(rewritten!==text){const temp=rolloutFile+'.'+process.pid+'.tmp';fs.writeFileSync(temp,rewritten);fs.renameSync(temp,rolloutFile);}
 return {changed:map.size,rollout:true};
}
export function collectDsh(snapshot,publicMessages,threadId,sessionId){
 if(snapshot.targetSessionId!==sessionId||snapshot.sourceThreadId!==threadId)throw Error('DSH_BINDING_MISMATCH');
 if(snapshot.agentStatus==='running')return [];
 const excluded=new Set(publicMessages.map(m=>importedDshId(threadId,m.id)));
 const out=[];
 for(const m of snapshot.messages){
  if(excluded.has(m.id))continue;
  // Imported IDs must be accounted for; never echo an unrecognized forward import.
  if(typeof m.id==='string'&&m.id.startsWith('shared-chat-'))throw Error('UNKNOWN_FORWARD_MESSAGE');
  if(!['user','assistant'].includes(m.role)||typeof m.id!=='string')continue;
  // Tool steps, reasoning-only steps and attachments carry no plain chat text; skip them.
  if((m.contentTypes??[]).some(t=>!['text','thinking','reasoning'].includes(t)))continue;
  const text=typeof m.text==='string'?m.text:'';
  if(!text.trim())continue;
  if(text.length>100000)throw Error('UNSUPPORTED_DSH_MESSAGE');
  out.push({id:codexId(sessionId,m.id),dshId:m.id,role:m.role,text,time:m.time??Date.now(),seq:m.seq});
 }
 return out;
}
export function responseItem(m){return {type:'message',id:m.id,role:m.role,status:'completed',...(m.role==='assistant'?{phase:'final_answer'}:{}),content:[{type:m.role==='user'?'input_text':'output_text',text:m.text}]};}
export function visibleItem(m){return m.role==='user'?{type:'userMessage',id:m.id,clientId:null,content:[{type:'text',text:m.text,text_elements:[]}]}:{type:'agentMessage',id:m.id,text:m.text,phase:'final_answer',memoryCitation:null,delivery:null,questions:null};}
export function visibleTurn(batch){const a=batch.messages;return {id:batch.turnId,rootTurnId:null,items:a.map(visibleItem),itemsView:'full',status:'completed',error:null,startedAt:Math.floor(batch.acceptedAt/1000),completedAt:Math.floor(batch.acceptedAt/1000),durationMs:0};}
export function notifications(threadId,batch){const turn=visibleTurn(batch);return [
 {method:'turn/started',params:{threadId,turn:{...turn,items:[],status:'inProgress',completedAt:null,durationMs:null}}},
 ...turn.items.flatMap(item=>[{method:'item/started',params:{threadId,turnId:turn.id,item,startedAtMs:batch.acceptedAt}},{method:'item/completed',params:{threadId,turnId:turn.id,item,completedAtMs:batch.acceptedAt}}]),
 {method:'turn/completed',params:{threadId,turn}},
 ];}
export class Ledger{
 constructor(file,threadId,sessionId){this.file=file;this.threadId=threadId;this.sessionId=sessionId;this.data=readJson(file,{version:1,threadId,sessionId,batches:[]});if(this.data.version!==1||this.data.threadId!==threadId||this.data.sessionId!==sessionId)throw Error('LEDGER_BINDING_MISMATCH');}
 save(){atomicJson(this.file,this.data);}
 stage(messages){
  const known=new Map(this.data.batches.flatMap(b=>b.messages).map(m=>[m.id,m]));const fresh=[];
  for(const m of messages){const old=known.get(m.id);if(old){if(old.role!==m.role||old.text!==m.text)throw Error('DSH_MESSAGE_CHANGED');continue;}fresh.push(m);known.set(m.id,m);}
  if(!fresh.length)return null;
  const groups=[];let group=[];
  const flush=()=>{if(group.length){groups.push(group);group=[];}};
  for(const m of fresh){if(m.role==='user')flush();group.push(m);if(m.role==='assistant')flush();}flush();
  const batches=groups.map(messages=>({turnId:'dsh-link-'+hash(messages.map(m=>m.id).join('\0')).slice(0,40),acceptedAt:Date.now(),messages,state:'pending'}));
  this.data.batches.push(...batches);this.save();return batches[0];
 }
 commit(batch){batch.state='committed';this.save();}
 committed(){return this.data.batches.filter(b=>b.state==='committed');}
 turns(){return this.committed().map(visibleTurn);}
}
function key(turn){return [turn.startedAt??0,turn.id];}
export function mergeTurns(native,external,direction='asc',batches=[]){
 const byId=new Map(native.map(t=>[t.id,t]));for(const t of external)if(!byId.has(t.id))byId.set(t.id,t);
 let all=[...byId.values()].sort((a,b)=>key(a)[0]-key(b)[0]||a.id.localeCompare(b.id));
 // An anchor preserves arrival order even when two turns share a rounded second.
 const previousByAnchor=new Map();
 for(const b of batches){if(!Object.hasOwn(b,'anchorTurnId'))continue;const t=byId.get(b.turnId);if(!t)continue;all=all.filter(x=>x.id!==b.turnId);const anchor=previousByAnchor.get(b.anchorTurnId)??b.anchorTurnId;const index=anchor===null?-1:all.findIndex(x=>x.id===anchor);if(index<0&&anchor!==null){all.push(t);}else all.splice(index+1,0,t);previousByAnchor.set(b.anchorTurnId,b.turnId);}
 return direction==='desc'?all.reverse():all;
}
export function pageRows(rows,params,scope){
 const direction=params.sortDirection??'asc',limit=Math.min(1000,Math.max(1,params.limit??50));let start=0;
 const cursor=params.cursor;
 if(cursor){
  let anchor;
  if(typeof cursor==='object')anchor=rows.findIndex(r=>(r.item?.id??r.id)===cursor.itemId);
  else{let decoded;try{decoded=JSON.parse(Buffer.from(cursor.replace(/^dshpage:/,''),'base64url'));}catch{throw Error('INVALID_BRIDGE_CURSOR');}if(decoded.scope!==scope)throw Error('CURSOR_SCOPE_MISMATCH');anchor=rows.findIndex(r=>(r.item?.id??r.id)===decoded.id);}
  if(anchor<0)throw Error('CURSOR_ANCHOR_MISSING');start=anchor+1;
 }
 const data=rows.slice(start,start+limit),cursorFor=id=>'dshpage:'+Buffer.from(JSON.stringify({scope,id})).toString('base64url');
 return {data,nextCursor:start+limit<rows.length&&data.length?cursorFor(data.at(-1).item?.id??data.at(-1).id):null,backwardsCursor:data.length?cursorFor(data[0].item?.id??data[0].id):null};
}
export function readInjected(file,ids){
 const found=new Map();if(!file||!fs.existsSync(file))return found;
 // Read only complete records from the owning backend's rollout; never write it.
 const text=fs.readFileSync(file,'utf8'),end=text.lastIndexOf('\n');
 for(const line of text.slice(0,end).split('\n')){if(!line)continue;const x=JSON.parse(line),p=x.payload;if(x.type!=='response_item'||p?.type!=='message'||!ids.has(p.id))continue;const value={role:p.role,text:(p.content??[]).map(b=>b.text??'').join('')};const old=found.get(p.id);if(old&&(old.role!==value.role||old.text!==value.text))throw Error('ROLL_OUT_ID_CONFLICT');found.set(p.id,value);}
 return found;
}
