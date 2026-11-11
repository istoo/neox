# Changelog

## 0.16.0 - 2026-11-11

Neox 首个从 [istoo/neox](https://github.com/istoo/neox) 发布的版本。提供 macOS（Apple 芯片与 Intel）、Windows 和 Linux 桌面版，通过 GitHub Releases 更新。

macOS 版暂未使用 Apple 开发者证书签名。第一次打开时如果被系统拦下，到「系统设置 › 隐私与安全性」点「仍要打开」，或者运行 `xattr -dr com.apple.quarantine /Applications/Neox.app`。

Windows 版和 Linux AppImage 版会自己下载并安装更新。macOS 版以及 Linux 的 `.deb`、`.rpm` 安装在有新版本时会提示你，并打开下载页面。

### 新增

- Neox 桌面界面：对话、分屏、看板、审阅、浏览器、设备和网关面板
- 模型网关：按提供方路由、故障切换、额度与敏感信息脱敏
- 桌面端通过 GitHub Releases 获取更新
