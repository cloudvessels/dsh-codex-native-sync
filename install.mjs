#!/usr/bin/env node
// 旧版单侧辅助工具；完整的分阶段安装使用 setup.mjs。
// 用法：
//   node install.mjs --profile <DSH profile 目录>
//   node install.mjs --runtime <运行库目录>
//   node install.mjs --profile <...> --runtime <...>
//   node install.mjs --profile <...> --dry        （只报告，不落盘）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readRelease} from './release.mjs';
import {installDshPackage} from './installer/dsh-package.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginSrc = path.join(repoRoot, 'packages', 'dsh-plugin');
const PACKAGE_NAME = 'dsh-codex-link';

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dry = args.includes('--dry');
const profileArg = option('profile');
const runtimeArg = option('runtime');

const steps = [];
const record = (name, ok, detail) => steps.push({name, ok, detail});

function resolveProfileDir() {
  if (profileArg) return path.resolve(profileArg);
  if (process.env.DSH_PROFILE_DIR) return path.resolve(process.env.DSH_PROFILE_DIR);
  const home = process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', 'desktop');
}

function installPlugin(profileDir) {
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    record('DSH 插件', false, `找不到 profile：${profileDir}\\package.json（用 --profile 指定实际目录）`);
    return;
  }
  if (!fs.existsSync(pluginSrc)) {
    record('DSH 插件', false, `仓库里缺少 ${pluginSrc}`);
    return;
  }
  const target = path.join(profileDir, 'node_modules', PACKAGE_NAME);
  if (dry) {
    record('DSH 插件', true, `[dry] 将复制到 ${target}，并登记到 profile 的 dependencies 与 dsh.profile.bundles`);
    return;
  }
  try {
    installDshPackage({source:pluginSrc,profile:profileDir,
      bridgeConfig:path.join(repoRoot,'packages','codex-bridge','config-v3.json')});
    record('DSH 插件', true, '已复制并登记；重启 DSH 后设置里应出现「Codex 同步」');
  } catch (error) {
    record('DSH 插件', false, error.message);
  }
}

function installRuntime(runtimeDir) {
  const dir = path.resolve(runtimeDir);
  const exe = path.join(dir, process.platform === 'win32' ? 'Codex-DSH-Runtime.exe' : 'Codex-DSH-Runtime');
  if (!fs.existsSync(exe)) {
    record('Codex 桥接', false, `找不到 ${exe}（先把运行库放进去，或先构建：packages/codex-bridge/src/Runtime.cs）`);
    return;
  }
  if (dry) {
    record('Codex 桥接', true, `[dry] 将把 CODEX_CLI_PATH 指向 ${exe}`);
    return;
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('setx', ['CODEX_CLI_PATH', exe], {stdio: 'ignore'});
    } else {
      record('Codex 桥接', false, `非 Windows 需手动设置环境变量 CODEX_CLI_PATH=${exe}`);
      return;
    }
    record('Codex 桥接', true, `CODEX_CLI_PATH=${exe}（需正常退出并重开 Codex 一次）`);
  } catch (error) {
    record('Codex 桥接', false, `设置环境变量失败：${error.message}`);
  }
}

function verify() {
  const dshOk = steps.find(s => s.name === 'DSH 插件')?.ok === true;
  const bridgeOk = steps.find(s => s.name === 'Codex 桥接')?.ok === true;
  if (!profileArg || !runtimeArg) {
    console.log('\n本次只处理指定的一侧，另一侧的安装状态尚未核验。');
    console.log('完整同步需要 DSH 插件与 Codex 组件配套运行；请补齐安装，并按 README 第 3 步验证双向。');
  } else if (!dshOk || !bridgeOk) {
    console.log('\n安装未完成：至少一侧未通过检查，不能宣告同步可用。');
    console.log('请处理上面的失败项，再按 README 第 3 步验证双向。');
  } else if (dry) {
    console.log('\n预演通过；没有复制文件、修改 profile 或设置环境变量。');
    console.log('这只证明本次输入通过检查，不表示两端已经安装或连接。');
  } else {
    console.log('\n两侧登记步骤已完成，尚未验证实际同步。接下来需要：');
    console.log('   1) 正常退出 Codex，再打开一次（让桥接接管 CLI）');
    console.log('   2) 重启 DSH（让插件加载）');
    console.log('   然后按 README 第 3 步逐项验证。');
  }
}

if (!profileArg && !runtimeArg) {
  console.log('用法：node install.mjs --profile <DSH profile 目录> [--runtime <运行库目录>] [--dry]');
  console.log('提示：不知道 profile 目录时，先看 DSH_HOME；未设置则为 ~/.dsh/profiles/desktop');
  process.exit(1);
}

console.log('dsh-codex-link 安装器' + (dry ? '（dry-run，不落盘）' : ''));
try {
  const release = readRelease(repoRoot);
  console.log(`同步套件 ${release.version}：${release.components.map(component => component.name + '@' + component.version).join(' + ')}`);
} catch (error) {
  console.error(error.message); process.exit(1);
}
if (profileArg) installPlugin(resolveProfileDir());
if (runtimeArg) installRuntime(runtimeArg);

console.log('');
for (const s of steps) console.log(`${s.ok ? '✓' : '✗'} ${s.name}：${s.detail}`);
verify();
process.exit(steps.every(s => s.ok) ? 0 : 1);
