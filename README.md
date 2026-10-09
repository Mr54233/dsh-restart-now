# dsh-restart-now

DSH 桌面版一键重启插件：在侧边栏底部与设置页各加一个「重启应用」入口，
点击后安全地退出并重新拉起 DeepSeek Harness 桌面应用。

## 工作原理

- **宿主半边**（`lib/index.js`）注册两条路由：
  - `GET /plugins/dsh-restart-now/environment` —— 环境探测（desktop / web）
  - `POST /plugins/dsh-restart-now/restart` —— 重启动作
- **门禁顺序**：`allowRestart` 总开关 → 环境判定（非 desktop 一律 403，
  绝不触碰 web 环境的进程）→ Q6 围栏（loopback 直连 + 无转发头 +
  `Origin==Host`，防浏览器端任意页面打本机端口）→ exe 存在性 fail-fast。
- **重启机制**（v0.7 勘误，WMI 逃逸树 + 单一杀手）：宿主把助手脚本写到
  `%TEMP%\dsh-restart-now-helper-<stamp>.cjs`，经 WMI（`Win32_Process.Create`，
  父进程为 WmiPrvSE，脱离宿主进程树，不会被 taskkill 连坐）拉起 node 助手；
  助手全权执行：延时 → `taskkill /PID <ppid> /T /F` → 轮询旧进程退出 → 重新拉起
  `DeepSeek Harness.exe`。失败写 `%TEMP%\dsh-restart-now-*.err.log`。
- **客户端半边**（`lib/client.js`）启动时探测环境，仅 desktop 挂载
  `sidebar.footer.action` 与 `settings.section` 双入口；web 环境零挂载。

## 配置

设置页「重启应用」区块可直接编辑并保存（落 `restart-now.config.json`）；
也可在 profile 的 `cordis.patch.yml` 条目 `config` 块中设置。
优先级：代码默认 < patch 条目 < 配置文件（UI 保存写入文件层）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `allowRestart` | `true` | 总开关，false 时动作口返回 403 disabled |
| `confirm` | `true` | 点击后二次确认 |
| `hideSidebarButton` | `false` | 隐藏侧栏底部重启入口（保存后立即生效） |
| `delayMs` | `50` | 应答后到杀树的延时（毫秒，0–60000） |
| `exePath` | `''` | exe 绝对路径；留空时从当前安装位置自动推导 |

## 安装

官方桌面端：设置 → 插件 → 从本地目录安装本包（或 `dsh plugin --profile desktop add <路径>`）。
dsh web / 终端宿主：本插件会探测到非 desktop 环境并拒绝动作；web 宿主的重启请用 dshmarket。

## 开发

```powershell
npm test   # node:test，U1–U8，无副作用
```

设计文档见 `docs/01-需求文档.md`、`docs/02-实施文档.md`、`docs/03-测试文档.md`。
