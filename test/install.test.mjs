import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDshPackage} from '../installer/dsh-package.mjs';
import {fixture,write} from './support.mjs';
const source=fileURLToPath(new URL('../packages/dsh-plugin',import.meta.url));
function profile(t){const {dir}=fixture(t),target=path.join(dir,'node_modules/dsh-codex-link');
  write(path.join(dir,'package.json'),'\uFEFF{"private":true,"dependencies":{"keep":"1"}}');
  write(path.join(target,'old-marker'),'old');write(path.join(target,'data','cursor.json'),'{"offset":12}');
  write(path.join(target,'link.config.json'),'{"bridgeConfig":"existing-user-config"}');return {dir,target};}
test('copy failure leaves the original plugin and BOM profile untouched',t=>{
  const {dir,target}=profile(t),before=fs.readFileSync(path.join(dir,'package.json'),'utf8');
  const io={...fs,copyFileSync(){throw Error('INJECTED_COPY_FAILURE');}};
  assert.throws(()=>installDshPackage({source,profile:dir,bridgeConfig:path.join(dir,'bridge.json'),io}),/INJECTED_COPY_FAILURE/);
  assert.equal(fs.readFileSync(path.join(target,'old-marker'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(dir,'package.json'),'utf8'),before);
});
test('manifest publication failure restores the promoted old package and data',t=>{
  const {dir,target}=profile(t),manifest=path.join(dir,'package.json'),before=fs.readFileSync(manifest,'utf8');
  const io={...fs,renameSync(from,to){if(to===manifest)throw Error('INJECTED_MANIFEST_FAILURE');return fs.renameSync(from,to);}};
  assert.throws(()=>installDshPackage({source,profile:dir,bridgeConfig:path.join(dir,'bridge.json'),io}),/INJECTED_MANIFEST_FAILURE/);
  assert.equal(fs.readFileSync(path.join(target,'old-marker'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(target,'data/cursor.json'),'utf8'),'{"offset":12}');
  assert.equal(fs.readFileSync(manifest,'utf8'),before);
});
test('successful upgrade preserves user configuration/data and backs up old files',async t=>{
  const {dir,target}=profile(t),result=installDshPackage({source,profile:dir,bridgeConfig:path.join(dir,'bridge.json')});
  assert.equal(fs.readFileSync(path.join(result.backup,'old-marker'),'utf8'),'old');
  assert.equal(fs.readFileSync(path.join(target,'link.config.json'),'utf8'),'{"bridgeConfig":"existing-user-config"}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target,'data/cursor.json'))).offset,12);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'package.json'))).dependencies.keep,'1');
  // The installed package imports outside the repository; no sibling bridge
  // module is present beside it, and configuration is explicitly overridden.
  write(path.join(target,'link.config.json'),'{}');
  await import(pathToFileURL(path.join(target,'src/plugin-core.mjs')));
  await import(pathToFileURL(path.join(target,'src/settings.mjs')));
});
