import fs from 'node:fs';
import path from 'node:path';
import {crc32} from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,write} from './support.mjs';
import {readJson,atomicJson} from '../packages/dsh-plugin/src/state.mjs';
import {compareVersions,selectRelease,checkForUpdate,applyPendingUpdate,download,digest,SOURCE,updateEnabled} from '../updater/update.mjs';
import {unpackWindowsBundle} from '../updater/archive.mjs';

function bundle(t){
  const f=fixture(t),runtime=path.join(f.dir,'runtime'),version='0.3.4-preview.1',source=path.join(f.dir,'source');
  write(path.join(source,'package.json'),JSON.stringify({version}));write(path.join(source,'payload.txt'),'public program only');
  // Generate an actual ZIP independently of GNU/BSD tar and shell PATH.
  const locals=[],central=[];let offset=0;
  for(const file of ['package.json','payload.txt']){
    const name=Buffer.from(file),data=fs.readFileSync(path.join(source,file)),sum=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(sum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt32LE(sum,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    locals.push(local,name,data);central.push(directory,name);offset+=local.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(2,8);end.writeUInt16LE(2,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  const bytes=Buffer.concat([...locals,directory,end]),name=`dsh-codex-native-sync-${version}-windows-x64.zip`,url=file=>`https://github.com/${SOURCE}/releases/download/v${version}/${file}`;
  const release={id:42,tag_name:'v'+version,prerelease:true,draft:false,assets:[{name,size:bytes.length,digest:'sha256:'+digest(bytes),browser_download_url:url(name)},{name:'release-manifest.json',browser_download_url:url('release-manifest.json')}]};
  const manifest={version,files:[{name,bytes:bytes.length,sha256:digest(bytes)}]};
  const config=path.join(runtime,'data','config.json');
  atomicJson(path.join(runtime,'.setup/installation.json'),{state:'activated',plan:{release:{version:'0.3.3-preview.1'},configFile:config}});
  const fetcher=async url=>new Response(url.includes('/releases?')?JSON.stringify([release]):url.endsWith('release-manifest.json')?JSON.stringify(manifest):bytes);
  return {...f,runtime,version,source,bytes,release,manifest,fetcher};
}
test('updater compares numeric prerelease versions and respects stable/preview channels',()=>{
  assert(compareVersions('0.3.4-preview.10','0.3.4-preview.2')>0);assert(compareVersions('0.3.4','0.3.4-preview.10')>0);
  const releases=[{tag_name:'v0.3.4-preview.1',prerelease:true},{tag_name:'v0.3.3',prerelease:false},{tag_name:'v9.0.0',draft:true},{tag_name:'not-a-version'}];
  assert.equal(selectRelease(releases,'0.3.2').tag_name,'v0.3.3');assert.equal(selectRelease(releases,'0.3.3-preview.1').tag_name,'v0.3.4-preview.1');
  assert.equal(selectRelease(releases,'0.3.4'),undefined);
});
test('new release is downloaded, checked and cached without touching installed code or chat data',async t=>{
  const f=bundle(t),chat=path.join(f.runtime,'data','chat.json');write(chat,'keep exact history');
  assert.equal((await checkForUpdate(f.runtime,{fetcher:f.fetcher})).state,'downloaded');
  const pending=readJson(path.join(f.runtime,'.updates/pending.json'));assert.equal(digest(fs.readFileSync(pending.archive)),digest(f.bytes));
  assert.equal(fs.readFileSync(chat,'utf8'),'keep exact history');assert.equal(readJson(path.join(f.runtime,'.setup/installation.json')).plan.release.version,'0.3.3-preview.1');
});
test('wrong checksum, foreign repository URL and oversized responses are rejected before installation',async t=>{
  const f=bundle(t);f.manifest.files[0].sha256='0'.repeat(64);
  await assert.rejects(checkForUpdate(f.runtime,{fetcher:f.fetcher}),/INTEGRITY/);assert(!fs.existsSync(path.join(f.runtime,'.updates/pending.json')));
  f.manifest.files[0].sha256=digest(f.bytes);f.release.assets[0].browser_download_url='https://github.com/attacker/fork/releases/download/v'+f.version+'/a.zip';
  await assert.rejects(checkForUpdate(f.runtime,{fetcher:f.fetcher}),/UNTRUSTED_UPDATE_URL/);
  await assert.rejects(download('https://api.github.com/',4,async()=>new Response('12345')),/TOO_LARGE/);
});
test('busy clients defer installation; an idle retry applies once and does not downgrade',async t=>{
  const f=bundle(t);await checkForUpdate(f.runtime,{fetcher:f.fetcher});let installs=0;
  const install=async(source,prior)=>{installs++;assert.equal(fs.readFileSync(path.join(source,'payload.txt'),'utf8'),'public program only');atomicJson(path.join(f.runtime,'.setup/installation.json'),{...prior,plan:{...prior.plan,release:{version:f.version}}});};
  assert.equal((await applyPendingUpdate(f.runtime,{busy:()=>true,install})).state,'waiting-for-clients');assert.equal(installs,0);
  assert.equal((await applyPendingUpdate(f.runtime,{busy:()=>false,install})).state,'installed');assert.equal(installs,1);
  assert.equal((await applyPendingUpdate(f.runtime,{busy:()=>false,install})).state,'no-update');assert.equal(installs,1);
  atomicJson(path.join(f.runtime,'.updates/pending.json'),{version:'0.3.2'});
  assert.equal((await applyPendingUpdate(f.runtime,{busy:()=>false,install})).state,'already-installed');assert.equal(installs,1);
});
test('disabled updates and corrupted cached downloads never execute the installer',async t=>{
  const f=bundle(t);await checkForUpdate(f.runtime,{fetcher:f.fetcher});
  atomicJson(path.join(f.runtime,'update.json'),{enabled:false});assert.equal(updateEnabled(f.runtime),false);
  assert.equal((await applyPendingUpdate(f.runtime)).state,'disabled');
  atomicJson(path.join(f.runtime,'update.json'),{enabled:true});const pending=readJson(path.join(f.runtime,'.updates/pending.json'));fs.appendFileSync(pending.archive,'tamper');
  await assert.rejects(applyPendingUpdate(f.runtime,{busy:()=>false,install:async()=>assert.fail('must not execute')}),/CACHE_CHECKSUM/);
  assert(!fs.existsSync(path.join(f.runtime,'.updates/apply.migration.lock')));
});
test('ZIP validates all entries and refuses path traversal, links and overwriting existing directories',t=>{
  const f=bundle(t),target=path.join(f.dir,'unpacked');assert.equal(unpackWindowsBundle(f.bytes,target),2);
  assert.equal(fs.readFileSync(path.join(target,'payload.txt'),'utf8'),'public program only');
  assert.throws(()=>unpackWindowsBundle(f.bytes,target),/TARGET_EXISTS/);
  const bad=Buffer.from(f.bytes);const old=Buffer.from('payload.txt'),evil=Buffer.from('../evil.txt');
  for(let at=0;(at=bad.indexOf(old,at))>=0;at+=old.length)evil.copy(bad,at);
  assert.throws(()=>unpackWindowsBundle(bad,path.join(f.dir,'bad')),/UNSAFE_UPDATE_PATH/);assert(!fs.existsSync(path.join(f.dir,'bad')));
  const link=Buffer.from(f.bytes);let entry=link.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));link.writeUInt32LE(0xa1ff0000,entry+38);
  assert.throws(()=>unpackWindowsBundle(link,path.join(f.dir,'link')),/UNSUPPORTED_UPDATE_ENTRY/);
});
