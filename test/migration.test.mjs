import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {anchor,nativeFixture} from './native-support.mjs';
import {atomicJson,readJson,assertMigrationSettled,registerBridgeOwner} from '../packages/dsh-plugin/src/state.mjs';
import {offlineMigration,migrateBinding,recoverMigration} from '../packages/dsh-plugin/src/migration.mjs';
import {appendToLiveSession} from '../packages/dsh-plugin/src/append-v2.mjs';
import {Ledger} from '../packages/codex-bridge/history.mjs';
import {incomingMessages} from '../packages/codex-bridge/text-sync.mjs';

async function prepare(t){
  const f=await nativeFixture(t),old='original',targetPath=path.join(f.dir,'correct-project');
  fs.mkdirSync(targetPath);await f.ctx.sessionController.create({sessionId:old,cwd:path.join(f.dir,'old-project')});
  const agent=(await f.ctx.sessionController.resolveAgent(old)).agent;
  appendToLiveSession(agent.session,{source:'native',messages:[{id:'native-user',role:'user',text:'User message'},
    {id:'native-assistant',role:'assistant',text:'Assistant message'}]},f.r.validate,{preserveIds:true});
  const ledgerFile=path.join(f.dir,'ledger.json'),ledger=new Ledger(ledgerFile,'thread',old);
  ledger.stage(incomingMessages(f.snapshot(old),old));for(const batch of ledger.data.batches)ledger.commit(batch);
  atomicJson(ledgerFile+'.forward.json',{version:1,threadId:'thread',offset:123,sourceFile:'original-rollout',line:7,pending:[{id:'pending',role:'user',text:'still pending'}]});
  const binding={threadId:'thread',sessionId:old,ledgerFile,sourceFile:'original-rollout'},bindingsFile=path.join(f.dir,'bindings.json');
  atomicJson(f.configFile,{bindings:[binding]});atomicJson(bindingsFile,{version:2,bindings:[{threadId:'thread',sessionId:old}]});
  return {...f,old,binding,bindingsFile,targetPath,workspace:await f.ctx.workspaceRegistry.create(targetPath),ledgerFile};
}
test('rehome preserves native IDs, committed and pending work, and restart deduplication',{skip:!anchor},async t=>{
  const f=await prepare(t),oldLedger=fs.readFileSync(f.ledgerFile,'utf8'),oldView=f.snapshot(f.old);
  const result=await offlineMigration(f.configFile,f.ctx,()=>migrateBinding({ctx:f.ctx,configFile:f.configFile,bindingsFile:f.bindingsFile,
    binding:f.binding,workspace:f.workspace,targetPath:f.targetPath,snapshot:oldView,validate:f.r.validate}));
  const next=readJson(f.configFile).bindings[0],ledger=new Ledger(next.ledgerFile,'thread',result.to);
  assert.equal(ledger.data.batches.flatMap(batch=>batch.messages).length,2);assert(ledger.data.batches.every(batch=>batch.state==='committed'));
  assert.equal(fs.readFileSync(f.ledgerFile,'utf8'),oldLedger);assert.equal(next.identitySessionId,f.old);
  const view=f.snapshot(result.to);assert.deepEqual(view.messages,oldView.messages);
  const known=new Set(ledger.data.batches.flatMap(batch=>batch.messages.map(message=>message.id)));
  assert(incomingMessages(view,result.to,next.identitySessionId).every(message=>known.has(message.id)));
  assert.equal(fs.readFileSync(next.ledgerFile+'.forward.json','utf8'),fs.readFileSync(f.ledgerFile+'.forward.json','utf8'));
  assert.equal(readJson(f.bindingsFile).bindings[0].sessionId,result.to);assert(f.archived.includes(f.old));
  f.r.validate(f.native.sessions.get(result.to).header,f.native.sessions.get(result.to).snapshotEvents(),0);
});
test('failure publishing the second mapping restores the original files before archiving the source',{skip:!anchor},async t=>{
  const f=await prepare(t),beforeConfig=fs.readFileSync(f.configFile,'utf8'),beforeBindings=fs.readFileSync(f.bindingsFile,'utf8');
  const io={...fs,renameSync(from,to){if(to===f.bindingsFile)throw Error('SECOND_MAPPING_FAILURE');return fs.renameSync(from,to);}};
  await assert.rejects(offlineMigration(f.configFile,f.ctx,()=>migrateBinding({ctx:f.ctx,configFile:f.configFile,bindingsFile:f.bindingsFile,
    binding:f.binding,workspace:f.workspace,targetPath:f.targetPath,snapshot:f.snapshot(f.old),validate:f.r.validate,io})),/SECOND_MAPPING_FAILURE/);
  assert.equal(fs.readFileSync(f.configFile,'utf8'),beforeConfig);assert.equal(fs.readFileSync(f.bindingsFile,'utf8'),beforeBindings);
  assert(!f.archived.includes(f.old));assert.equal(f.snapshot(f.old).messages.length,2);assertMigrationSettled(f.configFile);
});
test('active bridge refuses all migration changes',{skip:!anchor},async t=>{
  const f=await prepare(t),before=fs.readFileSync(f.configFile,'utf8'),release=registerBridgeOwner(f.configFile);
  try{await assert.rejects(offlineMigration(f.configFile,f.ctx,()=>{throw Error('must not reach');}),/CODEX_BRIDGE_MUST_BE_STOPPED/);}
  finally{release();}
  assert.equal(fs.readFileSync(f.configFile,'utf8'),before);assert.equal(f.native.sessions.list().length,1);
});
test('interrupted prepared publication rolls back before a new bridge can start',{skip:!anchor},async t=>{
  const f=await prepare(t),beforeConfig=fs.readFileSync(f.configFile,'utf8'),beforeBindings=fs.readFileSync(f.bindingsFile,'utf8');
  await f.ctx.sessionController.create({sessionId:'uncommitted-copy',cwd:f.targetPath});
  atomicJson(f.configFile+'.migration-journal.json',{phase:'prepared',oldSessionId:f.old,newSessionId:'uncommitted-copy',bindingsFile:f.bindingsFile,beforeConfig,beforeBindings,archiveNewOnRollback:true});
  atomicJson(f.configFile,{bindings:[{...f.binding,sessionId:'uncommitted-copy'}]});
  assert.throws(()=>registerBridgeOwner(f.configFile),/MIGRATION_RECOVERY_REQUIRED/);
  await recoverMigration(f.configFile,f.ctx);assert.equal(fs.readFileSync(f.configFile,'utf8'),beforeConfig);
  assert(f.archived.includes('uncommitted-copy'));assert(!f.archived.includes(f.old));
  const release=registerBridgeOwner(f.configFile);release();
});
test('new source messages arriving during preparation abort without losing them',{skip:!anchor},async t=>{
  const f=await prepare(t),before=fs.readFileSync(f.configFile,'utf8'),snapshot=f.snapshot(f.old);let changed=false;
  f.ctx.sessionPersistence.flush=async()=>{if(changed)return;changed=true;
    appendToLiveSession(f.native.sessions.get(f.old),{source:'native',messages:[{id:'late-user',role:'user',text:'Arrived during migration'}]},f.r.validate,{preserveIds:true});};
  await assert.rejects(offlineMigration(f.configFile,f.ctx,()=>migrateBinding({ctx:f.ctx,configFile:f.configFile,bindingsFile:f.bindingsFile,
    binding:f.binding,workspace:f.workspace,targetPath:f.targetPath,snapshot,validate:f.r.validate})),/SOURCE_CHANGED_DURING_MIGRATION/);
  assert.equal(fs.readFileSync(f.configFile,'utf8'),before);assert(!f.archived.includes(f.old));assert.equal(f.snapshot(f.old).messages.at(-1).id,'late-user');
});

