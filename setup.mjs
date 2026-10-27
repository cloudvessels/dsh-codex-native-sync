#!/usr/bin/env node
import path from 'node:path';
import {createPlan,prepare,activate,rollbackSetup} from './installer/setup.mjs';

const args=process.argv.slice(2),flags=new Set(['--dry','--apply','--activate','--rollback','--help']);
const names=new Set(['--profile','--runtime','--codex-home','--native-cli','--node','--compiler','--runtime-binary','--port','--plugin-port']);
const values={};
try{
  for(let i=0;i<args.length;i++){
    const key=args[i];if(flags.has(key))continue;
    if(!names.has(key)||!args[i+1]||args[i+1].startsWith('--'))throw Error('未知参数或缺少值：'+key);
    values[key]=args[++i];
  }
  if(args.includes('--help')||!args.length){
    console.log('准备：node setup.mjs --profile <DSH profile> --runtime <固定目录> --native-cli <原生 codex.exe> [--codex-home <目录>] [--dry | --apply]');
    console.log('接入：node setup.mjs --runtime <固定目录> --activate');
    console.log('回滚：node setup.mjs --runtime <固定目录> --rollback');
  }else{
    const modes=['--apply','--activate','--rollback'].filter(flag=>args.includes(flag));
    if(modes.length>1||args.includes('--dry')&&modes.length)throw Error('预演、准备、接入、回滚应分别执行');
    if(args.includes('--activate')||args.includes('--rollback')){
      if(!values['--runtime'])throw Error('必须指定 --runtime');
      const runtime=path.resolve(values['--runtime']);
      const result=args.includes('--activate')?await activate(runtime):await rollbackSetup(runtime);
      console.log(JSON.stringify(result,null,2));console.log('请按 README 完成重启和实际双向验收；安装步骤完成不等于桌面验收通过。');
    }else{
      const plan=createPlan({profile:values['--profile'],runtime:values['--runtime'],home:values['--codex-home'],native:values['--native-cli'],node:values['--node'],compiler:values['--compiler'],runtimeBinary:values['--runtime-binary'],port:values['--port'],pluginPort:values['--plugin-port']});
      if(args.includes('--apply'))console.log(JSON.stringify(await prepare(plan),null,2));
      else console.log(JSON.stringify({mode:'dry',version:plan.release.version,profile:plan.profile,runtime:plan.runtime,codexHome:plan.home,actions:plan.actions,writes:false,next:'核对以上目录后，将 --dry 改成 --apply'},null,2));
    }
  }
}catch(error){console.error(error.message);process.exitCode=1;}
