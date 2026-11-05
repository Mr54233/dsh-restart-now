// dsh-restart-now —— 重启助手与派发参数（宿主半边，纯函数，便于单测）
//
// 沿革（每一版都可追溯到一次真机故障）：
//   v0.7  taskkill /PID <ppid> /T /F 会按父子关系连坐杀掉 detached 助手 → 改 WMI 派发脱离进程树
//   v0.9  火绒拦「隐藏执行 PowerShell」+ WMI 给助手开可见控制台黑框 → 改 wscript.exe + VBS(ShowWindow=0)
//   v1.1  实测（.m4/exp-kill 三组实验）：detached 子进程在「只杀主进程」时存活，WMI/VBS 整层可删；
//         杀法改为「只结束 Electron 主进程（不带 /T）」，让宿主因 IPC 断开自行优雅关闭（会话落盘），
//         超时再定点补杀宿主；拉起改用 detached spawn(应用自身 exe) 当 node，助手派发不再需要 WMI。
//   v1.3.0 加 macOS：契约不变（只杀 Electron 主进程 → 宿主收 IPC disconnect 优雅退出 → 再拉起），
//         变的只有系统原语：taskkill→SIGTERM(宽限)/SIGKILL、WMI→ps、PowerShell 监听探测→lsof、
//         PowerShell 消息框→osascript。macOS 主进程 = <App>.app/Contents/MacOS/<App>，路径含空格，
//         所以解析启动参数用「已知 exe 前缀匹配 + POSIX 分词」而不是按空白切。
//
// 助手时序（两平台同构）：写 ack → 问主进程启动参数（问不到就不带参数）→ 等 500ms
//          → 停 main（Windows: taskkill /F；macOS: SIGTERM，宽限 10s 后 SIGKILL）
//          → 等 main 消失 30s → 等宿主优雅退出 graceMs → 仍未退则 SIGKILL/taskkill host 补刀
//          → 800ms 缓冲 → 带上参数拉起 exe（重试 3 次，每次存活验证 2.5s）→ 写回执
//          → 全失败则弹窗告知「请手动打开」（v1.2.1）
//          → 成功后观测新实例的 web 服务是否真的在监听（只进日志，不影响结论）
import { readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';

/** 默认「给宿主优雅关闭」的宽限窗口。 */
export const HOST_GRACE_MS = 15000;
/** 拉起重试次数与每次存活验证时长。 */
export const RESPAWN_ATTEMPTS = 3;
export const RESPAWN_ALIVE_MS = 2500;
/** 问「主进程当初怎么被启动的」的超时（WMI 首次查询会慢一些）。 */
export const LAUNCH_PROBE_TIMEOUT_MS = 8000;
/** 拉起后等「web 服务重新监听」的窗口与轮询间隔（v1.2.1 第 6 项）。 */
export const RELISTEN_MS = 20000;
export const RELISTEN_POLL_MS = 500;
/** macOS 停机宽限（v1.3.0）：先 SIGTERM 给 Electron 主进程一个体面退出的机会，超时才 SIGKILL。
 *  Windows 没有等价语义（taskkill 只有强杀），保持原样。 */
export const MAIN_STOP_GRACE_MS = 10000;
/** 助手脚本支持的平台（与 lib/environment.js 的 SUPPORTED_PLATFORMS 一致，单测交叉校验）。 */
export const HELPER_PLATFORMS = Object.freeze(['win32', 'darwin']);

/**
 * 生成「新实例的 web 服务是否在监听」的 PowerShell 探测脚本（v1.2.1 第 6 项）。
 *
 * 为什么不连旧端口：实测每次启动端口都不一样（56355 → 57042 → 55843），
 * 连旧端口只会在**每次成功**重启后报超时，是纯噪音。
 * 为什么不只看主进程存活：进程活着 ≠ 服务起来了（端口被占、宿主崩了都可能还有窗口）。
 *
 * 所以判据改为「新实例的**进程树**里有人在 LISTEN」：web 服务跑在宿主子进程里，
 * 不是主进程本身。脚本内部自己轮询，一次 spawn 覆盖整个等待窗口。
 * @param {number} mainPid 新实例的主进程 pid。
 * @param {number} timeoutMs 最长等待毫秒数。
 * @param {number} pollMs 轮询间隔毫秒数。
 * @returns {string} 供 `powershell.exe -Command` 执行的脚本。
 */
export function webListenScript(mainPid, timeoutMs, pollMs) {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$main = ' + Math.trunc(Number(mainPid) || 0),
    '$limit = (Get-Date).AddMilliseconds(' + Math.trunc(Number(timeoutMs) || 0) + ')',
    'while ((Get-Date) -lt $limit) {',
    '  $ids = @($main)',
    '  foreach ($child in (Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $main))) { $ids += $child.ProcessId }',
    '  $hit = Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess } | Select-Object -First 1',
    '  if ($hit) { Write-Output ("ok " + $hit.LocalPort); exit 0 }',
    '  Start-Sleep -Milliseconds ' + Math.trunc(Number(pollMs) || 0),
    '}',
    'Write-Output "timeout"',
  ].join('\n');
}

/**
 * 比较路径时统一分隔符、大小写与尾部分隔符（v1.3.0 平台感知）。
 *
 * Windows：NTFS 大小写不敏感，分隔符统一成反斜杠再小写比较。
 * macOS：APFS 默认大小写不敏感，但路径**可能**是大小写敏感的；这里刻意保留大小写——
 * 宁可偶尔判「不是同一个 exe」（回退到不带参数启动，安全），也不要把两个不同程序判成同一个
 * （那会拉起错误的进程）。分隔符统一成 / 再去掉尾部分隔符。
 * @param value 待归一化的路径
 * @param platform 目标平台（默认 win32，保持 v1.2 的既有调用语义）
 */
