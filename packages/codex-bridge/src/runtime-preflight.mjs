import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {activationState,RUNTIME_VERSION} from './activation.mjs';
import {Ledger} from '../history.mjs';
import {assertMigrationSettled,acquireBindingLock} from '../../dsh-plugin/src/state.mjs';
import {resolveNativeCli} from './native-cli.mjs';
try{
 const spec=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const activation=activationState(spec.project,spec.home,spec.controlFile);
 if(!activation.enabled){console.log(JSON.stringify({mode:'native',reason:activation.paused?'paused':'plugin_disabled'}));process.exitCode=3;}
 else{
  for(const file of [spec.node,resolveNativeCli(process.env.DSH_SYNC_NATIVE_CLI??spec.nativeCli),spec.proxy])if(!fs.existsSync(file))throw Error('RUNTIME_COMPONENT_MISSING: '+path.basename(file));
  const checked=spawnSync(process.execPath,['--check',spec.proxy],{encoding:'utf8',windowsHide:true,timeout:3000});if(checked.status!==0)throw Error('BRIDGE_SYNTAX_CHECK_FAILED');
  const configFile=process.env.DSH_BRIDGE_CONFIG??spec.config;
  const unlock=acquireBindingLock(configFile);try{assertMigrationSettled(configFile);}finally{unlock();}
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  const bindings=Array.isArray(config.bindings)?config.bindings:[config];
  const ids=bindings.flatMap(b=>new Ledger(b.ledgerFile,b.threadId,b.sessionId).data.batches.flatMap(batch=>batch.messages).map(m=>m.id));
  if(ids.some(id=>id.length>64))throw Error('OVERSIZED_HISTORY_ID_REQUIRES_MANUAL_REPAIR');
  console.log(JSON.stringify({mode:'bridge',runtimeVersion:RUNTIME_VERSION,bindings:bindings.length,ledgerMessages:ids.length}));
 }
}catch(error){console.error(error.message);process.exitCode=2;}
