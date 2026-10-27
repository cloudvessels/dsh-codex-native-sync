import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readRelease} from '../release.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),option=name=>{const i=args.indexOf('--'+name);return i<0?null:args[i+1];};
const out=path.resolve(option('out')??path.join(repo,'dist')),release=readRelease(repo);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const status=spawnSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8',windowsHide:true});
if(status.status!==0||status.stdout.trim())throw Error('请先提交或处理工作区改动，再构建发布包');
const git=spawnSync('git',['ls-files','-z'],{cwd:repo,encoding:'utf8',windowsHide:true});if(git.status!==0)throw Error('无法读取已跟踪的发布源码清单');
const files=git.stdout.split('\0').filter(Boolean);
const allowed=file=>!file.startsWith('.git/')&&!file.includes('/node_modules/')&&!file.includes('/data/')&&!file.includes('/evidence/')&&!/\.(?:link-token|sqlite|log|jsonl|bak)$/.test(file)&&!/(?:^|\/)(?:config-v3|link\.config|bindings)\.json$/.test(file);
if(files.some(file=>!allowed(file)))throw Error('源码清单含有机器配置或运行数据，请先检查');
fs.mkdirSync(out,{recursive:true});
const work=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-release-'));
const stages=[];
function populate(name){
 const directory=path.join(work,name);fs.mkdirSync(directory);
 for(const file of files){if(fs.lstatSync(path.join(repo,file)).isSymbolicLink())throw Error('发布源码不能含链接：'+file);const target=path.join(directory,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(repo,file),target);}
 return directory;
}
function archive(directory,name){
 const file=path.join(out,name);if(fs.existsSync(file))throw Error('发布文件已存在，拒绝覆盖：'+file);
 const result=spawnSync('tar',['-a','-cf',file,'-C',directory,'.'],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error(result.stderr||'归档失败');
 stages.push({name,path:file,sha256:sha(fs.readFileSync(file)),bytes:fs.statSync(file).size});
}
try{
 const source=populate('source');archive(source,'dsh-codex-native-sync-'+release.version+'-source.zip');
 const windows=populate('windows'),binaryDir=path.join(windows,'artifacts','windows-x64');fs.mkdirSync(binaryDir,{recursive:true});
 const compiler=option('compiler')??path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
 const binary=path.join(binaryDir,'Codex-DSH-Runtime.exe'),runtimeSource=path.join(repo,'packages','codex-bridge','src','Runtime.cs');
 const built=spawnSync(compiler,['/nologo','/codepage:65001','/target:exe','/platform:x64','/reference:System.Web.Extensions.dll','/out:'+binary,runtimeSource],{encoding:'utf8',windowsHide:true});
 if(built.status!==0)throw Error('编译发布运行库失败：'+built.stdout+built.stderr);
 fs.writeFileSync(path.join(binaryDir,'runtime-build.json'),JSON.stringify({suiteVersion:release.version,architecture:'windows-x64',sha256:sha(fs.readFileSync(binary)),sourceSha256:sha(fs.readFileSync(runtimeSource))},null,2));
 archive(windows,'dsh-codex-native-sync-'+release.version+'-windows-x64.zip');
 fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),stages.map(file=>file.sha256+'  '+file.name).join('\n')+'\n');
 fs.writeFileSync(path.join(out,'release-manifest.json'),JSON.stringify({version:release.version,files:stages.map(({path,...file})=>file),sourceFileCount:files.length},null,2));
 console.log(JSON.stringify({version:release.version,files:stages,checksums:path.join(out,'SHA256SUMS.txt')},null,2));
}finally{
 if(path.dirname(path.resolve(work))!==path.resolve(os.tmpdir())||!path.basename(work).startsWith('dsh-release-'))throw Error('UNSAFE_RELEASE_CLEANUP');
 fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
