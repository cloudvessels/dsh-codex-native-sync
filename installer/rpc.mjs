import {spawn} from 'node:child_process';
import readline from 'node:readline';

export class NativeClient {
  constructor(executable,home){
    this.pending=new Map();this.sequence=0;this.stderr='';
    this.child=spawn(executable,['app-server'],{env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.done=new Promise(resolve=>this.child.once('close',resolve));
    this.child.stderr.on('data',bytes=>{this.stderr=(this.stderr+bytes).slice(-1000);});
    this.lines=readline.createInterface({input:this.child.stdout});
    const fail=error=>{for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(error);}this.pending.clear();};
    this.child.on('error',fail);this.child.on('exit',()=>fail(Error('原生 Codex 后台退出')));
    this.lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}
      const job=this.pending.get(String(value.id));if(!job)return;
      clearTimeout(job.timer);this.pending.delete(String(value.id));
      if(value.error)job.reject(Error(JSON.stringify(value.error)));else job.resolve(value.result);
    });
  }
  request(method,params={}){
    if(this.child.exitCode!==null||this.child.killed)return Promise.reject(Error('原生 Codex 后台不可用'));
    const id=String(++this.sequence);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('原生接口超时：'+method));},20000);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  async initialize(){await this.request('initialize',{clientInfo:{name:'dsh_sync_setup',version:'1'},capabilities:{experimentalApi:true}});this.child.stdin.write('{"method":"initialized","params":{}}\n');}
  async close(){this.child.stdin.end();const timer=setTimeout(()=>this.child.kill(),5000);try{await this.done;}finally{clearTimeout(timer);this.lines.close();}}
}
