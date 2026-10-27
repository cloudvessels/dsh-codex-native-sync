import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,write} from './support.mjs';
import {repository,createPlan} from '../installer/setup.mjs';
import {createHash} from 'node:crypto';
import {SetupTransaction} from '../installer/transaction.mjs';

const environment={get:async()=>null,set:async()=>{throw Error('must not change user environment');}};
test('full setup dry-run lists the installation plan without creating files or changing profiles',t=>{
  const f=fixture(t),profile=path.join(f.dir,'profile'),runtime=path.join(f.dir,'runtime');
  write(path.join(profile,'package.json'),'{"private":true,"dependencies":{"existing":"1"}}');
  const compiler=path.join(f.dir,'compiler.exe');write(compiler,'never execute');
  const before=fs.readFileSync(path.join(profile,'package.json'),'utf8');
  const result=spawnSync(process.execPath,[path.join(repository,'setup.mjs'),'--profile',profile,'--runtime',runtime,
    '--native-cli',process.execPath,'--compiler',compiler,'--codex-home',path.join(f.dir,'home'),'--dry'],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).writes,false);
  assert.equal(fs.readFileSync(path.join(profile,'package.json'),'utf8'),before);assert(!fs.existsSync(runtime));assert(!fs.existsSync(path.join(f.dir,'home')));
});
test('setup rollback restores prior bytes and removes only unchanged generated files',async t=>{
  const f=fixture(t),runtime=path.join(f.dir,'runtime'),old=path.join(f.dir,'existing.json'),added=path.join(f.dir,'generated.json');
  write(old,'\uFEFF{"original":true}');const tx=new SetupTransaction(runtime);tx.write(old,'replacement');tx.write(added,'generated');
  await tx.rollback(environment);assert.equal(fs.readFileSync(old,'utf8'),'\uFEFF{"original":true}');assert(!fs.existsSync(added));
});
test('rollback preserves later edits and reports a conflict instead of deleting them',async t=>{
  const f=fixture(t),file=path.join(f.dir,'configuration.json'),tx=new SetupTransaction(path.join(f.dir,'runtime'));
  tx.write(file,'generated');fs.writeFileSync(file,'later user change');
  await assert.rejects(tx.rollback(environment),/已有后续修改/);assert.equal(fs.readFileSync(file,'utf8'),'later user change');
});
test('rolling back a second preparation restores the first installation and its rollback record',async t=>{
  const f=fixture(t),runtime=path.join(f.dir,'runtime'),file=path.join(f.dir,'program');
  write(file,'original');const first=new SetupTransaction(runtime);first.write(file,'first');first.data.state='ready';first.save();
  const second=new SetupTransaction(runtime);second.write(file,'second');second.data.state='ready';second.save();
  await second.rollback(environment);assert.equal(fs.readFileSync(file,'utf8'),'first');assert.equal(SetupTransaction.load(runtime).data.id,first.data.id);
  await SetupTransaction.load(runtime).rollback(environment);assert.equal(fs.readFileSync(file,'utf8'),'original');
});
test('bundled runtime checks its version, binary and source before skipping compilation',t=>{
  const f=fixture(t),repo=path.join(f.dir,'bundle'),profile=path.join(f.dir,'profile');
  for(const file of ['package.json','packages/dsh-plugin/package.json','packages/codex-bridge/package.json','packages/codex-bridge/src/Runtime.cs'])write(path.join(repo,file),fs.readFileSync(path.join(repository,file)));
  write(path.join(profile,'package.json'),'{"private":true}');
  const binary=path.join(repo,'artifacts/windows-x64/Codex-DSH-Runtime.exe');write(binary,'prebuilt fixture, never execute');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const metadata={suiteVersion:JSON.parse(fs.readFileSync(path.join(repo,'package.json'))).version,sha256:hash(fs.readFileSync(binary)),sourceSha256:hash(fs.readFileSync(path.join(repo,'packages/codex-bridge/src/Runtime.cs')))};
  write(path.join(path.dirname(binary),'runtime-build.json'),JSON.stringify(metadata));
  const options={repository:repo,profile,runtime:path.join(f.dir,'runtime'),native:process.execPath,compiler:path.join(f.dir,'missing-compiler')};
  assert.equal(createPlan(options).compiler,null);assert.equal(createPlan(options).runtimeBinary,binary);
  fs.appendFileSync(binary,'tamper');assert.throws(()=>createPlan(options),/完整性检查失败/);
});
