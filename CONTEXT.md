# dsh-restart-now

DSH 桌面版一键重启插件的需求语境。此上下文只关心一件事：让用户从 Web UI 内一键重启整个桌面应用。

## Language

**重启 (Restart)**:
应用级重启：DeepSeek Harness 桌面应用整棵进程树退出并重新启动，窗口消失后重现。
_Avoid_: 重载、刷新、重启宿主（这些是别的动作）

**宿主重启 (Host Reload)**:
仅重启插件宿主进程，窗口不动、页面断连重连——dshmarket 已有的能力，不是本插件的职责。
_Avoid_: 快速重启

**桌面版 (Desktop App)**:
官方 Electron 桌面应用 DeepSeek Harness，与终端启动的 dsh web（纯浏览器访问、无应用窗口）相对。
_Avoid_: 客户端、DSH 应用
