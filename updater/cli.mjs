import path from 'node:path';
import {readJson,atomicJson,acquireBindingLock} from '../packages/dsh-plugin/src/state.mjs';
import {checkForUpdate,applyPendingUpdate,updaterPaths} from './update.mjs';

const args=process.argv.slice(2),at=args.indexOf('--runtime');
try{
  if(at<0||!args[at+1])throw Error('用法：node updater/cli.mjs --runtime <运行目录> [--check | --apply | --retry]');
  const runtime=path.resolve(args[at+1]),p=updaterPaths(runtime);
  if(args.includes('--retry')){const state=readJson(p.status,{});delete state.blockedVersion;atomicJson(p.status,state);}
  if(args.includes('--check')||args.includes('--apply')){
    const unlock=acquireBindingLock(path.join(p.folder,'worker'));
    try{console.log(JSON.stringify(args.includes('--check')?await checkForUpdate(runtime):await applyPendingUpdate(runtime),null,2));}finally{unlock();}
  }else console.log(JSON.stringify(readJson(p.status,{state:'not-checked'}),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
