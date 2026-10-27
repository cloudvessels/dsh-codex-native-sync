import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {anchor,nativeFixture} from './native-support.mjs';
import {installDshPackage} from '../installer/dsh-package.mjs';
import {appendToLiveSession} from '../packages/dsh-plugin/src/append-v2.mjs';
import {publishSettings} from '../packages/dsh-plugin/src/settings.mjs';
import {atomicJson,readJson} from '../packages/dsh-plugin/src/state.mjs';
import {Client} from './rpc-client.mjs';
import {write} from './support.mjs';

const compiler=process.env.CSC_TEST_PATH??path.join(process.env.WINDIR??'', 'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const available=process.platform==='win32'&&anchor&&process.env.CODEX_TEST_CLI&&fs.existsSync(compiler);

test('compiled runtime, installed DSH host and MCP complete an isolated native round trip',{skip:!available},async t=>{
  const f=await nativeFixture(t),repo=fileURLToPath(new URL('..',import.meta.url)),home=path.join(f.dir,'codex-home');
  write(path.join(home,'config.toml'),'model="gpt-5.1"\nmodel_provider="no_inference"\n[model_providers.no_inference]\nname="Isolated regression"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[plugins."dsh-chat-sync@dsh-local-sync"]\nenabled=true\n');
  const bridge=path.join(repo,'packages','codex-bridge'),statusFile=path.join(f.dir,'status.json'),tokenFile=path.join(f.dir,'token');
  atomicJson(f.configFile,{nativeCli:process.env.CODEX_TEST_CLI,bindings:[],dshTokenFile:tokenFile,statusFile,
    codexStateDb:path.join(home,'state_5.sqlite'),ledgerDir:path.join(f.dir,'ledgers'),
    discoveryMs:150,reconcileMs:100,forwardMs:100,debounceMs:20});
  const profile=path.join(f.dir,'installed profile');write(path.join(profile,'package.json'),'{"private":true}');
  const installed=installDshPackage({source:path.join(repo,'packages','dsh-plugin'),profile,bridgeConfig:f.configFile});
  atomicJson(path.join(installed.target,'link.config.json'),{bridgeConfig:f.configFile,port:0,legacyThreadId:'',legacySourceFile:''});
  const previous=process.env.DSH_CORE_PACKAGE;process.env.DSH_CORE_PACKAGE=anchor;
  let Host;
  try{Host=(await import(pathToFileURL(path.join(installed.target,'lib/index.js')))).default;}
  finally{if(previous===undefined)delete process.env.DSH_CORE_PACKAGE;else process.env.DSH_CORE_PACKAGE=previous;}
  const parsed=Host.Config['~standard'].validate({bridgeConfig:f.configFile});assert(!parsed.issues);
  const {Service}=await f.r.load('@deepseek-ai/cordis');
  for await(const _ of new Host(f.ctx,parsed.value)[Service.init]()){}
  const state=readJson(path.join(path.dirname(f.configFile),'data/dsh/sync-status.json'));
  const dshUrl='http://127.0.0.1:'+state.port;
  atomicJson(f.configFile,{...readJson(f.configFile),dshUrl});
  publishSettings(f.configFile,{enabled:true,autoBind:true,reverseBind:true});
  await f.ctx.sessionController.create({sessionId:'native-dsh',cwd:f.dir});
  await f.ctx.sessionController.rename({sessionId:'native-dsh',title:'Native DSH title'});
  appendToLiveSession(f.native.sessions.get('native-dsh'),{source:'fixture',messages:[
    {id:'native-user',role:'user',text:'DSH user text'},{id:'native-answer',role:'assistant',text:'DSH reply text'}]},f.r.validate,{preserveIds:true});

  const runtimeDir=path.join(f.dir,'runtime with spaces'),exe=path.join(runtimeDir,'Codex-DSH-Runtime.exe');fs.mkdirSync(runtimeDir);
  const built=spawnSync(compiler,['/nologo','/target:exe','/reference:System.Web.Extensions.dll','/out:'+exe,path.join(bridge,'src/Runtime.cs')],{encoding:'utf8',windowsHide:true});
  assert.equal(built.status,0,built.stdout+built.stderr);
  write(path.join(runtimeDir,'native.path'),process.env.CODEX_TEST_CLI);
  atomicJson(path.join(runtimeDir,'runtime.json'),{node:process.execPath,nativeCli:process.env.CODEX_TEST_CLI,
    proxy:path.join(bridge,'proxy-v3.mjs'),preflight:path.join(bridge,'src/runtime-preflight.mjs'),project:repo,config:f.configFile});
  const client=new Client(exe,['app-server','--analytics-default-enabled'],{CODEX_HOME:home,DSH_BRIDGE_CONFIG:f.configFile});
  f.cleanups.push(()=>client.close());await client.initialize();
  const launch=readJson(path.join(runtimeDir,'last-launch.json'));assert.equal(launch.mode,'bridge');assert.equal(launch.reason,'ready');
  const until=async(check,label)=>{const deadline=Date.now()+12000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out '+label+' '+client.stderr);};
  await until(()=>readJson(statusFile,{bindings:[]}).bindings.some(b=>b.sessionId==='native-dsh'&&b.committedMessages===2),'reverse native history');
  const reverse=readJson(f.configFile).bindings.find(b=>b.sessionId==='native-dsh');
  assert.equal(reverse.title,'Native DSH title');assert(fs.existsSync(reverse.sourceFile));
  const created=await client.request('thread/start',{cwd:f.dir,historyMode:'paginated',ephemeral:false});
  await client.request('thread/inject_items',{threadId:created.thread.id,items:[
    {type:'message',id:'msg_forward_user',role:'user',content:[{type:'input_text',text:'Codex user text'}]},
    {type:'message',id:'msg_forward_answer',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Codex reply text'}]}]});
  await until(()=>f.native.sessions.get('codexhist-'+created.thread.id)?.snapshotEvents().filter(e=>['user/message','assistant/message'].includes(e.type)).length===2,'forward native history');
  const forward=f.native.sessions.get('codexhist-'+created.thread.id);f.r.validate(forward.header,forward.snapshotEvents(),0);
  assert.deepEqual(f.snapshot(forward.id).messages.map(m=>m.text),['Codex user text','Codex reply text']);
  assert(!client.calls.includes('turn/start'));

  const mcpConfig=path.join(f.dir,'mcp-config.json');
  atomicJson(mcpConfig,{threadId:reverse.threadId,sessionId:reverse.sessionId,dshUrl,dshTokenFile:tokenFile,
    pluginPort:0,publicSnapshotFile:path.join(f.dir,'missing-public-snapshot.json'),dshArtifact:path.join(f.dir,'unused-artifact')});
  const mcp=new Client(process.execPath,[path.join(bridge,'src/server.mjs')],{DSH_SYNC_CONFIG:mcpConfig,DSH_SYNC_DATA:path.join(f.dir,'mcp-data')});
  f.cleanups.push(()=>mcp.close());await mcp.request('initialize',{protocolVersion:'2024-11-05'});
  assert((await mcp.request('tools/list')).tools.some(tool=>tool.name==='sync_now'));
  const result=await mcp.request('tools/call',{name:'sync_now',arguments:{}});
  assert.equal(result.isError,false);assert.equal(JSON.parse(result.content[0].text).publicMessages,2);
});
