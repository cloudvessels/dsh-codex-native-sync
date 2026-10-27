import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const threadId=process.env.DSH_CODEX_THREAD_ID ?? '';
export const sourceFile=process.env.DSH_CODEX_ROLLOUT ?? '';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');

/** Only completed canonical public message records; never exports tools or private context. */
export function createPublicCollector(root,{sourcePath=sourceFile,sourceThreadId=threadId}={}){
  const attachmentsDir=path.join(root,'attachments');fs.mkdirSync(attachmentsDir,{recursive:true});
  let offset=0,pending=Buffer.alloc(0),rows=0,filteredRuntimeMessages=0;
  const messages=[],byId=new Map(),attachments=new Map();
  function keepAttachment(bytes,name,source){
    const digest=sha(bytes),safeName=path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
    const target=path.join(attachmentsDir,digest.slice(0,16)+'-'+safeName);
    if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx'});
    const info={id:digest,name:safeName,path:target.replaceAll('\\','/'),source,bytes:bytes.length,referenceOnly:true,nativeImageMessage:false};
    attachments.set(digest,info);return info;
  }
  function parse(row,lineNumber){
    const p=row.payload;
    if(row.type!=='response_item'||p?.type!=='message'||!['user','assistant'].includes(p.role))return;
    // These messages already exist natively in DSH. Never send them back as new imports.
    // Bridge ids are 'msg_dshlink_' + a hash that has been shortened to fit the 64-char model limit.
    if(/^msg_dshlink_[a-f0-9]{16,64}$/.test(p.id??''))return;
    if(p.role==='assistant'&&!['commentary','final_answer'].includes(p.phase))return;
    let text=(p.content??[]).filter(b=>['text','input_text','output_text'].includes(b.type)).map(b=>b.text??'').join('');
    if(p.role==='user'&&/^\s*<(environment_context|external_codex_apps_open_page)>/.test(text)){filteredRuntimeMessages++;return;}
    const refs=[];const inputImages=(p.content??[]).filter(b=>b.type==='input_image');
    if(p.role==='user'){
      for(const m of text.matchAll(/^## (.+?): ([A-Za-z]:[\\/][^\r\n]+)$/gm)){
        const origin=m[2].trim();
        if(fs.existsSync(origin)&&fs.statSync(origin).isFile())refs.push(keepAttachment(fs.readFileSync(origin),path.basename(origin),origin));
        else {
          const safeName=path.basename(origin).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
          const cached=fs.readdirSync(attachmentsDir).filter(n=>n.endsWith('-'+safeName)).flatMap(n=>{const bytes=fs.readFileSync(path.join(attachmentsDir,n));return sha(bytes).startsWith(n.slice(0,16))?[{bytes,name:safeName}]:[];});
          // Reuse only an unambiguous, hash-checked copy made during an earlier sync.
          if(cached.length===1)refs.push(keepAttachment(cached[0].bytes,cached[0].name,origin));
          else refs.push({name:m[1],source:origin,path:origin,missing:true,referenceOnly:true,nativeImageMessage:false});
        }
      }
      let i=0;
      for(const b of inputImages){
        if(refs.some(a=>!a.missing&&/\.(png|jpe?g|webp)$/i.test(a.name)))break;
        const uri=typeof b.image_url==='string'?b.image_url:b.image_url?.url;
        const match=/^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(uri??'');
        if(match)refs.push(keepAttachment(Buffer.from(match[2],'base64'),'embedded-'+String(p.id??lineNumber)+'-'+(++i)+'.'+(match[1]==='jpeg'?'jpg':match[1]),'embedded-codex-input'));
      }
      if(text.includes('# Files mentioned by the user:')){
        const marker='## My request:';const at=text.indexOf(marker);
        let request=at>=0?text.slice(at+marker.length).trim():'';
        request=request.replace(/<image\b[^>]*>[\s\S]*?<\/image>/g,'').trim();
        text=[request,refs.length?'附件：\n'+refs.map(a=>'- ['+a.name+']('+a.path.replaceAll('\\','/')+')'+(a.missing?'（原文件当前不可用）':'')).join('\n'):''].filter(Boolean).join('\n\n');
      }else if(refs.length){text+='\n\n附件：\n'+refs.map(a=>'- ['+a.name+']('+a.path+')').join('\n');}
    }
    if(!text.trim())return;
    const id=p.id??'line-'+lineNumber;
    const value={id,role:p.role,text:text.trim(),time:Date.parse(row.timestamp)||0,phase:p.phase??null,source:sourceThreadId,attachments:refs};
    const known=byId.get(id);
    if(known){if(known.role!==value.role||known.text!==value.text)throw new Error('SOURCE_MESSAGE_CHANGED: '+id);return;}
    byId.set(id,value);messages.push(value);
  }
  function drain(){
    const size=fs.statSync(sourcePath).size;if(size<offset)throw new Error('SOURCE_TRUNCATED');
    if(size===offset)return [];
    const before=messages.length,fd=fs.openSync(sourcePath,'r');
    try{
      while(offset<size){
        const chunk=Buffer.alloc(Math.min(1024*1024,size-offset));const read=fs.readSync(fd,chunk,0,chunk.length,offset);if(!read)break;
        offset+=read;pending=Buffer.concat([pending,chunk.subarray(0,read)]);
        let newline;
        while((newline=pending.indexOf(10))>=0){
          const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);rows++;
          if(line.length)parse(JSON.parse(line.toString('utf8')),rows);
        }
      }
    }finally{fs.closeSync(fd);}
    return messages.slice(before);
  }
  const snapshot=()=>({threadId:sourceThreadId,sourceFile:sourcePath,offset,completeRows:rows,incompleteTailBytes:pending.length,filteredRuntimeMessages,messages:[...messages],attachments:[...attachments.values()]});
  return {drain,snapshot};
}
