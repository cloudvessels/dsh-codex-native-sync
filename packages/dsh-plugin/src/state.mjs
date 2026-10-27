import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function atomicText(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, text);
    for(let attempt=0;;attempt++){
      try{fs.renameSync(temporary,file);break;}
      catch(error){
        if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
        // Bounded retries for Windows sharing violations; never unlink the
        // destination, so readers always see either complete version.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10*(attempt+1));
      }
    }
  }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
export const atomicJson = (file, value) => atomicText(file, JSON.stringify(value, null, 2));
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
export function acquireBindingLock(configFile) {
  const file = configFile + '.migration.lock';
  fs.mkdirSync(path.dirname(file), {recursive:true});
  for (let attempt=0; attempt<2; attempt++) {
    try {
      const fd=fs.openSync(file,'wx');
      try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid})); } finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(file); } catch (error) { if(error.code!=='ENOENT')throw error; } };
    } catch (error) {
      if (error.code!=='EEXIST') throw error;
      const owner=readJson(file,{});
      if(processAlive(owner.pid))throw Error('BINDING_MIGRATION_BUSY');
      fs.unlinkSync(file);
    }
  }
  throw Error('BINDING_MIGRATION_BUSY');
}
export function assertMigrationSettled(configFile) {
  const journal=readJson(configFile+'.migration-journal.json',null);
  if(journal?.phase==='prepared')throw Error('MIGRATION_RECOVERY_REQUIRED: start DSH before restarting the bridge');
}
export function registerBridgeOwner(configFile) {
  const unlock=acquireBindingLock(configFile);
  const file=path.join(configFile+'.owners',process.pid+'.json');
  try { assertMigrationSettled(configFile); atomicJson(file,{pid:process.pid}); }
  finally { unlock(); }
  return () => { try { fs.unlinkSync(file); } catch(error){if(error.code!=='ENOENT')throw error;} };
}
export function assertBridgeOffline(configFile, statusFile) {
  const folder=configFile+'.owners';
  if(fs.existsSync(folder))for(const name of fs.readdirSync(folder)){
    if(!/^\d+\.json$/.test(name))continue;
    const owner=readJson(path.join(folder,name),{});
    if(processAlive(owner.pid))throw Error('CODEX_BRIDGE_MUST_BE_STOPPED');
  }
  const status=statusFile?readJson(statusFile,null):null;
  if(processAlive(status?.pid))throw Error('CODEX_BRIDGE_MUST_BE_STOPPED');
}
