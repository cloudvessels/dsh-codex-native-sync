import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,write} from './support.mjs';
import {anchor,nativeFixture} from './native-support.mjs';
import {appendOperations} from '../packages/dsh-plugin/src/operation-steps.mjs';
import {OperationOutbox} from '../packages/codex-bridge/operation-sync.mjs';
import {incomingMessages} from '../packages/codex-bridge/text-sync.mjs';
import {loadSettings,publishSettings} from '../packages/dsh-plugin/src/settings.mjs';
import {apply as coreApply} from '../packages/dsh-plugin/src/plugin-core.mjs';
import {atomicJson,readJson} from '../packages/dsh-plugin/src/state.mjs';
import {Client} from './rpc-client.mjs';
import {fileURLToPath} from 'node:url';

const row=p=>JSON.stringify({type:'response_item',payload:p})+'\n';
const call=(id='call-one')=>row({type:'function_call',call_id:id,name:'exec_command',arguments:'{"cmd":"echo safe"}'});
const output=(id='call-one',text='safe')=>row({type:'function_call_output',call_id:id,output:text});
function sourceFixture(t){const f=fixture(t),source=path.join(f.dir,'rollout.jsonl');write(source,JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n');return {...f,source,box:new OperationOutbox(path.join(f.dir,'ops.json'),'thread')};}

test('operation switch is opt-in and independent of automatic updates',t=>{
  const f=fixture(t),file=path.join(f.dir,'config.json');assert.equal(loadSettings(file).syncSteps,false);
  publishSettings(file,{syncSteps:true,autoUpdate:false});assert.equal(loadSettings(file).syncSteps,true);assert.equal(loadSettings(file).autoUpdate,false);
  const first=loadSettings(file).operationEpoch;publishSettings(file,{syncSteps:true,autoUpdate:true});assert.equal(loadSettings(file).operationEpoch,first);
  publishSettings(file,{syncSteps:false});publishSettings(file,{syncSteps:true});assert.notEqual(loadSettings(file).operationEpoch,first);
});
test('a new enable epoch skips disabled history even if the bridge missed the off transition',t=>{
  const f=sourceFixture(t);f.box.scan(f.source,true,'first');fs.appendFileSync(f.source,call('while-off')+output('while-off'));f.box.scan(f.source,true,'second');assert.equal(f.box.data.pending.length,0);
  fs.appendFileSync(f.source,call('current')+output('current'));f.box.scan(f.source,true,'second');assert.deepEqual(f.box.data.pending.map(s=>s.id),['current']);
});
test('a chat born after enabling includes its first fast operation before the first polling scan',t=>{
  const f=sourceFixture(t),enabledSince=Date.now()-1000;
  write(f.source,JSON.stringify({type:'session_meta',payload:{id:'thread',timestamp:new Date().toISOString()}})+'\n'+call('first-fast')+output('first-fast'));
  f.box.scan(f.source,true,'enabled',enabledSince);assert.deepEqual(f.box.data.pending.map(s=>s.id),['first-fast']);
});
test('enabling operations does not backfill old tools; completed new calls survive restart and retry',t=>{
  const f=sourceFixture(t);fs.appendFileSync(f.source,call('old')+output('old'));f.box.scan(f.source,true);assert.equal(f.box.data.pending.length,0);
  fs.appendFileSync(f.source,call());f.box.scan(f.source,true);assert.equal(f.box.data.pending.length,0);
  const reopened=new OperationOutbox(f.box.file,'thread');fs.appendFileSync(f.source,output());reopened.scan(f.source,true);assert.equal(reopened.data.pending.length,1);
  const again=new OperationOutbox(f.box.file,'thread');again.scan(f.source,true);assert.deepEqual(again.data.pending,reopened.data.pending);
  again.forget(new Set(['call-one']));assert.equal(new OperationOutbox(f.box.file,'thread').data.pending.length,0);
});
test('disabled intervals exclude operations, keep completed pending work, and never include reasoning or images',t=>{
  const f=sourceFixture(t);f.box.scan(f.source,true);fs.appendFileSync(f.source,call('enabled')+output('enabled'));f.box.scan(f.source,true);
  f.box.scan(f.source,false);fs.appendFileSync(f.source,call('disabled')+output('disabled'));f.box.scan(f.source,false);f.box.scan(f.source,true);
  fs.appendFileSync(f.source,row({type:'message',role:'assistant',phase:'analysis',content:[{type:'text',text:'private'}]})+call('new')+row({type:'function_call_output',call_id:'new',output:[{type:'image',data:'private-image'},{type:'text',text:'visible result'}]}));f.box.scan(f.source,true);
  assert.deepEqual(f.box.data.pending.map(s=>s.id),['enabled','new']);assert.equal(f.box.data.pending[1].result,'visible result');
});
test('partial rows, disabled partial tails, output limits and wrong thread files are handled safely',t=>{
  const f=sourceFixture(t);f.box.scan(f.source,true);fs.appendFileSync(f.source,call()+output('call-one','x'.repeat(9000)).slice(0,-1));f.box.scan(f.source,true);assert.equal(f.box.data.pending.length,0);
  fs.appendFileSync(f.source,'\n');f.box.scan(f.source,true);assert(f.box.data.pending[0].result.length<2100);
  fs.appendFileSync(f.source,'partial discarded');f.box.scan(f.source,false);f.box.scan(f.source,true);fs.appendFileSync(f.source,' remainder\n'+call('second')+output('second'));f.box.scan(f.source,true);assert.equal(f.box.data.pending.length,2);
  const other=path.join(f.dir,'other.jsonl');write(other,JSON.stringify({type:'session_meta',payload:{id:'other'}})+'\n');assert.throws(()=>f.box.scan(other,true),/SOURCE_MISMATCH/);
});
test('native operation events validate, deduplicate after restore, and do not echo as assistant chat',{skip:!anchor},async t=>{
  const f=await nativeFixture(t),session=f.native.sessions.create('operation-session',{meta:{cwd:f.dir}}),step={id:'call-native',name:'exec_command',arguments:'{"cmd":"echo safe"}',result:'safe',isError:false};
  const batch={source:'codex:thread',steps:[step]};assert.equal(appendOperations(session,batch,f.r.validate).appendedSteps,1);
  f.r.validate(session.header,session.snapshotEvents(),0);assert.equal(appendOperations(session,batch,f.r.validate).appendedSteps,0);
  assert.equal(session.snapshotEvents().filter(e=>e.type==='tool/call').length,1);assert.equal(session.snapshotEvents().filter(e=>e.type==='tool/result').length,1);
  assert.equal(session.snapshotEvents().filter(e=>e.type==='assistant/message').length,1);assert.deepEqual(incomingMessages(f.snapshot(session.id),session.id),[]);
  const before=session.seq;assert.throws(()=>appendOperations(session,{...batch,steps:[{...step,result:'changed'}]},f.r.validate),/ID_CONFLICT/);assert.equal(session.seq,before);
});

test('real Codex rollout operations reach a native DSH session and stop when the switch is off',{skip:!anchor||!process.env.CODEX_TEST_CLI},async t=>{
  const f=await nativeFixture(t),home=path.join(f.dir,'codex-home'),tokenFile=path.join(f.dir,'token'),statusFile=path.join(f.dir,'bridge-status.json');
  write(path.join(home,'config.toml'),'model="gpt-5.1"\nmodel_provider="no_inference"\n[model_providers.no_inference]\nname="Isolated operations"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n');
  atomicJson(f.configFile,{nativeCli:process.env.CODEX_TEST_CLI,bindings:[],dshTokenFile:tokenFile,statusFile,ledgerDir:path.join(f.dir,'ledgers'),codexStateDb:path.join(home,'state_5.sqlite'),discoveryMs:100,reconcileMs:100,forwardMs:100});
  publishSettings(f.configFile,{enabled:true,autoBind:true,syncSteps:true,autoUpdate:false});
  await coreApply(f.ctx,{runtime:f.r,runtimeAnchor:anchor,bridgeConfig:f.configFile,port:0});
  const host=readJson(path.join(path.dirname(f.configFile),'data/dsh/sync-status.json'));
  atomicJson(f.configFile,{...readJson(f.configFile),dshUrl:'http://127.0.0.1:'+host.port});
  const proxy=fileURLToPath(new URL('../packages/codex-bridge/proxy-v3.mjs',import.meta.url));
  const client=new Client(process.execPath,[proxy,'app-server'],{CODEX_HOME:home,DSH_BRIDGE_CONFIG:f.configFile});f.cleanups.push(()=>client.close());await client.initialize();
  const until=async(check)=>{const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('operation sync timed out: '+JSON.stringify(readJson(statusFile,{})));};
  const made=await client.request('thread/start',{cwd:f.dir,historyMode:'paginated',ephemeral:false}),tid=made.thread.id;
  await client.request('thread/inject_items',{threadId:tid,items:[{type:'message',id:'msg_operation_user',role:'user',content:[{type:'input_text',text:'operation acceptance'}]}]});
  let binding;await until(()=>{binding=readJson(f.configFile).bindings.find(b=>b.threadId===tid);return binding&&readJson(binding.ledgerFile+'.operations.json',{}).enabled;});
  const inject=async(id)=>client.request('thread/inject_items',{threadId:tid,items:[{type:'function_call',id:'fc_'+id,call_id:id,name:'exec_command',arguments:'{"cmd":"never execute this historical operation"}'},{type:'function_call_output',call_id:id,output:'historical result'}]});
  await inject('operation-on');
  await until(()=>f.native.sessions.get(binding.sessionId).snapshotEvents().some(e=>e.type==='tool/result'));
  const session=f.native.sessions.get(binding.sessionId);f.r.validate(session.header,session.snapshotEvents(),0);
  assert.equal(session.snapshotEvents().filter(e=>e.type==='tool/result').length,1);
  assert.equal(readJson(statusFile).syncSteps,true);
  const fast=await client.request('thread/start',{cwd:f.dir,historyMode:'paginated',ephemeral:false});
  await client.request('thread/inject_items',{threadId:fast.thread.id,items:[{type:'message',id:'msg_fast_user',role:'user',content:[{type:'input_text',text:'new fast operation'}]},{type:'function_call',id:'fc_first_fast',call_id:'first-fast',name:'exec_command',arguments:'{}'},{type:'function_call_output',call_id:'first-fast',output:'first fast result'}]});
  await until(()=>{const fresh=readJson(f.configFile).bindings.find(b=>b.threadId===fast.thread.id);return fresh&&f.native.sessions.get(fresh.sessionId)?.snapshotEvents().some(e=>e.type==='tool/result');});
  publishSettings(f.configFile,{enabled:true,autoBind:true,syncSteps:false,autoUpdate:false});await until(()=>readJson(binding.ledgerFile+'.operations.json').enabled===false);
  await inject('operation-off');await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(session.snapshotEvents().filter(e=>e.type==='tool/result').length,1);
  assert(!client.calls.includes('turn/start'));assert.equal(readJson(path.join(path.dirname(f.configFile),'data/dsh/sync-status.json')).modelRequests,0);
  const raw=fs.readFileSync(readJson(f.configFile).bindings.find(b=>b.threadId===tid).sourceFile,'utf8');assert(!raw.includes('shared-op-'));
});
