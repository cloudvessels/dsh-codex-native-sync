import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {fixture,write} from './support.mjs';
import {Client} from './rpc-client.mjs';
import {createPlan,prepare,activate,rollbackSetup} from '../installer/setup.mjs';
import {SetupTransaction} from '../installer/transaction.mjs';
import {readJson} from '../packages/dsh-plugin/src/state.mjs';

const compiler=process.env.CSC_TEST_PATH??path.join(process.env.WINDIR??'','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const available=process.platform==='win32'&&process.env.CODEX_TEST_CLI&&fs.existsSync(compiler);
async function setupFixture(t){
  const f=fixture(t),profile=path.join(f.dir,'DSH profile'),runtime=path.join(f.dir,'runtime with spaces'),home=path.join(f.dir,'codex-home');
  const original='model="gpt-5.1"\nmodel_provider="no_inference"\n[model_providers.no_inference]\nname="Isolated setup test"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n';
  write(path.join(profile,'package.json'),'\uFEFF{"private":true,"dependencies":{"keep":"1"}}');write(path.join(home,'config.toml'),original);
  const servers=[net.createServer(),net.createServer()];
  for(const server of servers)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const [port,pluginPort]=servers.map(server=>server.address().port);
  for(const server of servers)await new Promise(resolve=>server.close(resolve));
  const plan=createPlan({profile,runtime,home,native:process.env.CODEX_TEST_CLI,compiler,port,pluginPort});
  return {...f,profile,runtime,home,original,plan};
}
test('prepared installation registers a real native plugin, boots its runtime and restores prior setup',{skip:!available},async t=>{
  const f=await setupFixture(t),profileFile=path.join(f.profile,'package.json'),before=fs.readFileSync(profileFile,'utf8');
  assert.equal((await prepare(f.plan)).state,'ready');
  const token=fs.readFileSync(readJson(f.plan.configFile).dshTokenFile,'utf8');assert.equal(token.length,64);
  const version=spawnSync(path.join(f.runtime,'Codex-DSH-Runtime.exe'),['--version'],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(version.status,0,version.stderr);
  let setting=null;const environment={get:async()=>setting,set:async value=>{setting=value;}};
  const result=await activate(f.runtime,{environment});assert.equal(result.state,'activated');assert.equal(setting,path.join(f.runtime,'Codex-DSH-Runtime.exe'));
  await activate(f.runtime,{environment});
  assert.equal(SetupTransaction.load(f.runtime).data.environment.before,null);
  assert.match(fs.readFileSync(path.join(f.home,'config.toml'),'utf8'),/dsh-chat-sync@dsh-local-sync/);
  const client=new Client(setting,['app-server','--analytics-default-enabled'],{CODEX_HOME:path.join(f.dir,'wrong-home'),DSH_BRIDGE_CONFIG:path.join(f.dir,'wrong-config.json')});
  f.cleanups.push(()=>client.close());await client.initialize();
  assert.equal(readJson(path.join(f.runtime,'last-launch.json')).mode,'bridge');
  await assert.rejects(rollbackSetup(f.runtime,environment),/CODEX_BRIDGE_MUST_BE_STOPPED|正常退出/);
  const spec=readJson(path.join(f.runtime,'marketplace/plugins/dsh-chat-sync/.mcp.json')).mcpServers.dsh_chat_sync;
  const mcp=new Client(spec.command,spec.args,spec.env);f.cleanups.push(()=>mcp.close());
  await mcp.request('initialize',{protocolVersion:'2024-11-05'});
  const tools=await mcp.request('tools/list');assert(tools.tools.some(tool=>tool.name==='sync_status'));
  const snapshot=await mcp.request('tools/call',{name:'sync_status',arguments:{}});assert.equal(JSON.parse(snapshot.content[0].text).mode,'multi');
  assert.equal((await mcp.request('tools/call',{name:'sync_pause',arguments:{}})).isError,false);
  assert.equal(readJson(readJson(f.plan.configFile).pluginControlFile).enabled,false);
  await mcp.request('tools/call',{name:'sync_resume',arguments:{}});
  await mcp.close();await client.close();
  await rollbackSetup(f.runtime,environment);
  assert.equal(setting,null);assert.equal(fs.readFileSync(profileFile,'utf8'),before);assert.equal(fs.readFileSync(path.join(f.home,'config.toml'),'utf8'),f.original);
  assert(fs.existsSync(f.plan.configFile));assert.equal(fs.readFileSync(readJson(f.plan.configFile).dshTokenFile,'utf8'),token);
  assert(!fs.existsSync(path.join(f.runtime,'Codex-DSH-Runtime.exe')));
});
test('a preparation failure restores an existing DSH profile and keeps unrelated data',{skip:!available},async t=>{
  const f=await setupFixture(t),file=path.join(f.profile,'package.json'),before=fs.readFileSync(file,'utf8');
  const marker=path.join(f.profile,'node_modules/dsh-codex-link/data/retained.txt');write(marker,'retained');
  const existing={bindings:[{threadId:'retained-thread',sessionId:'retained-session'}],nativeCli:f.plan.native,dshUrl:'http://127.0.0.1:'+f.plan.port,
    dshTokenFile:path.join(f.runtime,'data','original-token'),pluginControlFile:path.join(f.runtime,'data','custom-control.json')};
  write(f.plan.configFile,JSON.stringify(existing));write(existing.dshTokenFile,'retain-this-token');write(existing.pluginControlFile,'{"enabled":false}');
  await assert.rejects(prepare(f.plan,{failAfter:'files'}),/INJECTED_PREPARE_FAILURE/);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readFileSync(marker,'utf8'),'retained');assert.deepEqual(readJson(f.plan.configFile),existing);
  assert.equal(fs.readFileSync(existing.dshTokenFile,'utf8'),'retain-this-token');assert.equal(readJson(existing.pluginControlFile).enabled,false);
});
