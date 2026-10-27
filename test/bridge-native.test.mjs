import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,write} from './support.mjs';
import {Client} from './rpc-client.mjs';
import {hash,Ledger} from '../packages/codex-bridge/history.mjs';
import {publishSettings} from '../packages/dsh-plugin/src/settings.mjs';
import {atomicJson,readJson,assertBridgeOffline} from '../packages/dsh-plugin/src/state.mjs';

test('published proxy passes native bidirectional, pause and migrated restart checks without inference',{skip:!process.env.CODEX_TEST_CLI},async t=>{
  const f=fixture(t),home=path.join(f.dir,'isolated-codex-home');
  write(path.join(home,'config.toml'),'model="gpt-5.1"\nmodel_provider="no_inference"\n[model_providers.no_inference]\nname="Isolated regression"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n');
  const sessions=new Map([['dsh-native',{sessionId:'dsh-native',title:'DSH native',cwd:f.dir,messages:[
    {id:'native-u',role:'user',text:'DSH user text',contentTypes:['text']},{id:'native-a',role:'assistant',text:'DSH reply text',contentTypes:['text']}]}]]);
  const registered=new Map(),routes=[];
  const server=http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');try{
    assert.equal(req.headers.authorization,'Bearer fixture-token');let text='';for await(const bytes of req)text+=bytes;
    const body=JSON.parse(text||'{}'),url=new URL(req.url,'http://localhost');routes.push(url.pathname);let result;
    if(url.pathname==='/sessions')result={items:[...sessions.values()].map(row=>({...row,blank:false,running:false}))};
    else if(url.pathname==='/snapshot'){const row=sessions.get(url.searchParams.get('sessionId'));assert(row);result={targetSessionId:row.sessionId,agentStatus:'idle',messages:row.messages};}
    else if(url.pathname==='/register'){registered.set(body.threadId,body.sessionId);result=body;}
    else if(url.pathname==='/ensure'){const sid=registered.get(body.threadId)??'codexhist-'+body.threadId;registered.set(body.threadId,sid);
      if(!sessions.has(sid))sessions.set(sid,{sessionId:sid,title:body.title,cwd:body.cwd,messages:[]});result={sessionId:sid};}
    else if(url.pathname==='/append'){const row=sessions.get(body.sessionId);for(const message of body.messages){const id='shared-chat-'+hash(body.source+'\0'+message.id);if(!row.messages.some(m=>m.id===id))row.messages.push({...message,id});}result={ok:true};}
    else throw Error('Unexpected route '+url.pathname);
    res.end(JSON.stringify(result));
  }catch(error){res.statusCode=409;res.end(JSON.stringify({error:error.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.cleanups.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const configFile=path.join(f.dir,'bridge.json'),statusFile=path.join(f.dir,'status.json');write(path.join(f.dir,'token'),'fixture-token');
  atomicJson(configFile,{nativeCli:process.env.CODEX_TEST_CLI,bindings:[],dshUrl:'http://127.0.0.1:'+server.address().port,dshTokenFile:path.join(f.dir,'token'),statusFile,
    codexStateDb:path.join(home,'state_5.sqlite'),ledgerDir:path.join(f.dir,'ledgers'),autoBind:true,reverseBind:true,archiveMirror:false,
    discoveryMs:150,reconcileMs:100,forwardMs:100,debounceMs:20});
  const proxy=fileURLToPath(new URL('../packages/codex-bridge/proxy-v3.mjs',import.meta.url));let client;
  f.cleanups.push(async()=>{await client?.close();});
  const start=async()=>{const c=new Client(process.execPath,[proxy,'app-server'],{CODEX_HOME:home,DSH_BRIDGE_CONFIG:configFile});await c.initialize();return c;};
  const until=async(check,label)=>{const deadline=Date.now()+12000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out '+label+' '+client?.stderr);};
  client=await start();
  await until(()=>readJson(statusFile,{bindings:[]}).bindings.some(b=>b.sessionId==='dsh-native'&&b.committedMessages===2),'native reverse bootstrap');
  const original=readJson(configFile).bindings.find(b=>b.sessionId==='dsh-native');assert(original.sourceFile&&fs.existsSync(original.sourceFile));
  assert.throws(()=>assertBridgeOffline(configFile),/CODEX_BRIDGE_MUST_BE_STOPPED/);
  const made=await client.request('thread/start',{cwd:f.dir,historyMode:'paginated',ephemeral:false});
  await client.request('thread/inject_items',{threadId:made.thread.id,items:[{type:'message',id:'msg_local_user',role:'user',content:[{type:'input_text',text:'Codex public text'}]},
    {type:'message',id:'msg_local_reply',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Codex public reply'}]}]});
  await until(()=>registered.has(made.thread.id)&&sessions.get(registered.get(made.thread.id)).messages.length===2,'native forward text');
  publishSettings(configFile,{enabled:false});sessions.get('dsh-native').messages.push({id:'native-later',role:'user',text:'Catch up after pause',contentTypes:['text']});
  await new Promise(resolve=>setTimeout(resolve,350));assert.equal(new Ledger(original.ledgerFile,original.threadId,'dsh-native').data.batches.flatMap(b=>b.messages).length,2);
  publishSettings(configFile,{enabled:true,autoBind:true,reverseBind:true});
  await until(()=>readJson(statusFile,{bindings:[]}).bindings.find(b=>b.threadId===original.threadId)?.committedMessages===3,'hot resume');
  assert(!routes.includes('/append-steps'));assert(!routes.includes('/claim'));assert(!client.calls.includes('turn/start'));
  await client.close();client=null;assertBridgeOffline(configFile);
  // Simulate the already-tested native rehome transaction's resulting files.
  const config=readJson(configFile),row=config.bindings.find(b=>b.threadId===original.threadId),newSid='dsh-moved',newLedger=row.ledgerFile+'.moved.json';
  atomicJson(newLedger,{...readJson(row.ledgerFile),sessionId:newSid});row.identitySessionId='dsh-native';row.sessionId=newSid;row.ledgerFile=newLedger;atomicJson(configFile,config);
  sessions.get('dsh-native').archived=true;sessions.set(newSid,{...sessions.get('dsh-native'),sessionId:newSid,archived:false});
  const before=fs.readFileSync(original.sourceFile,'utf8');client=await start();
  await until(()=>readJson(statusFile,{bindings:[]}).bindings.some(b=>b.sessionId===newSid&&b.lastSyncAt),'migrated restart');
  const after=fs.readFileSync(original.sourceFile,'utf8');
  const receipts=text=>text.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='response_item'&&String(row.payload?.id??'').startsWith('msg_dshlink_')).map(row=>row.payload.id);
  assert.deepEqual(receipts(after),receipts(before));assert.equal(receipts(after).length,3);assert(!client.calls.includes('turn/start'));
});
