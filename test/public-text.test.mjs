import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publicTextMessage} from '../packages/dsh-plugin/src/public-text.mjs';
import {incomingMessages} from '../packages/codex-bridge/text-sync.mjs';
import {collectDsh, Ledger} from '../packages/codex-bridge/history.mjs';

test('mixed DSH image and tool messages retain public text through both bridge collectors', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-public-projection-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const original=[
    {id:'question',role:'user',content:[{type:'image',url:'private-image'},{type:'text',text:'What are these workspaces?'}]},
    {id:'progress',role:'assistant',content:[{type:'reasoning',text:'private reasoning'},{type:'text',text:'I found the cause.'},{type:'tool-call',arguments:'private arguments'}]},
    {id:'answer',role:'assistant',content:[{type:'text',text:'Public answer'}]},
    {id:'image-only',role:'user',content:[{type:'image',url:'private-image'}]},
    {id:'tool-only',role:'assistant',content:[{type:'reasoning',text:'private reasoning'},{type:'tool-call',arguments:'private arguments'}]},
  ];
  const messages=original.map((message,seq)=>publicTextMessage(message,{seq,time:1234+seq}));
  const view={targetSessionId:'s',sourceThreadId:'t',agentStatus:'idle',messages};
  const current=incomingMessages(view,'s'),legacy=collectDsh(view,[],'t','s');
  assert.deepEqual(current.map(m=>m.text),['What are these workspaces?','I found the cause.','Public answer']);
  assert.deepEqual(legacy,current);
  assert.deepEqual(messages[0].sourceContentTypes,['image','text']);
  assert.deepEqual(messages[1].sourceContentTypes,['reasoning','text','tool-call']);
  assert(!JSON.stringify(messages).includes('private-'));assert(!JSON.stringify(messages).includes('private reasoning'));assert(!JSON.stringify(messages).includes('private arguments'));
  const ledger=new Ledger(path.join(dir,'ledger.json'),'t','s');
  ledger.stage(current);for(const batch of ledger.data.batches.filter(b=>b.state==='pending'))ledger.commit(batch);
  assert.equal(ledger.stage(current),null);
  assert.equal(ledger.committed().flatMap(b=>b.messages).length,3);
  assert(current.every(m=>m.id.length<=64));
  assert(!JSON.stringify(original).includes('sourceContentTypes'));
});
