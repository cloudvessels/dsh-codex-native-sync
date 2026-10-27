# DSH STORE 接入与验收

2026-10-27 根据 [作者整改单 #1599](https://github.com/AI-Scarlett/DSH-Store/issues/1599) 核对。整改目标是修复上游安装契约；商城收录由 DSH STORE 自行复核，不因源码修复就自动视为已上架。

## 固定源码定位

| 字段 | 值 |
| --- | --- |
| repositoryUrl | `https://github.com/cloudvessels/dsh-codex-native-sync` |
| manifestPath | `packages/dsh-plugin/package.json` |
| installPath | `packages/dsh-plugin` |
| packageName | `dsh-codex-link` |
| entryIds | `codex-native-sync` |
| Patch | 包内 `./cordis.patch.yml`，只插入自身入口 |
| install lifecycle scripts | 无 `preinstall`、`install`、`postinstall`、`prepare` |
| Node.js | `>=24.0.0`，使用内置 SQLite |
| 许可 | MIT，包内含完整 LICENSE |

提交商城时另填写审阅过的 **40 位 Commit**，manifest、Patch、源码和安装目录必须来自同一提交。根目录为私有 workspace manifest，不是 DSH Bundle。直接把仓库根目录作为插件会找不到 `dsh.bundle.patch`。

## 设计与审阅边界

采用 monorepo 下的 Host + Client 标准包：Host 使用公开会话服务，Client 贡献自己的设置区。保留两侧配套结构，避免拆成一个安装后无法独立完成同步的伪完整产品。代价是商城安装子包后仍需安装和配置 Codex 组件；完整操作以根 README 为准。

本包风险按 R3 审阅：涉及聊天读写、本机令牌、HTTP 服务和配套升级进程/安装目录。适用的源码更新策略为 `user-reviewed`，不能声明低权限 `source-verified`。若商城当前仅接受无权限项目自动准入，应保留外部安装说明，等待人工政策审阅。任何审阅不得自动获得改动真实 Profile 的权限。

| 能力 | 数据/修改面 | 控制与代价 | 验证入口 |
| --- | --- | --- | --- |
| 文字追加 | 两端原生历史与绑定账本 | 单写入口、稳定 ID、账本去重；协议升级会失效 | native-host、native-text、history 测试 |
| 标题/归档 | 已绑定 DSH 会话 | 公开服务、遵守宿主标题限制；长标题不保证完全一致 | titles、migration 测试 |
| 回环 HTTP | 聊天快照/追加 | 回环地址、令牌、体积限制；无法隔离同用户恶意程序 | native-host 测试 |
| 可选操作记录 | 工具参数/结果 | 默认关闭、限长、独立队列；开启占上下文 | operations 测试 |
| 自动升级 | GitHub 网络、子进程、运行目录 | 可关闭、大小/摘要校验、活动进程门禁、失败恢复；信任发布账户 | update、setup 测试 |

Bundle 不再默认覆盖 `session-title` 的官方配置。保留已有用户配置，接受宿主截断结果并报告状态，避免为标题一致性扩大所有会话的限制。安装器/桥接的权限与版本约束仍需单独审阅。

## 逐版本证据

官方 npm 与 GitHub Release 在 2026-10-27 解析到的窗口为 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`。下一次检查必须重新解析，不能沿用此历史窗口。

当前 manifest 将这些版本及历史 `0.2.0-rc.2` 明确记录为 `unknown`。历史 Windows 原生测试、源码结构检查和打包成功均不能充当 Linux/macOS/Windows 的新版本安装、启动、卸载、回滚矩阵。只有实际完成对应版本的验收后才更新其精确状态；范围声明不是安装授权。

Windows x64 / Node 24.14.0 的一次性 Profile 已分别验证上述三版：官方 CLI 安装和配置展开、冷启动、认证 Web 页面、本插件认证 API、两条原生文字追加与去重、卸载后配置逐字恢复。零模型调用；这里的回滚指卸载恢复原组合，不代表故障升级的完整回滚。`scripts/test-dsh-profile.mjs` 可复现；新增的 `DSH compatibility` 工作流将在三个系统上解析实时窗口并重复验收，也覆盖更高的独立 next 版本。工作流通过前不将 Windows 结果泛化为全平台兼容。

仓库源码修复、一次性 Profile 验收、商城目录收录和用户电脑安装是四个独立结果。此轮只在临时目录测试，不替换用户正在使用的 DSH/Codex，也不清理原聊天。补齐证据前不提交虚假的 `approved` 或 `compatible` 声明。
