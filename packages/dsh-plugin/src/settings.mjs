import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson, readJson} from './state.mjs';

export const SWITCHES = ['enabled', 'autoBind', 'reverseBind', 'archiveMirror', 'autoUpdate', 'syncSteps'];
export function normalizeSettings(value = {}) {
  return {enabled: value.enabled !== false, autoBind: value.autoBind !== false,
    reverseBind: value.reverseBind === true, archiveMirror: value.archiveMirror === true, autoUpdate:value.autoUpdate !== false, syncSteps:value.syncSteps === true};
}
export function settingsPath(configPath) {
  return path.join(path.dirname(configPath), 'data', 'settings.json');
}
export function publishSettings(configPath, settings) {
  const file = settingsPath(configPath), value = normalizeSettings(settings);
  const previous=readJson(file,{});
  if(value.syncSteps){
    const same=previous.syncSteps===true&&typeof previous.operationEpoch==='string';
    value.operationEpoch=same?previous.operationEpoch:randomUUID();value.operationEnabledAt=same?previous.operationEnabledAt??Date.now():Date.now();
  }else if(typeof previous.operationEpoch==='string'){value.operationEpoch=previous.operationEpoch;value.operationEnabledAt=previous.operationEnabledAt;}
  fs.mkdirSync(path.dirname(file), {recursive: true});
  atomicJson(file, value);
  return {file, value};
}
// Read switches only; the bridge owns its independently persisted bindings.
export function loadSettings(configPath, base = {}) {
  const file = base.settingsFile ?? settingsPath(configPath);
  const value={...base,...readJson(file,{})};
  return {...normalizeSettings(value),operationEpoch:typeof value.operationEpoch==='string'?value.operationEpoch:null,operationEnabledAt:Number.isSafeInteger(value.operationEnabledAt)?value.operationEnabledAt:0};
}
