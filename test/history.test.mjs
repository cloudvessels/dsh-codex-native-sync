import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger,collectDsh,importedDshId,visibleTurn,mergeTurns,pageRows,readInjected,shrinkInjectedIds,MAX_ID} from '../packages/codex-bridge/history.mjs';
import {createPublicCollector} from '../packages/dsh-plugin/src/codex-public-v3.mjs';
import {alignIdleAgent} from '../packages/dsh-plugin/src/agent-turns.mjs';
const user={id:'real-dsh-user',role:'user',text:'来自 DSH 的用户消息',seq:10,time:123456};
const assistant={id:'real-dsh-assistant',role:'assistant',text:'来自 DSH 的回复',seq:11,time:123457};
const view=messages=>({targetSessionId:'ds',sourceThreadId:'cd',agentStatus:'idle',messages});
test('excludes forward imports and refuses unknown import ids',()=>{const source=[{id:'own'}];assert.equal(collectDsh(view([{id:importedDshId('cd','own')},user,assistant]),source,'cd','ds').length,2);assert.throws(()=>collectDsh(view([{...user,id:'shared-chat-unknown'}]),source,'cd','ds'),/UNKNOWN_FORWARD/);assert.throws(()=>collectDsh(view([user]),source,'other','ds'),/BINDING/);});
test('does not collect a running DSH reply',()=>assert.deepEqual(collectDsh({...view([user]),agentStatus:'running'},[],'cd','ds'),[]));
test('expired Windows attachment paths retain the same verified local attachment link',{skip:process.platform!=='win32'},()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-cache-test-')),sourcePath=path.join(root,'source.jsonl'),origin=path.join(root,'cached.png');fs.writeFileSync(origin,Buffer.from('previous attachment bytes'));fs.writeFileSync(sourcePath,JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'message',role:'user',id:'user-with-file',content:[{type:'input_text',text:'# Files mentioned by the user:\n\n## cached.png: '+origin+'\n\n## My request:\n查看附件'}]}})+'\n');const first=createPublicCollector(root,{sourcePath});first.drain();const before=first.snapshot().messages;fs.unlinkSync(origin);const reopened=createPublicCollector(root,{sourcePath});reopened.drain();assert.deepEqual(reopened.snapshot().messages,before);assert.equal(reopened.snapshot().attachments.length,1);});
test('native DSH next-turn reservation advances after external history and refuses active agents',()=>{const agent={status:'idle',phase:{kind:'idle',lastTurn:52},setPhase(p){this.phase=p;}};const events=[{type:'turn/start',data:{turn:59}}];assert.equal(alignIdleAgent(agent,events),59);assert.equal(agent.phase.lastTurn+1,60);agent.phase.kind='maintenance';assert.throws(()=>alignIdleAgent(agent,events),/SAFELY_IDLE/);agent.phase={kind:'idle',lastTurn:61};assert.throws(()=>alignIdleAgent(agent,events),/AHEAD/);});
test('durable identity deduplication and conflicts',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-ledger-test-'));const file=path.join(root,'ledger.json');const l=new Ledger(file,'cd','ds');const messages=collectDsh(view([user,assistant]),[],'cd','ds');const batch=l.stage(messages);l.commit(batch);const reopened=new Ledger(file,'cd','ds');assert.equal(reopened.turns().length,1);assert.equal(reopened.stage(messages),null);assert.throws(()=>reopened.stage([{...messages[0],text:'changed'}]),/CHANGED/);assert.throws(()=>new Ledger(file,'bad','ds'),/BINDING/);});
test('display keeps both roles and independent assistants',()=>{const t=visibleTurn({turnId:'x',acceptedAt:1000,messages:[user,assistant,{...assistant,id:'a2'}]});assert.deepEqual(t.items.map(x=>x.type),['userMessage','agentMessage','agentMessage']);assert.equal(t.status,'completed');});
test('anchor keeps external turn before the next native turn in same second',()=>{const native=[{id:'n1',startedAt:5},{id:'n2',startedAt:5}];const b={turnId:'dsh',anchorTurnId:'n1'};assert.deepEqual(mergeTurns(native,[{id:'dsh',startedAt:5}],'asc',[b]).map(x=>x.id),['n1','dsh','n2']);});
test('pagination has no missing or duplicate rows in either direction',()=>{const rows=Array.from({length:7},(_,i)=>({id:'t'+i}));for(const direction of ['asc','desc']){const ordered=direction==='asc'?rows:[...rows].reverse();let cursor=null,all=[];do{const page=pageRows(ordered,{limit:2,cursor,sortDirection:direction},'scope');all.push(...page.data);cursor=page.nextCursor;}while(cursor);assert.deepEqual(all,ordered);}const p=pageRows(rows,{limit:1},'x');assert.throws(()=>pageRows(rows,{cursor:p.nextCursor},'y'),/SCOPE/);});
test('Codex forward collector excludes reverse receipts including fragmented source writes',()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-loop-test-')),sourcePath=path.join(root,'source.jsonl');fs.writeFileSync(sourcePath,'');const collector=createPublicCollector(root,{sourcePath});const row=id=>JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',id,content:[{type:'output_text',text:'公开回复'}]}});fs.appendFileSync(sourcePath,row('msg_dshlink_'+'a'.repeat(64))+'\n'+row('msg_normal'));collector.drain();assert.equal(collector.snapshot().messages.length,0);fs.appendFileSync(sourcePath,'\n');collector.drain();assert.deepEqual(collector.snapshot().messages.map(x=>x.id),['msg_normal']);});

