import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TextOutbox, incomingMessages, persistBinding} from '../packages/codex-bridge/text-sync.mjs';
import {Ledger, responseItem} from '../packages/codex-bridge/history.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'dsh-text-regression-'));
const row=p=>JSON.stringify({type:'response_item',payload:p})+'\n';
test('public text outbox excludes operations, analysis, runtime messages, and injected echoes',()=>{
 const dir=temp(),source=path.join(dir,'rollout.jsonl');
 fs.writeFileSync(source,row({type:'message',id:'u',role:'user',content:[{type:'input_text',text:'user'}]})+
 row({type:'message',id:'a',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'answer'}]})+
 row({type:'message',id:'private',role:'assistant',phase:'analysis',content:[{type:'output_text',text:'private'}]})+
 row({type:'function_call',id:'tool',name:'exec_command',arguments:'secret operation'})+
 row(responseItem({id:'msg_dshlink_'+ 'a'.repeat(52),role:'user',text:'do not echo'}))+
 row({type:'message',id:'runtime',role:'user',content:[{type:'input_text',text:'<environment_context>runtime</environment_context>'}]}));
 const box=new TextOutbox(path.join(dir,'outbox.json'),'thread');box.scan(source);
 assert.deepEqual(box.data.pending.map(m=>m.id),['u','a']);
 box.forget(new Set(['u']));const loaded=new TextOutbox(box.file,'thread');loaded.scan(source);
 assert.deepEqual(loaded.data.pending.map(m=>m.id),['a']);
});
test('an incomplete trailing record is picked up once, after its newline arrives',()=>{
 const dir=temp(),source=path.join(dir,'source.jsonl');const body=row({type:'message',id:'next',role:'user',content:[{type:'input_text',text:'complete later'}]});
 fs.writeFileSync(source,body.slice(0,-1));const box=new TextOutbox(path.join(dir,'outbox.json'),'t');box.scan(source);
 assert.equal(box.data.pending.length,0);assert.equal(box.data.offset,0);
 fs.appendFileSync(source,'\n');box.scan(source);box.scan(source);assert.equal(box.data.pending.length,1);
});
test('a source that shrinks is stopped instead of silently replayed',()=>{
 const dir=temp(),source=path.join(dir,'source.jsonl');fs.writeFileSync(source,row({type:'message',id:'u',role:'user',content:[{type:'input_text',text:'hello'}]}));
 const box=new TextOutbox(path.join(dir,'outbox.json'),'t');box.scan(source);fs.writeFileSync(source,'');assert.throws(()=>box.scan(source),/SOURCE_TRUNCATED/);
});
test('automatic binding survives reload and refuses reassignment or two threads sharing one session',()=>{
 const dir=temp(),file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify({bindings:[]}));
 const binding={threadId:'t',sessionId:'s',rolloutPath:'test-path',ledger:new Ledger(path.join(dir,'ledger.json'),'t','s')};
 persistBinding(file,binding);persistBinding(file,binding);assert.equal(JSON.parse(fs.readFileSync(file)).bindings.length,1);
 assert.throws(()=>persistBinding(file,{...binding,sessionId:'other'}),/BINDING_CONFLICT/);
 assert.throws(()=>persistBinding(file,{...binding,threadId:'other'}),/SESSION_ALREADY_BOUND/);
});
test('reverse text filter does not return tool-bearing, fallback-operation, or imported messages',()=>{
 const view={targetSessionId:'s',messages:[{id:'native',role:'assistant',text:'public',contentTypes:['text']},{id:'shared-chat-x',role:'assistant',text:'⏺ shell output'},{id:'tool',role:'assistant',text:'x',contentTypes:['tool-call']}]};
 const result=incomingMessages(view,'s');assert.equal(result.length,1);assert(result[0].id.length<=64);assert.throws(()=>incomingMessages(view,'wrong'),/DSH_BINDING_MISMATCH/);
});
