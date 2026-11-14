# dsh-restart-now

[中文](README.md) | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-restart-now?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-restart-now)
[![license](https://img.shields.io/npm/l/dsh-restart-now)](https://www.npmjs.com/package/dsh-restart-now)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20DSH%20Desktop-0078d4)](#适用范围)

DSH 桌面版一键重启插件（Windows 10/11 与 macOS 12+）。装/更插件、卡住、需要重开时，
点一下就完成「关闭 → 自动拉起」，不用自己关窗口再找快捷方式。

![设置 → 重启应用](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/v1.4-settings.png)

## 安装

Windows（PowerShell）与 macOS（终端）同一条命令：

```bash
dsh plugin --profile desktop add dsh-restart-now
```

安装后重启 DSH 生效。升级时再次运行该命令。

## 入口

同一个重启动作，六个入口：

| 入口 | 位置 |
| --- | --- |
| 侧栏面板 | 侧边栏「扩展」列表 → 重启应用 |
| 侧栏底部按钮 | 侧边栏最下方的 ⟳ |
| 会话标题栏按钮 | 对话标题栏的操作区 |
| 窗口菜单栏 | Windows 桌面版「应用」「编辑」旁的「重启」；依赖当前桌面壳菜单结构 |
| 设置行 | 设置 → 通用 → 重启应用 |
| 斜杠命令 | `/restart`（支持 `--force` / `--wait`） |

![Windows 窗口菜单栏入口](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/v1.4-titlebar.png)

![侧栏面板入口](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/v1.4-sidebar-panel.png)

![会话标题栏入口](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/v1.4-conversation-header.png)

![侧栏底部入口](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/v1.4-footer.png)

![重启命令](https://raw.githubusercontent.com/Mr54233/dsh-restart-now/main/assets/v1.4-command.png)

以上六个入口中，除 `/restart` 外的五个界面入口都能在 **设置 → 重启应用** 里单独关掉（关掉即从界面撤除）；
`/restart` 不受界面入口开关影响，但需要宿主命令服务，且仍受总开关、环境和安全门禁约束。设置页同时显示运行版本自检、上次重启结果（停机时长或失败原因）、
只读**重启前预检**，以及各入口统一的进行中状态（旋转 spinner + 「正在重启…/正在关闭…」，
跨入口同步禁用防连点）。

侧栏面板和插件设置页还提供「仅关闭」：确认后退出应用，**不会自动重启**，需手动打开；忙碌时可选择仍然关闭或取消，不提供等待。重启会中断正在进行的输出和任务；等待模式最长 30 分钟，到期时即使仍有任务也会派发重启。助手尽量复用启动参数，无法安全获取时不带参数启动；拉起失败需手动打开。

### 重启安全性（v1.4.0）

- **进程身份核验**：助手结束主进程前核对路径、启动时间等信息；核验失败时放弃操作并记录原因，以降低误操作风险。进程检查与终止并非原子操作，不能保证排除所有竞态。
- **失败可见**：派发后的异常（身份不符、进程没停、请求结果未确认）会弹窗说明，不再静默失败。
- **只读预检**：设置页一键查看当前环境、目标程序、安装锁、任务与冷却状态；
  这是即时快照，不保证之后的重启一定安全，主进程身份与启动参数不在预检中核验。

| 回执情况 | 含义 |
| --- | --- |
| 无记录 | 没有可读取的上次操作回执，不推断是否发生过重启 |
| 已发起，未确认 | 已记录请求，尚无助手完成或失败结果 |
| 已完成 | 新进程通过短时存活检查，不代表所有插件已就绪 |
| 失败 | 助手记录了失败原因 |
| 已关闭 | 「仅关闭」完成，不会自动拉起 |

服务监听与 HTTP 探测仅供观察：本机端口有 2xx 响应也不能证明响应来自目标应用，更不能证明应用已就绪。热重载不是本插件的一次重启请求，回执不会因此更新。

## 它做了什么

1. 插件安装或卸载进行中会阻止重启；有活跃任务时可选择等待、强制重启或取消。
2. 助手先结束主进程，给宿主留出退出和落盘时间；超时后可能强制结束宿主，未落盘内容可能丢失。
3. 助手尝试拉起应用并复用可安全解析的原启动参数；参数无法获取时不带参数启动。
4. 结果写成回执，设置页可查看停机时长或失败原因。

两平台共用同一套「助手确认 → 主进程退出 → 自动拉起」流程，只是系统原语不同：Windows 用 `taskkill /F` 结束主进程、PowerShell 观测监听/弹窗；
macOS 先发 SIGTERM 请主进程体面退出（10 秒未退再 SIGKILL 升级）、`lsof` 观测监听、`osascript` 弹窗。

安全边界：动作接口检查回环来源和同源信息，并默认尝试使用平台会话鉴权。平台鉴权服务不可用、调用异常或被手动关闭时会退回围栏检查，不能保证阻止其他本机程序。

## 配置

设置页「重启应用」区块的开关修改后自动保存；可执行路径在失焦时校验并保存。配置写入当前 profile 的 `restart-now.config.json`，也可在 profile 的 `cordis.patch.yml` 条目 `config` 块中设置；文件配置优先于 patch。默认位置：

- Windows：`%USERPROFILE%\.dsh\profiles\desktop\restart-now.config.json`
- macOS：`~/.dsh/profiles/desktop/restart-now.config.json`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `allowRestart` | `true` | 总开关，false 时动作口返回 403 disabled |
| `confirm` | `true` | 点击后二次确认 |
| `entryPanel` | `true` | 侧栏面板入口开关 |
| `entryFooter` | `true` | 侧栏底部按钮开关（取代旧版 `hideSidebarButton`） |
| `entryHeader` | `true` | 会话标题栏按钮开关 |
| `entrySettingsRow` | `true` | 设置 → 通用行的开关 |
| `entryTitlebar` | `true` | Windows 窗口菜单栏「重启」项开关 |
| `platformAuth` | `true` | 默认尝试平台会话鉴权；服务不可用或关闭时退回围栏检查。界面鉴权失效时可置 `false` 自救 |
| `exePath` | `''` | 应用可执行文件绝对路径；留空时自动从当前安装位置推导（Windows `DeepSeek Harness.exe`；macOS 应用包内主二进制） |

## 适用范围

- **操作系统**：Windows 10/11 与 macOS 12+（Intel / Apple Silicon）；其它系统上插件不挂载任何入口。
- **DSH Desktop**：声明支持 `>=0.2.0-0`；并非保证所有未来版本均已验证。Windows 上曾验证桌面重启链路；本版新增改动尚未在 macOS 真机完整验收。设置页显示实际版本，超出声明范围时提示。
  Web profile / `dsh web` 下不生效。
  **macOS 支持需要真机贡献者**——维护者手头没有 macOS 机器，欢迎有条件的朋友[参与适配与验证](CONTRIBUTING.md#macos)。
- 无需系统 Node：助手用应用自带运行时（macOS 上就是应用自身二进制 + `ELECTRON_RUN_AS_NODE=1`）。

## 开发

见[贡献指南](CONTRIBUTING.md)。

架构与实现细节（门禁链、重启机制、客户端槽位、勘误史）见仓库 `docs/` 下的设计文档。
