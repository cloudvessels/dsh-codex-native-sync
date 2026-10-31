import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeTimelinePage,visibleTurn} from '../packages/codex-bridge/history.mjs';
const batch=(id,anchorTurnId)=>({turnId:id,anchorTurnId,acceptedAt:10000,messages:[{id:'msg_'+id,role:'assistant',text:'DSH '+id}]});
const end=(turnId,position)=>({type:'turnCompleted',position,turnId,status:'completed',error:null,startedAt:1,completedAt:2,durationMs:0});
test('timeline overlays appear exactly once across native page boundaries, keeping native cursors and realtime rows',()=>{
 const batches=[batch('a','n1'),batch('b','n1'),batch('c','n2')],native=new Set(['n1','n2']);
 const older={data:[{type:'turnStarted',position:0,turnId:'n1'},end('n1',10)],nextCursor:null,activeRealtimeSessionAtPageStart:null};
 const newer={data:[{type:'realtime',position:11,sessionId:'voice'},end('n2',20)],nextCursor:'native-opaque',activeRealtimeSessionAtPageStart:'voice'};
 const p1=mergeTimelinePage(older,batches,native),p2=mergeTimelinePage(newer,batches,native);
 assert.equal(p2.nextCursor,'native-opaque');assert.equal(p2.activeRealtimeSessionAtPageStart,'voice');assert.equal(p2.data[0],newer.data[0]);
 assert.deepEqual([...p1.data,...p2.data].filter(e=>e.type==='item').map(e=>e.item.id),['msg_a','msg_b','msg_c']);
 assert.deepEqual(p1.data.filter(e=>e.type==='turnCompleted').map(e=>e.turnId),['n1','a','b']);
 assert.equal(visibleTurn(batches[0]).rootTurnId,'a');
 assert.deepEqual(mergeTimelinePage(older,batches,native),p1,'re-reading never mutates native rows or batches');
});
test('unanchored and missing-anchor history is emitted only on the oldest page; existing native items are not echoed',()=>{
 const batches=[batch('a',null),batch('b','removed'),batch('c','n1')],native=new Set(['n1']);
 assert.deepEqual(mergeTimelinePage({data:[],nextCursor:'older'},batches,native).data,[]);
 const oldest=mergeTimelinePage({data:[end('n1',1)],nextCursor:null},batches,native);
 assert.deepEqual(oldest.data.filter(e=>e.type==='item').map(e=>e.item.id),['msg_a','msg_b','msg_c']);
 const existing={data:[{type:'item',position:0,turnId:'n1',item:{id:'msg_c'}},end('n1',1)],nextCursor:null};
 assert.equal(mergeTimelinePage(existing,[batches[2]],native).data.filter(e=>e.type==='item').length,1);
});
test('interrupted anchors with no completion marker attach after their final native item, not after partial pages',()=>{
 const batches=[batch('a','interrupted')],ids=new Set(['interrupted']),ends=new Map([['interrupted','last']]);
 const early={data:[{type:'item',position:1,turnId:'interrupted',item:{id:'first'}}],nextCursor:null};
 assert.equal(mergeTimelinePage(early,batches,ids,ends).data.length,1);
 const last={data:[{type:'item',position:2,turnId:'interrupted',item:{id:'last'}}],nextCursor:'older'};
 assert.deepEqual(mergeTimelinePage(last,batches,ids,ends).data.filter(e=>e.type==='item').map(e=>e.item.id),['last','msg_a']);
});
