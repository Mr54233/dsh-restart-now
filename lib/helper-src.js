// dsh-restart-now —— 重启助手与派发参数（宿主半边，纯函数，便于单测）
//
// 沿革（每一版都可追溯到一次真机故障）：
//   v0.7  taskkill /PID <ppid> /T /F 会按父子关系连坐杀掉 detached 助手 → 改 WMI 派发脱离进程树
//   v0.9  火绒拦「隐藏执行 PowerShell」+ WMI 给助手开可见控制台黑框 → 改 wscript.exe + VBS(ShowWindow=0)
//   v1.1  实测（.m4/exp-kill 三组实验）：detached 子进程在「只杀主进程」时存活，WMI/VBS 整层可删；
//         杀法改为「只结束 Electron 主进程（不带 /T）」，让宿主因 IPC 断开自行优雅关闭（会话落盘），
//         超时再定点补杀宿主；拉起改用 detached spawn(应用自身 exe) 当 node，助手派发不再需要 WMI。
//
// 助手时序：写 ack → 问主进程启动参数（WMI，问不到就不带参数）→ 等 500ms → taskkill main /F（不带 /T）
//          → 等 main 消失 30s → 等宿主优雅退出 graceMs → 仍未退则 taskkill host /F 补刀
//          → 800ms 缓冲 → 带上参数拉起 exe（重试 3 次，每次存活验证 2.5s）→ 写回执
//          → 全失败则弹窗告知「请手动打开」（v1.2.1）
import { readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认「给宿主优雅关闭」的宽限窗口。 */
export const HOST_GRACE_MS = 15000;
/** 拉起重试次数与每次存活验证时长。 */
export const RESPAWN_ATTEMPTS = 3;
export const RESPAWN_ALIVE_MS = 2500;
/** 问「主进程当初怎么被启动的」的超时（WMI 首次查询会慢一些）。 */
export const LAUNCH_PROBE_TIMEOUT_MS = 8000;

/** 比较路径时统一分隔符、大小写与尾部分隔符。 */
export function normalizePath(value) {
  return String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();
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
 * @param {string|null} commandLine WMI 读到的命令行。
 * @param {string} exe 目标可执行文件。
 * @returns {string[]|null} 要转发的参数；null 表示「问不出来/不敢用」。
 */
export function relaunchArgsFrom(commandLine, exe) {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return null;
  if (commandLine.includes('\\"')) return null;
  const tokens = tokenizeCommandLine(commandLine);
  if (tokens.length === 0) return null;
  if (normalizePath(tokens[0]) !== normalizePath(exe)) return null;
  const args = tokens.slice(1);
  for (const arg of args) {
    if (/^--type=/u.test(arg) || arg === '--expose-internals') return null;
  }
  return args;
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
 * 解析要拉起的目标可执行文件：配置里填了就用配置，否则按当前宿主进程所在目录推导。
 * @param config 生效配置（可含 exePath）
 * @param execPath 宿主进程的 process.execPath（桌面端即 DeepSeek Harness.exe）
 */
export function resolveExe(config, execPath) {
  const configured = config && typeof config.exePath === 'string' ? config.exePath.trim() : '';
  if (configured) return configured;
  return join(dirname(execPath), 'DeepSeek Harness.exe');
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
 */
export function buildHelperScript(options) {
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
  } = options;
  const j = (value) => JSON.stringify(value === undefined ? null : value);
  return `'use strict';
// dsh-restart-now helper (v1.1) —— 由宿主在重启前写出并 detached 拉起，独立于应用进程树。
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

// 启动参数复用（v1.2.1）：下面三个函数是模块里同名函数的**同一份源码**（toString 注入），
// 避免助手脚本再抄一遍解析规则；改逻辑只改一处。
${normalizePath.toString()}
${tokenizeCommandLine.toString()}
${relaunchArgsFrom.toString()}

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