test('missing ledger stops migration without resetting deduplication history',{skip:!anchor},async t=>{
  const f=await prepare(t),before=fs.readFileSync(f.configFile,'utf8');fs.unlinkSync(f.ledgerFile);
  await assert.rejects(offlineMigration(f.configFile,f.ctx,()=>migrateBinding({ctx:f.ctx,configFile:f.configFile,bindingsFile:f.bindingsFile,
    binding:f.binding,workspace:f.workspace,targetPath:f.targetPath,snapshot:f.snapshot(f.old),validate:f.r.validate})),/MIGRATION_LEDGER_MISSING/);
  assert.equal(fs.readFileSync(f.configFile,'utf8'),before);assert.equal(f.native.sessions.list().length,1);assert(!f.archived.includes(f.old));
});

test('migration copies histories larger than one append batch without changing IDs',{skip:!anchor},async t=>{
  const f=await prepare(t),more=Array.from({length:999},(_,n)=>({id:'history-'+n,role:n%2?'assistant':'user',text:'Historical text '+n}));
  appendToLiveSession(f.native.sessions.get(f.old),{source:'native',messages:more},f.r.validate,{preserveIds:true});
  const snapshot=f.snapshot(f.old);
  const result=await offlineMigration(f.configFile,f.ctx,()=>migrateBinding({ctx:f.ctx,configFile:f.configFile,bindingsFile:f.bindingsFile,
    binding:f.binding,workspace:f.workspace,targetPath:f.targetPath,snapshot,validate:f.r.validate}));
  assert.deepEqual(f.snapshot(result.to).messages,snapshot.messages);assert.equal(result.messages,1001);
});
