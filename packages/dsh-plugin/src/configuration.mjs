import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readJson} from './state.mjs';

export const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function linkConfiguration(overrides={}, env=process.env) {
  const local=readJson(env.DSH_LINK_CONFIG??path.join(packageRoot,'link.config.json'),{});
  const config={...local,...overrides};
  const bridgeConfig=path.resolve(config.bridgeConfig??env.DSH_BRIDGE_CONFIG??path.join(packageRoot,'..','codex-bridge','config-v3.json'));
  const bridge=readJson(bridgeConfig,{});
  const dataDir=path.resolve(config.dataDir??path.join(path.dirname(bridgeConfig),'data','dsh'));
  return {...config,bridgeConfig,dataDir,
    tokenFile:path.resolve(config.tokenFile??bridge.dshTokenFile??path.join(dataDir,'.link-token')),
    codexStateDb:config.codexStateDb??bridge.codexStateDb??path.join(env.CODEX_HOME??path.join(os.homedir(),'.codex'),'state_5.sqlite'),
    legacyThreadId:config.legacyThreadId??env.DSH_CODEX_THREAD_ID??'',
    legacySourceFile:config.legacySourceFile??env.DSH_CODEX_ROLLOUT??'',
    project:config.project??env.DSH_CODEX_PROJECT??'',
    port:config.port??19389};
}
export function runtimeAnchor(config={}, env=process.env, argv=process.argv) {
  const explicit=config.runtimeAnchor??env.DSH_CORE_PACKAGE;
  if(explicit){if(!path.isAbsolute(explicit)||!fs.existsSync(explicit))throw Error('DSH_RUNTIME_ANCHOR_INVALID');return explicit;}
  // The native host entry is inside DSH's own dependency tree, including ASAR.
  for(const base of [argv[1],fileURLToPath(import.meta.url)]){
    if(!base||!path.isAbsolute(base))continue;
    try{return createRequire(base).resolve('@deepseek-ai/dsh-session');}catch{}
  }
  throw Error('DSH_RUNTIME_NOT_FOUND: set runtimeAnchor in link.config.json or DSH_CORE_PACKAGE');
}
