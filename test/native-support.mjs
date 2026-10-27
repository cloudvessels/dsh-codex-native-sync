import path from 'node:path';
import {runtime} from '../packages/dsh-plugin/src/runtime.mjs';
import {fixture} from './support.mjs';
export const anchor=process.env.DSH_TEST_ANCHOR;
export async function nativeFixture(t){
  const f=fixture(t),r=await runtime(anchor),native=new r.Context();await native.plugin(r.default);
  f.cleanups.push(()=>native.fiber.dispose());
  const agents=new Map(),workspaces=new Map(),archived=[],titles=new Map();
  const ctx={sessions:native.sessions,agents,logger:{warn(){},info(){}},on(){},get(){return null;},
    effect(fn){const cleanup=fn();if(cleanup)f.cleanups.push(cleanup);},
    workspaceRegistry:{archivedSessionIds:archived,async create(cwd){const id='workspace-'+workspaces.size;const value={id,path:cwd};workspaces.set(id,value);return value;},
      async archiveSession(id){if(!archived.includes(id))archived.push(id);},async unarchiveSession(id){const index=archived.indexOf(id);if(index>=0)archived.splice(index,1);}},
    sessionTitle:{rename(session,title){titles.set(session.id,title);return {title};}},
    sessionPersistence:{async flush(){},locate(){return {path:'isolated-native-fixture'};}},
    sessionController:{async create({sessionId,workspaceId,cwd}){if(!native.sessions.get(sessionId))native.sessions.create(sessionId,{meta:{cwd:workspaces.get(workspaceId)?.path??cwd??f.dir}});},
      async resolveAgent(id){let agent=agents.get(id);if(!agent){const session=native.sessions.get(id);if(!session)return {error:{code:'notfound'}};
        agent={session,status:'idle',phase:{kind:'idle',lastTurn:0},setPhase(value){this.phase=value;}};agents.set(id,agent);}return {agent};},
      async inspect(id){const session=native.sessions.get(id);if(!session)throw Error('NO_SESSION');return {meta:session.header,events:session.snapshotEvents(),inheritedEventCount:session.inheritedEventCount};},
      async rename({sessionId,title}){titles.set(sessionId,title);return {title};},
      async list(){return {items:native.sessions.list().map(session=>({sessionId:session.id,cwd:session.header.cwd,blank:session.seq===0,
        running:agents.get(session.id)?.status==='running',projections:{values:{title:titles.get(session.id)??null}}}))};}}};
  const snapshot=id=>{const session=native.sessions.get(id);return {targetSessionId:id,agentStatus:agents.get(id)?.status??'idle',
    messages:session.snapshotEvents().flatMap(event=>{const body=event.type==='user/message'?event.data:event.type==='assistant/message'?event.data.message:null;
      return body?[{id:body.id,role:body.role,text:body.content.filter(block=>block.type==='text').map(block=>block.text).join(''),contentTypes:['text']}]:[];})};};
  return {...f,r,native,ctx,agents,archived,workspaces,snapshot,configFile:path.join(f.dir,'bridge','config.json')};
}
