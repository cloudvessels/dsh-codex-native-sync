# Windows 安装交付

安装分为预演、准备文件、接入启动、桌面验收。前三项由 `setup.mjs` 提供；最后一项需要实际打开两个客户端检查。

## 准备条件

- 已安装 Codex 和 DSH，使用 Node.js 24 或更新且兼容本项目的版本。
- Windows 发布包自带运行库，无需编译器；安装前会核对版本、二进制和源码摘要。仅源码包需要 Windows .NET Framework C# 编译器，默认查找 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`；其他位置可用 `--compiler` 指定。
- 确认原来使用的 DSH profile 目录，里面必须已有 `package.json`；安装器不会创建空 profile，也不修改 `DSH_HOME`。
- 确认原生 `codex.exe` 路径，不能使用 `Codex-DSH-Runtime.exe`。通常位于 `%LOCALAPPDATA%\OpenAI\Codex\bin\<版本目录>\codex.exe`。
- 准备/接入/回滚前正常退出两个客户端。安装器会拒绝它能检测到的活动桥接或运行库；这项检查不能替代退出 DSH。

## 1. 预演

在源码仓库打开 PowerShell，替换下列两处实际路径：

```powershell
$profileDir = '<实际 DSH profile 目录>'
$nativeCli = '<实际原生 codex.exe 路径>'
$runtimeDir = "$env:LOCALAPPDATA\CodexDshSync"
node setup.mjs --profile "$profileDir" --runtime "$runtimeDir" --native-cli "$nativeCli" --dry
```

预演只读取和检查，不创建运行目录、不改 profile 或用户环境变量。不写 `--dry` / `--apply` 时也默认预演。

可选参数：`--codex-home <实际 Codex 数据目录>`、`--node <node.exe>`、`--compiler <csc.exe>`、`--port <DSH 通道端口>`、`--plugin-port <Codex 插件服务端口>`。默认端口为 19389 / 19390；预演检查参数有效性，不证明这些端口空闲。

## 2. 准备文件

核对预演中的目录后，把 `--dry` 换为 `--apply`：

```powershell
node setup.mjs --profile "$profileDir" --runtime "$runtimeDir" --native-cli "$nativeCli" --apply
```

如果预演用了可选参数，此处仍需提供相同参数。运行目录必须与源码仓库相互独立；不要准备到某个源码子目录。

这一步会：

1. 将配套代码复制到固定运行目录的 `suite/`，无需依赖下载目录一直留在原处。
2. 安装已核对的预编译运行库，或从源码编译；生成 `native.path`、`runtime.json`。
3. 在 `data/` 创建连接配置、随机通道令牌和控制文件；保留已有绑定、账本、队列与用户设置。
4. 将 DSH 插件代码复制到指定 profile，合并依赖与 bundle 登记。
5. 生成 Codex 本地插件市场与 MCP 配置。

完成状态是 `ready`，此时尚未修改 `CODEX_CLI_PATH`。安装记录和原文件备份位于 `<运行目录>/.setup/`，其中可能含有个人配置，不要上传或分享整个运行目录。

如果现有 DSH 插件指向另一份共享库，或启动入口已被别的程序接管，安装器会拒绝自动覆盖；请先核对迁移方案。不会通过重建空库来绕过冲突。

## 3. 接入启动

```powershell
node setup.mjs --runtime "$runtimeDir" --activate
```

这一步通过原生 Codex 接口登记并安装本地插件，核对启用状态，再设置用户级 `CODEX_CLI_PATH`。从 0.3.8 起，完整安装不自动启动辅助 MCP 服务；后台同步由桥接承担，不依赖 MCP 握手。配置修改只针对本套件的插件与市场项，并检查其他有效配置没有变化；已有其他启动入口时会停止。

原生后台调用只处理配置和插件登记，不发送聊天、不启动模型生成。

新的启动入口一般需在新启动的进程中生效。正常退出并重新打开 Codex、DSH 后，执行 README 的桌面验收；不要把 `activated` 当成双向同步验收通过。

默认自动接入 Codex 新聊天；DSH 新聊天反向接入和归档跟随默认关闭，可在「Codex 同步」设置页开启。已绑定的聊天始终按总开关进行双向文字同步。

## 4. 回滚

```powershell
node setup.mjs --runtime "$runtimeDir" --rollback
```

回滚恢复本次变更前的安装文件、DSH profile、Codex 配置与启动入口，保留共享库配置、令牌、聊天、账本和队列。若某个文件或启动入口后来已被其他操作修改，安装器会保留它并报告冲突，不盲目恢复整份旧文件。

回滚前也需退出两个客户端。Codex 的插件缓存可能仍保留在本机；本次登记和启动接入已撤回，不以删除缓存或聊天历史完成回滚。

## 已完成的交付测试

隔离 profile 与独立 `CODEX_HOME` 下验证了：预演无写入、准备文件、原生插件登记、运行库进入 `bridge`、多聊天 MCP 服务、暂停/恢复、重复接入、失败恢复与回滚保留数据。用户级环境变量用测试替身验证，未改动开发者正在使用的启动入口。

已在全新隔离数据目录启动真实 DSH Host 和原生客户端界面，确认四个设置开关保存及重启保留、DSH 界面消息进入 Codex 原生记录、Codex 公开回复自动出现在同一条 DSH 聊天。Codex 桌面窗口即时重绘、其他电脑和版本组合仍需验证，首次公开包按预览版提供。

Codex 本地插件市场的文件布局参考[官方插件打包文档](https://developers.openai.com/plugins/build/plugins)。原生配置/安装接口为本机已验证的集成路径，后续 Codex 版本仍需复测。
