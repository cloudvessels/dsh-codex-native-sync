import {spawn} from 'node:child_process';
import readline from 'node:readline';
export class Client{
  constructor(command,args,env){this.sequence=0;this.pending=new Map();this.stderr='';this.calls=[];
    this.child=spawn(command,args,{env:{...process.env,...env},stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.done=new Promise(resolve=>this.child.once('close',resolve));
    this.child.stderr.on('data',bytes=>{this.stderr=(this.stderr+bytes).slice(-3000);});
    this.lines=readline.createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const p=this.pending.get(String(value.id));if(!p)return;
      clearTimeout(p.timer);this.pending.delete(String(value.id));if(value.error)p.reject(Error(JSON.stringify(value.error)));else p.resolve(value.result);});
    this.child.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Backend exited: '+this.stderr));}this.pending.clear();});}
  request(method,params={}){this.calls.push(method);const id=String(++this.sequence);return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('RPC timeout: '+method+' '+this.stderr));},15000);
    this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  async initialize(){await this.request('initialize',{clientInfo:{name:'dsh_sync_regression',version:'0.3.1'},capabilities:{experimentalApi:true}});this.child.stdin.write('{"method":"initialized","params":{}}\n');}
  async close(){if(this.child.exitCode!==null||this.child.signalCode!==null){this.lines.close();return;}this.child.stdin.end();
    const timer=setTimeout(()=>this.child.kill(),3000);await this.done;clearTimeout(timer);this.lines.close();}
}
