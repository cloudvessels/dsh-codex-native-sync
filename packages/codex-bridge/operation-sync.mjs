import fs from 'node:fs';
import path from 'node:path';
import {readJson,atomicJson} from './history.mjs';

const clip=(s,n)=>s.length>n?s.slice(0,n)+'\n[truncated]':s;
function resultText(value){
  if(typeof value==='string')return clip(value,2000);
  const content=Array.isArray(value)?value:value?.content;
  if(Array.isArray(content))return clip(content.filter(b=>b?.type==='text').map(b=>b.text??'').join('\n'),2000);
  return clip(JSON.stringify(value??''),2000);
}
/** Optional, independent cursor: never replays pre-enable operation history. */
export class OperationOutbox {
  constructor(file,threadId){this.file=file;this.threadId=threadId;this.data=readJson(file,{version:1,threadId,pending:[],calls:{},offset:0,primed:false,enabled:false});if(this.data.threadId!==threadId)throw Error('OPERATION_OUTBOX_BINDING_MISMATCH');}
  save(){atomicJson(this.file,this.data);}
  scan(sourceFile,enabled,epoch=null,enabledSince=0){
    if(!sourceFile||!fs.existsSync(sourceFile))return;
    const size=fs.statSync(sourceFile).size;if(!size)return;
    const fd=fs.openSync(sourceFile,'r');
    try{
      let createdAt=this.data.sourceCreatedAt??0;
      if(this.data.sourceFile!==sourceFile){
        const head=Buffer.alloc(Math.min(65536,size)),n=fs.readSync(fd,head,0,head.length,0),text=head.subarray(0,n).toString('utf8'),end=text.indexOf('\n');
        if(end<0)return;
        const row=JSON.parse(text.slice(0,end).replace(/^\uFEFF/,''));if(row.type!=='session_meta'||row.payload?.id!==this.threadId)throw Error('OPERATION_SOURCE_MISMATCH');
        createdAt=Date.parse(row.payload.timestamp??row.timestamp)||0;
      }
      if(this.data.primed&&size<this.data.offset)throw Error('OPERATION_SOURCE_TRUNCATED');
      if(!enabled||!this.data.primed||!this.data.enabled||this.data.epoch!==epoch){
        if(this.data.sourceFile===sourceFile&&this.data.offset===size&&this.data.enabled===enabled&&this.data.primed&&this.data.epoch===epoch)return;
        const last=Buffer.alloc(1);fs.readSync(fd,last,0,1,size-1);
        const fresh=enabled&&enabledSince>0&&createdAt>=enabledSince;
        this.data={...this.data,sourceFile,sourceCreatedAt:createdAt,offset:fresh?0:size,primed:true,enabled,epoch,discardPartial:!fresh&&last[0]!==10,calls:{}};this.save();if(!fresh)return;
      }
      const next=structuredClone(this.data),known=new Set(next.pending.map(s=>s.id));let position=next.offset,partial=Buffer.alloc(0),stop=false;
      while(position<size&&!stop){
        const buf=Buffer.alloc(Math.min(1024*1024,size-position)),n=fs.readSync(fd,buf,0,buf.length,position);if(!n)break;position+=n;partial=Buffer.concat([partial,buf.subarray(0,n)]);
        if(partial.length>16*1024*1024)throw Error('OPERATION_SOURCE_ROW_TOO_LARGE');
        let end;
        while((end=partial.indexOf(10))>=0){
          if(next.pending.length>=1000){stop=true;break;}
          const line=partial.subarray(0,end);partial=partial.subarray(end+1);next.offset+=end+1;
          if(next.discardPartial){next.discardPartial=false;continue;}if(!line.length)continue;
          const row=JSON.parse(line.toString('utf8')),p=row.payload;if(row.type!=='response_item'||!p)continue;
          const id=p.call_id;
          if(typeof id!=='string'||!id||id.length>512||id.startsWith('msg_dshlink_'))continue;
          if(['function_call','custom_tool_call'].includes(p.type)&&typeof p.name==='string'){
            if(Object.keys(next.calls).length>=1000&&!Object.hasOwn(next.calls,id))throw Error('TOO_MANY_PENDING_OPERATIONS');
            // Null-prototype semantics through defineProperty avoid special JS
            // object keys changing the call map's prototype.
            Object.defineProperty(next.calls,id,{value:{name:p.name.slice(0,256),arguments:clip(typeof p.arguments==='string'?p.arguments:typeof p.input==='string'?p.input:JSON.stringify(p.arguments??{}),4000)},enumerable:true,configurable:true,writable:true});
          }else if(['function_call_output','custom_tool_call_output'].includes(p.type)&&Object.hasOwn(next.calls,id)){
            const call=next.calls[id];delete next.calls[id];if(known.has(id))continue;
            next.pending.push({id,...call,result:resultText(p.output),isError:p.isError===true||p.is_error===true||p.output?.isError===true});known.add(id);
          }
        }
      }
      next.sourceFile=sourceFile;this.data=next;this.save();
    }finally{fs.closeSync(fd);}
  }
  forget(ids){this.data.pending=this.data.pending.filter(s=>!ids.has(s.id));this.save();}
}
