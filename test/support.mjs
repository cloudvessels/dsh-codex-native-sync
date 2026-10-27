import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sync-fix-')),cleanups=[];
  t.after(async()=>{
    for(const cleanup of cleanups.reverse())await cleanup();
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('dsh-sync-fix-'))throw Error('UNSAFE_TEST_CLEANUP');
    // Native Windows processes can briefly retain a directory handle after exit.
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  return {dir,cleanups};
}
export const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
