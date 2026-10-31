import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {fixture,write} from './support.mjs';
import {resolveNativeCli} from '../packages/codex-bridge/src/native-cli.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from './rpc-client.mjs';
test('CLI rotation keeps an existing hint, resolves removed vendor paths and refuses wrapper recursion',t=>{
 const f=fixture(t),cacheDir=path.join(f.dir,'bin'),old=path.join(cacheDir,'old/codex.exe'),newer=path.join(cacheDir,'new/codex.exe');
 write(old,'old');write(newer,'new');fs.utimesSync(old,1,1);fs.utimesSync(newer,2,2);
 assert.equal(resolveNativeCli(old,{cacheDir}),old);
 fs.unlinkSync(old);assert.equal(resolveNativeCli(old,{cacheDir}),newer);
 const wrapper=path.join(f.dir,'Codex-DSH-Runtime.exe');write(wrapper,'wrapper');assert.throws(()=>resolveNativeCli(wrapper,{cacheDir}),/NATIVE_CLI_MISSING/);
 assert.throws(()=>resolveNativeCli(path.join(f.dir,'missing.exe'),{cacheDir}),/NATIVE_CLI_MISSING/);
 fs.unlinkSync(newer);assert.throws(()=>resolveNativeCli(old,{cacheDir}),/NATIVE_CLI_MISSING/);
});
const compiler=path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
test('compiled launcher uses its resolved CLI for both preflight and proxy when configuration paths are stale',{
 skip:process.platform!=='win32'||!process.env.CODEX_TEST_CLI||!fs.existsSync(compiler)
},async t=>{
 const f=fixture(t),repo=fileURLToPath(new URL('..',import.meta.url)),home=path.join(f.dir,'home'),configFile=path.join(f.dir,'config.json');
 const stale=path.join(f.dir,'removed-version/codex.exe'),exe=path.join(f.dir,'Codex-DSH-Runtime.exe');
 write(path.join(home,'config.toml'),'[plugins."dsh-chat-sync@dsh-local-sync"]\nenabled=true\n');
 write(path.join(f.dir,'control.json'),'{"enabled":true}');
 write(configFile,JSON.stringify({nativeCli:stale,bindings:[],enabled:false,statusFile:path.join(f.dir,'status.json'),watchDir:f.dir}));
 write(path.join(f.dir,'native.path'),process.env.CODEX_TEST_CLI);
 write(path.join(f.dir,'runtime.json'),JSON.stringify({home,project:repo,node:process.execPath,nativeCli:stale,config:configFile,controlFile:path.join(f.dir,'control.json'),proxy:path.join(repo,'packages/codex-bridge/proxy-v3.mjs'),preflight:path.join(repo,'packages/codex-bridge/src/runtime-preflight.mjs')}));
 const built=spawnSync(compiler,['/nologo','/target:exe','/reference:System.Web.Extensions.dll','/out:'+exe,path.join(repo,'packages/codex-bridge/src/Runtime.cs')],{encoding:'utf8',windowsHide:true});
 assert.equal(built.status,0,built.stdout+built.stderr);
 const client=new Client(exe,['app-server','--analytics-default-enabled'],{DSH_SYNC_DISABLE_UPDATES:'1'});f.cleanups.push(()=>client.close());await client.initialize();
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'last-launch.json'))).mode,'bridge');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'status.json'))).initialized,true);
});
