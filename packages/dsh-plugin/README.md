# dsh-codex-link

[Codex ↔ DSH 原生聊天同步套件](https://github.com/cloudvessels/dsh-codex-native-sync)的 DSH 配套插件。将两端公开文字记录追加到各自原生聊天，提供六个设置开关和可选 Codex → DSH 工具记录；不传附件或私有推理。**仅安装本子包不能完成同步，需要同套件的 Codex 桥接。**

## 安装与启用

完整桌面套件目前面向 Windows x64，需要 Node.js 24、已安装的 Codex 和 DSH。请从仓库 [Releases](https://github.com/cloudvessels/dsh-codex-native-sync/releases) 获取完整 Windows 包，按 [安装说明](https://github.com/cloudvessels/dsh-codex-native-sync/blob/main/docs/INSTALLATION.md) 预演、准备、接入 Codex，再在 DSH「设置 → Codex 同步」启用。

DSH STORE 的 monorepo 定位：`manifestPath: packages/dsh-plugin/package.json`、`installPath: packages/dsh-plugin`，入口 ID 为 `codex-native-sync`。安装目标必须固定到同一个完整 Commit。包内已提交运行代码，不需要 `prepare` 或安装脚本。单独通过商城安装后仍需配置配套桥接；不要把插件登记成功当作双端同步已经可用。

独立开发测试可通过 `DSH_LINK_CONFIG` 指定私有 JSON：`bridgeConfig` 为绑定配置绝对路径，`dataDir` 为插件状态目录，`tokenFile` 为本机访问令牌路径，`runtimeAnchor` 指向实际 DSH 包内的运行入口，`port: 0` 可分配临时端口。不要把这些机器配置上传到 GitHub。

## 权限与设置

- 读取本机 Codex 公开聊天、状态数据库和绑定账本；通过 DSH 会话服务读取、追加、重命名及按设置归档会话。接收记录不触发模型或执行远端工具。
- 写入本插件状态、去重数据、令牌和设置。HTTP 只监听 `127.0.0.1`，接口要求本机令牌；同一用户下的其他程序不是隔离的安全边界。
- 配套更新器可访问本项目 GitHub Release、下载并校验升级包，启动更新子进程，在两端退出后更新配置的安装目录。自动更新可关闭，运行中不替换代码。
- 总开关、新聊天接入、反向接入、归档跟随、自动升级和操作同步分别设置；操作同步默认关闭，会消耗上下文。
- Bundle 只新增自身入口，不替换官方组件，不自动扩大官方标题限制；长标题可能被 DSH 规范化。

这是有文件、进程和网络权限的同步工具，不能归类为低权限 `source-verified` 插件。商城更新需要单独的用户审阅策略；套件自己的自动更新开关是另一条更新通道，详见 [安全说明](SECURITY.md)。

## 兼容与卸载

`engines` 表达开发目标范围；`dsh.compatibility.dshReleases` 才是逐完整版本的验收声明。`unknown` 不等于兼容。当前最新三版及安装/启动/卸载/回滚证据见 [商城验收记录](https://github.com/cloudvessels/dsh-codex-native-sync/blob/main/docs/DSH-STORE.md)。历史 Windows DSH 0.2.0-rc.2 的原生同步测试不替代新版本或其他系统验收。

退出同步后用原安装通道卸载 DSH 插件。若要卸载整个套件，还需按安装说明恢复 Codex 启动入口。保留聊天原库、绑定、账本及令牌；不要通过清空历史解决卸载或升级问题。非官方 Codex 协议升级后可能失效，其他机器的桌面即时刷新仍需验收。
