import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {readJson,atomicJson,processAlive,assertBridgeOffline,acquireBindingLock} from '../packages/dsh-plugin/src/state.mjs';
import {loadSettings} from '../packages/dsh-plugin/src/settings.mjs';
import {unpackWindowsBundle} from './archive.mjs';
import {resolveNativeCli} from '../packages/codex-bridge/src/native-cli.mjs';

export const SOURCE='cloudvessels/dsh-codex-native-sync';
export const digest=data=>createHash('sha256').update(data).digest('hex');
const parse=value=>{const m=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);if(!m)throw Error('INVALID_UPDATE_VERSION');return {numbers:m.slice(1,4).map(Number),pre:m[4]?.split('.')};};
export function compareVersions(a,b){
  a=parse(a);b=parse(b);for(let i=0;i<3;i++)if(a.numbers[i]!==b.numbers[i])return Math.sign(a.numbers[i]-b.numbers[i]);
  if(!a.pre||!b.pre)return a.pre?-1:b.pre?1:0;
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
    const x=a.pre[i],y=b.pre[i];if(x===y)continue;if(x===undefined)return -1;if(y===undefined)return 1;
    const nx=/^\d+$/.test(x),ny=/^\d+$/.test(y);if(nx&&ny)return Math.sign(Number(x)-Number(y));if(nx!==ny)return nx?-1:1;return x<y?-1:1;
  }return 0;
}
export function selectRelease(releases,current){
  parse(current);
  return releases.filter(r=>{try{return !r.draft&&((!r.prerelease&&!r.tag_name?.includes('-'))||current.includes('-'))&&r.tag_name==='v'+r.tag_name?.slice(1)&&compareVersions(r.tag_name.slice(1),current)>0;}catch{return false;}})
    .sort((a,b)=>compareVersions(b.tag_name.slice(1),a.tag_name.slice(1)))[0];
}
function asset(release,name){const row=release.assets?.find(a=>a.name===name);if(!row)throw Error('UPDATE_ASSET_MISSING: '+name);const url=new URL(row.browser_download_url);if(url.origin!=='https://github.com'||url.pathname!==`/${SOURCE}/releases/download/${release.tag_name}/${name}`||url.search||url.hash)throw Error('UNTRUSTED_UPDATE_URL');return row;}
export async function download(url,limit,fetcher=fetch){
  const response=await fetcher(url,{headers:{'User-Agent':'dsh-codex-native-sync-updater','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error('UPDATE_HTTP_'+response.status);
  if(response.url){const u=new URL(response.url);if(u.protocol!=='https:'||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw Error('UNTRUSTED_UPDATE_REDIRECT');}
  if(Number(response.headers.get('content-length'))>limit)throw Error('UPDATE_DOWNLOAD_TOO_LARGE');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit){await response.body.cancel?.().catch(()=>{});throw Error('UPDATE_DOWNLOAD_TOO_LARGE');}chunks.push(chunk);}return Buffer.concat(chunks);
}
export function updaterPaths(runtime){return {folder:path.join(runtime,'.updates'),status:path.join(runtime,'.updates','status.json'),pending:path.join(runtime,'.updates','pending.json')};}
export async function checkForUpdate(runtime,{fetcher=fetch}={}){
  const record=readJson(path.join(runtime,'.setup','installation.json')),current=record.plan.release.version,p=updaterPaths(runtime);
  const releases=JSON.parse((await download(`https://api.github.com/repos/${SOURCE}/releases?per_page=20`,1024*1024,fetcher)).toString());
  if(!Array.isArray(releases))throw Error('INVALID_UPDATE_RELEASES');
  const release=selectRelease(releases,current);if(!release)return {state:'up-to-date',current};
  const version=release.tag_name.slice(1),filename=`dsh-codex-native-sync-${version}-windows-x64.zip`;
  const manifest=JSON.parse((await download(asset(release,'release-manifest.json').browser_download_url,65536,fetcher)).toString());
  const expected=manifest.files?.find(row=>row.name===filename);
  if(manifest.version!==version||!expected||!Number.isSafeInteger(expected.bytes)||expected.bytes<1||expected.bytes>32*1024*1024||!/[a-f0-9]{64}/.test(expected.sha256)||expected.sha256.length!==64)throw Error('INVALID_UPDATE_MANIFEST');
  const zip=asset(release,filename);
  if(zip.size!==expected.bytes||zip.digest&&zip.digest!=='sha256:'+expected.sha256)throw Error('UPDATE_ASSET_INTEGRITY_MISMATCH');
  const cached=readJson(p.pending,null);
  if(cached?.version===version&&cached.sha256===expected.sha256&&path.dirname(path.resolve(cached.archive))===path.resolve(p.folder)&&fs.existsSync(cached.archive)&&digest(fs.readFileSync(cached.archive))===expected.sha256)return {state:'downloaded',current,version};
  const content=await download(zip.browser_download_url,32*1024*1024,fetcher);
  if(content.length!==expected.bytes||digest(content)!==expected.sha256)throw Error('UPDATE_CHECKSUM_FAILED');
  fs.mkdirSync(p.folder,{recursive:true});
  const archive=path.join(p.folder,version+'-'+randomUUID()+'.zip');fs.writeFileSync(archive,content,{flag:'wx'});
  const pending={version,archive,sha256:expected.sha256,bytes:expected.bytes,releaseId:release.id,downloadedAt:new Date().toISOString()};
  atomicJson(p.pending,pending);return {state:'downloaded',current,version};
}
export function clientsRunning(runtime){
  const record=readJson(path.join(runtime,'.setup','installation.json')),plan=record.plan,config=readJson(plan.configFile,{});
  try{assertBridgeOffline(plan.configFile,config.statusFile);}catch{return true;}
  if(processAlive(readJson(path.join(runtime,'last-launch.json'),{}).pid))return true;
  const local=readJson(path.join(plan.target,'link.config.json'),{}),data=local.dataDir??path.join(path.dirname(plan.configFile),'data','dsh');
  if(processAlive(readJson(path.join(data,'sync-status.json'),{}).pid))return true;
  // Conservatively include desktop windows which have begun launching but have
  // not yet registered their bridge/DSH status. Never terminate these processes.
  if(process.platform==='win32'){
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-Process -Name 'Codex','DeepSeek Harness' -ErrorAction SilentlyContinue).Count"],{encoding:'utf8',windowsHide:true,timeout:10000});
    if(result.status!==0||!/^\d+\s*$/.test(result.stdout))return true;
    if(Number(result.stdout)>0)return true;
  }return false;
}
export function updateEnabled(runtime){const record=readJson(path.join(runtime,'.setup','installation.json'),null);return record?.state==='activated'&&readJson(path.join(runtime,'update.json'),{}).enabled!==false&&loadSettings(record.plan.configFile).autoUpdate;}
export async function applyPendingUpdate(runtime,{busy=clientsRunning,install}={}){
  const p=updaterPaths(runtime),pending=readJson(p.pending,null);if(!pending)return {state:'no-update'};
  if(!updateEnabled(runtime))return {state:'disabled'};
  const prior=readJson(path.join(runtime,'.setup','installation.json')),version=prior.plan.release.version;
  if(compareVersions(pending.version,version)<=0){fs.unlinkSync(p.pending);return {state:'already-installed',version};}
  const unlock=acquireBindingLock(path.join(p.folder,'apply'));
  try{
    if(busy(runtime))return {state:'waiting-for-clients',version:pending.version};
    const relative=path.relative(p.folder,path.resolve(pending.archive));if(relative.startsWith('..')||path.isAbsolute(relative)||path.dirname(relative)!=='.')throw Error('UNSAFE_PENDING_ARCHIVE');
    const content=fs.readFileSync(pending.archive);if(content.length!==pending.bytes||digest(content)!==pending.sha256)throw Error('UPDATE_CACHE_CHECKSUM_FAILED');
    // The installer deliberately refuses source/runtime containment. Extract to
    // a new sibling directory, never inside the active installation tree.
    const source=path.join(path.dirname(runtime),path.basename(runtime)+'.update-stage-'+randomUUID());unpackWindowsBundle(content,source);
    const manifest=readJson(path.join(source,'package.json'));if(manifest.version!==pending.version)throw Error('UPDATE_BUNDLE_VERSION_MISMATCH');
    if(busy(runtime))return {state:'waiting-for-clients',version:pending.version};
    if(!updateEnabled(runtime))return {state:'disabled'};
    if(install)await install(source,prior);
    else{
      // All archives, paths and byte hashes have been checked before executing
      // the updater/installer shipped by the one configured upstream repository.
      const setup=await import(pathToFileURL(path.join(source,'installer','setup.mjs')).href);
      const old=prior.plan,newPlan=setup.createPlan({repository:source,profile:old.profile,runtime,home:old.home,native:resolveNativeCli(old.native),node:old.node,port:old.port,pluginPort:old.pluginPort});
      await setup.prepare(newPlan);
      if(prior.state==='activated')await setup.activate(runtime,{startup:false});
    }
    const result={state:'installed',previous:version,version:pending.version,installedAt:new Date().toISOString()};
    atomicJson(path.join(p.folder,'installed-'+pending.version+'.json'),{...pending,...result});atomicJson(p.status,result);fs.unlinkSync(p.pending);return result;
  }finally{unlock();}
}
