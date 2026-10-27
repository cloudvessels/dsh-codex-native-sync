import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readRelease} from '../release.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-codex-pair-'));
  t.after(() => {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('dsh-codex-pair-')) throw Error('Unsafe test cleanup path');
    fs.rmSync(dir, {recursive:true, force:true});
  });
  for (const file of ['install.mjs','release.mjs','installer/dsh-package.mjs','package.json','packages/dsh-plugin/package.json','packages/codex-bridge/package.json']) {
    fs.mkdirSync(path.dirname(path.join(dir,file)), {recursive:true});
    fs.copyFileSync(path.join(root,file),path.join(dir,file));
  }
  const profile = path.join(dir,'profile'), runtime = path.join(dir,'runtime');
  fs.mkdirSync(profile); fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(profile,'package.json'),'{"private":true}');
  fs.writeFileSync(path.join(runtime,process.platform === 'win32' ? 'Codex-DSH-Runtime.exe' : 'Codex-DSH-Runtime'),'dry-run fixture; never execute');
  return {dir,profile,runtime};
}
const run = (dir,...args) => spawnSync(process.execPath,[path.join(dir,'install.mjs'),...args],{encoding:'utf8',windowsHide:true});

test('source release records both matching component versions', () => {
  const release=readRelease(root); assert.equal(release.components.length,2);
  assert.deepEqual(release.components.map(row=>row.name),['dsh-codex-link','dsh-codex-bridge']);
});
test('mismatched pair is refused before any installation writes', t => {
  const {dir,profile,runtime}=fixture(t), file=path.join(dir,'packages/codex-bridge/package.json');
  const manifest=JSON.parse(fs.readFileSync(file));manifest.version='99.0.0';fs.writeFileSync(file,JSON.stringify(manifest));
  const result=run(dir,'--profile',profile,'--runtime',runtime);
  assert.equal(result.status,1);assert.match(result.stderr,/配套组件版本不匹配/);
  assert.deepEqual(fs.readdirSync(profile),['package.json']);assert.equal(fs.readFileSync(path.join(profile,'package.json'),'utf8'),'{"private":true}');
});
test('paired dry-run never says installed and leaves profile untouched', t => {
  const {dir,profile,runtime}=fixture(t), result=run(dir,'--profile',profile,'--runtime',runtime,'--dry');
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/预演通过/);
  assert.doesNotMatch(result.stdout,/两侧都已登记|半残状态/);
  assert.deepEqual(fs.readdirSync(profile),['package.json']);
});
test('one-side update reports the other side as unverified', t => {
  const {dir,profile}=fixture(t), result=run(dir,'--profile',profile,'--dry');
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/另一侧的安装状态尚未核验/);
  assert.doesNotMatch(result.stdout,/半残状态|两侧都已登记/);
});
