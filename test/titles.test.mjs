import test from 'node:test';
import assert from 'node:assert/strict';
import {syncBoundTitles} from '../packages/dsh-plugin/src/title-sync.mjs';
test('native string projection is idempotent and later source rename follows once',async()=>{
  let current='Same',calls=0;const ctx={sessionPersistence:{async flush(){}},sessionController:{
    async list(){return {items:[{sessionId:'s',projections:{values:{title:current}}}]};},
    async rename({title}){calls++;current=title;return {title};}}};
  const bindings=new Map([['t','s']]),rows=[{id:'t',title:'Same'}];
  await syncBoundTitles(ctx,bindings,rows);await syncBoundTitles(ctx,bindings,rows);assert.equal(calls,0);
  rows[0].title='New';await syncBoundTitles(ctx,bindings,rows);await syncBoundTitles(ctx,bindings,rows);assert.equal(calls,1);
});
test('truncation is reported truthfully and does not cause endless rename events',async()=>{
  let current='old',calls=0;const ctx={sessionPersistence:{async flush(){}},sessionController:{
    async list(){return {items:[{sessionId:'s',projections:{values:{title:current}}}]};},
    async rename({title}){calls++;current=title.slice(0,4);return {title:current};}}};
  const bindings=new Map([['t','s']]),rows=[{id:'t',title:'A long Codex title'}],receipts=new Map();
  assert.equal((await syncBoundTitles(ctx,bindings,rows,false,receipts)).errors.length,1);
  assert.equal((await syncBoundTitles(ctx,bindings,rows,false,receipts)).errors.length,1);assert.equal(calls,1);
});
