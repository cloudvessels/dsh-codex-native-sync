import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function resolveNativeCli(hint,{cacheDir=path.join(process.env.LOCALAPPDATA??path.join(os.homedir(),'AppData','Local'),'OpenAI','Codex','bin')}={}){
 const usable=file=>typeof file==='string'&&path.isAbsolute(file)&&fs.statSync(file,{throwIfNoEntry:false})?.isFile()&&!/Codex-DSH-Runtime(?:\.exe)?$/i.test(file);
 if(usable(hint))return hint;
 if(typeof hint!=='string'||path.basename(hint).toLowerCase()!=='codex.exe')throw Error('NATIVE_CLI_MISSING');
 const candidates=fs.existsSync(cacheDir)?fs.readdirSync(cacheDir,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(cacheDir,d.name,'codex.exe')).filter(usable):[];
 candidates.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs||a.localeCompare(b));
 if(!candidates.length)throw Error('NATIVE_CLI_MISSING');
 return candidates[0];
}
