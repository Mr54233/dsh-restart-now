// dsh-restart-now —— 重启助手与派发参数（宿主半边，纯函数，便于单测）
//
// 沿革（每一版都可追溯到一次真机故障）：
//   v0.7  taskkill /PID <ppid> /T /F 会按父子关系连坐杀掉 detached 助手 → 改 WMI 派发脱离进程树
//   v0.9  火绒拦「隐藏执行 PowerShell」+ WMI 给助手开可见控制台黑框 → 改 wscript.exe + VBS(ShowWindow=0)
//   v1.1  实测（.m4/exp-kill 三组实验）：detached 子进程在「只杀主进程」时存活，WMI/VBS 整层可删；
//         杀法改为「只结束 Electron 主进程（不带 /T）」，让宿主因 IPC 断开自行优雅关闭（会话落盘），
//         超时再定点补杀宿主；拉起改用 detached spawn(应用自身 exe) 当 node，助手派发不再需要 WMI。
//
// 助手时序：写 ack → 等 500ms → taskkill main /F（不带 /T）→ 等 main 消失 30s
//          → 等宿主优雅退出 graceMs → 仍未退则 taskkill host /F 补刀
//          → 800ms 缓冲 → 拉起 exe（重试 3 次，每次存活验证 2.5s）→ 写回执
import { readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认「给宿主优雅关闭」的宽限窗口。 */
export const HOST_GRACE_MS = 15000;
/** 拉起重试次数与每次存活验证时长。 */
export const RESPAWN_ATTEMPTS = 3;
export const RESPAWN_ALIVE_MS = 2500;

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
 *  - 拉起后做存活验证并重试，全失败写日志 + 回执 failed 段，客户端下次挂载能看到提示。
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
      child = spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env });
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
