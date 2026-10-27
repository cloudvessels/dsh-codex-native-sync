# AGENTS.md — 给 AI 代理的速查

> 这是**摘要**。完整步骤、期望输出、故障对照都在 `README.md`，冲突时以 README 为准。

## 这是什么

一个仓库维护的 Codex ↔ DSH 原生聊天同步套件，包含两个配套组件：

- `packages/dsh-plugin` —— 标准 DSH 插件（bundle + 设置页）
- `packages/codex-bridge` —— Codex 侧桥接（非官方，包装 CLI）

DSH 包是本套件的配套接入端，不面向不用 Codex 的用户。按同一个发布包提供两侧；版本组合在根目录 `package.json` 的 `syncComponents` 中。安装器是辅助工具，手工安装同样有效。

## 安装边界

公开包尚未完成另一台干净电脑的整套桌面验收。新的 `setup.mjs` 支持预演、准备源码与运行库、配置生成、原生插件登记及回滚；先读 `docs/INSTALLATION.md`。`ready` / `activated` 不等于桌面同步验收通过。旧 `install.mjs` 仍只是辅助工具。

```bash
node setup.mjs --profile <实际 DSH profile> --runtime <独立固定目录> --native-cli <原生 codex.exe> --dry
```

预演不会安装。某次只处理一侧时，另一侧的状态是“尚未核验”，不能据此断言已装好或缺失。完整步骤以 README 为准。

## 验证（必须逐项确认，不要靠"看起来正常"）

1. 新安装的 `<运行目录>/data/status-v2.json`：`initialized: true`、`bindings > 0`、所有 binding 的 `lastError` 为 null；旧手工部署按其 `statusFile` 查找；
2. 运行库目录下 `last-launch.json`：`"mode": "bridge"`（不是 `native`）；
3. DSH 设置里出现「Codex 同步」，五个开关可保存；
4. 两侧各发一句话，确认对方出现。

**任一项失败即视为未安装完成**，不要向用户报告成功。

## 不可违反的规则

1. **消息 ID ≤ 64 字符**：`msg_dshlink_` + 52 位摘要。超长会让 Codex 整条请求被拒（`Invalid 'input[N].id'`）。
2. **一条聊天只能有一个写入口**：同一消息不能被采集器和推送各写一次。保留既有绑定的 ID 和 source 规则，禁止盲目合并不同命名空间。
3. **迁移会话必须同时迁移账本**：改了 `sessionId` 而账本仍绑旧 ID，启动前检查会失败 → Codex 静默回退 `native` 模式，同步停摆但界面无提示。

4. **DSH 必须沿用原数据目录**：重载时显式保留 `DSH_HOME`，不能误开默认空库。不得重导入或清理既有历史来绕过安装问题。

故障定位见 README「出问题了先看这里」；历次修复见 CHANGELOG。

## 边界

- 只同步**纯文字**；命令、工具输出、附件不同步；
- 操作级同步默认关闭（占上下文）；
- Codex 侧依赖未承诺稳定的协议，**升级后可能失效**；
- 跨机器不支持。

## 自动更新

完整安装从 0.3.4-preview.1 起包含 GitHub 自动更新器，见 `docs/UPDATES.md`。自动下载与运行中换代码不同：客户端运行中只缓存，两端退出后安装。不得绕过活动进程检查来测试升级；测试必须使用隔离安装，真实共享库、令牌和聊天不进入发布包。
