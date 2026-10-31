import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,write} from './support.mjs';
import {Client} from './rpc-client.mjs';
import {TurnCache} from '../packages/codex-bridge/turn-cache.mjs';

test('history cache coalesces concurrent reads and invalidates in-flight or failed loads',async()=>{
 let now=0,count=0,finish;const cache=new TurnCache({now:()=>now});
 const first=cache.get('a',()=>{count++;return new Promise(resolve=>{finish=resolve;});});
 const second=cache.get('a',()=>{throw Error('duplicate load');});await Promise.resolve();
 assert.equal(count,1);cache.invalidate('a');
 assert.deepEqual(await cache.get('a',async()=>['new']),['new']);finish(['old']);assert.deepEqual(await first,['old']);await second;
 assert.deepEqual(await cache.get('a',async()=>['wrong']),['new']);now=2001;
 assert.deepEqual(await cache.get('a',async()=>['expired']),['expired']);
 await assert.rejects(cache.get('b',async()=>{throw Error('failed');}),/failed/);
 assert.deepEqual(await cache.get('b',async()=>['retry']),['retry']);
});

test('unused cached histories are released after the TTL without another request',async()=>{
 const cache=new TurnCache({ttl:5});
 await cache.get('idle',async()=>['retained history']);
 assert.equal(cache.entries.size,1);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(cache.entries.size,0);
});

test('held history requests do not block desktop authentication IDs and share one native read',async t=>{
 const f=fixture(t),configFile=path.join(f.dir,'bridge.json');
 write(path.join(f.dir,'app-server'),`const rl=require('node:readline').createInterface({input:process.stdin});let held=[],reads=0;
 const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
 rl.on('line',line=>{const x=JSON.parse(line);if(x.id==null)return;
 if(x.method==='initialize')return send({id:x.id,result:{}});
 if(x.method==='thread/turns/list'){reads++;held.push(x);return;}
 if(x.method==='test/release'){for(const h of held)send({id:h.id,result:{data:[{id:'native',items:[],startedAt:1,status:'completed'}],nextCursor:null}});held=[];return send({id:x.id,result:{reads}});}
 send({id:x.id,result:{account:'fixture',echoId:x.id}});
 });`);
 write(path.join(f.dir,'ledger.json'),JSON.stringify({version:1,threadId:'thread',sessionId:'session',batches:[{state:'committed',turnId:'external',acceptedAt:1,messages:[]}]}));
 write(configFile,JSON.stringify({nativeCli:process.execPath,bindings:[{threadId:'thread',sessionId:'session',ledgerFile:path.join(f.dir,'ledger.json')}],enabled:false,statusFile:path.join(f.dir,'status.json'),watchDir:f.dir}));
 const proxy=fileURLToPath(new URL('../packages/codex-bridge/proxy-v3.mjs',import.meta.url));
 const client=new Client(process.execPath,[proxy,'app-server'],{DSH_BRIDGE_CONFIG:configFile,DSH_BRIDGE_BOOTSTRAP_ONLY:'1'},{cwd:f.dir});f.cleanups.push(()=>client.close());await client.initialize();
 let settled=false;const history=client.request('thread/turns/list',{threadId:'thread',itemsView:'full'}).then(value=>{settled=true;return value;});
 const another=client.request('thread/turns/list',{threadId:'thread',itemsView:'full'});
 const auth=await client.request('getAuthStatus',{},'desktop-auth:fixture');
 assert.equal(auth.echoId,'desktop-auth:fixture');assert.equal(settled,false);
 // Wait for the test native process to receive the asynchronous history request.
 let released;for(let i=0;i<10;i++){released=await client.request('test/release');if(released.reads)break;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal(released.reads,1);assert.equal((await history).data.length,2);assert.deepEqual(await another,await history);
});
test('actual proxy decorates timeline reads while preserving opaque native cursors',async t=>{
 const f=fixture(t),configFile=path.join(f.dir,'bridge.json');
 write(path.join(f.dir,'app-server'),`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.id==null)return;let result={};if(x.method==='thread/turns/list')result={data:[{id:'native',items:[],status:'completed'}],nextCursor:null};if(x.method==='thread/items/list')result={data:[],nextCursor:null,backwardsCursor:null};if(x.method==='thread/timeline/list')result={data:[{type:'turnCompleted',turnId:'native',position:20,status:'completed'}],nextCursor:'opaque-native',activeRealtimeSessionAtPageStart:null};process.stdout.write(JSON.stringify({id:x.id,result})+'\\n');});`);
 write(path.join(f.dir,'ledger.json'),JSON.stringify({version:1,threadId:'thread',sessionId:'session',batches:[{state:'committed',turnId:'external',anchorTurnId:'native',acceptedAt:1000,messages:[{id:'message',role:'assistant',text:'from DSH'}]}]}));
 write(configFile,JSON.stringify({nativeCli:process.execPath,bindings:[{threadId:'thread',sessionId:'session',ledgerFile:path.join(f.dir,'ledger.json')}],enabled:false,statusFile:path.join(f.dir,'status.json'),watchDir:f.dir}));
 const proxy=fileURLToPath(new URL('../packages/codex-bridge/proxy-v3.mjs',import.meta.url));
 const client=new Client(process.execPath,[proxy,'app-server'],{DSH_BRIDGE_CONFIG:configFile,DSH_BRIDGE_BOOTSTRAP_ONLY:'1'},{cwd:f.dir});f.cleanups.push(()=>client.close());await client.initialize();
 const result=await client.request('thread/timeline/list',{threadId:'thread',cursor:'opaque-before'});
 assert.equal(result.nextCursor,'opaque-native');assert.equal(result.data.find(e=>e.type==='item').item.text,'from DSH');
 assert.equal((await client.request('thread/timeline/list',{threadId:'unbound'})).data.length,1);
 const resumedItems=await client.request('thread/items/list',{threadId:'thread',turnId:'external',cursor:'native-resume-snapshot',sortDirection:'desc',limit:1});
 assert.equal(resumedItems.data.length,1,'native resume cursor must not empty a synthetic turn');
 assert.equal(resumedItems.data[0].item.text,'from DSH');
});
