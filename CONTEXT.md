# dsh-restart-now

DSH 桌面版一键重启插件的需求语境。此上下文只关心一件事：让用户从 Web UI 内一键重启整个桌面应用。

## Language

**重启 (Restart)**:
应用级重启：DeepSeek Harness 桌面应用整体退出（只结束 Electron 主进程，宿主因 IPC 断开优雅退出、会话落盘）并重新启动，窗口消失后重现。
_Avoid_: 重载、刷新、重启宿主（这些是别的动作）

**宿主重启 (Host Reload)**:
仅重启插件宿主进程，窗口不动、页面断连重连——dshmarket 已有的能力，不是本插件的职责。
_Avoid_: 快速重启

**桌面版 (Desktop App)**:
官方 Electron 桌面应用 DeepSeek Harness，与终端启动的 dsh web（纯浏览器访问、无应用窗口）相对。
_Avoid_: 客户端、DSH 应用

**入口 (Entry)**:
把「重启」这个动作暴露到界面上的一处可点位置。v1.2 起共四个可开关入口——
侧栏面板项（`sidebar.panellist`）、侧栏底部按钮（`sidebar.footer.action`）、
会话标题栏按钮（`conversation.session.header.actions`）、设置→通用行（`settings.general.item`）。
设置页区块（`settings.section`）与斜杠命令 `/restart` **不算入口**：前者是控制台兼逃生口，后者不占界面。
_Avoid_: 按钮（会与对话框里的确认按钮混淆）

**入口开关 (Entry Toggle)**:
控制某个入口是否被注册到宿主槽位的布尔配置。v1.2 存本机 `localStorage`，**v1.2.2 起存 profile 配置文件**
（随 profile 走、可跨机器、扛得住强杀）。
_Avoid_: 可见性（那是 CSS 层面的事）、显示开关（与 `hideSidebarButton` 旧语义混淆）

**配置层 (Config Layer)**:
插件配置的三层叠加：代码默认 < `cordis.patch.yml` 条目 `config` 块 < `restart-now.config.json` 文件
（UI 保存写文件层）。v1.2.2 起入口开关也走这套叠加，不再是独立的一层。
_Avoid_: 配置源、配置优先级（说「层」更准确）

**强杀 (Hard Kill)**:
不经过主进程退出钩子的停机方式。Windows：`taskkill /PID <主进程> /F`，不带 `/T`；
macOS：`SIGKILL`（先 `SIGTERM` 宽限 10s，仍未退出才升级）。主进程收不到退出钩子，
Chromium 尚未提交的 `localStorage` 写入会丢——这是 v1.2.1 入口开关回弹的根因。
_Avoid_: 杀树（那是 v0.7 之前的做法，已被证明会连坐助手进程）

**信号式重启 (Signal Restart)**:
macOS 上的停机方式：先对主进程发 `SIGTERM`（宽限 10s），未退出再 `SIGKILL`；宿主随后因 IPC 断开优雅退出。
它与 Windows 的「只结束主进程」是同一契约下的两种系统原语，不是两套重启流程。
_Avoid_: macOS 专属重启、kill 进程树

## Decisions

**ADR-001 入口开关改存 profile 配置文件**（2026-10-26）
起因：GitHub issue #1（alnona 报告 + LevelDB 取证）。v1.2–v1.2.1 把四个入口开关只存
`localStorage`，而重启走强杀，未提交写入丢失 → 开关回弹。
决定：四个入口开关改存 profile 配置文件，与其余五键同一条通路；`localStorage` 降级为纯缓存。
理由：桌面版单窗口单用户，「本机偏好」本来没有价值；配置文件是唯一扛得住强杀、又能跨机器复现的层。
放弃的替代方案：给 localStorage 加「写完即落盘」通道（仍需新接口，换机仍丢）。

**ADR-002 废弃 `hideSidebarButton`**（2026-10-26）
它在 v1.2 已退化为「底部入口的默认值」，与 `entryFooter` 管同一件事。决定废弃：读配置时把
`hideSidebarButton: true` 映射成 `entryFooter: false`（一次性兼容），此后 schema / UI / 文档只出现
`entryFooter`。

**ADR-003 支持 macOS**（2026-11-05）
起因：v1.2.3 及之前只支持 Windows（taskkill / WMI / PowerShell 全是 Win32 机制），macOS 用户无法使用。
决定：
① 重启契约不变——只结束 Electron 主进程，宿主因 IPC 断开优雅退出（会话落盘），助手等它退出后再拉起；
   只把系统原语换成 macOS 版本：`SIGTERM`（宽限 10s 未退则 `SIGKILL`）、`ps` 读启动参数、`lsof` 观测监听、
   `osascript` 弹窗。
② 配置路径由 profileContext 解析（`<profile>/restart-now.config.json`），DSH_PROFILE_DIR / DSH_HOME /
   USERPROFILE / HOME 依次兜底；macOS 默认 `~/.dsh/profiles/desktop/restart-now.config.json`，
   Windows 默认 `%USERPROFILE%\.dsh\profiles\desktop\restart-now.config.json`。
理由：
- macOS 没有 taskkill / WMI：`SIGTERM` 是 Electron 主进程的标准退出语义，先 TERM 后 KILL 才能给会话落盘
  留时间；`kill -9` 起步虽快，但与「优雅退出」契约冲突。
- macOS 桌面宿主不导出 DSH_* 环境变量（真机只剩 ELECTRON_RUN_AS_NODE 与 DSH_CLIENT_VERSION），旧实现
  纯环境变量解析会返回 null → `/config` 写入 500、入口开关存不住；profileContext 是官方权威来源，HOME 只作兜底。
放弃的替代方案：
- 为 macOS 单写一套重启流程（契约会漂移；除系统原语外，ack / 收据 / 重试 / 观测都可以共用）；
- 把配置路径硬编码到 `~/.dsh`（忽略自定义 profile，也破坏 Windows 既有行为）。
适用范围：Windows 10/11 + macOS 12+（Intel / Apple Silicon），DSH Desktop 0.2.0+（真机验证 0.2.1-rc.5）。
