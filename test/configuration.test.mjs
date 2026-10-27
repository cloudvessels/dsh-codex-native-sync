import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {linkConfiguration,runtimeAnchor} from '../packages/dsh-plugin/src/configuration.mjs';
import {acquireBindingLock,registerBridgeOwner,assertBridgeOffline,assertMigrationSettled,atomicJson} from '../packages/dsh-plugin/src/state.mjs';
import {fixture,write} from './support.mjs';
test('runtime path comes from configured/native host dependencies, never a fixed drive',t=>{
  const {dir}=fixture(t),anchor=path.join(dir,'different-drive-simulated','package.json');write(anchor,'{}');
  assert.equal(runtimeAnchor({runtimeAnchor:anchor},{},[]),anchor);
  assert.throws(()=>runtimeAnchor({}, {}, []),/DSH_RUNTIME_NOT_FOUND/);
  const config=linkConfiguration({bridgeConfig:path.join(dir,'config.json')},{});
  assert.equal(config.legacyThreadId,'');assert.equal(config.legacySourceFile,'');
});
test('bridge ownership blocks migration and a migration blocks new bridge ownership',t=>{
  const {dir}=fixture(t),config=path.join(dir,'config.json');
  const release=registerBridgeOwner(config);
  assert.throws(()=>assertBridgeOffline(config),/CODEX_BRIDGE_MUST_BE_STOPPED/);release();assertBridgeOffline(config);
  const unlock=acquireBindingLock(config);assert.throws(()=>registerBridgeOwner(config),/BINDING_MIGRATION_BUSY/);unlock();
  atomicJson(config+'.migration-journal.json',{phase:'prepared'});assert.throws(()=>assertMigrationSettled(config),/MIGRATION_RECOVERY_REQUIRED/);
});
