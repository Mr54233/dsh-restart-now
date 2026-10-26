# dsh-restart-now

[![npm](https://img.shields.io/npm/v/dsh-restart-now?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-restart-now)
[![license](https://img.shields.io/npm/l/dsh-restart-now)](https://www.npmjs.com/package/dsh-restart-now)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20DSH%20Desktop-0078d4)](#适用范围)

DSH 桌面版一键重启插件。装/更插件、卡住、需要重开时，点一下就完成「关闭 → 自动拉起」，
不用自己关窗口再找快捷方式。

![设置 → 重启应用](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/screenshot-1-settings.png)

## 安装

```powershell
dsh plugin --profile desktop add dsh-restart-now
```

安装后重启 DSH 生效。升级时再次运行该命令。

## 入口

同一个动作，五个入口：

| 入口 | 位置 |
| --- | --- |
| 侧栏面板 | 侧边栏「扩展」列表 → 重启应用 |
| 侧栏底部按钮 | 侧边栏最下方的 ⟳ |
| 会话标题栏按钮 | 对话标题栏的操作区 |
| 设置行 | 设置 → 通用 → 重启应用 |
| 斜杠命令 | `/restart`（支持 `--force` / `--wait`） |

![侧栏面板入口](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/screenshot-2-panel.png)

![另外两个轻量入口](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/screenshot-3-entries.png)

四个界面入口都能在 **设置 → 重启应用** 里单独关掉（关掉即从界面撤除）；
斜杠命令始终可用。设置页同时显示运行版本自检和上次重启结果（成功停机时长或失败原因）。

## 它做了什么

1. 点击后如有**正在运行的任务**或**插件正在安装**，会先拦住，让你选：等任务结束再重启 / 仍然重启 / 取消。
2. 确认后**只结束主进程**——宿主自己优雅退出、会话日志正常落盘，不是杀进程树。
3. 独立助手等旧实例完全退出后，把 `DeepSeek Harness.exe` 重新拉起来（复用你原来的启动参数）。
4. 结果写成回执，设置页可见「上次重启：已完成，停机约 N 秒」或失败原因。

安全边界：动作请求仅限本机回环同源，本机其它程序直接调接口会被拒绝（可关）。

## 配置

设置页「重启应用」区块可直接编辑保存（写入 profile 的 `restart-now.config.json`）；
也可在 profile 的 `cordis.patch.yml` 条目 `config` 块中设置。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `allowRestart` | `true` | 总开关，false 时动作口返回 403 disabled |
| `confirm` | `true` | 点击后二次确认 |
| `entryPanel` | `true` | 侧栏面板入口开关 |
| `entryFooter` | `true` | 侧栏底部按钮开关（取代旧版 `hideSidebarButton`） |
| `entryHeader` | `true` | 会话标题栏按钮开关 |
| `entrySettingsRow` | `true` | 设置 → 通用行的开关 |
| `platformAuth` | `true` | 仅允许本应用界面操作重启，本机其它程序调接口被拒；界面自身失效时可置 `false` 自救 |
| `exePath` | `''` | exe 绝对路径；留空时自动从当前安装位置推导 |

## 适用范围

- **操作系统**：暂时仅支持 Windows 10/11；其它系统上插件不挂载任何入口。
- **DSH Desktop**：0.2.0 及以上（验证于 0.2.1-rc.2）。设置页显示实际版本，超出范围红字提示。
  Web profile / `dsh web` 下不生效。
- 无需系统 Node：助手用应用自带运行时。

## 开发

```powershell
npm test            # node:test；12 个文件 122 个用例，零进程副作用
npm pack --dry-run  # 校验 tarball 内容（CI 同样会跑）
```

架构与实现细节（门禁链、重启机制、客户端槽位、勘误史）见仓库 `docs/` 下的设计文档。
