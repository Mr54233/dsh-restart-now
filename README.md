# dsh-restart-now

DSH 桌面版一键重启插件（v1.2.0）：**五个入口**——侧边栏面板、侧边栏底部图标、会话标题栏按钮、设置 → 通用 里的一行、斜杠命令 `/restart`。
其中四个界面入口都能在设置 → 重启应用 里**单独开关**（关掉即从界面上撤除，不是仅仅隐藏）；斜杠命令没有界面可关，始终可用。
点一下（或敲一条命令）后，插件先确认自己真的能把助手拉起来（ACK 握手），再**只关掉主进程**让宿主自己优雅退出，
最后把 `DeepSeek Harness.exe` 重新拉起来；重启结果会写成回执，下次打开设置页就能看到「上次重启成没成」。

## 功能特性

- **五个入口，同一套逻辑**：侧边栏面板（点左上角那一项切到主区的重启面板页）、侧边栏底部图标、会话标题栏按钮、
  设置 → 通用 里的一行、斜杠命令 `/restart`（另有 `--force` / `--wait`）。
- **每个入口可单独开关**（v1.2）：设置 → 重启应用 里有 4 个开关（面板 / 底部按钮 / 标题栏 / 设置行），关掉即**撤销槽位注册**；
  斜杠命令不参与开关。开关状态是**本机（本浏览器）偏好**，存 `localStorage`，默认值仍读配置文件。
- **不会误杀**：派发后先等助手回 ACK；**拿不到 ACK 就报错返回，绝不杀任何进程**（`500 helper-not-responding`）。
- **只关主进程**：助手执行 `taskkill /PID <主进程> /F`，**不带 `/T`**——宿主因 IPC 断开自己优雅退出、会话日志照常落盘。
- **不依赖系统 Node**：用应用自身 exe 当 node（`ELECTRON_RUN_AS_NODE=1`），不碰系统 PATH，也不用安装目录里的 runtime。
- **任务守卫**：有活跃任务时不硬重启——返回 409，弹窗三选一：取消 / 等空闲后重启 / 仍然重启（`?wait=1` / `?force=1`）。
  插件管理器正在装插件时硬拦（409 `installing`）。
- **重启回执**：成功写「已完成，停机约 N 秒」，失败写原因；设置页与探测口都能读到。
- **版本自检**：设置页显示「DSH `<version>` · `<range>`」，不满足 `>=0.2.0` 时红字提示。
- **中英双语**：界面文案跟随宿主语言（50 个键，中英字典键集合由测试保证一致）；语言取自 DSH 的 locale 服务，
  在设置里切换语言即时生效。

## 工作原理

### 宿主半边（`lib/index.js`）

