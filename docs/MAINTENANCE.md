# 连接配置与离线维护

新安装优先使用 [分阶段安装流程](INSTALLATION.md)。本页用于手工部署和已有安装的维护。

## 连接路径

DSH 插件读取包目录中的 `link.config.json`（也可用 `DSH_LINK_CONFIG` 指定），常用字段：

| 字段 | 用途 |
|---|---|
| `bridgeConfig` | Codex 组件 `config-v3.json` 的绝对路径，两侧使用同一份配置 |
| `runtimeAnchor` | 可选：DSH 自身依赖树中的实际文件路径，用于特殊部署；正常桌面宿主自动定位 |
| `dataDir` | 可选：DSH 侧同步状态目录；默认位于桥接配置旁的 `data/dsh` |
| `tokenFile` | 可选：共享本机通道令牌文件；默认采用桥接配置的 `dshTokenFile`，不存在时 DSH 安全生成 |
| `codexStateDb` | 可选：Codex 状态库路径，默认使用桥接配置或 `CODEX_HOME` |
| `port` | 本机监听端口，默认 19389，必须与桥接配置的 `dshUrl` 一致 |

桥接配置还需按本机环境设置 `nativeCli`、`statusFile`、`watchDir`、`ledgerDir` 和 `pluginControlFile`；这些文件路径使用绝对路径，初始 `bindings` 可为空数组。真实会话绑定、账本、令牌和状态文件不能提交到 Git。

## 构建 Windows 运行库

仓库提供 `packages/codex-bridge/src/Runtime.cs` 源码，不包含编译后的运行库。以下命令在已安装 .NET Framework 编译器的 Windows 上构建；路径按本机情况设置：

```powershell
$compilerPath = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$runtimeDir = "$env:LOCALAPPDATA\CodexDshSync"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
& $compilerPath /nologo /target:exe /reference:System.Web.Extensions.dll "/out:$runtimeDir\Codex-DSH-Runtime.exe" packages/codex-bridge/src/Runtime.cs
```

在运行库目录放置 `native.path`，内容为原生 `codex.exe` 的绝对路径，不能指向刚编译的包装程序。还需提供 `runtime.json`：

```json
{
  "node": "<node.exe 的绝对路径>",
  "nativeCli": "<原生 codex.exe 的绝对路径>",
  "proxy": "<仓库>/packages/codex-bridge/proxy-v3.mjs",
  "preflight": "<仓库>/packages/codex-bridge/src/runtime-preflight.mjs",
  "project": "<仓库的绝对路径>",
  "config": "<仓库>/packages/codex-bridge/config-v3.json"
}
```

替换所有占位符；JSON 路径建议使用 `/`。原生 Codex 插件的登记和启用仍需另外完成；编译成功仅表明运行库可执行，不表示桌面已接管或同步已连通。

不应为新安装配置旧聊天采集器。仅迁移早期部署时，才同时设置 `legacyThreadId`、`legacySourceFile` 和 `project`，并将桥接的 `legacyForwardThreadId` 设为同一线程 ID；否则启动会拒绝，避免两个写入口产生回声。

## 项目重归属

1. 正常退出 Codex，确认桥接后台退出；暂停开关不等于退出后台。
2. 保持 DSH 启动，通过带令牌的本机 `/rehome` 接口先执行 `dry:true` 核对计划。
3. 执行 `dry:false`。桥接仍在运行时会收到 `CODEX_BRIDGE_MUST_BE_STOPPED`，不会继续写入。
4. 迁移保留旧消息 ID，生成新的账本文件，复制包含待发送消息和游标的队列，然后发布两份绑定映射。
5. 只有新记录及映射持久化后才归档旧会话；旧会话、旧账本均保留。
6. 重新打开 Codex，检查 `last-launch.json` 的 `mode: bridge` 和各绑定错误状态。

若返回 `MIGRATION_LEDGER_MISSING`，先从备份恢复对应账本，再重试。不要新建空账本绕过检查，否则会丢失原来的去重依据。超过 1000 条的公开文字历史会分批复制。

迁移期间请勿在源会话或目标副本继续聊天。准备期间源消息变化会中止迁移、恢复原绑定，新增消息仍留在源会话。

包含工具调用/结果的会话返回 `OPERATION_HISTORY_REHOME_UNSUPPORTED`，因为当前重归属流程只复制文字，不能通过此流程迁移完整工具历史。原会话与绑定保留，不要删除工具事件绕过检查。尚未接收工具历史的会话迁移时会复制 `.operations.json` 队列与游标。

## 中断恢复

`config-v3.json.migration-journal.json` 记录未完成的发布事务。

- `prepared`：Codex 桥接拒绝启动同步，等待 DSH 恢复；原会话不被归档。正常退出 Codex，再启动 DSH，让其恢复旧配置和映射后重试。
- `committed`：新账本与映射已经完整发布，仅剩旧会话归档；先退出 Codex，再启动 DSH 完成归档。
- 完成的迁移记录保存在配置旁的 `data/migrations`。不要手动删除未完成的日志或清空账本来绕过检查。

安装失败保留的 `.stage-*` / `.failed-*` 目录仅用于诊断；成功升级的旧包位于 `.bak-*`。恢复结果以实际旧安装目录和配置是否还在为准。

## 标题

插件 bundle 将 DSH 的 `session-title.maxTitleBytes` 设为 8192，用户 profile 的覆盖仍有更高优先级。如果源标题被自定义长度限制截断，状态会报告 `DSH_TITLE_LIMIT`，而不会将截断伪称为完全同名或持续重复改写。调整限制后重启 DSH 即可重新检查。