export function normalizePath(value, platform = 'win32') {
  const text = String(value ?? '');
  if (platform === 'win32') return text.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();
  return text.replace(/\/+$/u, '');
}

/**
 * 按 Windows 的规则把命令行拆成参数（v1.2.1）。
 *
 * 只处理最常见的两种写法：引号包裹、以及引号里的 `\"`。刻意不实现完整的反斜杠连写规则——
 * 遇到 `\"` 时调用方会直接放弃复用原始参数，所以这里不需要为罕见形态承担有损解析的风险。
 * @param {string} text 命令行原文。
 * @returns {string[]} 参数列表（含第 0 个可执行文件）。
 */
export function tokenizeCommandLine(text) {
  const tokens = [];
  let current = '';
  let started = false;
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '"') {
      current += '"';
      started = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * 按 POSIX shell 的常见规则把命令行拆成参数（v1.3.0，macOS 用）。
 *
 * 只处理最常见的两种写法：单/双引号包裹、以及引号/空白前的反斜杠转义。刻意不实现
 * 完整的 POSIX 展开（$VAR / $(...) / 反引号）——真出现那种形态时，ps 输出的原文本来
 * 就不是可安全复用的 argv，宁可让调用方退回不带参数启动。
 * @param text 命令行原文。
 * @returns {string[]} 参数列表（含第 0 个可执行文件）。
 */
export function tokenizePosixCommandLine(text) {
  const tokens = [];
  let current = '';
  let started = false;
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = '';
        continue;
      }
      if (char === '\\' && quote === '"' && (text[index + 1] === '"' || text[index + 1] === '\\')) {
        current += text[index + 1];
        started = true;
        index += 1;
        continue;
      }
      current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\') {
      if (index + 1 < text.length) {
        current += text[index + 1];
        started = true;
        index += 1;
      }
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * 从「主进程命令行」里取出可复用的启动参数（v1.2.1，借鉴 dsh-desktop-restart）。
 *
 * 为什么不能直接转发自己的 `process.argv`：本插件跑在桌面宿主进程里，它的 argv 是
 * 「desktop-host 运行器」的参数（`--expose-internals ...index.js <一堆路径>`）；
 * 原样转发会拉起一个没有窗口的宿主进程，比不带参数更糟。所以只能在重启时问系统
 * 「最上面那个 GUI 进程当初是怎么被启动的」。
 *
 * 三重保险，任一条不成立就返回 null（调用方退回不带参数启动，绝不猜）：
 *   ① 空命令行 → null
 *   ② 命令行第 0 段不是同一个 exe（进程表有同名/多份安装） → null
 *   ③ 参数里出现 `--type=` 或 `--expose-internals` → 抓到的是 Chromium 子进程或宿主，不是用户启动 → null
 *
 * v1.3.0 平台分叉：Windows 的 WMI 返回带引号的命令行，走原来的 tokenizeCommandLine；
 * macOS 的 ps 返回的是 argv 用空格拼接后的原文（不重新加引号），而应用 exe 路径本身含空格，
 * 无法靠分词还原第 0 段。所以 darwin 分支先用「已知 exe 字符串前缀」切出参数区，再用 POSIX 分词：
 *   命令行 === exe            → []（确实是这个 exe、没有额外参数）
 *   命令行以 exe + 空格开头    → 参数区按 POSIX 规则分词
 *   其它                      → null（不敢猜）
 * @param {string|null|undefined} commandLine 进程表读到的命令行。
 * @param {string} exe 目标可执行文件。
 * @param {'win32'|'darwin'} [platform] 解析规则；默认 win32（保持 v1.2 调用语义）。
 * @returns {string[]|null} 要转发的参数；null 表示「问不出来/不敢用」。
 */
export function relaunchArgsFrom(commandLine, exe, platform = 'win32') {
  if (typeof commandLine !== 'string') return null;
  const text = commandLine.trim();
  if (text === '') return null;
  const args = platform === 'darwin'
    ? argsFromPosixCommandLine(text, exe)
    : argsFromWindowsCommandLine(text, exe);
  if (args === null) return null;
  for (const arg of args) {
    if (/^--type=/u.test(arg) || arg === '--expose-internals') return null;
  }
  return args;
}

/** Windows 命令行 → 参数（含 exe 校验）。 */
function argsFromWindowsCommandLine(text, exe) {
  if (text.includes('\\"')) return null;
  const tokens = tokenizeCommandLine(text);
  if (tokens.length === 0) return null;
  if (normalizePath(tokens[0], 'win32') !== normalizePath(exe, 'win32')) return null;
  return tokens.slice(1);
}

/** macOS ps 命令行 → 参数（含 exe 校验；路径含空格，所以用前缀匹配而不是依赖分词还原第 0 段）。 */
function argsFromPosixCommandLine(text, exe) {
  const target = String(exe ?? '').replace(/\/+$/u, '');
  if (target === '') return null;
  if (text === target) return [];
  if (!text.startsWith(target + ' ')) return null;
  const rest = text.slice(target.length + 1);
  const tokens = tokenizePosixCommandLine(rest);
  if (tokens.length === 0) return null;
  return tokens;
}

/**
 * 拉起新实例前必须从继承环境里删掉的键（v1.2.1）。
 *
 * 判据：这些变量描述的是「某一次运行 / 某一个会话」的事实，而不是「这台机器」的事实。
 * 平台文档（@deepseek-ai/dsh-shell-env）说它们是「每次模型 shell 调用时新收集的管理环境」，
 * 也就是说每次调用都该重新算；跨进程继承等于把上一轮的事实带进下一轮。
 *   ① ELECTRON_RUN_AS_NODE —— 留着新实例会退化成 node，没有窗口（v1.1 起就删）
 *   ② DSH_SESSION_ID       —— 被中断那次会话的 id：留着会污染回执/续跑/日志的归属
 *   ③ DSH_WEB_URL          —— **旧进程**的 Web 端口（= webApp.getAdvertisedUrl()）；
 *                             新实例自己会重新绑端口，旧地址指向已退出的进程
 *   ④ DSH_SHELL            —— 标记「本进程由模型 shell 拉起」，新实例是用户级宿主
 *
 * 反过来，安装身份必须保留：DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR 决定用哪套安装、
 * 哪个 profile。删掉它们，新实例会退回默认 home 或默认 profile——那才是真的灾难。
 */
export const RESPAWN_ENV_DROP = Object.freeze([
  'ELECTRON_RUN_AS_NODE',
  'DSH_SESSION_ID',
  'DSH_WEB_URL',
  'DSH_SHELL',
]);

/**
 * 解析要拉起的目标可执行文件：配置里填了就用配置，否则从当前宿主进程推导。
 *
 * Windows：宿主 process.execPath 是 app 目录里的可执行文件，真正的主程序固定叫
 * `DeepSeek Harness.exe`，所以按目录推导。
 * macOS（v1.3.0）：宿主是应用包里那个 Mach-O（`<App>.app/Contents/MacOS/<App>`，
 * 由 Electron 以 ELECTRON_RUN_AS_NODE 启动），process.execPath 本身就是主进程二进制，
 * 直接用它——旧逻辑拼 `...MacOS/DeepSeek Harness.exe` 必然不存在（真机已验证）。
 * 其它平台：同样退回 execPath（环境门禁本就不会放行）。
 * @param config 生效配置（可含 exePath）
 * @param execPath 宿主进程的 process.execPath
 * @param platform 目标平台（默认取 process.platform）
 */
export function resolveExe(config, execPath, platform = process.platform) {
  const configured = config && typeof config.exePath === 'string' ? config.exePath.trim() : '';
  if (configured) return configured;
  const binary = String(execPath ?? '').trim();
  if (binary === '') return '';
  if (platform === 'win32') return win32.join(win32.dirname(binary), 'DeepSeek Harness.exe');
  return posix.normalize(binary);
}

// —— v1.3.0：macOS 系统原语的纯函数封装（便于单测；助手脚本通过 toString 注入同一份实现）——

/** 断言用的系统工具绝对路径（助手是 detached 进程，不赌 PATH）。 */
export const MAC_TOOLS = Object.freeze({
  ps: '/bin/ps',
  lsof: '/usr/sbin/lsof',
  osascript: '/usr/bin/osascript',
});

/**
 * 读主进程命令行的 ps 参数（`-ww` 关掉终端宽度截断，否则长路径会被截成一半）。
 * @param {number} pid 主进程 pid。
 * @returns {string[]} ps 参数。
 */
export function macPsArgs(pid) {
  return ['-ww', '-p', String(Math.trunc(Number(pid) || 0)), '-o', 'command='];
}

/**
 * lsof 观测「这些 pid 的 TCP 监听」的参数（-n 不做 DNS、-P 不解析端口名、-a 让过滤条件 AND）。
 * @param {number[]} pids 进程 pid 列表。
 * @returns {string[]} lsof 参数。
 */
export function macListenArgs(pids) {
  const args = ['-nP', '-a', '-iTCP', '-sTCP:LISTEN'];
  for (const pid of Array.isArray(pids) ? pids : []) {
    const id = Math.trunc(Number(pid) || 0);
    if (id > 0) args.push('-p', String(id));
  }
  return args;
}

/**
 * 从 lsof 输出里取第一个 LISTEN 端口；没有监听返回 0。
 * NAME 列形如 `127.0.0.1:50508 (LISTEN)` / `*:443 (LISTEN)` / `[::1]:3000 (LISTEN)`。
 * @param {string} output lsof 输出。
 * @returns {number} 端口（1-65535）或 0。
 */
export function parseLsofListenPort(output) {
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const matched = /\)?\s*(?:\*|[^\s:]*):(\d{1,5})\s+\(LISTEN\)/u.exec(line);
    if (!matched) continue;
    const port = Number(matched[1]);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return 0;
}

