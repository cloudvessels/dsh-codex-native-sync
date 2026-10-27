import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomicJson,atomicText,readJson,acquireBindingLock,assertBridgeOffline} from './state.mjs';
import {appendToLiveSession} from './append-v2.mjs';
import {alignIdleAgent} from './agent-turns.mjs';

const journalFile=configFile=>configFile+'.migration-journal.json';
function restoreFile(file,text){if(text===null){try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}}else atomicText(file,text);}
function saveJournal(file,journal){atomicJson(file,journal);}

// The old native session and old ledger are never removed or overwritten.
// A prepared journal blocks new bridge launches until DSH recovers it.
export async function recoverMigration(configFile,ctx,{locked=false}={}) {
  const file=journalFile(configFile),journal=readJson(file,null);
  if(!journal)return null;
  const unlock=locked?()=>{}:acquireBindingLock(configFile);
  try{
    const config=readJson(configFile,{});
    assertBridgeOffline(configFile,config.statusFile);
    if(journal.phase==='prepared'){
      restoreFile(configFile,journal.beforeConfig);
      restoreFile(journal.bindingsFile,journal.beforeBindings);
      if(journal.archiveNewOnRollback!==false&&ctx.sessions.get(journal.newSessionId))await ctx.workspaceRegistry.archiveSession(journal.newSessionId,{stopActivity:false});
      journal.phase='rolled-back';saveJournal(file,journal);
    }
    if(journal.phase==='committed'){
      if(ctx.agents?.get(journal.oldSessionId)?.status==='running')throw Error('SOURCE_SESSION_BUSY_NOT_ARCHIVED');
      await ctx.workspaceRegistry.archiveSession(journal.oldSessionId,{stopActivity:false});
      journal.phase='archived';saveJournal(file,journal);
    }
    const audit=path.join(path.dirname(configFile),'data','migrations',randomUUID()+'.json');
    atomicJson(audit,journal);fs.unlinkSync(file);
    return journal;
  }finally{unlock();}
}

export async function offlineMigration(configFile,ctx,work){
  const unlock=acquireBindingLock(configFile);
  try{
    const config=readJson(configFile,{});assertBridgeOffline(configFile,config.statusFile);
    await recoverMigration(configFile,ctx,{locked:true});
    return await work();
  }finally{unlock();}
}

