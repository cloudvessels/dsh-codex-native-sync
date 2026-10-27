import {createHash} from 'node:crypto';

export const surfaceTypes=new Set(['system/message','developer/message','user/message','assistant/message','tool/result']);
const idFor=(source,id)=>'shared-chat-'+createHash('sha256').update(source+'\0'+id).digest('hex');
const bodyOf=e=>e.type==='assistant/message'?e.data.message:e.type==='user/message'?e.data:null;

/** Prepare the entire valid batch before changing a live Session. Text-only proof. */
export function planAppend({header,events,inheritedEventCount=0},batch,validate,{preserveIds=false}={}){
  if(!batch || typeof batch.source!=='string' || !batch.source.trim() || !Array.isArray(batch.messages) || batch.messages.length>1000)throw new Error('INVALID_BATCH');
  let openTurn=false;
  for(const e of events){if(e.type==='turn/start')openTurn=true;if(e.type==='turn/end')openTurn=false;}
  if(openTurn)throw new Error('SESSION_TURN_OPEN');
  const existing=new Map(events.map(bodyOf).filter(Boolean).map(m=>[m.id,m]));
  const pending=new Map();const additions=[];
  for(const m of batch.messages){
    if(!m || typeof m.id!=='string' || !m.id || !['user','assistant'].includes(m.role) || typeof m.text!=='string' || !m.text.trim() || m.text.length>100000)throw new Error('INVALID_MESSAGE');
    const id=preserveIds?m.id:idFor(batch.source,m.id),known=existing.get(id)??pending.get(id);
    if(known){
      const text=known.content.map(b=>b.type==='text'?b.text:'').join('');
      if(known.role!==m.role || text!==m.text)throw new Error('MESSAGE_ID_CONFLICT');
      continue;
    }
    const body={id,role:m.role,content:[{type:'text',text:m.text}],source:m.role==='user'?{kind:'user'}:{kind:'model',provider:'external-sync',model:batch.source}};
    pending.set(id,body);additions.push(body);
  }
  if(!additions.length)return {events:[],messages:0,duplicates:batch.messages.length};
  const surface=events.filter(e=>surfaceTypes.has(e.type));
  if(surface.length && surface[0].type!=='system/message')throw new Error('MISSING_PROTECTED_SYSTEM_HEAD');
  let turn=events.reduce((n,e)=>e.type==='turn/start'?Math.max(n,e.data.turn):n,0);
  const suffix=[];const time=Date.now();
  const push=(type,data,opts={})=>suffix.push({type,data,seq:events.length+suffix.length,time,...opts});
  let groupOpen=false,groupMessages=0;
  const close=()=>{if(groupOpen){push('step/end',{turn,step:1});push('turn/end',{turn,reason:{kind:'completed'}});groupOpen=false;}};
  for(const message of additions){
    if(message.role==='user' && groupMessages>0)close();
    if(!groupOpen){
      turn++;push('turn/start',{turn});push('step/start',{turn,step:1});groupOpen=true;groupMessages=0;
      if(!surface.length && suffix.filter(e=>e.type==='system/message').length===0)push('system/message',{turn,step:1,message:{id:idFor('system-head',header.id),role:'system',content:[],source:{kind:'system-prompt'}}},{surfaceOp:'append'});
    }
    if(message.role==='user')push('user/message',message,{surfaceOp:'append'});
    else push('assistant/message',{turn,step:1,message,stream:[]},{surfaceOp:'append'});
    groupMessages++;
    // DSH renders one settled assistant per native step/turn. Never pack replies.
    if(message.role==='assistant')close();
  }
  close();
  validate(header,[...events,...suffix],inheritedEventCount);
  return {events:suffix,messages:additions.length,duplicates:batch.messages.length-additions.length};
}

/** Must be called inside the owning DSH host; never opens another writer. */
export function appendToLiveSession(session,batch,validate,{busy=false,preserveIds=false}={}){
  if(busy)throw new Error('SESSION_BUSY');
  const plan=planAppend({header:session.header,events:session.snapshotEvents(),inheritedEventCount:session.inheritedEventCount},batch,validate,{preserveIds});
  const firstSeq=session.seq;
  for(const event of plan.events){
    if(session.seq!==event.seq)throw new Error('SESSION_CHANGED_DURING_APPEND');
    const {type,data,surfaceOp,sourceEventSeqs}=event;
    session.append(type,data,...(surfaceOp===undefined?[]:[{surfaceOp,...(sourceEventSeqs===undefined?{}:{sourceEventSeqs})}]));
  }
  return {sessionId:session.id,firstSeq,nextSeq:session.seq,appendedMessages:plan.messages,duplicates:plan.duplicates};
}
