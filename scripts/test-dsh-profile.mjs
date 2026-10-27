// Disposable official-CLI acceptance for the DSH half of this suite.
// No Codex process or model request is started. All mutable paths are temporary.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';

const cli=path.resolve(process.argv[2]??'');
if(!process.argv[2]||!fs.existsSync(cli))throw Error('Pass an installed official DSH lib/bin.js path');
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../packages/dsh-plugin');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-profile-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL|^DSH_|^CODEX_)/i.test(key)));
const bridgeConfig=path.join(root,'bridge.json'),dataDir=path.join(root,'sync'),tokenFile=path.join(dataDir,'.link-token');
fs.writeFileSync(bridgeConfig,JSON.stringify({bindings:[],dshTokenFile:tokenFile}));
const linkConfig=path.join(root,'link.json');
fs.writeFileSync(linkConfig,JSON.stringify({bridgeConfig,dataDir,tokenFile,runtimeAnchor:cli,port:0}));
Object.assign(env,{DSH_HOME:path.join(root,'home'),DSH_AGENTS_HOME:path.join(root,'agents'),CODEX_HOME:path.join(root,'codex'),
  DSH_LINK_CONFIG:linkConfig,DSH_BRIDGE_CONFIG_SCHEMA_PATH:bridgeConfig,DSH_SYNC_DISABLE_UPDATES:'1',DSH_TELEMETRY_DISABLED:'1',
  npm_config_cache:path.join(root,'npm-cache'),npm_config_userconfig:path.join(root,'.npmrc'),npm_config_registry:'https://registry.npmjs.org/',CI:'true'});
fs.writeFileSync(env.npm_config_userconfig,'');
const execute=promisify(execFile),report={checkedAt:new Date().toISOString(),platform:process.platform,node:process.version,
  disposableProfile:true,install:'unknown',start:'unknown',uninstall:'unknown',rollback:'unknown'};