注册四条路由（全部 `exact`）＋一条斜杠命令：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/plugins/dsh-restart-now/environment` | GET | 探测口：环境（desktop/web）、平台、版本判定（`version` / `supportedRange` / `supported`）、生效配置与推导 exe、**上次重启回执**、等待快照 |
| `/plugins/dsh-restart-now/restart` | POST | 动作口：`?force=1` 越过任务守卫、`?wait=1` 等空闲后重启、`?cancel=1` 撤销等待 |
| `/plugins/dsh-restart-now/status` | GET | 等待模式状态：`{state, since, remainingMs, tasks, jobs}` |
| `/plugins/dsh-restart-now/config` | GET/POST | 配置读写（单注册按 method 分派） |

**门禁顺序（固定）**：① `allowRestart` 总开关 → ② 环境判定（非 desktop 一律 403，绝不触碰 web 环境的进程）
→ ③ 平台（非 win32 → 403 `unsupported-platform`）→ ④ Q6 围栏（loopback 直连 + 转发头存在即校验、缺失容忍，
防浏览器端任意页面打本机端口）→ ⑤ 插件安装中硬拦（409 `installing`）→ ⑥ 活跃任务（409 `busy` / `?wait=1` / `?force=1`）
→ 派发。

### 重启机制（v1.1 重写）

> v0.7 的 WMI 逃逸树、v0.9 的 wscript + VBS 派发已在 v1.1 **整条删除**（`buildVbsDispatch` / `buildDispatcherVbs` /
> `isStandaloneNode` / `resolveNodeExecutable` 均不再存在）。历史勘误保留在 `docs/02-实施文档.md` §5.0-1。

1. **派发**：宿主把助手脚本写到 `%TEMP%\dsh-restart-now-helper-<stamp>.cjs`，然后用**应用自身 exe 当 node** 拉起：
   ```js
   spawn(process.execPath, [helperPath], {
     detached: true, stdio: 'ignore', windowsHide: true,
     env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
   })
   ```
   Electron exe + `ELECTRON_RUN_AS_NODE=1` 就是一个 node（实测 24.21.0），所以**不依赖系统 node / PATH / runtime 目录**。
2. **ACK 握手**：宿主 `waitForAck(ackPath, 800ms)`（每 50ms 轮询）。**ACK 没出现就返回 500 `helper-not-responding`，一个进程都不杀**
   ——点了没反应也不会误杀。
3. **只杀主进程**：`taskkill /PID <主进程> /F`，**绝不带 `/T`**。不带 `/T`，宿主才会因为 IPC 断开自己优雅退出、把会话日志落盘；
   带 `/T` 会把宿主一起强杀，那才是真丢数据。
4. **等宿主自退**：轮询主进程死亡（30s）→ 等宿主退出（`HOST_GRACE_MS = 15000`）→ 超时才补刀 `taskkill /PID <宿主> /F`。
5. **重拉**：800ms 缓冲 → **删掉 `ELECTRON_RUN_AS_NODE`**（不删新实例不出窗口）→ detached 拉起 exe，最多 3 次、
   每次存活验证 2500ms。
6. **留痕**：成功/失败都写回执；`%TEMP%\dsh-restart-now-<stamp>.err.log` 里还有一行
   `main_stop=…ms host_grace=…ms respawn=…ms total=…ms` 的计时。

### 任务守卫与等待模式

- 有活跃任务（`agent.status === 'running'`、`inbox.nextTurn` / `nextStep` 非空、或 `jobs` 里有 `running` / `stopping`）时，
  动作口返回 `409 { reason:'busy', tasks, jobs, forceable:true }`，客户端弹**三选一**：取消 / 等空闲后重启 / 仍然重启（默认焦点在后者）。
- `?wait=1` 进入等待模式：宿主每 5s 复检，空闲即派发，**上限 30 分钟**（到期强制重启）；设置页显示倒计时与「撤销等待」，`?cancel=1` 撤销。
- `?force=1` 跳过守卫立即重启。
- 插件安装/卸载中（`<profile>\.plugin-manager\run.json` 的 pid 仍存活）→ `409 installing`，不可 force。
  `run.json` 解析失败时记日志放行（宁可放行也不让崩溃残锁把按钮永久锁死）。

### 回执与版本

- 回执：`<profile>\restart-now.last.json`。派发前写 begin（stamp / hostPid / mainPid），成功后写
  `respawnedAt` / `newPid` / `downtimeMs`，失败写 `failed{reason}`。设置页显示「上次重启：已完成，停机约 N 秒 /
  已发起但未确认成功 / 失败：原因」。
- 版本：`SUPPORTED_RANGE = '>=0.2.0-0'`（与 `package.json` 的 `engines.dsh` 强同步，单测强制），
  运行时从 `<resources>\app.asar\package.json` 读版本，回退 `<resources>\app\package.json`。
  设置页显示「DSH 0.2.1-rc.2 · >=0.2.0」，超出范围时红字。

### 客户端半边（`lib/client.js`）

启动时探测环境，**仅 desktop 且平台为 win32** 才挂载入口；web 环境零挂载。v1.2 起注册 **6 个槽位条目**——五个入口里的四个界面入口（其中侧栏面板是 `panellist` + `main` 两个槽位）+ 一个恒注册的设置页区块：

| 槽位 | order | 作用 |
| --- | --- | --- |
| `sidebar.panellist` + `main` | 60 / — | 侧栏面板项 + 它切过去的主区面板页，**必须成对注册**（`selectPanel(key)` 找不到 key 会抛错）；面板项组件只画图标，整行由侧栏渲染 |
| `sidebar.footer.action` | 100 | 侧边栏底部动作按钮（v1.1 起就有） |
| `conversation.session.header.actions` | 15 | 会话标题栏按钮；**order 15 故意排在官方 ui-jobs（20）之前**，否则动作组会被挤到右侧 |
| `settings.general.item` | 91 | 设置 → 通用 里的「左文案 + 右按钮」一行 |
| `settings.section` | 900 | 插件自己的配置页（**不算入口，恒定注册**——否则用户把入口全关了就再也回不来） |

入口开关存本机 `localStorage` 的 `dsh-restart-now:entries`（`{panel, footer, header, settingsRow}` 四个布尔），
关掉一个即调用 disposer **撤销该槽位注册**，不做「注册后隐藏」；插件卸载时全部经 `ctx.effect` 回收。

文案中英双语（`STRINGS.zh` / `STRINGS.en`，50 键，键集合一致由单测强制）。**语言以 DSH 的 locale 服务为准**
（`locale.getSnapshot().active` → `<html lang>` → `navigator.languages` → `en`；服务异步就绪，故另有
`<html lang>` 属性观察兜底）：在 设置 → 通用 里切换语言，各入口即时跟随。槽位 `label` 是函数 `navLabel()`；
导航图标认领同时匹配中英两种标签。面板页主按钮优先用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `Button`
（`try { require(...) }` 包住，取不到就退回自绘 `.dsrn-button`）。

### 斜杠命令

```
/restart              # 直接重启（有任务时弹 409 的三选一由客户端处理）
/restart --force      # 有任务也立刻重启
/restart --wait       # 等任务结束再重启（最多 30 分钟）
```

回执中英并列（宿主管不到前端语言），例如「正在重启桌面应用… / Restarting the desktop app…」。

## 配置

设置页「重启应用」区块可直接编辑并保存（落 `restart-now.config.json`）；
也可在 profile 的 `cordis.patch.yml` 条目 `config` 块中设置。
优先级：代码默认 < patch 条目 < 配置文件（UI 保存写入文件层）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `allowRestart` | `true` | 总开关，false 时动作口返回 403 disabled |
| `confirm` | `true` | 点击后二次确认 |
| `hideSidebarButton` | `false` | 底部入口的默认可见性（v1.2 起＝底部开关的**默认值**，开关本身存 localStorage；保存后立即生效） |
| `exePath` | `''` | exe 绝对路径；留空时从当前安装位置自动推导 |

**v1.1 起只有 4 键**：原第 5 键 `delayMs`（应答后到杀树的延时）已删除——用户要求「不给反悔的机会，尽可能快」，
现在固定为「等助手 ACK（≤800ms）」。旧配置文件里残留的 `delayMs` 会被静默忽略，不影响启动。

**入口可见性是本机偏好（v1.2）**：哪个入口显示、哪个不显示，存在**本机浏览器的 `localStorage`**
（键 `dsh-restart-now:entries`，值为 `{panel, footer, header, settingsRow}` 的布尔对象），不进配置文件、不跨机器同步。
配置文件的 `hideSidebarButton` 因此退化为**底部入口的默认值**（写 `true` 时首次加载即关闭底部按钮，旧配置照旧生效）；
其余三个入口默认开启。切换底部开关时会把四键配置整体写回 `/config`（`hideSidebarButton = !enabled`），
让这个默认值在重装或换机后仍然成立；写回失败则静默忽略（本机开关已经生效）。

## 安装

在 DSH 桌面版所在机器上运行：

```powershell
dsh plugin --profile desktop add dsh-restart-now
```

DSH CLI 会通过 pnpm 从 npm 安装插件，并将其登记到桌面 profile；不需要下载或解压项目源码。安装完成后重启 DSH。升级时再次运行该命令。

## 适用范围

- **操作系统**：暂时仅支持 Windows 10/11。重启链路（`taskkill`、detached spawn、`DeepSeek Harness.exe` 路径推导）
  目前全部是 Windows 机制；在其他系统上安装后插件不挂载任何入口，动作口返回 403 `unsupported-platform`。
  macOS / Linux 支持在计划中。
- **DSH Desktop**：**0.2.0 及以上（验证于 0.2.1-rc.2）**。设置页会显示实际运行版本与支持范围，超出范围时红字提示；
  版本声明以包内 `engines.dsh` 为准（DSH 只读这个字段）。注意 `DeepSeek Harness.exe` 文件属性里的 44.0.0 是内嵌
  Electron 运行时版本，不是产品版本；产品版本以 `dsh --version` / 包 `@deepseek-ai/dsh-desktop` 为准。
  Web profile / `dsh web` 下插件不生效（不挂载入口，动作口拒绝并提示使用 dshmarket 的宿主重启）。
- **Node**：插件自身代码不要求系统安装 Node（助手用应用自带 exe 当 runtime）；`npm test` 与 CI 用 Node 22 / 24。

## 开发

```powershell
npm test            # node:test；12 个文件 101 个用例，零进程副作用、无需运行中的宿主
npm pack --dry-run  # 校验 tarball 内容（CI 同样会跑）
```

CI：`.github/workflows/ci.yml`（`windows-latest` × Node 22/24，跑 `npm test` 与 `npm pack --dry-run`，并断言 tarball 含
`package.json` / `cordis.patch.yml` / `lib/*.js` / `icon.svg` / `locale/*.json`）。
