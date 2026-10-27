import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {timingSafeEqual,randomBytes} from 'node:crypto';
import {runtime} from './runtime.mjs';
import {appendToLiveSession} from './append-v2.mjs';
import {appendOperations,planOperations} from './operation-steps.mjs';
import {alignIdleAgent} from './agent-turns.mjs';
import {createPublicCollector} from './codex-public-v3.mjs';
import {atomicJson, readJson} from './state.mjs';
import {linkConfiguration,runtimeAnchor} from './configuration.mjs';
import {loadSettings} from './settings.mjs';
import {syncBoundTitles,sessionTitle} from './title-sync.mjs';
import {offlineMigration,recoverMigration,migrateBinding} from './migration.mjs';

export const name = 'dsh-multi-chat-link';
export const inject = ['sessionController', 'sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'sessionTitle'];

export async function apply(ctx, options = {}) {
  const config=linkConfiguration(options),root=config.dataDir,project=config.project;
  fs.mkdirSync(root,{recursive:true});
  const bridgeConfig=config.bridgeConfig,bridgeConfigPath=bridgeConfig,codexStateDb=config.codexStateDb;
  const threadId=config.legacyThreadId,sourceFile=config.legacySourceFile;
  const legacyEnabled=!!(threadId&&sourceFile);
  if(!!threadId!==!!sourceFile)throw Error('INCOMPLETE_LEGACY_CONFIG');
  if(legacyEnabled&&(!project||!path.isAbsolute(sourceFile)||!path.isAbsolute(project)))throw Error('LEGACY_CONFIG_REQUIRES_ABSOLUTE_PATHS');
  if(legacyEnabled&&readJson(bridgeConfig,{}).legacyForwardThreadId!==threadId)throw Error('LEGACY_COLLECTOR_REQUIRES_SINGLE_WRITER_CONFIG');
  const legacySessionId=legacyEnabled?'shared-codex-'+threadId:null;
  let title='双向聊天同步';
  const bindingsPath=path.join(root,'bindings.json');
  const settings = () => loadSettings(bridgeConfig);
  const r = options.runtime??await runtime(runtimeAnchor(config));
  const collector = legacyEnabled?createPublicCollector(root,{sourcePath:sourceFile,sourceThreadId:threadId}):null;
  fs.mkdirSync(path.dirname(config.tokenFile),{recursive:true});
  if(!fs.existsSync(config.tokenFile))try{fs.writeFileSync(config.tokenFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  const token = fs.readFileSync(config.tokenFile,'utf8').trim();
  if(!token)throw Error('EMPTY_SYNC_TOKEN');
  await recoverMigration(bridgeConfig,ctx);

  // threadId -> sessionId. The current live chat keeps its original binding.
  const bindings = new Map();
  if(legacyEnabled)bindings.set(threadId, legacySessionId);
  for(const rows of [readJson(bridgeConfig,{bindings:[]}).bindings,readJson(bindingsPath,{bindings:[]}).bindings]){
    for(const b of rows??[])if(b?.threadId&&b?.sessionId){
      if(bindings.has(b.threadId)&&bindings.get(b.threadId)!==b.sessionId)throw Error('BINDING_FILES_DISAGREE');
      bindings.set(b.threadId,b.sessionId);
    }
  }

  function registerBinding(tid, sid) {
    if (typeof tid !== 'string' || typeof sid !== 'string' || !tid || !sid) throw Error('INVALID_BINDING');
    const previous = bindings.get(tid);
    if (previous && previous !== sid) throw Error('BINDING_CONFLICT');
    for (const [other, value] of bindings) if (value === sid && other !== tid) throw Error('SESSION_ALREADY_BOUND');
    bindings.set(tid, sid);
    atomicJson(bindingsPath, {version: 2, bindings: [...bindings].map(([threadId, sessionId]) => ({threadId, sessionId}))});
    return {threadId: tid, sessionId: sid};
  }

  let legacy = {sourceMessages: 0, syncedMessages: 0, totalAppended: 0, modelRequests: 0, syncRuns: 0, lastError: null, lastSourceMessageId: null, lastSyncAt: null};
  let chain = Promise.resolve(), timer, closed = false, workspaceId, ready = !legacyEnabled;
  let listeningPort=config.port;
  const pushed = new Map(); // sessionId -> {count, lastAt, lastError}

  const state = () => ({version: 3, pluginVersion: '0.1.4', settings: settings(), syncSteps: settings().syncSteps, sourceThreadId:threadId||null, targetSessionId: legacySessionId, title, workspaceId, port:listeningPort, pid: process.pid, bindings: bindings.size, ready, ...legacy});

  const save = () => {
    try { fs.writeFileSync(path.join(root, 'sync-status.json'), JSON.stringify({...state(), pushed: Object.fromEntries(pushed)}, null, 2)); } catch {}
  };

  let titleBusy = false, titleChain = Promise.resolve(), lastTitleCheck = 0;
  const titleReceipts=new Map();
  async function syncTitles(dry = false) {
    const database = options.titleStateDb ?? codexStateDb;
    if (!database) return {skipped: true};
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(database, {readOnly: true});
    let rows;
    try { rows = db.prepare("select id,coalesce(nullif(name,''),title) as title from threads").all(); }
    finally { db.close(); }
    const result = await syncBoundTitles(ctx, bindings, rows, dry,titleReceipts);
    const currentTitle = rows.find(row => row.id === threadId)?.title;
    if (!dry && currentTitle?.trim()) title = currentTitle;
    atomicJson(path.join(root, 'title-sync-status.json'), {at: new Date().toISOString(), ...result});
    return result;
  }
  const scheduleTitles = () => {
    if (closed || !ready || titleBusy || !settings().enabled || !bindings.size) return;
    titleBusy = true;
    titleChain = syncTitles().catch(error => {
      atomicJson(path.join(root, 'title-sync-status.json'), {at: new Date().toISOString(), error: error.message});
      ctx.logger.warn('Title sync: ' + error.message);
    }).finally(() => {titleBusy = false;});
  };

  async function snapshotFor(sessionId) {
    if(!sessionId)throw Error('SESSION_ID_REQUIRED');
    const view = await ctx.sessionController.inspect(sessionId);
    r.validate(view.meta, view.events, view.inheritedEventCount);
    const messages = view.events.flatMap(e => {
      const m = e.type === 'user/message' ? e.data : e.type === 'assistant/message' ? e.data.message : null;
      if (m?.role === 'user' && m.source?.kind !== 'user') return [];
      return m ? [{id: m.id, role: m.role, text: m.content.filter(b => b.type === 'text').map(b => b.text).join(''), seq: e.seq, time: e.time, contentTypes: m.content.map(b => b.type)}] : [];
    });
    return {
      targetSessionId: sessionId,
      sourceThreadId: [...bindings].find(([, sid]) => sid === sessionId)?.[0] ?? null,
      agentStatus: ctx.agents.get(sessionId)?.status ?? 'idle',
      header: view.meta,
      events: view.events.length,
      messages,
      artifact: ctx.sessionPersistence.locate(view.meta).path,
    };
  }

  async function appendTo(sessionId, source, messages) {
    if (!settings().enabled) throw Error('SYNC_PAUSED');
    if (![...bindings.values()].includes(sessionId)) throw new Error('UNKNOWN_BINDING');
    const found = await ctx.sessionController.resolveAgent(sessionId);
    if (found.error) throw new Error('RESOLVE_' + found.error.code);
    if (found.agent.status === 'running') throw new Error('SESSION_BUSY');
    alignIdleAgent(found.agent, found.agent.session.snapshotEvents());
    const result = appendToLiveSession(found.agent.session, {source, messages}, r.validate);
    alignIdleAgent(found.agent, found.agent.session.snapshotEvents());
    await ctx.sessionPersistence.flush();
    const previous = pushed.get(sessionId) ?? {count: 0};
    pushed.set(sessionId, {count: previous.count + result.appendedMessages, lastAt: new Date().toISOString(), lastError: null});
    save();
    return result;
  }

  async function appendStepsTo(sessionId,source,steps,{dry=false}={}){
    if(!settings().syncSteps)throw Error('OPERATION_SYNC_DISABLED');
    if(!settings().enabled)throw Error('SYNC_PAUSED');
    const tid=[...bindings].find(([,sid])=>sid===sessionId)?.[0];
    if(!tid||source!=='codex:'+tid)throw Error('OPERATION_BINDING_MISMATCH');
    const found=await ctx.sessionController.resolveAgent(sessionId);
    if(found.error)throw Error('RESOLVE_'+found.error.code);
    if(found.agent.status!=='idle')throw Error('SESSION_BUSY');
    if(!settings().syncSteps)throw Error('OPERATION_SYNC_DISABLED');
    if(!settings().enabled)throw Error('SYNC_PAUSED');
    alignIdleAgent(found.agent,found.agent.session.snapshotEvents());
    if(dry){const plan=planOperations(found.agent.session,{source,steps},r.validate);return {ok:true,mode:'native-tool-events',appendedSteps:plan.appendedSteps};}
    const result=appendOperations(found.agent.session,{source,steps},r.validate);
    alignIdleAgent(found.agent,found.agent.session.snapshotEvents());
    await ctx.sessionPersistence.flush();
    const previous=pushed.get(sessionId)??{count:0};pushed.set(sessionId,{...previous,steps:(previous.steps??0)+result.appendedSteps,lastAt:new Date().toISOString(),lastError:null});save();return result;
  }

  async function sync() {
    if (closed) return state();
    if (!settings().enabled) { save(); return state(); }
    if(!legacyEnabled){save();return state();}
    try {
      collector.drain();
      const data = collector.snapshot();
      legacy.sourceMessages = data.messages.length;
      fs.writeFileSync(path.join(root, 'public-snapshot.json'), JSON.stringify(data, null, 2));
      fs.writeFileSync(path.join(root, 'shared-chat.jsonl'), data.messages.map(m => JSON.stringify(m)).join('\n') + '\n');
      if (!ready) {
        const workspace = await ctx.workspaceRegistry.create(project, path.basename(project));
        workspaceId = workspace.id;
        await ctx.sessionController.create({sessionId: legacySessionId, workspaceId, agentPreset: 'cordis'});
        ready = true;
      }
      if (Date.now() - lastTitleCheck > 15000) { lastTitleCheck = Date.now(); scheduleTitles(); }
      const found = await ctx.sessionController.resolveAgent(legacySessionId);
      if (found.error) throw found.error;
      if (found.agent.status === 'running') { legacy.lastError = 'WAITING_FOR_DSH_IDLE'; save(); return state(); }
      if (path.resolve(found.agent.session.header.cwd) !== path.resolve(project)) throw new Error('BOUND_WORKSPACE_CHANGED');
      alignIdleAgent(found.agent, found.agent.session.snapshotEvents());
      const result = appendToLiveSession(found.agent.session, {source: threadId, messages: data.messages}, r.validate);
      alignIdleAgent(found.agent, found.agent.session.snapshotEvents());
      await ctx.sessionPersistence.flush();
      legacy.syncedMessages = data.messages.length;
      legacy.totalAppended += result.appendedMessages;
      legacy.syncRuns++;
      legacy.lastError = null;
      legacy.lastSyncAt = new Date().toISOString();
      legacy.lastSourceMessageId = data.messages.at(-1)?.id ?? null;
      save();
      fs.mkdirSync(path.join(root,'evidence'),{recursive:true});
      fs.appendFileSync(path.join(root, 'evidence', 'sync-runs.jsonl'), JSON.stringify({at: legacy.lastSyncAt, ...result}) + '\n');
      return state();
    } catch (error) {
      legacy.lastError = error.message;
      save();
      ctx.logger.warn('Multi chat link: ' + error.message);
      return state();
    }
  }

  const enqueue = () => chain = chain.then(sync, sync);
  const schedule = () => { if (!closed) { clearTimeout(timer); timer = setTimeout(() => void enqueue(), 400); } };
  ctx.on('llm/stream', (options, next) => { if (options.sessionId === legacySessionId) { legacy.modelRequests++; save(); } return next(); }, {global: true, prepend: true});
  ctx.on('agent/status', ({agent, status}) => { if (agent.id === legacySessionId && status !== 'running' && legacy.lastError === 'WAITING_FOR_DSH_IDLE') schedule(); }, {global: true});
  const watcher = legacyEnabled?fs.watch(sourceFile, schedule):null;
  watcher?.on('error', error => { legacy.lastError = error.message; save(); });

  async function ensureSession({threadId: tid, cwd, title: wanted}) {
    if (!settings().enabled) throw Error('SYNC_PAUSED');
    if (!tid) throw new Error('THREAD_ID_REQUIRED');
    const sessionId = 'codexhist-' + tid;
    if (bindings.has(tid)) return {sessionId: bindings.get(tid), created: false};
    if (!settings().autoBind) throw Error('AUTO_BIND_DISABLED');
    if (ctx.sessions.get(sessionId)) { registerBinding(tid, sessionId); return {sessionId, created: false}; }
    const dir = cwd || project;
    if(!dir||!path.isAbsolute(dir))throw Error('WORKSPACE_PATH_REQUIRED');
    fs.mkdirSync(dir, {recursive: true});
    const workspace = await ctx.workspaceRegistry.create(dir, path.basename(dir));
    await ctx.sessionController.create({sessionId, workspaceId: workspace.id, agentPreset: 'cordis'});
    try {
      const live = ctx.sessions.get(sessionId);
      if (live) await ctx.sessionTitle.rename(live, wanted || tid.slice(0, 8));
    } catch {}
    await ctx.sessionPersistence.flush();
    registerBinding(tid, sessionId);
    return {sessionId, created: true, workspaceId: workspace.id};
  }

  // Native history remains in the old session until new history, ledgers and
  // both mapping files are durable. The bridge must be offline for publication.
  async function rehomeSessions(dry) {
    const execute=async()=>{
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync(codexStateDb,{readOnly:true});
      let projects,roots,threads;
      try{
        projects=db.prepare('select id,name from projects').all();
        roots=db.prepare('select project_id,path from project_roots').all();
        threads=db.prepare('select id,cwd from threads').all();
      }finally{db.close();}
      const normalize=value=>String(value??'').replace(/^[\\/]{2}\?[\\/]/,'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
      const projectRoots=roots.map(row=>({path:normalize(row.path),rawPath:String(row.path).replace(/^[\\/]{2}\?[\\/]/,''),
        name:projects.find(project=>project.id===row.project_id)?.name??row.project_id})).filter(row=>row.path);
      const cwdOf=new Map(threads.map(row=>[row.id,normalize(row.cwd)]));
      const current=readJson(bridgeConfigPath,{bindings:[]});
      const moved=[],skipped=[];
      for(const binding of current.bindings){
        if(binding.sessionId===legacySessionId){skipped.push({sessionId:binding.sessionId,reason:'LEGACY_COLLECTOR_BOUND'});continue;}
        const cwd=cwdOf.get(binding.threadId)??'';
        const match=projectRoots.filter(row=>cwd===row.path||cwd.startsWith(row.path+'/')).sort((a,b)=>b.path.length-a.path.length)[0];
        if(!match){skipped.push({sessionId:binding.sessionId,reason:'NO_PROJECT'});continue;}
        try{
          const view=await ctx.sessionController.inspect(binding.sessionId);
          if(normalize(view.meta.cwd)===match.path){skipped.push({sessionId:binding.sessionId,reason:'ALREADY'});continue;}
          if(dry){moved.push({threadId:binding.threadId,sessionId:binding.sessionId,project:match.name,to:match.rawPath,dry:true});continue;}
          const snapshot=await snapshotFor(binding.sessionId);
          if(snapshot.agentStatus==='running')throw Error('SESSION_BUSY');
          const workspace=await ctx.workspaceRegistry.create(match.rawPath,match.name);
          const result=await migrateBinding({ctx,configFile:bridgeConfigPath,bindingsFile:bindingsPath,binding,workspace,
            targetPath:match.rawPath,snapshot,validate:r.validate});
          const refreshed=readJson(bridgeConfigPath,{bindings:[]});
          for(const row of refreshed.bindings)bindings.set(row.threadId,row.sessionId);
          moved.push({...result,project:match.name});
          if(result.archivePending)break;
        }catch(error){skipped.push({sessionId:binding.sessionId,reason:error.message});}
      }
      return {dry:!!dry,moved:moved.length,skipped:skipped.length,details:moved,reasons:skipped};
    };
    return dry?execute():offlineMigration(bridgeConfigPath,ctx,execute);
  }
  // Mirror Codex project grouping: one DSH workspace per Codex project root, sessions attached by their thread cwd.
  async function organizeProjects() {
    let DatabaseSync;
    try { ({DatabaseSync} = await import('node:sqlite')); } catch (error) { throw new Error('SQLITE_UNAVAILABLE: ' + error.message); }
    const db = new DatabaseSync(codexStateDb, {readOnly: true});
    let projects, roots, cwdRows;
    try {
      projects = db.prepare('select id, name from projects').all();
      roots = db.prepare('select project_id, path from project_roots').all();
      cwdRows = db.prepare('select id, cwd from threads').all();
    } finally { db.close(); }
    const strip = p => String(p ?? '').replace(/^[\\/]{2}\?[\\/]/, '').replace(/^[\\/]+/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const nameOf = id => (projects.find(p => p.id === id)?.name) ?? id;
    const rootList = roots.map(r => ({name: nameOf(r.project_id), path: strip(r.path), rawPath: String(r.path ?? '').replace(/^[\\/]{2}\?[\\/]/, '')}))
      .filter(r => r.path);
    const cwdOf = new Map(cwdRows.map(r => [r.id, strip(r.cwd)]));
    let config;
    try { config = JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf8')); } catch { config = {bindings: []}; }
    const moved = [], skipped = [];
    for (const binding of config.bindings ?? []) {
      const tid = binding.threadId, sessionId = binding.sessionId;
      const cwd = cwdOf.get(tid);
      if (!cwd) { skipped.push({sessionId, reason: 'NO_CWD'}); continue; }
      const match = rootList.filter(r => cwd === r.path || cwd.startsWith(r.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
      if (!match) { skipped.push({sessionId, reason: 'NO_PROJECT'}); continue; }
      try {
        const workspace = await ctx.workspaceRegistry.create(match.rawPath, match.name);
        await workspace.attachSession(sessionId);
        moved.push({sessionId, workspace: match.name, path: match.rawPath});
      } catch (error) {
        skipped.push({sessionId, reason: String(error?.message ?? error)});
      }
    }
    await ctx.sessionPersistence.flush();
    return {workspaces: [...new Set(moved.map(m => m.workspace))], moved: moved.length, skipped: skipped.length, details: moved};
  }


  async function archiveSession(sessionId) {
    if (!sessionId) throw new Error('SESSION_ID_REQUIRED');
    await ctx.workspaceRegistry.archiveSession(sessionId, {stopActivity: true});
    return {archived: true, sessionId};
  }

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const supplied = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const expectedToken=Buffer.from(token);
      if (req.headers.origin || supplied.length !== expectedToken.length || !timingSafeEqual(supplied,expectedToken)) { res.writeHead(403); res.end('Forbidden'); return; }
      if (req.method !== 'POST') { res.writeHead(405); res.end('POST required'); return; }
      let body = '';
      for await (const part of req) { body += part; if (body.length > 4 * 1024 * 1024) throw new Error('REQUEST_TOO_LARGE'); }
      const parsed = body ? JSON.parse(body) : {};
      const url = reqUrl;
      if (['/append', '/ensure', '/register', '/archive', '/unarchive'].includes(url.pathname) && !settings().enabled) throw Error('SYNC_PAUSED');
      if (['/archive', '/unarchive'].includes(url.pathname) && !settings().archiveMirror) throw Error('ARCHIVE_MIRROR_DISABLED');
      let out;
      if (url.pathname === '/status') out = {...state(), pushed: Object.fromEntries(pushed)};
      else if (url.pathname === '/sync') out = await enqueue();
      else if (url.pathname === '/snapshot') out = await snapshotFor(url.searchParams.get('sessionId') || legacySessionId);
      else if (url.pathname === '/append') out = await appendTo(parsed.sessionId, parsed.source || 'codex-push', parsed.messages || []);
      else if (url.pathname === '/bindings') out = Object.fromEntries(bindings);
      else if (url.pathname === '/append-steps') out=await appendStepsTo(parsed.sessionId,parsed.source,parsed.steps);
      else if (url.pathname === '/ensure') out = await ensureSession(parsed);
      else if (url.pathname === '/claim') throw Error('IMPLICIT_CLAIM_DISABLED');
      else if (url.pathname === '/register') {
        await ctx.sessionController.inspect(parsed.sessionId);
        out = registerBinding(parsed.threadId, parsed.sessionId);
      }
      else if (url.pathname === '/sessions') {
        const list = await ctx.sessionController.list({}, AbortSignal.timeout(8000));
        out = {items: (list.items ?? []).map(i => ({sessionId: i.sessionId, title: sessionTitle(i), parentSessionId: i.parentSessionId ?? null, archived: ctx.workspaceRegistry.archivedSessionIds.includes(i.sessionId), cwd: i.cwd ?? null, running: !!i.running, blank: !!i.blank}))};
      }
      else if (url.pathname === '/archive') out = await archiveSession(parsed.sessionId);
      else if (url.pathname === '/organize-projects') out = await organizeProjects();
      else if (url.pathname === '/rehome') out = await rehomeSessions(parsed.dry !== false);
      else if (url.pathname === '/sync-titles') { await titleChain; out = await syncTitles(parsed.dry === true); }
      else if (url.pathname === '/unarchive') { await ctx.workspaceRegistry.unarchiveSession(parsed.sessionId); out = {sessionId: parsed.sessionId, archived: false}; }
      else if (url.pathname === '/validate-steps') out=await appendStepsTo(parsed.sessionId,parsed.source,parsed.steps,{dry:true});
      else throw new Error('UNKNOWN_OPERATION');
      res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      res.end(JSON.stringify(out));
    } catch (error) { res.writeHead(409, {'content-type': 'application/json'}); res.end(JSON.stringify({error: error.message})); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  listeningPort=server.address().port;
  let wasEnabled = settings().enabled;
  const reconcile = setInterval(() => {
    const enabled = settings().enabled;
    if (enabled !== wasEnabled) { wasEnabled = enabled; schedule(); }
  }, 1000); reconcile.unref();
  const titleTimer = setInterval(scheduleTitles, 15000); titleTimer.unref();
  ctx.effect(() => async () => { closed = true; clearTimeout(timer); clearInterval(reconcile); clearInterval(titleTimer); watcher?.close(); await chain; await titleChain; await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); save(); }, name);
  const appReady = ctx.get('appReady');
  if (appReady) ctx.effect(() => appReady.onReady(() => void enqueue()), name + ': ready'); else void enqueue();
  save();
}

export default {name, inject, apply};
