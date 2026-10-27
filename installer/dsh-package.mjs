import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function installDshPackage({source, profile, bridgeConfig, dry=false, io=fs}) {
  source=path.resolve(source);profile=path.resolve(profile);
  const parent=path.join(profile,'node_modules'), target=path.join(parent,'dsh-codex-link');
  const id=randomUUID(), stage=path.join(parent,'.dsh-codex-link.stage-'+id), backup=target+'.bak-'+id;
  const failed=path.join(parent,'.dsh-codex-link.failed-'+id);
  const manifestPath=path.join(profile,'package.json'), temporary=manifestPath+'.tmp-'+id;
  const original=io.readFileSync(manifestPath,'utf8');
  const manifest=JSON.parse(original.replace(/^\uFEFF/,''));
  const pkg=JSON.parse(io.readFileSync(path.join(source,'package.json'),'utf8'));
  manifest.dependencies={...manifest.dependencies,'dsh-codex-link':'link:'+target.replace(/\\/g,'/')};
  manifest.dsh={...manifest.dsh,profile:{...manifest.dsh?.profile,
    bundles:[...new Set([...(manifest.dsh?.profile?.bundles??[]),'dsh-codex-link'])]}};
  const within=(candidate,base)=>{const rel=path.relative(base,path.resolve(candidate));return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
  for(const candidate of [target,stage,backup,failed])if(!within(candidate,parent))throw Error('UNSAFE_INSTALL_PATH');
  const copy=(from,to)=>{
    const stat=io.lstatSync(from);if(stat.isSymbolicLink())throw Error('SYMLINK_IN_PACKAGE: '+from);
    if(stat.isDirectory()){io.mkdirSync(to,{recursive:true});for(const name of io.readdirSync(from))copy(path.join(from,name),path.join(to,name));}
    else {io.mkdirSync(path.dirname(to),{recursive:true});io.copyFileSync(from,to);}
  };
  if(dry)return {target,dry:true};
  let savedOld=false,promoted=false;
  try {
    io.mkdirSync(stage,{recursive:true});
    // Copy only the declared package payload; never a developer's live data.
    for(const name of ['package.json',...(pkg.files??['lib','src','client.js','cordis.patch.yml'])]){
      const from=path.join(source,name),to=path.join(stage,name);
      if(!within(from,source)||!within(to,stage))throw Error('UNSAFE_PACKAGE_FILE');
      if(io.existsSync(from))copy(from,to);
    }
    for(const name of ['link.config.json','data']){
      const from=path.join(target,name);if(io.existsSync(from))copy(from,path.join(stage,name));
    }
    if(!io.existsSync(path.join(stage,'link.config.json'))){
      io.writeFileSync(path.join(stage,'link.config.json'),JSON.stringify({bridgeConfig:path.resolve(bridgeConfig)},null,2));
    }
    io.writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n');
    // Neither live file is touched until staging and manifest parsing succeed.
    if(io.existsSync(target)){io.renameSync(target,backup);savedOld=true;}
    io.renameSync(stage,target);promoted=true;
    io.renameSync(temporary,manifestPath);
    return {target,backup:savedOld?backup:null,dry:false};
  } catch(error) {
    const recovery=[];
    try {if(promoted&&io.existsSync(target))io.renameSync(target,failed);}catch(e){recovery.push(e.message);}
    try {if(savedOld)io.renameSync(backup,target);}catch(e){recovery.push(e.message);}
    // Retain staging/failed artifacts for diagnosis; never recursively remove
    // an existing installation or its data in the failure branch.
    try {if(io.existsSync(temporary))io.unlinkSync(temporary);}catch(e){recovery.push(e.message);}
    throw Error((recovery.length?'安装失败，恢复未完成：':'安装失败，原安装保持/恢复：')+error.message+
      (recovery.length?'；备份：'+backup+'；'+recovery.join('; '):''));
  }
}
