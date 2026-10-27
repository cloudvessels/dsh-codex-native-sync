import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {processAlive,readJson} from './state.mjs';
import {publishSettings} from './settings.mjs';
import {linkConfiguration, runtimeAnchor} from './configuration.mjs';

// DSH resolves its own packages against the app package; resolve the same way here.
const defaults = linkConfiguration();
const anchor = runtimeAnchor(defaults);
const require = createRequire(anchor);
const {Service} = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const z = (await import(pathToFileURL(require.resolve('@deepseek-ai/schemastery')).href)).default;

const DEFAULT_BRIDGE_CONFIG = process.env.DSH_BRIDGE_CONFIG_SCHEMA_PATH
  ?? defaults.bridgeConfig;

export default class CodexNativeSync {
  static inject = ['sessionController', 'sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'sessionTitle'];
  static Config = z.object({
    enabled: z.boolean().default(true).description('总开关：关闭后不再同步任何聊天').volatile(),
    autoBind: z.boolean().default(true).description('新 Codex 聊天自动接入 DSH').volatile(),
    reverseBind: z.boolean().default(false).description('新 DSH 聊天自动在 Codex 建对应聊天').volatile(),
    archiveMirror: z.boolean().default(false).description('Codex 归档/恢复跟随到 DSH').volatile(),
    autoUpdate: z.boolean().default(true).description('自动下载新版本；两端退出后安装').volatile(),
    syncSteps: z.boolean().default(false).description('将 Codex 工具操作同步到 DSH，会占用上下文').volatile(),
    bridgeConfig: z.string().default(DEFAULT_BRIDGE_CONFIG).description('Codex 桥接配置文件路径'),
  });

  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }

  async *[Service.init]() {
    const config = this.config ?? {};
    const bridgeConfig = config.bridgeConfig ?? DEFAULT_BRIDGE_CONFIG;
    const root=defaults.updateRuntime;
    if(root){
      const lock=path.join(root,'.updates','apply.migration.lock');
      const until=Date.now()+60000;
      while(processAlive(readJson(lock,{}).pid)){if(Date.now()>until)throw Error('UPDATE_IN_PROGRESS');await delay(200);}
    }
    const {apply:coreApply}=await import('./plugin-core.mjs');
    const current = () => Object.fromEntries(['enabled', 'autoBind', 'reverseBind', 'archiveMirror', 'autoUpdate', 'syncSteps'].map(key => [key, config[key]?.get?.() ?? config[key]]));
    let last = '';
    const publish = () => {
      const settings = current(), next = JSON.stringify(settings);
      if (next === last) return;
      publishSettings(bridgeConfig, settings); last = next;
      if(root&&settings.autoUpdate!==false&&process.env.DSH_SYNC_DISABLE_UPDATES!=='1'){
        const spec=readJson(path.join(root,'runtime.json'),{}),worker=path.join(root,'suite','updater','worker.mjs');
        if(spec.node&&fs.existsSync(worker)){
          const child=spawn(spec.node,[worker,'--runtime',root],{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
        }
      }
    };
    publish();
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        try { publish(); } catch (error) { this.ctx.logger?.warn?.('Cannot apply sync settings: ' + error.message); }
      }, 500);
      timer.unref(); return () => clearInterval(timer);
    }, 'codex-link: live settings');
    yield await coreApply(this.ctx, {bridgeConfig, runtimeAnchor:anchor});
    this.ctx.logger?.info?.(
      '[codex-link] 已启动：文字同步、可选操作同步，设置实时生效',
    );
  }
}
