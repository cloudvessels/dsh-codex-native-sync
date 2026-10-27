import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {readRelease} from '../release.mjs';
import {readJson,processAlive,assertBridgeOffline,acquireBindingLock} from '../packages/dsh-plugin/src/state.mjs';
import {PLUGIN_ID} from '../packages/codex-bridge/src/activation.mjs';
import {SetupTransaction} from './transaction.mjs';
import {NativeClient} from './rpc.mjs';

export const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const compilerDefault=()=>path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const requiredFile=file=>{if(!path.isAbsolute(file??'')||!fs.statSync(file,{throwIfNoEntry:false})?.isFile())throw Error('缺少有效的绝对文件路径：'+file);return file;};
export function createPlan(options){
  const release=readRelease(options.repository??repository),repo=path.resolve(options.repository??repository);
  if(!options.profile||!options.runtime)throw Error('请明确指定 --profile 和 --runtime，避免接入错误的数据目录');
  const profile=path.resolve(options.profile),runtime=path.resolve(options.runtime),home=path.resolve(options.home??process.env.CODEX_HOME??path.join(os.homedir(),'.codex'));
  const contains=(base,target)=>{const relative=path.relative(base,target);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
  if(contains(repo,runtime)||contains(runtime,repo))throw Error('运行目录与源码仓库不能相互包含，请选择独立的固定目录');
  const manifest=readJson(path.join(profile,'package.json'),null);if(!manifest)throw Error('DSH profile 不存在：'+profile);
  const native=requiredFile(options.native),node=requiredFile(options.node??process.execPath);
  const bundled=path.join(repo,'artifacts','windows-x64','Codex-DSH-Runtime.exe');
  const runtimeBinary=options.runtimeBinary??(fs.existsSync(bundled)?bundled:null);
  const compiler=runtimeBinary?null:requiredFile(options.compiler??compilerDefault());
  if(runtimeBinary){
    requiredFile(runtimeBinary);
    const metadata=readJson(path.join(path.dirname(runtimeBinary),'runtime-build.json'),null);
    const digest=value=>createHash('sha256').update(value).digest('hex');
    if(!metadata||metadata.suiteVersion!==release.version||metadata.sha256!==digest(fs.readFileSync(runtimeBinary))||metadata.sourceSha256!==digest(fs.readFileSync(path.join(repo,'packages/codex-bridge/src/Runtime.cs'))))throw Error('预编译运行库的版本或完整性检查失败');
  }
  if(/Codex-DSH-Runtime(?:\.exe)?$/i.test(native))throw Error('--native-cli 必须指向原生 Codex，不能指向同步运行库');
  const port=Number(options.port??19389),pluginPort=Number(options.pluginPort??19390);
  if(!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(pluginPort)||pluginPort<1||pluginPort>65535||port===pluginPort)throw Error('两个本机端口必须是不同的 1–65535 整数');
  const configFile=path.join(runtime,'data','config-v3.json'),target=path.join(profile,'node_modules','dsh-codex-link');
  const prior=readJson(path.join(target,'link.config.json'),null);
  if(prior&&path.resolve(prior.bridgeConfig??'')!==configFile)throw Error('现有 DSH 安装指向另一份共享库，请先按维护说明迁移；不会自动改绑');
  const existing=readJson(configFile,null);assertBridgeOffline(configFile,existing?.statusFile);
  if(processAlive(readJson(path.join(runtime,'last-launch.json'),{}).pid))throw Error('请先正常退出使用此运行库的 Codex');
  const previous=readJson(path.join(runtime,'.setup','installation.json'),null);
  if(previous&&!['ready','activated','rolled-back'].includes(previous.state))throw Error('上次安装尚未结束，请先 --rollback');
  return {repo,release,profile,runtime,home,native,node,compiler,runtimeBinary,port,pluginPort,configFile,target,
    actions:['复制配套源码到固定运行目录',runtimeBinary?'安装已核对的预编译 Windows 运行库':'编译 Windows 运行库','生成连接配置和令牌，保留已有绑定与账本','登记 DSH bundle','生成 Codex 本地插件市场'],writesUserStartup:false};
}
function copyTree(tx,source,target){
  if(fs.lstatSync(source).isSymbolicLink())throw Error('安装源码不能包含链接：'+source);
  if(fs.statSync(source).isDirectory())for(const name of fs.readdirSync(source))copyTree(tx,path.join(source,name),path.join(target,name));
  else tx.write(target,fs.readFileSync(source));
}
export async function prepare(plan,{failAfter}={}){
  const unlock=acquireBindingLock(path.join(plan.runtime,'.setup','setup'));
  try{plan=createPlan({...plan,repository:plan.repo});}catch(error){unlock();throw error;}
  let tx;const bridge=path.join(plan.runtime,'suite','packages','codex-bridge');
  try{
    tx=new SetupTransaction(plan.runtime);
    tx.data.plan=plan;tx.save();
    const checked=spawnSync(plan.native,['--version'],{encoding:'utf8',windowsHide:true,timeout:10000});
    if(checked.status!==0||!/codex/i.test(checked.stdout))throw Error('原生 Codex 版本检查失败，请核对 --native-cli');
    for(const component of ['codex-bridge','dsh-plugin']){
      const source=path.join(plan.repo,'packages',component),target=path.join(plan.runtime,'suite','packages',component);
      const names=component==='codex-bridge'?['package.json','history.mjs','text-sync.mjs','proxy-v3.mjs','src']:['package.json','lib','src','client.js','cordis.patch.yml','link.config.example.json'];
      for(const name of names)copyTree(tx,path.join(source,name),path.join(target,name));
    }
    const build=path.join(plan.runtime,'.setup','build-'+randomUUID()),exe=path.join(build,'Codex-DSH-Runtime.exe');fs.mkdirSync(build,{recursive:true});
    if(!plan.runtimeBinary){
      const compiled=spawnSync(plan.compiler,['/nologo','/codepage:65001','/target:exe','/reference:System.Web.Extensions.dll','/out:'+exe,path.join(bridge,'src','Runtime.cs')],{encoding:'utf8',windowsHide:true});
      if(compiled.status!==0)throw Error('运行库编译失败：'+compiled.stdout+compiled.stderr);
    }
    tx.write(path.join(plan.runtime,'Codex-DSH-Runtime.exe'),fs.readFileSync(plan.runtimeBinary??exe));
    tx.write(path.join(plan.runtime,'native.path'),plan.native);
    const data=path.join(plan.runtime,'data'),defaultControl=path.join(data,'control.json'),token=path.join(data,'.link-token');
    const old=readJson(plan.configFile,null);
    const config=old??{bindings:[],nativeCli:plan.native,dshUrl:'http://127.0.0.1:'+plan.port,dshTokenFile:token,
      statusFile:path.join(data,'status-v2.json'),watchDir:data,ledgerDir:path.join(data,'ledgers'),pluginControlFile:defaultControl,
      codexStateDb:path.join(plan.home,'state_5.sqlite'),pluginPort:plan.pluginPort,discoveryMs:5000,reconcileMs:1000,forwardMs:1000,debounceMs:250};
    if(old&&(old.nativeCli!==plan.native||old.dshUrl!=='http://127.0.0.1:'+plan.port))throw Error('已有配置与本次原生程序/端口不同；请先核对，不会覆盖');
    const control=config.pluginControlFile??defaultControl;
    // The shared library may acquire live bindings after setup. Rollback must
    // retain its configuration, token and controls along with chat/ledger data.
    if(!old)tx.json(plan.configFile,config,{retain:true});
    if(!fs.existsSync(config.dshTokenFile))tx.write(config.dshTokenFile,randomBytes(32).toString('hex'),{retain:true});
    if(!fs.existsSync(control))tx.json(control,{enabled:true},{retain:true});
    tx.json(path.join(plan.runtime,'runtime.json'),{project:path.join(plan.runtime,'suite'),home:plan.home,node:plan.node,nativeCli:plan.native,
      proxy:path.join(bridge,'proxy-v3.mjs'),preflight:path.join(bridge,'src','runtime-preflight.mjs'),config:plan.configFile,controlFile:control});
    const dshSource=path.join(plan.runtime,'suite','packages','dsh-plugin');
    for(const name of ['package.json','lib','src','client.js','cordis.patch.yml','link.config.example.json'])copyTree(tx,path.join(dshSource,name),path.join(plan.target,name));
    if(!fs.existsSync(path.join(plan.target,'link.config.json')))tx.json(path.join(plan.target,'link.config.json'),{bridgeConfig:plan.configFile,port:plan.port});
    const manifestFile=path.join(plan.profile,'package.json'),manifest=readJson(manifestFile);
    manifest.dependencies={...manifest.dependencies,'dsh-codex-link':'link:'+plan.target.replaceAll('\\','/')};
    manifest.dsh={...manifest.dsh,profile:{...manifest.dsh?.profile,bundles:[...new Set([...(manifest.dsh?.profile?.bundles??[]),'dsh-codex-link'])]}};
    tx.json(manifestFile,manifest);
    const market=path.join(plan.runtime,'marketplace'),plugin=path.join(market,'plugins','dsh-chat-sync');
    tx.json(path.join(plugin,'.codex-plugin','plugin.json'),{name:'dsh-chat-sync',version:plan.release.version,description:'Codex 与 DSH 原生聊天的本地文字同步',requires_local_executor:true,mcpServers:'./.mcp.json',
      interface:{displayName:'DSH 聊天同步',shortDescription:'与 DSH 自动同步聊天文字',capabilities:['Read','Write'],category:'Productivity'}});
    tx.json(path.join(plugin,'.mcp.json'),{mcpServers:{dsh_chat_sync:{command:plan.node,args:[path.join(bridge,'src','server.mjs')],
      env:{DSH_SYNC_PROJECT:path.join(plan.runtime,'suite'),DSH_SYNC_CONFIG:plan.configFile,DSH_SYNC_DATA:path.join(data,'mcp')},startup_timeout_sec:10,default_tools_approval_mode:'approve'}}});
    tx.json(path.join(market,'.agents','plugins','marketplace.json'),{name:'dsh-local-sync',interface:{displayName:'DSH 本地聊天同步'},plugins:[{name:'dsh-chat-sync',source:{source:'local',path:'./plugins/dsh-chat-sync'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]});
    if(failAfter==='files')throw Error('INJECTED_PREPARE_FAILURE');
    tx.data.state='ready';tx.save();return {state:'ready',version:plan.release.version,record:tx.file,runtime:plan.runtime,requiresActivation:true};
  }catch(error){if(tx)await tx.rollback({get:async()=>null,set:async()=>{}});throw error;}
  finally{unlock();}
}
function unrelated(config){const result=structuredClone(config);delete result.plugins?.[PLUGIN_ID];delete result.marketplaces?.['dsh-local-sync'];
  for(const key of ['plugins','marketplaces'])if(result[key]&&Object.keys(result[key]).length===0)delete result[key];return result;}
export function userStartup(){
  const run=(script,input)=>{const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input,encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('用户启动路径设置失败：'+result.stderr);return result.stdout.trim();};
  return {get:async()=>JSON.parse(run("ConvertTo-Json -Compress -InputObject ([Environment]::GetEnvironmentVariable('CODEX_CLI_PATH','User'))")),
    set:async value=>{run("$v=[Console]::In.ReadToEnd()|ConvertFrom-Json; [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH',$v.value,'User')",JSON.stringify({value}));}};
}
export async function activate(runtime,{environment=userStartup(),startup=true}={}){
  const unlock=acquireBindingLock(path.join(path.resolve(runtime),'.setup','setup'));
  try{return await activateLocked(runtime,{environment,startup});}finally{unlock();}
}
async function activateLocked(runtime,{environment,startup}){
  const tx=SetupTransaction.load(path.resolve(runtime)),plan=tx.data.plan;
  if(!['ready','activated'].includes(tx.data.state))throw Error('请先完成 --apply，或处理未完成的回滚');
  assertBridgeOffline(plan.configFile,readJson(plan.configFile).statusFile);
  if(processAlive(readJson(path.join(plan.runtime,'last-launch.json'),{}).pid))throw Error('请先正常退出使用此运行库的 Codex');
  const configFile=path.join(plan.home,'config.toml'),market=path.join(plan.runtime,'marketplace'),marketFile=path.join(market,'.agents','plugins','marketplace.json');
  const cliPath=path.join(plan.runtime,'Codex-DSH-Runtime.exe'),previous=startup?await environment.get():null;
  if(startup&&previous&&path.resolve(previous).toLowerCase()!==cliPath.toLowerCase())throw Error('CODEX_CLI_PATH 已指向另一个程序，未修改；先按维护说明迁移');
  tx.track(configFile);tx.data.state='activating';tx.save();let client;
  try{
    client=new NativeClient(plan.native,plan.home);await client.initialize();
    const before=await client.request('config/read',{includeLayers:true});
    const layer=before.layers?.find(row=>row.name.type==='user'&&path.resolve(row.name.file).toLowerCase()===configFile.toLowerCase()&&row.name.profile==null);
    await client.request('config/batchWrite',{edits:[{keyPath:'marketplaces.dsh-local-sync',value:{source_type:'local',source:market},mergeStrategy:'replace'}],filePath:configFile,...layer?{expectedVersion:layer.version}:{},reloadUserConfig:true});
    tx.capture(configFile);await client.close();client=new NativeClient(plan.native,plan.home);await client.initialize();
    const installed=await client.request('plugin/install',{marketplacePath:marketFile,pluginName:'dsh-chat-sync'});tx.capture(configFile);
    if(installed.appsNeedingAuth?.length)throw Error('本地同步插件不应要求远程账户授权');
    const after=await client.request('config/read',{includeLayers:false});
    if(!isDeepStrictEqual(unrelated(before.config),unrelated(after.config))){tx.track(configFile).keepOnRollback=true;throw Error('检测到其他配置变化，保留当前配置等待核对');}
    const info=await client.request('plugin/read',{marketplacePath:marketFile,pluginName:'dsh-chat-sync'});
    if(!info.plugin.summary.installed||!info.plugin.summary.enabled||!info.plugin.mcpServers.includes('dsh_chat_sync'))throw Error('原生插件登记未通过验证');
    if(startup){tx.data.environment={before:tx.data.environment?tx.data.environment.before:previous,after:cliPath};tx.save();await environment.set(cliPath);if(await environment.get()!==cliPath)throw Error('启动路径写后核对失败');}
    tx.data.state='activated';tx.data.startupChanged=startup;tx.save();return {state:'activated',pluginId:PLUGIN_ID,startupChanged:startup,desktopVerified:false};
  }catch(error){await client?.close();client=null;await tx.rollback(environment);throw error;}
  finally{await client?.close();}
}
export async function rollbackSetup(runtime,environment=userStartup()){
  runtime=path.resolve(runtime);const unlock=acquireBindingLock(path.join(runtime,'.setup','setup'));
  try{
    const tx=SetupTransaction.load(runtime),plan=tx.data.plan;
    assertBridgeOffline(plan.configFile,readJson(plan.configFile,{}).statusFile);
    if(processAlive(readJson(path.join(runtime,'last-launch.json'),{}).pid))throw Error('请先正常退出使用此运行库的 Codex');
    return await tx.rollback(environment);
  }finally{unlock();}
}
