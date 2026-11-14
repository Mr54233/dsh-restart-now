# 贡献指南 | Contributing

[中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

感谢关注 dsh-restart-now！本文件说明开发环境、提交规范，以及目前最需要帮助的方向。

## 开发环境

```bash
git clone https://github.com/Mr54233/dsh-restart-now.git
cd dsh-restart-now
npm install
npm test            # node:test，Windows / macOS 均可跑，零进程副作用
npm pack --dry-run  # 校验 tarball 内容
```

- 测试在 Windows 和 macOS 上都能跑，不需要真实重启 DSH；
- CI（GitHub Actions，`ubuntu/windows/macos` 矩阵）会在 PR 上自动执行全套测试；
- 架构与实现细节（门禁链、重启机制、客户端槽位、勘误史）见仓库 `docs/` 下的设计文档（中文）。

## 提交规范

- 一个 PR 聚焦一件事；发版说明按提交整理，粒度清晰的历史对双方都省事；
- 改行为必须带测试；修 bug 请先加一个能复现该 bug 的用例；
- 文案改动（README / locale / 设置页提示）请中英同步——客户端提示是双语的，漏译会退化成中文或键名。

## macOS

**macOS 支持目前只有代码和隔离测试，没有真机验收**——维护者手头没有 macOS 机器。我们不想在没有真机验证的情况下盲目改动这部分：无法验证的适配不可信。因此，macOS 相关改动**需要有真机的贡献者验证后再合并**。

已有基础（v1.3.0 由社区 PR #4 贡献，v1.4.0 增强；全部有单测覆盖，未上真机）：

- 重启链路：SIGTERM → 10s 宽限 → SIGKILL，宿主走 IPC 断开的优雅退出；
- 进程身份核验：`lsof` 映像 + `ps` 启动时间，三个核验点（动手前 / SIGKILL 升级前 / 宿主补刀前）；
- 启动参数复用：`ps -ww` + POSIX 分词（应用路径含空格已处理）；
- 失败弹窗：`osascript display alert`。

### 待验证清单（欢迎逐项确认并反馈）

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | 基本重启链路 | 从各入口触发重启，确认窗口正常回来、会话日志完整 |
| 2 | 退出确认语义 | macOS 应用可能弹自己的退出确认（如有定时任务时）。当前实现超时后 SIGKILL，可能绕过确认框；理想行为可能是检测到未响应时中止重启并提示 |
| 3 | 身份核验的保守拒绝 | `lsof` 无权限 / 异常输出时当前直接放弃操作——真机上是否误拒正常场景 |
| 4 | 失败弹窗 | `osascript` 弹窗在失败场景（如拉起失败）是否正常出现 |
| 5 | 仅关闭 | v1.4.0 新增的 close-only 动作在 macOS 上的完整链路 |
| 6 | 顶部菜单入口 | 目前 Windows 专用（macOS 菜单栏是原生系统菜单，机制不同）；是否值得做、怎么做，先开 issue 讨论 |

### 怎么参与

- **验证反馈**：手头有 macOS 12+（Intel / Apple Silicon）+ DSH Desktop 的朋友，按上面清单逐项真机验证，开 issue 附上结果（DSH 版本、现象、`$TMPDIR` 下 `dsh-restart-now-*.err.log` 的内容）；
- **提 PR**：macOS 助手在 `lib/helper-src.js` 的 `buildMacHelperScript`，对应测试在 `test/mac-helper.test.js`（隔离测试在任何平台都能跑）；改动请附真机验证说明；
- **大件事项**（如退出确认语义、菜单入口）建议先开 issue 讨论方案再动手，避免返工。

## 其他方向

- 窗口状态恢复（重启后保留窗口位置 / 大小 / 所在显示器）已确认有需求，尚未实现；
- Linux 支持：目前不支持，是否值得做取决于 DSH Desktop 是否发布 Linux 版——欢迎讨论。

## 许可

提交即表示你同意以 [MIT](LICENSE) 许可发布你的贡献。