test('large rollout scan preserves receipts before and after the old tail boundary',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-tail-'));
  const file=path.join(root,'rollout.jsonl');
  const filler='{"type":"event_msg","payload":{}}\n';
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const row=(id,text)=>JSON.stringify({type:'response_item',payload:{type:'message',id,role:'assistant',content:[{type:'output_text',text}]}})+'\n';
  fs.writeFileSync(file,row('old-receipt','head-hit'));
  fs.appendFileSync(file,filler.repeat(Math.ceil((33*1024*1024)/filler.length)));
  const id='msg_dshlink_'+'a'.repeat(MAX_ID-'msg_dshlink_'.length);
  fs.appendFileSync(file,JSON.stringify({type:'response_item',payload:{type:'message',id,role:'assistant',content:[{type:'output_text',text:'tail-hit'}]}})+'\n');
  const found=await readInjected(file,new Set([id,'old-receipt']));
  assert.equal(found.get('old-receipt').text,'head-hit');
  assert.equal(found.get(id)?.text??found.get(id),'tail-hit');
});

test('oversized rollout is skipped without truncating ledger ids first',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-huge-'));
  const longId='msg_'+'b'.repeat(MAX_ID+12);
  const ledgerFile=path.join(root,'ledger.json');
  fs.writeFileSync(ledgerFile,JSON.stringify({batches:[{messages:[{id:longId,role:'assistant',text:'x'}]}]}));
  const rolloutFile=path.join(root,'rollout.jsonl');
  fs.writeFileSync(rolloutFile,'');
  fs.truncateSync(rolloutFile,65*1024*1024);
  const result=shrinkInjectedIds(rolloutFile,ledgerFile);
  assert.equal(result.skipped,'ROLLOUT_TOO_LARGE');
  const after=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));
  assert.equal(after.batches[0].messages[0].id,longId,'ledger must keep original id when rollout cannot be rewritten');
});

test('receipt scan ignores partial UTF-8 tail and rejects conflicting receipts across large histories',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-scan-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'rollout.jsonl'),row=text=>JSON.stringify({type:'response_item',payload:{type:'message',id:'receipt',role:'assistant',content:[{text}]}});
 fs.writeFileSync(file,row('保留原文')+'\n'+row('未完成'));
 assert.equal((await readInjected(file,new Set(['receipt']))).get('receipt').text,'保留原文');
 fs.appendFileSync(file,'\n');await assert.rejects(readInjected(file,new Set(['receipt'])),/ROLL_OUT_ID_CONFLICT/);
 fs.writeFileSync(file,' '.repeat(33*1024*1024)+'\n');
 await assert.rejects(readInjected(file,new Set(['receipt'])),/INJECTION_SCAN_RECORD_TOO_LARGE/);
});
