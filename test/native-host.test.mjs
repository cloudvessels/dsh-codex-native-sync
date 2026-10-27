import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {anchor,nativeFixture} from './native-support.mjs';
import {installDshPackage} from '../installer/dsh-package.mjs';
import {publishSettings} from '../packages/dsh-plugin/src/settings.mjs';
import {write} from './support.mjs';

test('fresh installed DSH host starts with zero legacy variables and synchronizes native text',{skip:!anchor},async t=>{
  const f=await nativeFixture(t),profile=path.join(f.dir,'profile with spaces');
  write(path.join(profile,'package.json'),'{"private":true}');
  const tokenFile=path.join(f.dir,'private','token');
  write(f.configFile,JSON.stringify({bindings:[],dshTokenFile:tokenFile}));
  const installed=installDshPackage({source:fileURLToPath(new URL('../packages/dsh-plugin',import.meta.url)),profile,bridgeConfig:f.configFile});
  write(path.join(installed.target,'link.config.json'),JSON.stringify({bridgeConfig:f.configFile,port:0,legacyThreadId:'',legacySourceFile:''}));
  const previous=process.env.DSH_CORE_PACKAGE;process.env.DSH_CORE_PACKAGE=anchor;
  let Host;
  try{Host=(await import(pathToFileURL(path.join(installed.target,'lib/index.js')))).default;}
  finally{if(previous===undefined)delete process.env.DSH_CORE_PACKAGE;else process.env.DSH_CORE_PACKAGE=previous;}
  const parsed=Host.Config['~standard'].validate({bridgeConfig:f.configFile});assert(!parsed.issues);
  const {Service}=await f.r.load('@deepseek-ai/cordis');
  const host=new Host(f.ctx,parsed.value);for await(const _ of host[Service.init]()){}
  const stateFile=path.join(path.dirname(f.configFile),'data/dsh/sync-status.json');
  const state=JSON.parse(fs.readFileSync(stateFile));assert(state.ready);assert.equal(state.bindings,0);assert.equal(state.targetSessionId,null);
  assert.equal(f.native.sessions.list().length,0);
  const token=fs.readFileSync(tokenFile,'utf8').trim();assert.equal(token.length,64);
  const post=async(route,body={})=>{const response=await fetch('http://127.0.0.1:'+state.port+route,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body)});return {code:response.status,value:await response.json()};};
  const ensured=await post('/ensure',{threadId:'fixture-thread',cwd:f.dir,title:'User title'});assert.equal(ensured.code,200);
  const sid=ensured.value.sessionId,messages=[{id:'fixture-user',role:'user',text:'Public user text'},{id:'fixture-reply',role:'assistant',text:'Public reply'}];
  assert.equal((await post('/sessions')).value.items.find(item=>item.sessionId===sid).title,'User title');
  assert.equal((await post('/append',{sessionId:sid,source:'codex:fixture-thread',messages})).value.appendedMessages,2);
  assert.equal((await post('/append',{sessionId:sid,source:'codex:fixture-thread',messages})).value.appendedMessages,0);
  const view=(await post('/snapshot?sessionId='+sid)).value;assert.deepEqual(view.messages.map(m=>m.role),['user','assistant']);
  const session=f.native.sessions.get(sid);f.r.validate(session.header,session.snapshotEvents(),0);
  const before=session.seq;publishSettings(f.configFile,{enabled:false});
  assert.equal((await post('/append',{sessionId:sid,source:'codex:fixture-thread',messages})).value.error,'SYNC_PAUSED');
  assert.equal((await post('/append-steps',{sessionId:sid,steps:[]})).value.error,'OPERATION_SYNC_DISABLED');
  assert.equal(session.seq,before);assert.equal((await post('/status')).value.modelRequests,0);
});
