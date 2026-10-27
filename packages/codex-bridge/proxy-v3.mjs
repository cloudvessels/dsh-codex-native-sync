import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Ledger, atomicJson, readJson, responseItem, notifications, mergeTurns, pageRows, readInjected, PREFIX, hash, codexId} from './history.mjs';
import {REVISION, incomingMessages, persistBinding, TextOutbox} from './text-sync.mjs';
import {loadSettings} from '../dsh-plugin/src/settings.mjs';
import {registerBridgeOwner} from '../dsh-plugin/src/state.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const configFile = process.env.DSH_BRIDGE_CONFIG ?? path.join(root, 'config-v3.json');
const args = process.argv.slice(2);
const serverMode = args.includes('app-server') && !args.some(x => ['generate-ts', 'generate-json-schema', 'daemon', 'proxy', '--help'].includes(x));
if(serverMode){const release=registerBridgeOwner(configFile);process.once('exit',release);}
const config = readJson(configFile);
if (!config?.nativeCli || !Array.isArray(config.bindings)) throw Error('INVALID_BRIDGE_CONFIG');

// Never rewrite a live rollout on startup. The preflight refuses legacy oversized IDs.

const child = spawn(config.nativeCli, args, {env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
child.stderr.pipe(process.stderr);

if (!serverMode) {
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.on('exit', code => process.exit(code ?? 1));
} else {
    const imported = new Map(); // dsh message id -> {role,text} for already-synced forward imports
  const states = config.bindings.map(b => ({
    threadId: b.threadId,
    sessionId: b.sessionId,
    identitySessionId: b.identitySessionId ?? b.sessionId,
    title: b.title ?? '',
    ledger: new Ledger(b.ledgerFile, b.threadId, b.sessionId),
    rolloutPath: b.sourceFile,
    loaded: false,
    active: false,
    uncertain: false,
    delivered: 0,
    lastError: null,
    lastSyncAt: null,
    origin: b.origin ?? 'codex',
    registered: b.registered !== false,
    archived: !!b.archived,
    lastPushError: null,
  }));
  const byThread = new Map(states.map(s => [s.threadId, s]));
  const bootstrapOnly=process.env.DSH_BRIDGE_BOOTSTRAP_ONLY==='1';
  const initialThreads=new Set(byThread.keys());
  const settings = () => loadSettings(configFile, config);
  const syncEnabled = () => settings().enabled && !(config.pluginControlFile && readJson(config.pluginControlFile, {enabled:true}).enabled === false);
  const registering = new Map();
  const reverseJobsFile = path.join(path.dirname(config.statusFile), 'reverse-jobs.json');
  const reverseJobs = readJson(reverseJobsFile, {});

  async function dsh(route, body = {}) {
    const token = fs.readFileSync(config.dshTokenFile, 'utf8').trim();
    const response = await fetch(config.dshUrl + route, {method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)});
    const value = await response.json();
    if (!response.ok) throw Error(value.error ?? 'DSH_HTTP_' + response.status);
    return value;
  }

  // Codex chats get their own DSH mirror; unrelated chats are never implicitly claimed.
  async function autoRegister(thread) {
    const tid=thread?.id;
    if(bootstrapOnly||!tid||!syncEnabled()||!settings().autoBind||thread.ephemeral||typeof thread.source==='object')return;
    if(byThread.has(tid))return;
    if(registering.has(tid))return registering.get(tid);
    const operation=(async()=>{
      try {
        const result=await dsh('/ensure',{threadId:tid,cwd:thread.cwd,title:thread.name??thread.title});
        const ledgerDir=config.ledgerDir??path.join(root,'data','ledgers');
        const binding={threadId:tid,sessionId:result.sessionId,title:thread.name??thread.title??'',
          ledger:new Ledger(path.join(ledgerDir,tid+'.json'),tid,result.sessionId),
          rolloutPath:thread.path,loaded:true,active:thread.status?.type==='active',uncertain:false,
          delivered:0,lastError:null,lastPushError:null,lastSyncAt:null,origin:'codex',archived:false};
        persistBinding(configFile,binding);states.push(binding);byThread.set(tid,binding);
        debug({state:'auto-bound',threadId:tid,sessionId:binding.sessionId});save();
      }catch(error){discoveryError=error.message;save();}
    })();
    registering.set(tid,operation);
    try{return await operation;}finally{registering.delete(tid);}
  }

  // The database is read-only. An archive hides the mirror without deleting history.
  let lastSweep=0,discoveryError=null;
  async function sweepArchive() {
    if(bootstrapOnly||!config.codexStateDb||Date.now()-lastSweep<(config.discoveryMs??60000))return;
    lastSweep=Date.now();
    let rows;
    try {
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync(config.codexStateDb,{readOnly:true});
      try { rows=db.prepare('select id,archived,rollout_path,cwd,coalesce(name,title) as title,source from threads').all(); }
      finally { db.close(); }
    }catch(error){discoveryError='CODEX_DISCOVERY: '+error.message;save();return;}
    discoveryError=null;
    for(const row of rows){
      if(!syncEnabled())return;
      const b=byThread.get(row.id);
      if(!b){
        if(!row.archived&&settings().autoBind&&['cli','vscode','app-server','desktop'].includes(row.source)&&row.rollout_path&&fs.existsSync(row.rollout_path))
          await autoRegister({id:row.id,path:row.rollout_path,cwd:row.cwd,title:row.title,source:row.source});
        continue;
      }
      if(row.rollout_path && row.rollout_path !== b.rolloutPath && fs.existsSync(row.rollout_path)) {
        b.rolloutPath=row.rollout_path;persistBinding(configFile,b);
      }
      if(!settings().archiveMirror||!!row.archived===!!b.archived)continue;
      try {
        await dsh(row.archived?'/archive':'/unarchive',{sessionId:b.sessionId});
        b.archived=!!row.archived;persistBinding(configFile,b);save();
      }catch(error){b.lastError='ARCHIVE: '+error.message;save();}
    }
  }

  const pending = new Map();
  const desktopPending = new Map();
  let serial = 0, initialized = false, closed = false, chain = Promise.resolve(), timer, watcher;
  const debugFile = path.join(root, 'data', 'bridge-v2-debug.log');
  const debug = entry => { try { if (fs.existsSync(debugFile) && fs.statSync(debugFile).size > 4 * 1024 * 1024) fs.truncateSync(debugFile, 0); fs.appendFileSync(debugFile, new Date().toISOString() + ' ' + JSON.stringify(entry) + '\n'); } catch {} };
  const output = x => process.stdout.write(JSON.stringify(x) + '\n');

  const state = () => ({
    version: 3,
    bridgeRevision: REVISION,
    runtimeVersion: "0.2.0",
    recordedAt: new Date().toISOString(),
    syncSteps: false,
    settings: settings(),
    discoveryError,
    pid: process.pid,
    backendPid: child.pid,
    initialized,
    bindings: states.map(s => ({
      threadId: s.threadId,
      sessionId: s.sessionId,
      title: s.title,
      origin: s.origin,
      archived: !!s.archived,
      lastPushError: s.lastPushError,
      loaded: s.loaded,
      active: s.active,
      committedMessages: s.ledger.committed().reduce((n, b) => n + b.messages.length, 0),
      pendingMessages: s.ledger.data.batches.filter(b => b.state !== 'committed').reduce((n, b) => n + b.messages.length, 0),
      deliveredThisProcess: s.delivered,
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
    })),
  });
  const save = () => atomicJson(process.env.DSH_BRIDGE_STATUS_FILE ?? config.statusFile, state());

  function request(method, params = {}) {
    if(['turn/start','turn/addUserMessage','turn/steer','review/start'].includes(method))return Promise.reject(Error('SYNC_CANNOT_START_MODEL_GENERATION'));
    if (closed) return Promise.reject(Error('BACKEND_CLOSED'));
    const id = 'dshbridge-internal-' + process.pid + '-' + (++serial);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(Error('OUTCOME_UNKNOWN: ' + method)); }, 20000);
      pending.set(id, {resolve, reject, timeout});
      child.stdin.write(JSON.stringify({id, method, params}) + '\n');
    });
  }

  async function allNativeTurns(binding) {
    let rows = [], cursor = null;
    do {
      const p = await request('thread/turns/list', {threadId: binding.threadId, limit: 100, sortDirection: 'asc', itemsView: 'full', ...(cursor ? {cursor} : {})});
      rows.push(...p.data);
      if (p.nextCursor === cursor && cursor) throw Error('NATIVE_CURSOR_STALLED');
      cursor = p.nextCursor;
      if (rows.length > 20000) throw Error('HISTORY_TOO_LARGE');
    } while (cursor);
    return rows;
  }

  async function decorateRequest(x) {
    const p = x.params ?? {};
    const binding = byThread.get(p.threadId);
    if (!binding) return false;
    const committed = binding.ledger.committed();
    if (!committed.length) return false;
    if (['thread/turns/list', 'thread/items/list', 'thread/items/read'].includes(x.method)) {
      const externalIds = new Set(binding.ledger.turns().map(t => t.id));
      if (p.turnId && !externalIds.has(p.turnId)) return false;
      const native = await allNativeTurns(binding);
      const turns = mergeTurns(native, binding.ledger.turns(), p.sortDirection ?? (x.method === 'thread/turns/list' ? 'desc' : 'asc'), committed);
      if (x.method === 'thread/turns/list') {
        const scope = 'turns:' + binding.threadId;
        let adjusted = {...p, sortDirection: p.sortDirection ?? 'desc'};
        if (typeof p.cursor === 'string' && !p.cursor.startsWith('dshpage:')) {
          const original = await request(x.method, p);
          if (!original.data.length) { output({id: x.id, result: original}); return true; }
          const first = turns.findIndex(t => t.id === original.data[0].id), nativeIds = new Set(native.map(t => t.id));
          const previous = turns.slice(0, first).findLast(t => nativeIds.has(t.id));
          adjusted.cursor = previous ? 'dshpage:' + Buffer.from(JSON.stringify({scope, id: previous.id})).toString('base64url') : null;
        }
        const full = pageRows(turns, adjusted, scope);
        full.data = full.data.map(t => p.itemsView === 'notLoaded' ? {...t, items: [], itemsView: 'notLoaded'} : {...t, itemsView: 'full'});
        output({id: x.id, result: full});
        return true;
      }
      let rows = turns.filter(t => !p.turnId || p.turnId === t.id).flatMap(t => (p.sortDirection === 'desc' ? [...t.items].reverse() : t.items).map(item => ({turnId: t.id, item, startedAtMs: (t.startedAt ?? 0) * 1000, completedAtMs: (t.completedAt ?? 0) * 1000})));
      if (x.method === 'thread/items/read') { output({id: x.id, result: {data: rows.filter(r => p.itemIds.includes(r.item.id))}}); return true; }
      const scope = 'items:' + binding.threadId + ':' + (p.turnId ?? '');
      let adjusted = p;
      if (typeof p.cursor === 'string' && !p.cursor.startsWith('dshpage:')) {
        const original = await request(x.method, p);
        if (!original.data.length) { output({id: x.id, result: original}); return true; }
        const first = rows.findIndex(r => r.item.id === original.data[0].item.id), nativeIds = new Set(native.flatMap(t => t.items.map(i => i.id)));
        const previous = rows.slice(0, first).findLast(r => nativeIds.has(r.item.id));
        adjusted = {...p, cursor: previous ? 'dshpage:' + Buffer.from(JSON.stringify({scope, id: previous.item.id})).toString('base64url') : null};
      }
      output({id: x.id, result: pageRows(rows, adjusted, scope)});
      return true;
    }
    return false;
  }

  // DSH -> Codex for one binding: pull the bound session snapshot and inject what Codex has not seen.
  async function pump(binding) {
    if (!syncEnabled()) return;
    if (closed || !initialized || binding.active || binding.archived || (bootstrapOnly&&initialThreads.has(binding.threadId))) return;
    try {
      if (binding.origin === 'dsh' && !binding.registered) {
        await dsh('/register', {threadId: binding.threadId, sessionId: binding.sessionId});
        binding.registered=true;persistBinding(configFile,binding);
      }
      if (binding.uncertain) {
        const barrier=await request('thread/read',{threadId:binding.threadId,includeTurns:false});
        if(barrier.thread?.status?.type==='active') return;
        binding.rolloutPath=barrier.thread?.path??binding.rolloutPath;binding.uncertain=false;
      }
      const token = fs.readFileSync(config.dshTokenFile, 'utf8').trim();
      const response = await fetch(config.dshUrl + '/snapshot?sessionId=' + encodeURIComponent(binding.sessionId), {method: 'POST', headers: {authorization: 'Bearer ' + token}, body: '{}', signal: AbortSignal.timeout(4000)});
      if (!response.ok) throw Error('DSH_SNAPSHOT_' + response.status);
      const view = await response.json();
      if (!syncEnabled() || binding.active || view.agentStatus === 'running') return;
      const messages = incomingMessages(view, binding.sessionId, binding.identitySessionId);

      const known = new Map(binding.ledger.data.batches.flatMap(b => b.messages.map(m => [m.id, m])));
      for(const message of messages){const old=known.get(message.id);if(old&&(old.role!==message.role||old.text!==message.text))throw Error('DSH_MESSAGE_CHANGED');}
      const unseen = messages.filter(m => !known.has(m.id));
      const groups = [];
      let group = [];
      const flush = () => { if (group.length) { groups.push(group); group = []; } };
      for (const m of unseen) { if (m.role === 'user') flush(); group.push(m); if (m.role === 'assistant') flush(); }
      flush();
      for (const msgs of groups) {
        const turnId = 'dsh-link-' + hash(msgs.map(m => m.id).join('\0')).slice(0, 40);
        binding.ledger.data.batches.push({turnId, acceptedAt: Date.now(), messages: msgs, state: 'pending'});
      }
      if (groups.length) binding.ledger.save();
      // Retry every batch that is still pending, including ones interrupted by a restart.
      for (const batch of binding.ledger.data.batches.filter(b => b.state === 'pending')) {
        if(!syncEnabled()||binding.active)return;
        // A freshly restarted backend only knows threads it has opened; load it before injecting.
        if (!binding.loaded) {
          try { const resumed=await request('thread/resume', {threadId: binding.threadId, excludeTurns: true}); binding.rolloutPath=resumed.thread?.path??binding.rolloutPath; binding.loaded = true; }
          catch (error) { throw Error('THREAD_LOAD_FAILED: ' + error.message); }
        }
        if (!Object.hasOwn(batch, 'anchorTurnId')) { const native = binding.rolloutPath && fs.existsSync(binding.rolloutPath) ? await allNativeTurns(binding) : []; batch.anchorTurnId = native.at(-1)?.id ?? null; binding.ledger.save(); }
        const present = readInjected(binding.rolloutPath, new Set(batch.messages.map(m => m.id)));
        const missing = batch.messages.filter(m => !present.has(m.id));
        if(!syncEnabled()||binding.active)return;
        if (missing.length) await request('thread/inject_items', {threadId: binding.threadId, items: missing.map(responseItem)});
        binding.ledger.commit(batch);
        for (const n of notifications(binding.threadId, batch)) output(n);
        binding.delivered += batch.messages.length;
      }
      binding.lastError = null;
      const creationJob=reverseJobs[binding.sessionId];
      if(binding.origin==='dsh' && creationJob && !creationJob.nameSet) {
        await request('thread/name/set',{threadId:binding.threadId,name:binding.title});
        creationJob.nameSet=true;creationJob.state='bound';atomicJson(reverseJobsFile,reverseJobs);
      }
      binding.lastSyncAt = new Date().toISOString();
      save();
    } catch (error) {
      binding.lastError = error.message;
      if (String(binding.lastError).startsWith('OUTCOME_UNKNOWN')) binding.uncertain = true;
      save();
    }
  }

  // Persist a creation intent immediately, so a retry reuses the same Codex thread.
  let lastReverse=0;
  async function reverseBind(){
    if(!syncEnabled()||!settings().reverseBind||Date.now()-lastReverse<(config.discoveryMs??60000))return;
    lastReverse=Date.now();
    let items;
    try{items=(await dsh('/sessions')).items??[];}catch(error){discoveryError='DSH_DISCOVERY: '+error.message;save();return;}
    const bound=new Set(states.map(s=>s.sessionId));
    for(const s of items){
      if(!syncEnabled())return;
      const sid=String(s.sessionId??'');
      if(!sid||bound.has(sid)||sid.startsWith('codexhist-')||sid.startsWith('codex-')||sid.startsWith('shared-chat-probe-')||s.running||s.blank||s.archived||s.parentSessionId||s.delegationDepth>0)continue;
      try{
        const snapshot=await dsh('/snapshot?sessionId='+encodeURIComponent(sid));
        if(!syncEnabled())return;
        if(snapshot.agentStatus==='running'||!incomingMessages(snapshot,sid).length)continue;
        let job=reverseJobs[sid];
        if(!job){
          const made=await request('thread/start',{cwd:s.cwd||root,historyMode:'paginated',ephemeral:false});
          if(!made.thread?.id)throw Error('THREAD_CREATE_FAILED');
          job=reverseJobs[sid]={threadId:made.thread.id,sourceFile:made.thread.path,state:'created'};
          atomicJson(reverseJobsFile,reverseJobs);
        }
        const tid=job.threadId,ledgerDir=config.ledgerDir??path.join(root,'data','ledgers');
        const binding={threadId:tid,sessionId:sid,title:s.title||snapshot.title||'[DSH] '+sid.slice(0,8),
          ledger:new Ledger(path.join(ledgerDir,tid+'.json'),tid,sid),rolloutPath:job.sourceFile,
          loaded:!!(job.state==='created'&&!fs.existsSync(job.sourceFile??'')),active:false,uncertain:false,
          delivered:0,lastError:null,lastPushError:null,lastSyncAt:null,origin:'dsh',archived:false,registered:false};
        persistBinding(configFile,binding);states.push(binding);byThread.set(tid,binding);bound.add(sid);
        await dsh('/register',{threadId:tid,sessionId:sid});
        binding.registered=true;persistBinding(configFile,binding);
        // Injection itself materializes a fresh rollout; querying turns beforehand cannot.
        await pump(binding);
        if(binding.lastError)throw Error(binding.lastError);
        job.state='bound';atomicJson(reverseJobsFile,reverseJobs);save();
      }catch(error){discoveryError='REVERSE_BIND '+sid+': '+error.message;save();}
    }
  }

  async function pumpAll() {
    if(!syncEnabled())return;
    await sweepArchive();
    await reverseBind();
    for (const binding of states) { if (closed) return; await pump(binding); }
  }

  const enqueue = () => { chain = chain.then(pumpAll, pumpAll); return chain; };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void enqueue(), config.debounceMs ?? 500); };

  // Forward only persisted public text. The durable outbox retries busy/offline peers.
  const outboxes=new Map();let forwardBusy=false;
  function bufferPush(){scheduleForward();}
  function scheduleForward(){void flushPush();}
  async function flushPush(){
    if(bootstrapOnly||closed||!initialized||forwardBusy||!syncEnabled())return;
    forwardBusy=true;
    try{
      for(const b of states){
        if(!syncEnabled())return;
        if(b.archived||b.threadId===config.legacyForwardThreadId)continue;
        try{
          let box=outboxes.get(b.threadId);
          if(!box){box=new TextOutbox(b.ledger.file+'.forward.json',b.threadId);outboxes.set(b.threadId,box);}
          box.scan(b.rolloutPath);if(!box.data.pending.length)continue;
          const snapshot=await dsh('/snapshot?sessionId='+encodeURIComponent(b.sessionId));
          if(!syncEnabled())return;
          if(snapshot.agentStatus==='running')continue;
          const existing=new Set(snapshot.messages.map(m=>m.id));
          box.forget(new Set(box.data.pending.filter(m=>existing.has(box.importedId(m.id))).map(m=>m.id)));
          while(box.data.pending.length){
            if(!syncEnabled())return;
            const batch=box.data.pending.slice(0,100);
            await dsh('/append',{sessionId:b.sessionId,source:'codex:'+b.threadId,messages:batch});
            box.forget(new Set(batch.map(m=>m.id)));
          }
          b.lastPushError=null;
        }catch(error){b.lastPushError=error.message;}
      }
    }finally{forwardBusy=false;save();}
  }
  const forwardInterval=setInterval(scheduleForward,config.forwardMs??1000);
  forwardInterval.unref();

  function observeRequest(x) {
    const binding = byThread.get(x.params?.threadId);
    if(binding && ['thread/archive','thread/unarchive','thread/unsubscribe'].includes(x.method)) binding.loaded=false;
    if (binding && ['turn/start', 'turn/addUserMessage', 'turn/steer', 'review/start', 'thread/compact/start', 'thread/shellCommand'].includes(x.method)) { binding.active = true; save(); }
    if (x.id != null) desktopPending.set(String(x.id), {method: x.method, params: x.params ?? {}});
  }

  async function desktop(x) {
    try { if (await decorateRequest(x)) return; observeRequest(x); child.stdin.write(JSON.stringify(x) + '\n'); }
    catch (error) { output({id: x.id, error: {code: -32000, message: 'DSH bridge: ' + error.message}}); }
  }

  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  input.on('line', line => {
    let x; try { x = JSON.parse(line); } catch { child.stdin.write(line + '\n'); return; }
    chain = chain.then(() => desktop(x)).catch(error => { save(); });
  });

  const backend = readline.createInterface({input: child.stdout, crlfDelay: Infinity});
  backend.on('line', line => {
    let x; try { x = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
    const internal = pending.get(String(x.id));
    if (x.id != null && internal) { clearTimeout(internal.timeout); pending.delete(String(x.id)); if (x.error) internal.reject(Error(JSON.stringify(x.error))); else internal.resolve(x.result); return; }
    if (String(x.id ?? '').startsWith('dshbridge-internal-')) return;
    if (x.id != null) {
      const original = desktopPending.get(String(x.id));
      desktopPending.delete(String(x.id));
      if (original?.method === 'initialize' && !x.error) { initialized = true; debug({state: 'initialized'}); save(); schedule(); }
      if (x.result?.thread && !byThread.has(x.result.thread.id)) void autoRegister(x.result.thread);
      const binding = byThread.get(original?.params?.threadId);
      if (binding) {
        if (['thread/resume', 'thread/read'].includes(original.method) && x.result?.thread) {
          const t = x.result.thread;
          binding.rolloutPath = t.path ?? binding.rolloutPath;
          binding.loaded = true;
          if (t.status?.type === 'active') binding.active = true; else if (t.status?.type === 'idle') binding.active = false;
          if (Array.isArray(t.turns) && !original.params.excludeTurns && (original.method === 'thread/resume' || original.params.includeTurns === true)) t.turns = mergeTurns(t.turns, binding.ledger.turns(), 'asc', binding.ledger.committed());
          for (const k of ['initialTurnsPage', 'turnsPage']) if (x.result[k]) x.result[k].data = mergeTurns(x.result[k].data, binding.ledger.turns(), 'desc', binding.ledger.committed());
          save(); schedule();
        }
        if (x.error && ['turn/start', 'turn/addUserMessage', 'review/start'].includes(original.method)) binding.active = false;
      }
    }
    const notifyBinding = byThread.get(x.params?.threadId);
    if (notifyBinding) {
      if (x.method === 'turn/started') { notifyBinding.active = true; save(); }
      if (x.method === 'item/completed' && x.params?.item) bufferPush(x.params.threadId, x.params.item);
      if (x.method === 'turn/completed') { notifyBinding.active = false; schedule(); }
      if (x.method === 'thread/status/changed') { notifyBinding.active = x.params.status?.type === 'active'; if (!notifyBinding.active) schedule(); }
      if (x.method === 'thread/closed') notifyBinding.loaded = false;
    }
    output(x);
  });

  const heartbeat=setInterval(save,5000);heartbeat.unref();
  try { watcher=fs.watch(config.watchDir,(_,filename)=>{if(String(filename??'')==='control.json')schedule();}); } catch {}
  const interval = setInterval(schedule, config.reconcileMs ?? 30000);
  interval.unref();
  input.on('close', () => { closed = true; clearTimeout(timer); clearInterval(interval); clearInterval(heartbeat); clearInterval(forwardInterval); watcher?.close(); child.stdin.end(); });
  child.on('exit', code => { closed = true; for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(Error('BACKEND_EXITED')); } pending.clear(); clearTimeout(timer); clearInterval(interval); clearInterval(heartbeat); clearInterval(forwardInterval); watcher?.close(); save(); process.exitCode = code ?? 1; input.close(); process.stdin.destroy(); });
  process.on('SIGTERM', () => child.kill());
  process.on('SIGINT', () => child.kill());
  save();
}
