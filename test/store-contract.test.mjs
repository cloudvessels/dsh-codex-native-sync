import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {installDshPackage} from '../installer/dsh-package.mjs';
import {fixture,write} from './support.mjs';

const source=fileURLToPath(new URL('../packages/dsh-plugin',import.meta.url));
test('DSH package installs its declared entry, license and user instructions without overriding official entries',t=>{
  const f=fixture(t),profile=path.join(f.dir,'profile');
  write(path.join(profile,'package.json'),'{"private":true}');
  const {target}=installDshPackage({source,profile,bridgeConfig:path.join(f.dir,'bridge.json')});
  const manifest=JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8'));
  for(const file of [manifest.main,manifest.exports['./client'],manifest.dsh.bundle.patch,'README.md','LICENSE','SECURITY.md']){
    assert(fs.statSync(path.resolve(target,file)).isFile(),file+' missing from installed package');
  }
  assert.match(fs.readFileSync(path.join(target,'LICENSE'),'utf8'),/Permission is hereby granted/);
  const patch=fs.readFileSync(path.join(target,manifest.dsh.bundle.patch),'utf8');
  assert.equal(patch.split(/\r?\n/).filter(line=>/^-\s/.test(line)).length,1,'only the plugin insertion may be a top-level patch');
  assert.match(patch,/^- insert:/);
  assert.deepEqual([...patch.matchAll(/\bid:\s*(\S+)/g)].map(match=>match[1]),['codex-native-sync']);
  assert.equal(manifest.repository.directory,'packages/dsh-plugin');
  assert.equal(Object.keys(manifest.scripts??{}).filter(name=>['preinstall','install','postinstall','prepare'].includes(name)).length,0);
});
