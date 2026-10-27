import fs from 'node:fs';
import path from 'node:path';
import {atomicJson, readJson} from './state.mjs';

export const SWITCHES = ['enabled', 'autoBind', 'reverseBind', 'archiveMirror', 'autoUpdate'];
export function normalizeSettings(value = {}) {
  return {enabled: value.enabled !== false, autoBind: value.autoBind !== false,
    reverseBind: value.reverseBind === true, archiveMirror: value.archiveMirror === true, autoUpdate:value.autoUpdate !== false, syncSteps: false};
}
export function settingsPath(configPath) {
  return path.join(path.dirname(configPath), 'data', 'settings.json');
}
export function publishSettings(configPath, settings) {
  const file = settingsPath(configPath), value = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  atomicJson(file, value);
  return {file, value};
}
// Read switches only; the bridge owns its independently persisted bindings.
export function loadSettings(configPath, base = {}) {
  const file = base.settingsFile ?? settingsPath(configPath);
  return normalizeSettings({...base, ...readJson(file, {})});
}