/**
 * 解析 `ps -axo pid=,ppid=` 的输出成「ppid → 子 pid 列表」。
 * @param {string} output ps 输出。
 * @returns {Map<number, number[]>} 父子索引。
 */
export function parsePsProcessTable(output) {
  const children = new Map();
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const matched = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!matched) continue;
    const pid = Number(matched[1]);
    const ppid = Number(matched[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

/**
 * 从父子索引里收集 rootPid 的整棵进程树（含自身，BFS，防御脏数据成环）。
 * @param {Map<number, number[]>} children parsePsProcessTable 的结果。
 * @param {number} rootPid 根 pid。
 * @returns {number[]} 进程树 pid 列表。
 */
export function collectDescendants(children, rootPid) {
  const root = Math.trunc(Number(rootPid) || 0);
  if (root <= 0 || !(children instanceof Map)) return [];
  const seen = new Set([root]);
  const queue = [root];
  const out = [];
  while (queue.length > 0) {
    const current = queue.shift();
    out.push(current);
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * AppleScript 字符串字面量转义（v1.3.0）。
 * 不能用 JSON.stringify：AppleScript 方言不认 JSON 的 \uXXXX 转义，换行要写成 \n，
 * 反斜杠与双引号各自用反斜杠转义。
 * @param {string} text 原文。
 * @returns {string} 带双引号的 AppleScript 字符串字面量。
 */
export function appleScriptLiteral(text) {
  return '"' + String(text ?? '')
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\r\n|\r|\n/gu, '\\n') + '"';
}

/**
 * 拉起失败弹窗的 AppleScript 源码（纯函数，便于单测）：应用已经没了，弹窗是唯一能说话的通道。
 * @param {string} message 正文。
 * @param {string} [title] 标题。
 * @returns {string} 供 osascript -e 执行的源码。
 */
export function macAlertScript(message, title = 'DeepSeek Harness') {
  return 'display alert ' + appleScriptLiteral(title) + ' message ' + appleScriptLiteral(message) + ' as critical';
}

/**
 * 一次重启涉及的 %TEMP% 产物路径（同一 stamp → 同一组，prune 时同进退）。
 * helper：助手脚本；ack：派发确认（宿主据此决定 202/500）；errLog：失败与 perf 日志。
 */
export function artifactPaths(dir, stamp) {
  return {
    helper: join(dir, `dsh-restart-now-helper-${stamp}.cjs`),
    ack: join(dir, `dsh-restart-now-helper-${stamp}.ack`),
    errLog: join(dir, `dsh-restart-now-${stamp}.err.log`),
  };
}

/**
 * 生成助手脚本（可独立运行的 CommonJS 源码）。
 *
 * 设计要点：
 *  - 只杀 Electron 主进程、不带 /T：宿主的 IPC 连接断开后会走官方 application.shutdown 优雅关闭，
 *    会话日志得以落盘；带 /T 会把宿主一起强杀，那才是真的丢数据（竞品实测结论）。
 *  - 宿主 pid 已知（process.ppid），主进程退出后定点等它自己退，超时才补刀。
 *  - 拉起前必须按 ENV_DROP 清环境：删掉 ELECTRON_RUN_AS_NODE（否则新实例退化成 node 无窗口），
 *    并清掉 DSH_SESSION_ID / DSH_WEB_URL / DSH_SHELL 这些「上一次运行」的事实（v1.2.1）。
 *  - 拉起时尽量复用主进程原始启动参数（v1.2.1）：先问 WMI「GUI 主进程当初怎么被启动的」，
 *    三重校验不过就不带参数——绝不用自己的 argv（那是 desktop-host 运行器的参数）。
 *  - 拉起后做存活验证并重试，全失败写日志 + 回执 failed 段，并弹系统消息框告知
 *    「请手动打开」（v1.2.1：此时界面已经不存在，弹窗是唯一能把话传到眼前的通道）。
 *  - 拉起成功后观测旧端口是否重新监听（v1.2.1 第 6 项）：进程活着 ≠ 服务起来了，
 *    这一步把盲区记进日志；只观测，不因此判失败（新实例可能合法换端口）。
 *
 * 刻意不做（2026-10-22 决定）：端口卡住时「清掉同 exe 的残留进程」。
 * 我们的流程已按 pid 精确杀主进程、再等宿主优雅退出、超时才定点补杀宿主，端口不会悬空；
 * 替宿主决定「哪个进程该杀」风险大于收益（杀错就是别的安装实例/正在保存的会话）。
 */
export function buildHelperScript(options = {}) {
  const platform = options.platform || 'win32';
  if (platform === 'win32') return buildWindowsHelperScript(options);
  if (platform === 'darwin') return buildMacHelperScript(options);
  throw new TypeError('buildHelperScript: unsupported platform ' + JSON.stringify(platform)
    + ' (supported: ' + HELPER_PLATFORMS.join(', ') + ')');
}

/**
 * Windows 助手脚本（v1.1 起逐字沿用；v1.3.0 只加了 pid 健全性检查）。
 * 平台专项：taskkill /F、WMI 读命令行、PowerShell 观测监听与消息框、.exe 路径推导。
 */
export function buildWindowsHelperScript(options) {
  const {
    exe,
    mainPid,
    hostPid,
    errLog,
    ack,
    receipt = '',
    hostGraceMs = HOST_GRACE_MS,
    attempts = RESPAWN_ATTEMPTS,
    aliveMs = RESPAWN_ALIVE_MS,
    probeTimeoutMs = LAUNCH_PROBE_TIMEOUT_MS,
    webListenMs = RELISTEN_MS,
    webListenPollMs = RELISTEN_POLL_MS,
  } = options;
  const j = (value) => JSON.stringify(value === undefined ? null : value);
  return `'use strict';
// dsh-restart-now helper (v1.3.0, win32) —— 由宿主在重启前写出并 detached 拉起，独立于应用进程树。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');

const path = require('node:path');

const EXE = ${j(exe)};
const MAIN = ${j(mainPid)};
const HOST = ${j(hostPid)};
const ERR_LOG = ${j(errLog)};
const ACK = ${j(ack)};
const RECEIPT = ${j(receipt)};
const HOST_GRACE_MS = ${j(hostGraceMs)};
const ATTEMPTS = ${j(attempts)};
const ALIVE_MS = ${j(aliveMs)};
const ENV_DROP = ${JSON.stringify([...RESPAWN_ENV_DROP])};
const PROBE_TIMEOUT_MS = ${j(probeTimeoutMs)};
// 拉起后观测「新实例的 web 服务是否真的在监听」（第 6 项）。只观测，不当成功判据。
const WEB_LISTEN_MS = ${j(webListenMs)};
const WEB_LISTEN_POLL_MS = ${j(webListenPollMs)};

// 启动参数复用（v1.2.1；v1.3.0 加 POSIX 分支）：下面这些函数是模块里同名函数的**同一份源码**
// （toString 注入），避免助手脚本再抄一遍解析规则；改逻辑只改一处。
${normalizePath.toString()}
${tokenizeCommandLine.toString()}
${tokenizePosixCommandLine.toString()}
${relaunchArgsFrom.toString()}
${argsFromWindowsCommandLine.toString()}
${argsFromPosixCommandLine.toString()}
// web 服务监听探测（v1.2.1 第 6 项）同样是同一份源码。
${webListenScript.toString()}

// 问系统「主进程当初是怎么被启动的」。问不到就返回 null —— 那不等于「没有参数」，
// 但两者对调用方的结论一样：不带参数启动（绝不拿自己的 argv 去猜）。
function readLaunchArgs() {
  if (!Number.isInteger(MAIN) || MAIN <= 0) return null;
  const probe = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    + "$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=" + MAIN + "'; "
    + 'if ($p -and $p.CommandLine) { $p.CommandLine }';
  let text = '';
  try {
    text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    fail('launch-args probe failed: ' + ((error && error.message) || String(error)));
    return null;
  }
  const trimmed = String(text || '').trim();
  return trimmed === '' ? null : trimmed;
}

// 拉起全失败时把话说到用户脸前（v1.2.1）。窗口再也不会回来、日志没人会看，
// 弹窗是唯一能把「请手动打开」传到眼前的通道。尽力而为：弹不出来就记一笔，绝不影响收尾。
async function alertUser(message) {
  // 注意：PowerShell 里反斜杠**不是**转义符，所以不能用 JSON.stringify 拼字面量
  // （那样 C:\\Temp 会原样显示成两个反斜杠）。单引号字面量里只需把 ' 写成 ''。
  const quoted = "'" + String(message).replace(/'/g, "''") + "'";
  const shellScript = 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('
    + quoted + ", 'DeepSeek Harness') | Out-Null";
  const encoded = Buffer.from(shellScript, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const started = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        const child = spawn(shell, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => done(false));
        child.unref();
      } catch (error) {
        done(false);
        return;
      }
      // ENOENT 是异步事件：给它一点时间冒出来，才轮得到下一个 shell
      setTimeout(() => done(true), 600);
    });
    if (started) return true;
  }
  return false;
}

// 问系统要一次「新实例的进程树里有没有人在 LISTEN」，脚本自己轮询到超时。
// 拿不到 PowerShell / 命令报错都只回 unsupported，绝不因此判重启失败。
function waitWebListen(mainPid, timeoutMs) {
  const started = Date.now();
  const settle = (verdict, port, error) => ({ verdict: verdict, port: port || 0, wait: Date.now() - started, error: error || '' });
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', webListenScript(mainPid, timeoutMs, WEB_LISTEN_POLL_MS),
    ], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    const text = String(output || '').trim();
    if (text.indexOf('ok ') === 0) {
      const port = Number(text.slice(3).trim());
      return settle('ok', Number.isInteger(port) ? port : 0, '');
    }
    return settle('timeout', 0, '');
  } catch (error) {
    return settle('unsupported', 0, String((error && error.message) || error));
  }
}

const T0 = Date.now();
function fail(message) {
  try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' ' + message + '\\n'); } catch (error) { /* 日志失败不影响主流程 */ }
}
function perf(message) {
  try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' perf: ' + message + '\\n'); } catch (error) {}
}
function alive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function kill(pid, label) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (error) {
    fail('taskkill ' + label + ' failed: ' + (error && error.message));
    return false;
  }
}

function writeReceipt(patch) {
  if (!RECEIPT) return;
  try {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')); } catch (error) { current = {}; }
    fs.writeFileSync(RECEIPT, JSON.stringify(Object.assign({}, current, patch), null, 2));
  } catch (error) { fail('receipt write failed: ' + (error && error.message)); }
}

(async () => {
  // ⓪ pid 健全性（v1.3.0）：宿主是 Electron 主进程的子进程，但主进程可能已经先没了
  //    （此时 ppid 变成 0/1）。拿 0/1 去 taskkill 等于攻击 init 或空目标，必须先挡住。
  if (!Number.isInteger(MAIN) || MAIN <= 1) { fail('invalid main pid: ' + MAIN); return; }

  // ① 先写 ack：宿主据此判定派发成功（拿不到 ack 就报错、绝不杀任何进程）
  try { fs.writeFileSync(ACK, JSON.stringify({ at: new Date().toISOString(), helperPid: process.pid })); }
  catch (error) { fail('ack write failed: ' + (error && error.message)); return; }

  // ①b 趁主进程还活着，问它当初是怎么被启动的；问不到/不敢用就带空参数（见 relaunchArgsFrom）
  const rawCommandLine = readLaunchArgs();
  const launchArgs = relaunchArgsFrom(rawCommandLine, EXE);
  perf(launchArgs === null
    ? 'launch_args=unavailable' + (rawCommandLine ? ' (command line unusable)' : '')
    : 'launch_args=' + JSON.stringify(launchArgs));
  const args = launchArgs === null ? [] : launchArgs;

  await sleep(500);

  // ② 只结束 Electron 主进程（不带 /T）：宿主随之失去 IPC，走官方优雅关闭
  const T1 = Date.now();
  kill(MAIN, 'main');
  let deadline = Date.now() + 30000;
  while (alive(MAIN) && Date.now() < deadline) await sleep(200);
  if (alive(MAIN)) { fail('wait main timeout: ' + MAIN); writeReceipt({ failed: { at: new Date().toISOString(), reason: 'main-not-stopped' } }); return; }
  const T2 = Date.now();

  // ③ 等宿主自己退（给会话落盘留出时间），超时才定点补刀
  let hostDown = false;
  deadline = Date.now() + HOST_GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(HOST)) { hostDown = true; break; }
    await sleep(200);
  }
  if (!hostDown) {
    fail('host alive after ' + HOST_GRACE_MS + 'ms, killing ' + HOST);
    kill(HOST, 'host');
    deadline = Date.now() + 10000;
    while (alive(HOST) && Date.now() < deadline) await sleep(200);
  }
  const T3 = Date.now();

  // ④ 拉起新实例：干净环境（见 ENV_DROP：去掉 ELECTRON_RUN_AS_NODE 否则没有窗口，
  //    并清掉上一次运行/会话的 DSH_* 事实）+ 存活验证 + 重试
  const env = Object.assign({}, process.env);
  const dropped = [];
  for (const key of ENV_DROP) {
    if (key in env) dropped.push(key);
    delete env[key];
  }
  perf('env_dropped=' + (dropped.join(',') || 'none'));
  let newPid = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await sleep(attempt === 1 ? 800 : 1000);
    let child;
    try {
      child = spawn(EXE, args, { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env });
    } catch (error) {
      lastError = (error && error.message) || String(error);
      fail('respawn spawn failed (attempt ' + attempt + '): ' + lastError);
      continue;
    }
    child.on('error', (error) => fail('respawn error: ' + ((error && error.message) || String(error))));
    try { child.unref(); } catch (error) {}
    const pid = child.pid;
    await sleep(ALIVE_MS);
    if (pid && alive(pid)) { newPid = pid; break; }
    lastError = 'exited within ' + ALIVE_MS + 'ms';
    fail('respawn attempt ' + attempt + ' ' + lastError);
  }

  const T4 = Date.now();
  perf('main_stop=' + (T2 - T1) + 'ms host_grace=' + (T3 - T2) + 'ms respawn=' + (T4 - T3) + 'ms total=' + (T4 - T0) + 'ms');

  if (!newPid) {
    fail('respawn failed after ' + ATTEMPTS + ' attempts');
    writeReceipt({ failed: { at: new Date().toISOString(), reason: 'respawn-failed', detail: lastError } });
    // 唯一能把「请手动打开」送到眼前的通道（此时应用已经没了，界面不存在）
    const shown = await alertUser('重启失败：新实例没能启动。' + String.fromCharCode(10, 10)
      + '原因：' + (lastError || 'unknown') + String.fromCharCode(10, 10)
      + '请手动打开 DeepSeek Harness。日志：' + ERR_LOG);
    perf('alert_shown=' + shown);
    return;
  }
  writeReceipt({ respawnedAt: new Date().toISOString(), newPid: newPid, downtimeMs: T4 - (Number(readStart()) || T0) });

  // ⑤ 观测「新实例的 web 服务真的开始监听了吗」（v1.2.1 第 6 项）。
  //    进程活着 ≠ 服务起来了；这里查新实例的**进程树**里有没有人在 LISTEN（端口每次启动都变，
  //    所以不比端口号，只看有没有人听）。**只观测、不判失败**：结论只进日志，不影响重启结论。
  const listen = waitWebListen(newPid, WEB_LISTEN_MS);
  perf('web_listen=' + listen.verdict + ' wait=' + listen.wait + 'ms'
    + (listen.port ? ' port=' + listen.port : '')
    + (listen.error ? ' error=' + listen.error : ''));
  process.exit(0);

  function readStart() {
    try { return JSON.parse(fs.readFileSync(RECEIPT, 'utf8')).atMs; } catch (error) { return 0; }
  }
})();
`;
}

/**
 * macOS 助手脚本（v1.3.0）。与 Windows 版**同一契约**，只换系统原语：
 *  - 停机：SIGTERM 主进程（宽限 stopGraceMs，默认 10s）→ 仍在则 SIGKILL。
 *    主进程一死，宿主立刻收到 IPC disconnect → application.shutdown 优雅关闭（会话日志落盘）；
 *    宿主超过 hostGraceMs 仍未退才 SIGKILL 补刀（补刀是最后手段，会丢未落盘写入）。
 *  - 启动参数：ps -ww 读主进程命令行（先查已知 exe 前缀，再 POSIX 分词；路径含空格也不会拆错）。
 *  - 监听观测：ps 取新实例进程树 → lsof 查这些 pid 的 LISTEN（只进日志，绝不当成功判据）。
 *  - 失败弹窗：osascript display alert（应用已死，弹窗是唯一能把话传到眼前的通道）。
 */
export function buildMacHelperScript(options) {
  const {
    exe,
    mainPid,
    hostPid,
    errLog,
    ack,
    receipt = '',
    hostGraceMs = HOST_GRACE_MS,
    stopGraceMs = MAIN_STOP_GRACE_MS,
    attempts = RESPAWN_ATTEMPTS,
    aliveMs = RESPAWN_ALIVE_MS,
    probeTimeoutMs = LAUNCH_PROBE_TIMEOUT_MS,
    webListenMs = RELISTEN_MS,
    webListenPollMs = RELISTEN_POLL_MS,
  } = options;
  const j = (value) => JSON.stringify(value === undefined ? null : value);
  return `'use strict';
// dsh-restart-now helper (v1.3.0, darwin) —— 由宿主在重启前写出并 detached 拉起，独立于应用进程树。
// 与 Windows 版同一契约：只停 Electron 主进程 → 宿主因 IPC 断开优雅退出（会话落盘）→ 再拉起应用。
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = ${j(exe)};
const MAIN = ${j(mainPid)};
const HOST = ${j(hostPid)};
const ERR_LOG = ${j(errLog)};
const ACK = ${j(ack)};
const RECEIPT = ${j(receipt)};
const HOST_GRACE_MS = ${j(hostGraceMs)};
const STOP_GRACE_MS = ${j(stopGraceMs)};
const ATTEMPTS = ${j(attempts)};
const ALIVE_MS = ${j(aliveMs)};
const ENV_DROP = ${JSON.stringify([...RESPAWN_ENV_DROP])};
const PROBE_TIMEOUT_MS = ${j(probeTimeoutMs)};
// 拉起后观测「新实例的 web 服务是否真的在监听」（第 6 项）。只观测，不当成功判据。
const WEB_LISTEN_MS = ${j(webListenMs)};
const WEB_LISTEN_POLL_MS = ${j(webListenPollMs)};
const PS = ${j(MAC_TOOLS.ps)};
const LSOF = ${j(MAC_TOOLS.lsof)};
const OSASCRIPT = ${j(MAC_TOOLS.osascript)};

// 与模块同一份源码（toString 注入）：宿主与助手的解析/判定规则永不分叉。
${normalizePath.toString()}
${tokenizeCommandLine.toString()}
${tokenizePosixCommandLine.toString()}
${relaunchArgsFrom.toString()}
${argsFromWindowsCommandLine.toString()}
${argsFromPosixCommandLine.toString()}
${parsePsProcessTable.toString()}
${collectDescendants.toString()}
${macPsArgs.toString()}
${macListenArgs.toString()}
${parseLsofListenPort.toString()}
${appleScriptLiteral.toString()}
${macAlertScript.toString()}

const T0 = Date.now();
function fail(message) {
  try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' ' + message + '\\n'); } catch (error) { /* 日志失败不影响主流程 */ }
}
function perf(message) {
  try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' perf: ' + message + '\\n'); } catch (error) {}
}
function alive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 发信号停机。ESRCH = 进程已经不在了，对调用方等价于成功（幂等），绝不记成失败。
function signal(pid, sig, label) {
  try { process.kill(pid, sig); return true; } catch (error) {
    if (error && error.code === 'ESRCH') return true;
    fail('kill ' + label + ' with ' + sig + ' failed: ' + ((error && error.message) || String(error)));
    return false;
  }
}
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(200);
  }
  return !alive(pid);
}

// 问系统「主进程当初是怎么被启动的」。问不到就返回 null —— 那不等于「没有参数」，
// 但两者对调用方的结论一样：不带参数启动（绝不拿自己的 argv 去猜）。
function readLaunchArgs() {
  if (!Number.isInteger(MAIN) || MAIN <= 1) return null;
  let text = '';
  try {
    text = execFileSync(PS, macPsArgs(MAIN), {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    fail('launch-args probe failed: ' + ((error && error.message) || String(error)));
    return null;
  }
  const trimmed = String(text || '').trim();
  return trimmed === '' ? null : trimmed;
}

// 拉起全失败时把话说到用户脸前（v1.2.1 同款语义）：应用已经没了，弹窗是唯一通道。
// osascript 独立 detached 拉起，不阻塞助手收尾；600ms 内没冒 ENOENT 就认为弹窗进程已起。
async function alertUser(message) {
  let started = true;
  let child;
  try {
    child = spawn(OSASCRIPT, ['-e', macAlertScript(message)], { detached: true, stdio: 'ignore' });
  } catch (error) {
    return false;
  }
  child.once('error', () => { started = false; });
  try { child.unref(); } catch (error) { /* 老 Node 无 unref */ }
  await sleep(600);
  return started;
}

// 问系统要一次「新实例的进程树里有没有人在 LISTEN」；自己做轮询到超时。
// 拿不到 lsof / 命令报错都只回 unsupported，绝不因此判重启失败（新实例可能合法换端口）。
async function waitWebListen(mainPid, timeoutMs) {
  const started = Date.now();
  const settle = (verdict, port, error) => ({ verdict: verdict, port: port || 0, wait: Date.now() - started, error: error || '' });
  while (Date.now() - started <= timeoutMs) {
    let table;
    try {
      table = execFileSync(PS, ['-axo', 'pid=,ppid='], {
        encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      return settle('unsupported', 0, String((error && error.message) || error));
    }
    const pids = collectDescendants(parsePsProcessTable(table), mainPid);
    try {
      const output = execFileSync(LSOF, macListenArgs(pids), {
        encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const port = parseLsofListenPort(output);
      if (port > 0) return settle('ok', port, '');
    } catch (error) {
      // lsof 退出码 1 = 这些 pid 没有匹配的监听（正常状态），继续轮询。
      if (!(error && (error.status === 1 || error.code === 'EPIPE'))) {
        return settle('unsupported', 0, String((error && error.message) || error));
      }
    }
    await sleep(WEB_LISTEN_POLL_MS);
  }
  return settle('timeout', 0, '');
}

function writeReceipt(patch) {
  if (!RECEIPT) return;
  try {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')); } catch (error) { current = {}; }
    fs.writeFileSync(RECEIPT, JSON.stringify(Object.assign({}, current, patch), null, 2));
  } catch (error) { fail('receipt write failed: ' + (error && error.message)); }
}

(async () => {
  // ⓪ pid 健全性（v1.3.0）：宿主是 Electron 主进程的子进程，但主进程可能已经先没了
  //    （此时 ppid 变成 0/1）。拿 0/1 去 kill 等于攻击 init 或空目标，必须先挡住。
  if (!Number.isInteger(MAIN) || MAIN <= 1) { fail('invalid main pid: ' + MAIN); return; }

  // ① 先写 ack：宿主据此判定派发成功（拿不到 ack 就报错、绝不杀任何进程）
  try { fs.writeFileSync(ACK, JSON.stringify({ at: new Date().toISOString(), helperPid: process.pid })); }
  catch (error) { fail('ack write failed: ' + (error && error.message)); return; }

  // ①b 趁主进程还活着，问它当初是怎么被启动的；问不到/不敢用就带空参数（见 relaunchArgsFrom）
  const rawCommandLine = readLaunchArgs();
  const launchArgs = relaunchArgsFrom(rawCommandLine, EXE, 'darwin');
  perf(launchArgs === null
    ? 'launch_args=unavailable' + (rawCommandLine ? ' (command line unusable)' : '')
    : 'launch_args=' + JSON.stringify(launchArgs));
  const args = launchArgs === null ? [] : launchArgs;

  await sleep(500);

  // ② 停主进程：SIGTERM 先礼（Electron 主进程默认按 Node 规则终止），宽限后 SIGKILL 后兵。
  //    只杀主进程、绝不按进程树杀：宿主必须在主进程死后走 IPC disconnect 的优雅关闭路径。
  const T1 = Date.now();
  if (alive(MAIN)) {
    signal(MAIN, 'SIGTERM', 'main');
    if (!(await waitGone(MAIN, STOP_GRACE_MS))) {
      fail('main alive after ' + STOP_GRACE_MS + 'ms, sending SIGKILL');
      signal(MAIN, 'SIGKILL', 'main');
    }
  }
  if (!(await waitGone(MAIN, 30000))) {
    fail('wait main timeout: ' + MAIN);
    writeReceipt({ failed: { at: new Date().toISOString(), reason: 'main-not-stopped' } });
    return;
  }
  const T2 = Date.now();

  // ③ 等宿主自己退（IPC 断开 → application.shutdown → 会话落盘），超时才定点补刀
  let hostDown = await waitGone(HOST, HOST_GRACE_MS);
  if (!hostDown) {
    fail('host alive after ' + HOST_GRACE_MS + 'ms, killing ' + HOST);
    signal(HOST, 'SIGKILL', 'host');
    hostDown = await waitGone(HOST, 10000);
  }
  const T3 = Date.now();

  // ④ 拉起新实例：干净环境（见 ENV_DROP：去掉 ELECTRON_RUN_AS_NODE 否则没有窗口，
  //    并清掉上一次运行/会话的 DSH_* 事实）+ 存活验证 + 重试
  const env = Object.assign({}, process.env);
  const dropped = [];
  for (const key of ENV_DROP) {
    if (key in env) dropped.push(key);
    delete env[key];
  }
  perf('env_dropped=' + (dropped.join(',') || 'none'));
  let newPid = 0;
  let lastError = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await sleep(attempt === 1 ? 800 : 1000);
    let child;
    try {
      child = spawn(EXE, args, { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env });
    } catch (error) {
      lastError = (error && error.message) || String(error);
      fail('respawn spawn failed (attempt ' + attempt + '): ' + lastError);
      continue;
    }
    child.on('error', (error) => fail('respawn error: ' + ((error && error.message) || String(error))));
    try { child.unref(); } catch (error) {}
    const pid = child.pid;
    await sleep(ALIVE_MS);
    if (pid && alive(pid)) { newPid = pid; break; }
    lastError = 'exited within ' + ALIVE_MS + 'ms';
    fail('respawn attempt ' + attempt + ' ' + lastError);
  }

  const T4 = Date.now();
  perf('main_stop=' + (T2 - T1) + 'ms host_grace=' + (T3 - T2) + 'ms respawn=' + (T4 - T3) + 'ms total=' + (T4 - T0) + 'ms');

  if (!newPid) {
    fail('respawn failed after ' + ATTEMPTS + ' attempts');
    writeReceipt({ failed: { at: new Date().toISOString(), reason: 'respawn-failed', detail: lastError } });
    // 唯一能把「请手动打开」送到眼前的通道（此时应用已经没了，界面不存在）
    const shown = await alertUser('重启失败：新实例没能启动。' + String.fromCharCode(10, 10)
      + '原因：' + (lastError || 'unknown') + String.fromCharCode(10, 10)
      + '请手动打开 DeepSeek Harness。日志：' + ERR_LOG);
    perf('alert_shown=' + shown);
    return;
  }
  writeReceipt({ respawnedAt: new Date().toISOString(), newPid: newPid, downtimeMs: T4 - (Number(readStart()) || T0) });

  // ⑤ 观测「新实例的 web 服务真的开始监听了吗」（v1.2.1 第 6 项）。
  //    进程活着 ≠ 服务起来了；这里查新实例的**进程树**里有没有人在 LISTEN（端口每次启动都变，
  //    所以不比端口号，只看有没有人听）。**只观测、不判失败**：结论只进日志，不影响重启结论。
  const listen = await waitWebListen(newPid, WEB_LISTEN_MS);
  perf('web_listen=' + listen.verdict + ' wait=' + listen.wait + 'ms'
    + (listen.port ? ' port=' + listen.port : '')
    + (listen.error ? ' error=' + listen.error : ''));
  process.exit(0);

  function readStart() {
    try { return JSON.parse(fs.readFileSync(RECEIPT, 'utf8')).atMs; } catch (error) { return 0; }
  }
})();
`;
}


/**
 * 派发助手：用应用自身的 exe 当 node（ELECTRON_RUN_AS_NODE=1）detached 拉起，不依赖系统 Node。
 * 返回 spawn 参数（纯数据，便于单测断言）。
 */
export function buildHelperSpawn(execPath, helperPath, env = process.env) {
  const merged = Object.assign({}, env, { ELECTRON_RUN_AS_NODE: '1' });
  return {
    file: execPath,
    args: [helperPath],
    options: { detached: true, stdio: 'ignore', env: merged, windowsHide: true },
  };
}

/** 本插件在 %TEMP% 留下的产物命名（prune 与清理逻辑共用）。 */
export const ARTIFACT_RE =
  /^dsh-restart-now-(?:helper-)?(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.(?:cjs|ack|err\.log)$/;

/**
 * 只保留最近 keep 次重启的产物组（helper/ack/errLog 同进退），其余删除。
 * 逐文件吞错（正在使用的旧日志可能删不掉，下轮再删），目录不存在或缺权限时静默返回。
 */
export function pruneRestartArtifacts(dir, keep = 10) {
  const result = { removed: 0, kept: 0 };
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return result;
  }
  const groups = new Map();
  for (const name of names) {
    const matched = ARTIFACT_RE.exec(name);
    if (!matched) continue;
    const stamp = matched[1];
    if (!groups.has(stamp)) groups.set(stamp, []);
    groups.get(stamp).push(name);
  }
  const stamps = Array.from(groups.keys()).sort();
  const drop = Math.max(0, stamps.length - Math.max(0, keep));
  for (let i = 0; i < drop; i += 1) {
    for (const name of groups.get(stamps[i])) {
      try {
        unlinkSync(join(dir, name));
        result.removed += 1;
      } catch (error) {
        /* 下轮再删 */
      }
    }
  }
  result.kept = Math.min(stamps.length, Math.max(0, keep));
  return result;
}
