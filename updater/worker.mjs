import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readJson,atomicJson,acquireBindingLock} from '../packages/dsh-plugin/src/state.mjs';
import {checkForUpdate,applyPendingUpdate,updaterPaths,updateEnabled} from './update.mjs';

const index=process.argv.indexOf('--runtime');if(index<0||!process.argv[index+1])throw Error('Missing --runtime');
const runtime=path.resolve(process.argv[index+1]),p=updaterPaths(runtime);
let unlock;
try{unlock=acquireBindingLock(path.join(p.folder,'worker'));}catch{process.exit(0);}
try{
  let status=readJson(p.status,{}),blocked=status.blockedVersion;
  while(readJson(path.join(runtime,'.setup','installation.json'),{}).state==='activated'&&readJson(path.join(runtime,'update.json'),{}).enabled!==false){
    status=readJson(p.status,status);blocked=status.blockedVersion;
    if(!updateEnabled(runtime)){await delay(30000);continue;}
    try{
      if(Date.now()>=(status.nextCheckAt??((status.checkedAt??0)+6*60*60*1000))){
        const result=await checkForUpdate(runtime);status={...result,checkedAt:Date.now(),blockedVersion:blocked};atomicJson(p.status,status);
      }
      const pending=readJson(p.pending,null);
      if(pending&&pending.version!==blocked){
        try{
          const result=await applyPendingUpdate(runtime);
          status={...status,...result};atomicJson(p.status,status);
          if(result.state==='installed')break;
        }catch(error){blocked=pending.version;status={...status,state:'failed',lastError:error.message,blockedVersion:blocked};atomicJson(p.status,status);}
      }
    }catch(error){status={...status,state:'check-failed',checkedAt:Date.now(),nextCheckAt:Date.now()+15*60*1000,lastError:error.message};atomicJson(p.status,status);}
    // No page/browser residence. A single low-frequency local worker owns all
    // checks. A live settings toggle pauses work; uninstall/offline disable exits.
    await delay(30000);
  }
}finally{unlock();}
