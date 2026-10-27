import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const clip=(value,max)=>value.length>max?value.slice(0,max)+'\n[truncated]':value;
export function normalizeOperation(step){
  if(!step||typeof step.id!=='string'||!step.id||step.id.length>512||typeof step.name!=='string'||!step.name||step.name.length>256)throw Error('INVALID_OPERATION');
  const args=typeof step.arguments==='string'?step.arguments:JSON.stringify(step.arguments??{});
  if(typeof step.result!=='string'||typeof args!=='string')throw Error('INVALID_OPERATION');
  return {id:step.id,name:'codex_'+step.name.replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,80),arguments:clip(args,4000),result:clip(step.result,2000),isError:step.isError===true};
}
export function planOperations(session,{source,steps},validate){
  if(typeof source!=='string'||!source.startsWith('codex:')||!Array.isArray(steps)||steps.length>100)throw Error('INVALID_OPERATION_BATCH');
  const events=session.snapshotEvents();let open=false;
  for(const e of events){if(e.type==='turn/start')open=true;if(e.type==='turn/end')open=false;}
  if(open)throw Error('SESSION_TURN_OPEN');
  const calls=new Map(events.filter(e=>e.type==='tool/call').map(e=>[e.data.callId,e.data]));
  const results=new Map(events.filter(e=>e.type==='tool/result').map(e=>[e.data.message.id,e.data.message]));
  const additions=[],planned=new Map();
  for(const raw of steps){
    const step=normalizeOperation(raw),key=hash(source+'\0operation\0'+step.id),callId='dshext_'+key.slice(0,40),id='shared-op-'+key;
    const old=results.get(id),prior=planned.get(id);
    if(old){const call=calls.get(callId);if(!call||call.name!==step.name||call.arguments!==step.arguments||old.content.filter(b=>b.type==='text').map(b=>b.text).join('')!==step.result||!!old.isError!==step.isError)throw Error('OPERATION_ID_CONFLICT');continue;}
    if(prior){if(JSON.stringify(prior)!==JSON.stringify(step))throw Error('OPERATION_ID_CONFLICT');continue;}
    planned.set(id,step);additions.push({step,id,callId});
  }
  const suffix=[],time=Date.now(),push=(type,data,options={})=>suffix.push({type,data,seq:events.length+suffix.length,time,...options});
  let turn=events.reduce((n,e)=>e.type==='turn/start'?Math.max(n,e.data.turn):n,0);
  const surface=events.filter(e=>['system/message','developer/message','user/message','assistant/message','tool/result'].includes(e.type));
  const previousHeader=events.findLast(e=>e.type==='request/header')?.data.header??{config:{provider:'external-sync',model:'codex-operation'}};
  if(surface.length&&surface[0].type!=='system/message')throw Error('MISSING_PROTECTED_SYSTEM_HEAD');
  for(const {step,id,callId} of additions){
    turn++;push('turn/start',{turn});push('step/start',{turn,step:1});
    if(!surface.length&&!suffix.some(e=>e.type==='system/message'))push('system/message',{turn,step:1,message:{id:'shared-op-head-'+hash(session.id),role:'system',content:[],source:{kind:'system-prompt'}}},{surfaceOp:'append'});
    const headerSeq=events.length+suffix.length;
    push('request/header',{turn,step:1,reason:'change',header:{...structuredClone(previousHeader),tools:[...(previousHeader.tools??[]).filter(t=>t.name!==step.name),{name:step.name,description:'Historical Codex operation; receiving this record never executes it.',parameters:{type:'object',properties:{}}}]}});
    push('developer/message',{turn,step:1,headerSeq,message:{id:id+'-decl',role:'developer',content:[{type:'tool-addition',toolName:step.name}],source:{kind:'system-prompt'}}},{surfaceOp:'append'});
    push('assistant/message',{turn,step:1,message:{id:id+'-call',role:'assistant',content:[{type:'tool-call',id:callId,name:step.name,arguments:step.arguments}],source:{kind:'model',provider:'external-sync',model:'codex-operation'}},stream:[]},{surfaceOp:'append'});
    push('tool/call',{turn,step:1,callId,name:step.name,arguments:step.arguments});
    push('tool/result',{turn,step:1,message:{id,role:'tool',content:[{type:'text',text:step.result}],source:{kind:'tool',callId},toolCallId:callId,...step.isError?{isError:true}:{}}},{surfaceOp:'append'});
    push('developer/message',{turn,step:1,message:{id:id+'-remove',role:'developer',content:[{type:'tool-removal',toolName:step.name}],source:{kind:'system-prompt'}}},{surfaceOp:'append'});
    push('request/header',{turn,step:1,reason:'change',header:structuredClone(previousHeader)});
    push('step/end',{turn,step:1});push('turn/end',{turn,reason:{kind:'completed'}});
  }
  if(suffix.length)validate(session.header,[...events,...suffix],session.inheritedEventCount);
  return {events:suffix,appendedSteps:additions.length,duplicates:steps.length-additions.length};
}
export function appendOperations(session,batch,validate){
  const plan=planOperations(session,batch,validate);
  for(const event of plan.events){if(session.seq!==event.seq)throw Error('SESSION_CHANGED_DURING_APPEND');session.append(event.type,event.data,...event.surfaceOp?[{surfaceOp:event.surfaceOp}]:[]);}
  return {sessionId:session.id,appendedSteps:plan.appendedSteps,duplicates:plan.duplicates,nextSeq:session.seq,mode:'native-tool-events'};
}
