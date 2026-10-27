import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomicText,atomicJson,readJson} from '../packages/dsh-plugin/src/state.mjs';

const hash=value=>value===null?null:createHash('sha256').update(value).digest('hex');
const bytes=file=>{try{return fs.readFileSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
export class SetupTransaction {
  constructor(runtime,record){
    this.file=path.join(runtime,'.setup','installation.json');
    this.data=record??{version:1,id:randomUUID(),state:'writing',files:[],createdAt:new Date().toISOString()};
    if(!record){
      const prior=bytes(this.file);
      if(prior!==null){
        const archived=path.join(path.dirname(this.file),'history',this.data.id+'.json');
        fs.mkdirSync(path.dirname(archived),{recursive:true});fs.writeFileSync(archived,prior,{mode:0o600});
        this.data.previous={file:archived,hash:hash(prior)};
      }
    }
  }
  save(){atomicJson(this.file,this.data);}
  track(file){
    file=path.resolve(file);let row=this.data.files.find(item=>item.file===file);if(row)return row;
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('不能替换链接文件：'+file);
    const original=bytes(file),backup=path.join(path.dirname(this.file),this.data.id,String(this.data.files.length)+'.bak');
    if(original!==null){fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,original,{mode:0o600});}
    row={file,backup:original===null?null:backup,before:hash(original),after:hash(original)};this.data.files.push(row);this.save();return row;
  }
  write(file,value,{retain=false}={}){
    const row=this.track(file),content=Buffer.isBuffer(value)?value:Buffer.from(value);
    if(retain)row.retain=true;
    row.after=hash(content);this.save();
    atomicText(file,content);
  }
  json(file,value,options){this.write(file,JSON.stringify(value,null,2)+'\n',options);}
  capture(file){const row=this.track(file);row.after=hash(bytes(file));this.save();}
  async rollback(environment){
    const conflicts=[];
    if(this.data.environment){
      const current=await environment.get();
      if(current===this.data.environment.after)await environment.set(this.data.environment.before);
      else if(current!==this.data.environment.before)conflicts.push('CODEX_CLI_PATH 已被另行修改');
    }
    for(const row of [...this.data.files].reverse()){
      if(row.retain)continue;
      const current=hash(bytes(row.file));if(current===row.before)continue;
      if(current!==row.after||row.keepOnRollback){conflicts.push(row.file);continue;}
      if(row.backup===null){try{fs.unlinkSync(row.file);}catch(error){if(error.code!=='ENOENT')throw error;}}
      else {const original=fs.readFileSync(row.backup);if(hash(original)!==row.before)throw Error('备份校验失败：'+row.backup);this.writeRestored(row.file,original);}
    }
    this.data.state=conflicts.length?'rollback-conflict':'rolled-back';this.data.conflicts=conflicts;this.save();
    if(conflicts.length)throw Error('部分内容已有后续修改，已保留，需人工核对：'+conflicts.join('；'));
    if(this.data.previous){
      const prior=fs.readFileSync(this.data.previous.file);
      if(hash(prior)!==this.data.previous.hash)throw Error('上一轮安装记录校验失败');
      atomicJson(path.join(path.dirname(this.file),'history',this.data.id+'.rollback.json'),this.data);
      atomicText(this.file,prior);
    }
    return {state:'rolled-back',restoredPreviousInstallation:!!this.data.previous,historyDeleted:false};
  }
  writeRestored(file,value){atomicText(file,value);}
  static load(runtime){const record=readJson(path.join(runtime,'.setup','installation.json'),null);if(!record)throw Error('没有可回滚的安装记录');return new SetupTransaction(runtime,record);}
}