let child,stage='baseline',baseline,installed=false,log='';
const run=async args=>(await execute(process.execPath,[cli,...args],{cwd:root,env,windowsHide:true,timeout:240000,maxBuffer:4*1024*1024})).stdout;
const pause=()=>new Promise(done=>setTimeout(done,250));
async function packageArchive(){
  // A real package payload avoids pnpm 10's Windows cross-volume file: directory
  // resolution, and prevents undeclared developer files from making the test pass.
  const destination=path.join(root,'package'),manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  const copy=(from,to)=>{
    const stat=fs.lstatSync(from);if(stat.isSymbolicLink())throw Error('symlink in test package');
    if(stat.isDirectory()){fs.mkdirSync(to,{recursive:true});for(const name of fs.readdirSync(from))copy(path.join(from,name),path.join(to,name));}
    else{fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}
  };
  for(const file of ['package.json',...manifest.files]){
    const from=path.resolve(source,file),relative=path.relative(source,from);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('unsafe package payload path');
    copy(from,path.join(destination,relative));
  }
  const archive=path.join(root,'dsh-codex-link.tgz');
  await execute('tar',['-czf',archive,'-C',root,'package'],{cwd:root,env,windowsHide:true,timeout:30000});
  return archive;
}
async function stop(){
  if(!child||child.exitCode!==null)return;
    const current=child;
  const exited=new Promise(done=>current.once('exit',done));current.kill();
  await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('host shutdown timeout')),10000).unref())]);child=null;
}
try{
  stage='package';const archive=await packageArchive();report.packagePayload='declared-files-tarball';
  stage='baseline';
  report.dshVersion=(await run(['--version'])).trim();
  baseline=await run(['--profile','web','--dump-config']);
  stage='install';
  await run(['plugin','--profile','web','add','--ignore-scripts','--config.auto-install-peers=false',archive]);installed=true;
  assert.match(await run(['--profile','web','--dump-config']),/codex-native-sync/);report.install='passed';
  const server=createServer();await new Promise((done,reject)=>server.once('error',reject).listen(0,'127.0.0.1',done));
  const port=server.address().port;await new Promise(done=>server.close(done));
  stage='start';
  child=spawn(process.execPath,[cli,'web','--no-open','--port',String(port)],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.on('error',error=>{log+=error.message;});
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log=(log+bytes.toString()).slice(-65536);});
  let launchUrl;
  for(const until=Date.now()+90000;Date.now()<until;){
    launchUrl=/dsh web: (http:\/\/[^\s]+)/.exec(log)?.[1];if(launchUrl)break;
    if(child.exitCode!==null)throw Error('host exited '+child.exitCode);await pause();
  }
  assert(launchUrl,'host launch URL timeout');
  const login=await fetch(launchUrl,{redirect:'manual',signal:AbortSignal.timeout(10000)});
  assert([302,303].includes(login.status),'host authentication redirect');
  const cookie=login.headers.getSetCookie().map(row=>row.split(';')[0]).join('; ');assert(cookie);
  const home=await fetch(new URL('/',launchUrl),{headers:{cookie},signal:AbortSignal.timeout(10000)});assert.equal(home.status,200);
  let state;
  for(const until=Date.now()+30000;Date.now()<until;){
    try{state=JSON.parse(fs.readFileSync(path.join(dataDir,'sync-status.json'),'utf8'));if(state.ready)break;}catch{}
    await pause();
  }
  assert(state?.ready,'sync host did not initialize');
  const token=fs.readFileSync(tokenFile,'utf8').trim(),endpoint='http://127.0.0.1:'+state.port;
  const post=async(route,body={})=>{
    const response=await fetch(endpoint+route,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const status=await post('/status');assert.equal(status.modelRequests,0);
  const ensured=await post('/ensure',{threadId:'store-fixture',cwd:root,title:'Disposable store fixture'});
  const sessionId=ensured.sessionId;assert(sessionId);
  const messages=[{id:'store-user',role:'user',text:'Disposable user text'},{id:'store-assistant',role:'assistant',text:'Disposable reply'}];
  assert.equal((await post('/append',{sessionId,source:'codex:store-fixture',messages})).appendedMessages,2);
  assert.equal((await post('/append',{sessionId,source:'codex:store-fixture',messages})).appendedMessages,0);
  assert.deepEqual((await post('/snapshot?sessionId='+encodeURIComponent(sessionId))).messages.map(row=>row.role),['user','assistant']);
  assert.equal((await post('/status')).modelRequests,0);
  report.start='passed';report.nativeTextAndDedup='passed';report.modelRequests=0;
}catch(error){
  report.failedStage=stage;report.reason=error.message.slice(0,300);
  if(stage==='install')report.install='failed';if(stage==='start')report.start='failed';
  // Keep authentication URLs and machine paths out of public reports.
  let failureLog=(error.stdout??'')+'\n'+(error.stderr??log);
  const logPath=/diagnostics: ([^\r\n]+)/.exec(error.stderr??'')?.[1];
  if(logPath){
    const relative=path.relative(root,path.resolve(logPath));
    if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&fs.existsSync(logPath)&&!fs.lstatSync(logPath).isSymbolicLink()){
      const handle=fs.openSync(logPath,'r');
      try{const size=fs.fstatSync(handle).size,buffer=Buffer.alloc(Math.min(size,8000));fs.readSync(handle,buffer,0,buffer.length,Math.max(0,size-buffer.length));failureLog+='\n'+buffer.toString();}
      finally{fs.closeSync(handle);}
    }
  }
  const diagnostic=failureLog.replace(/https?:\/\/[^\s]+/g,'[url]').replaceAll(root,'[temporary-profile]').replaceAll(source,'[plugin-source]');
  report.diagnostic=diagnostic.slice(-5000);
  if(process.env.DSH_TEST_DIAGNOSTICS==='1')console.error(diagnostic.slice(-12000));
  process.exitCode=1;
}finally{
  try{
    await stop();
    if(installed){
      await run(['plugin','--profile','web','remove','dsh-codex-link']);
      assert.equal(await run(['--profile','web','--dump-config']),baseline,'uninstall must restore baseline composition');
      report.uninstall='passed';report.rollback='passed';report.rollbackMethod='uninstall-and-exact-baseline';
    }
  }catch(error){report.uninstall='failed';report.rollback='failed';report.cleanupError=error.message.slice(0,200);process.exitCode=1;}
  console.log(JSON.stringify(report,null,2));
  if(child&&child.exitCode===null){child.kill('SIGKILL');await new Promise(done=>child.once('exit',done));}
  if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('dsh-sync-profile-'))throw Error('UNSAFE_TEST_CLEANUP');
  fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
