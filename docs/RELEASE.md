# 发布与下载

当前预览版本为 `0.3.5-preview.1`，提供以下附件：

| 文件 | 适用场景 |
|---|---|
| `dsh-codex-native-sync-0.3.5-preview.1-windows-x64.zip` | Windows x64 使用者；包含源码及已编译的同步运行库 |
| `dsh-codex-native-sync-0.3.5-preview.1-source.zip` | 开发者；本机编译运行库 |
| `SHA256SUMS.txt` | 核对两个压缩包的 SHA-256 摘要 |
| `release-manifest.json` | 文件版本、大小与摘要清单 |

解压到一个独立目录后，按 [安装说明](INSTALLATION.md) 先预演。Node.js、Codex 和 DSH 需要自己安装；不会打包第三方客户端或使用者的共享库。

压缩包校验示例：

```powershell
Get-FileHash .\dsh-codex-native-sync-0.3.5-preview.1-windows-x64.zip -Algorithm SHA256
```

维护者构建发布包：先确保源码已提交、工作区干净，再在 Windows 使用 Node.js 24 运行：

```powershell
node scripts/build-release.mjs --out .\dist
```

构建会使用 Git 已跟踪源码清单，拒绝混入运行数据库/令牌/机器配置，编译运行库并生成摘要。同一输出路径中的现有包不会被覆盖。

此预览版已通过隔离自动化和 DSH 原生界面验收；Codex 桌面窗口刷新及更多机器组合仍待验证。请先接入测试聊天再用于正式项目。许可为 MIT。

本版新增可选 Codex → DSH 操作记录开关，默认关闭，见[操作记录说明](OPERATIONS.md)。GitHub 自动更新从 0.3.4-preview.1 起提供，见[自动更新说明](UPDATES.md)；更早版本需要手动升级一次。