export async function migrateBinding({ctx,configFile,bindingsFile,binding,workspace,targetPath,snapshot,validate,io=fs}){
  const beforeConfig=io.readFileSync(configFile,'utf8'),config=JSON.parse(beforeConfig.replace(/^\uFEFF/,''));
  const stored=config.bindings?.find(row=>row.threadId===binding.threadId);
  assertBridgeOffline(configFile,config.statusFile);
  if(!stored||stored.sessionId!==binding.sessionId)throw Error('MIGRATION_BINDING_CHANGED');
  if(!path.isAbsolute(stored.ledgerFile??''))throw Error('MIGRATION_LEDGER_PATH_REQUIRED');
  if(ctx.agents?.get(binding.sessionId)?.status==='running')throw Error('SESSION_BUSY');
  const oldLedger=readJson(stored.ledgerFile,null);
  if(!oldLedger)throw Error('MIGRATION_LEDGER_MISSING');
  if(oldLedger.threadId!==binding.threadId||oldLedger.sessionId!==binding.sessionId)throw Error('LEDGER_BINDING_MISMATCH');
  const sourceView=await ctx.sessionController.inspect(binding.sessionId);
  if(sourceView.events.some(event=>event.type==='tool/call'||event.type==='tool/result'))throw Error('OPERATION_HISTORY_REHOME_UNSUPPORTED');
  const suffix=createHash('sha256').update(targetPath.toLowerCase()).digest('hex').slice(0,12);
  const newSessionId=binding.sessionId+'-r'+suffix;
  const newLedger=stored.ledgerFile.replace(/\.json$/,'')+'-r'+suffix+'.json';
  const beforeBindings=io.existsSync(bindingsFile)?io.readFileSync(bindingsFile,'utf8'):null;
  const existing=ctx.sessions.get(newSessionId);
  const journal={version:1,phase:'prepared',threadId:binding.threadId,oldSessionId:binding.sessionId,newSessionId,
    bindingsFile,beforeConfig,beforeBindings,newLedger,
    archiveNewOnRollback:!existing||ctx.workspaceRegistry.archivedSessionIds?.includes(newSessionId)===true};
  const file=journalFile(configFile);if(io.existsSync(file))throw Error('MIGRATION_RECOVERY_REQUIRED');
  saveJournal(file,journal);
  try{
    if(!ctx.sessions.get(newSessionId))await ctx.sessionController.create({sessionId:newSessionId,workspaceId:workspace.id,agentPreset:'cordis'});
    const found=await ctx.sessionController.resolveAgent(newSessionId);
    if(found.error)throw Error('RESOLVE_'+found.error.code);
    if(found.agent.status==='running')throw Error('SESSION_BUSY');
    if(path.resolve(found.agent.session.header.cwd).toLowerCase()!==path.resolve(targetPath).toLowerCase())throw Error('MIGRATION_TARGET_WORKSPACE_CHANGED');
    alignIdleAgent(found.agent,found.agent.session.snapshotEvents());
    const messages=snapshot.messages.filter(message=>['user','assistant'].includes(message.role)&&typeof message.text==='string'&&message.text.trim());
    const wanted=new Map(messages.map(message=>[message.id,message]));
    for(const event of found.agent.session.snapshotEvents()){
      const body=event.type==='user/message'?event.data:event.type==='assistant/message'?event.data.message:null;
      if(!body)continue;
      const original=wanted.get(body.id),text=body.content.filter(block=>block.type==='text').map(block=>block.text).join('');
      if(!original||body.role!==original.role||text!==original.text)throw Error('MIGRATION_TARGET_CHANGED');
    }
    for(let offset=0;offset<messages.length;offset+=1000){
      appendToLiveSession(found.agent.session,{source:binding.threadId,messages:messages.slice(offset,offset+1000)},validate,{preserveIds:true});
    }
    alignIdleAgent(found.agent,found.agent.session.snapshotEvents());
    await ctx.sessionPersistence.flush();
    if(ctx.agents?.get(binding.sessionId)?.status==='running')throw Error('SESSION_BUSY');
    const source=ctx.sessions.get(binding.sessionId);
    if(source){
      const current=source.snapshotEvents().flatMap(event=>{
        const body=event.type==='user/message'?event.data:event.type==='assistant/message'?event.data.message:null;
        if(!body||(body.role==='user'&&body.source?.kind!=='user'))return [];
        return [{id:body.id,role:body.role,text:body.content.filter(block=>block.type==='text').map(block=>block.text).join('')}];
      });
      const expected=snapshot.messages.map(({id,role,text})=>({id,role,text}));
      if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('SOURCE_CHANGED_DURING_MIGRATION');
    }
    if(ctx.workspaceRegistry.archivedSessionIds?.includes(newSessionId))await ctx.workspaceRegistry.unarchiveSession(newSessionId);
    // Preserve already-injected Codex IDs, all batches, pending work, and the
    // immutable ID namespace. Copy the outbox with its original cursor intact.
    atomicJson(newLedger,{...oldLedger,sessionId:newSessionId});
    if(io.existsSync(stored.ledgerFile+'.forward.json'))atomicText(newLedger+'.forward.json',io.readFileSync(stored.ledgerFile+'.forward.json','utf8'));
    if(io.existsSync(stored.ledgerFile+'.operations.json'))atomicText(newLedger+'.operations.json',io.readFileSync(stored.ledgerFile+'.operations.json','utf8'));
    const next={...stored,sessionId:newSessionId,identitySessionId:stored.identitySessionId??stored.sessionId,ledgerFile:newLedger};
    config.bindings[config.bindings.indexOf(stored)]=next;
    const mapping=beforeBindings===null?{version:2,bindings:[]}:JSON.parse(beforeBindings.replace(/^\uFEFF/,''));
    mapping.bindings=config.bindings.map(row=>({threadId:row.threadId,sessionId:row.sessionId}));
    atomicJson(configFile,config);
    // io is injectable for fault tests at the second-file publication boundary.
    const temporary=bindingsFile+'.'+randomUUID()+'.tmp';
    io.mkdirSync(path.dirname(bindingsFile),{recursive:true});
    try{io.writeFileSync(temporary,JSON.stringify(mapping,null,2));io.renameSync(temporary,bindingsFile);}finally{try{io.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
    journal.phase='committed';saveJournal(file,journal);
  }catch(error){
    try{await recoverMigration(configFile,ctx,{locked:true});}
    catch(recovery){throw Error(error.message+'; MIGRATION_RECOVERY_REQUIRED: '+recovery.message);}
    throw error;
  }
  try{await recoverMigration(configFile,ctx,{locked:true});}
  catch(error){return {threadId:binding.threadId,from:binding.sessionId,to:newSessionId,archivePending:true,error:error.message};}
  return {threadId:binding.threadId,from:binding.sessionId,to:newSessionId,messages:snapshot.messages.length};
}
