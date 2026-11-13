// lib/index.js —— 宿主半边：路由注册 + 门禁 + 重启编排（v1.1；v1.3.1 加仅关闭 close-only）
//
// 路由（全部 exact，register 返回 disposer）：
//   GET  /plugins/dsh-restart-now/environment  探测口：环境/平台/版本/生效配置/上次回执/closeSupported
//   POST /plugins/dsh-restart-now/restart      动作口：?force=1 强制、?wait=1 等空闲、?cancel=1 撤销等待
//   POST /plugins/dsh-restart-now/close        仅关闭口：?force=1 强制；**无 wait/cancel**——等待模式
//                                              的终局是一次重启，与「仅关闭」语义冲突，刻意不复用。
//   GET  /plugins/dsh-restart-now/status       等待模式状态：{state, since, remainingMs, tasks, jobs}
//   GET|POST /plugins/dsh-restart-now/config   配置读写（单注册按 method 分派）
// 另注册斜杠命令 /restart（handler 在宿主内直接编排，无 HTTP 往返）。
//
// 门禁顺序（固定；restart 与 close 共用 ①–⑧，close 无 wait 分支）：
//   ① allowRestart → ② desktop 环境 → ③ 受支持平台(win32/darwin) → ④ 同源围栏
//   → ⑤ 平台会话鉴权(401/403) → ⑥ 插件安装中硬拦(409) → ⑦ 活跃任务(409 / wait / force)
//   → ⑧ 冷却(409) → 派发
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  artifactPaths, buildHelperScript, buildHelperSpawn, pruneRestartArtifacts, resolveExe,
} from './helper-src.js';
import { detectEnvironment, supportedPlatform } from './environment.js';
import { inspectRequest } from './guard.js';
import { inspectPlatformAuth, summarizeAuth } from './platform-auth.js';
import {
  resolveConfigFile, loadFileConfig, saveFileConfig, effectiveConfig, isUsableExePath, fileHasEntries, ENTRY_KEYS,
} from './config-store.js';
import { inspectActiveTasks, inspectInstallLock, resolveProfileDir } from './tasks.js';
import { inspectVersion } from './version.js';
import { cooldownRemaining, receiptStartAt } from './cooldown.js';
import {
  beginReceipt, readReceipt, receiptPath, summarizeReceipt, writeReceipt,
} from './receipt.js';

export const name = 'dsh-restart-now';

// 设置页表单 schema（可选依赖；解析失败时为 undefined，不影响功能）
export { Config } from './schema.js';

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * 配置文件路径（v1.3.0）。
 *
 * 必须优先用 profileContext.dir：真机 rc.5 的 macOS 桌面宿主**不导出** DSH_PROFILE_DIR /
 * DSH_HOME / USERPROFILE（宿主 env 里只有 ELECTRON_RUN_AS_NODE 与 DSH_CLIENT_VERSION），
 * 旧实现只读 env → 返回 null → 设置页保存 500、入口开关迁移永远失败。
 * cordis 的 profileContext 是官方启动器在宿主上下文里 provide 的权威来源
 * （{name,dir,patchPath,...}，见 app.asar profile-boot）；env 只在没有该服务时兜底。
 * @param ctx cordis 上下文（插件宿主半边）
 * @returns {string|null} <profile>/restart-now.config.json；全不可用时 null。
 */
function configFileFor(ctx) {
  let profileDir = '';
  try { profileDir = resolveProfileDir(ctx); } catch { profileDir = ''; }
  return resolveConfigFile(process.env, profileDir);
}

/** 围栏观测日志（v0.6）：每次动作口请求都留痕，容忍形态与拒绝都记录，供事后收紧围栏。
 *  v0.20：追加型日志加 512KB 上限——超过时只保留尾部 64KB（诊断价值在最近的条目）。 */
const DEBUG_LOG_MAX = 512 * 1024;
const DEBUG_LOG_TAIL = 64 * 1024;
function fenceDebugLog(entry) {
  try {
    const file = join(tmpdir(), 'dsh-restart-now-debug.log');
    appendFileSync(file, JSON.stringify(entry) + '\n');
    try {
      if (statSync(file).size > DEBUG_LOG_MAX) {
        const buf = readFileSync(file);
        writeFileSync(file, buf.subarray(Math.max(0, buf.length - DEBUG_LOG_TAIL)));
      }
    } catch { /* 截断失败不影响主流程，下轮再试 */ }
  } catch { /* 日志失败不影响主流程 */ }
}

function appendLog(file, text) {
  try { appendFileSync(file, new Date().toISOString() + ' ' + text + '\n'); } catch { /* 已无计可施 */ }
}

const stampOf = (now = Date.now()) => new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** 等助手写 ack：拿到才代表「助手活着并且马上要动手」，拿不到就报错、绝不杀任何进程。 */
export function waitForAck(ackPath, timeoutMs = 800, deps = {}) {
  const exists = deps.exists || existsSync;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  return (async () => {
    while (Date.now() - started <= timeoutMs) {
      try {
        if (exists(ackPath)) return true;
      } catch { /* 继续等 */ }
      await sleep(50);
    }
    return false;
  })();
}

// —— 等待模式状态（?wait=1）：宿主每 5s 复检，安静即派发，30 分钟封顶 ——
export const WAIT_TICK_MS = 5000;
export const WAIT_MAX_MS = 30 * 60 * 1000;
const waitState = { active: false, since: 0, deadline: 0, timer: null, last: null };

// 上一次真正派发重启的时间（内存）。与回执 atMs 一起构成冷却判据，见 lib/cooldown.js。
let lastDispatchAt = 0;

/** 清掉内存里的派发时间（仅测试用：同进程内多个用例要互不影响）。 */
export function resetCooldown() {
  lastDispatchAt = 0;
}

function waitSnapshot() {
  const now = Date.now();
  return {
    state: waitState.active ? 'waiting' : 'idle',
    since: waitState.active ? waitState.since : 0,
    remainingMs: waitState.active ? Math.max(0, waitState.deadline - now) : 0,
    tasks: waitState.active && waitState.last ? waitState.last.tasks : 0,
    jobs: waitState.active && waitState.last ? waitState.last.jobs : 0,
  };
}

export function cancelWait() {
  const wasActive = waitState.active;
  if (waitState.timer) {
    clearInterval(waitState.timer);
    waitState.timer = null;
  }
  waitState.active = false;
  waitState.since = 0;
  waitState.deadline = 0;
  waitState.last = null;
  return wasActive;
}

// —— v1.3.1 仅关闭（close-only）——
// close 的停机部分与 restart 完全同构（同一助手、同一 ack/回执/冷却契约），分叉点在「宿主退出」之后：
// restart 拉起新实例；close 到此为止，绝不 spawn exe（窗口由用户手动打开）。
// 助手按 action:'close' 分叉的实现落在 helper-src.js（另一条工作线，本文件不越界）；在它落地之前，
// 这里拒绝派发 close（501 close-helper-missing）——否则派发出去的还是现在的助手，会按 restart 拉起，
// 违反「close 绝不导致重启」。客户端据探测口 closeSupported 同步隐藏关闭入口，双保险。
// helper 实现 action:'close'（停机即止、绝不 spawn、回执写 closedAt）并过验收后翻 true 放开。
export const CLOSE_HELPER_READY = true;

/**
 * 停机派发（v1.3.1）：restart 与 close 的唯一执行点（HTTP 动作口/关闭口、等待模式 tick、斜杠命令都走这里）。
 *   action: 'restart'（默认，停机后拉起新实例）| 'close'（仅停机，不拉起）
 * 前置与派发机制完全共用：冷却 → 产物清理 → exe/pid 检查 → 回执 → 写助手 → detached 拉起 → 等 ack；
 * 停机之后做什么由助手脚本按 action 决定。options.deps.buildHelperScript 仅测试注入（默认真实现）。
 * 返回 { ok, status, reason?, stamp?, errLog?, helperPid?, mode? }。
 */
export async function performStop(ctx, config, options = {}) {
  const action = options.action === undefined ? 'restart' : options.action;
  if (action !== 'restart' && action !== 'close') {
    return { ok: false, status: 400, reason: 'invalid-action' };
  }
  // options.deps 仅测试注入（默认真实现/真常量）：buildHelperScript + closeHelperReady。
  const deps = options.deps || {};
  const closeReady = deps.closeHelperReady === undefined ? CLOSE_HELPER_READY : deps.closeHelperReady === true;
  const now = Date.now();
  const stamp = stampOf(now);
  const profileDir = resolveProfileDir(ctx);

  // ⑧ 冷却（v1.2.1 第 22 项）：连点两次会派发两个助手 → 可能留下两个实例。
  //    取「内存 lastAt」与「回执 atMs」中较晚的一个，重启后的新宿主也受同一窗口约束。
  //    必须在写回执之前判：否则本次会先把 atMs 刷成 now，自己把自己卡住。
  //    close 与 restart 共用同一窗口：刚停机过也不该立刻再派发停机/重启。
  if (options.ignoreCooldown !== true) {
    const lastAt = Math.max(lastDispatchAt, receiptStartAt(readReceipt(profileDir)));
    const remaining = cooldownRemaining(lastAt, now);
    if (remaining > 0) {
      return { ok: false, status: 409, reason: 'cooldown', retryAfterMs: remaining };
    }
  }

  // 仅关闭的前置能力检查：排在冷却之后（门禁口径与 restart 一致）、一切落盘副作用之前——
  // 助手尚未支持 close 时绝不派发（派发了就是现在的助手，会按 restart 拉起），且不占冷却窗口、
  // 不写产物与回执。helper 实现 action:'close' 后由 CLOSE_HELPER_READY 放开。
  if (action === 'close' && !closeReady) {
    return { ok: false, status: 501, reason: 'close-helper-missing' };
  }

  // v0.20 残留清理：在写本次新文件**之前**跑——本次 stamp 尚不存在，永无误删风险。
  try { pruneRestartArtifacts(tmpdir(), 10); } catch { /* 清理失败忽略 */ }

  const paths = artifactPaths(tmpdir(), stamp);
  const cfg = effectiveConfig(config, configFileFor(ctx));
  const exe = resolveExe(cfg, process.execPath, process.platform);
  if (!isUsableExePath(exe)) {
    appendLog(paths.errLog, `exe not usable (missing or not a file): ${exe}`);
    return { ok: false, status: 500, reason: 'exe-not-found', errLog: paths.errLog };
  }

  const hostPid = process.pid;
  const mainPid = process.ppid;
  // v1.3.0：主进程可能已经先没了（ppid 变 0/1）。此时派发助手只会空转后报错，
  // 且助手侧也会拒绝 kill 0/1；在这里 fail-fast，连助手都不写。
  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    appendLog(paths.errLog, 'invalid main pid (ppid): ' + mainPid);
    return { ok: false, status: 500, reason: 'no-main-process', errLog: paths.errLog };
  }

  // 从这一刻起才算「真派发了」：exe 不可用等前置失败不占冷却窗口，
  // 用户改完配置应该能立刻重试，而不是被自己刚才那次失败挡住 5 秒。
  lastDispatchAt = now;

  // 回执先写（宿主马上就要被杀，这是唯一能留给下一次启动的话）
  const begin = beginReceipt(profileDir, { stamp, hostPid, mainPid, now });
  if (action === 'close') {
    // 仅关闭：把动作类型带进回执，下次启动时「上次重启」行才能如实区分
    // （summarizeReceipt 目前忽略未知键，不影响既有展示；回执半边升级时据此渲染 closed 状态）。
    writeReceipt(profileDir, { ...begin, action: 'close' });
  }

  const buildHelper = typeof deps.buildHelperScript === 'function' ? deps.buildHelperScript : buildHelperScript;
  try {
    writeFileSync(paths.helper, buildHelper({
      // v1.3.0：助手脚本按宿主真实平台生成（win32: taskkill/WMI/PowerShell，
      // darwin: SIGTERM→SIGKILL/ps/lsof/osascript）；门禁 ③ 已保证平台受支持。
      platform: process.platform,
      exe,
      mainPid,
      hostPid,
      errLog: paths.errLog,
      ack: paths.ack,
      receipt: receiptPath(profileDir),
      // v1.3.1：停机后做什么由助手按 action 决定——restart 拉起新实例，close 绝不拉起。
      // stamp 同步传给助手：回执写回前核对 stamp，防上一次残留的旧助手污染新回执。
      action,
      stamp,
    }));
  } catch (error) {
    appendLog(paths.errLog, 'helper write failed: ' + String(error?.message ?? error));
    return { ok: false, status: 500, reason: 'helper-write-failed', errLog: paths.errLog };
  }

  // 派发：应用自身 exe 当 node（ELECTRON_RUN_AS_NODE=1）detached，脱离本进程树
  const dispatch = buildHelperSpawn(process.execPath, paths.helper);
  let child;
  try {
    child = spawn(dispatch.file, dispatch.args, dispatch.options);
    child.on('error', (error) => appendLog(paths.errLog, 'dispatcher spawn failed: ' + String(error?.message ?? error)));
    child.unref();
  } catch (error) {
    appendLog(paths.errLog, 'spawn threw: ' + String(error?.message ?? error));
    return { ok: false, status: 500, reason: 'helper-dispatch-failed', errLog: paths.errLog };
  }

  const acked = await waitForAck(paths.ack);
  if (!acked) {
    appendLog(paths.errLog, 'helper did not write ack within timeout; helper may still be running');
    return { ok: false, status: 500, reason: 'helper-not-responding', errLog: paths.errLog, helperPid: child?.pid ?? 0 };
  }

  return {
    ok: true,
    status: 202,
    stamp,
    errLog: paths.errLog,
    helperPid: child?.pid ?? 0,
    mode: options.mode || (action === 'close' ? 'close' : 'now'),
  };
}

/** v1.3.0 及之前的重启编排（现为 performStop 的 restart 形态；调用方/导出契约不变）。 */
export function performRestart(ctx, config, options = {}) {
  return performStop(ctx, config, { ...options, action: 'restart' });
}

/** 仅关闭编排：停机后不拉起（助手按 action:'close' 收尾；CLOSE_HELPER_READY=false 时 501 拒派）。 */
export function performClose(ctx, config, options = {}) {
  return performStop(ctx, config, { ...options, action: 'close' });
}

// —— 等待模式编排 ——
function startWait(ctx, config) {
  if (waitState.active) return waitSnapshot();
  waitState.active = true;
  waitState.since = Date.now();
  waitState.deadline = waitState.since + WAIT_MAX_MS;
  waitState.last = inspectActiveTasks(ctx);

  const tick = async () => {
    if (!waitState.active) return;
    const snapshot = inspectActiveTasks(ctx);
    waitState.last = snapshot;
    const expired = Date.now() >= waitState.deadline;
    if (!snapshot.active || expired) {
      cancelWait();
      const result = await performRestart(ctx, config, { mode: expired && snapshot.active ? 'forced-timeout' : 'wait' });
      fenceDebugLog({ t: new Date().toISOString(), kind: 'wait-dispatch', expired, tasks: snapshot.tasks, jobs: snapshot.jobs, ...result, errLog: undefined });
    }
  };
  waitState.timer = setInterval(() => { tick().catch(() => {}); }, WAIT_TICK_MS);
  try { waitState.timer.unref?.(); } catch { /* 老 Node 无 unref，忽略 */ }
  return waitSnapshot();
}

// —— 动作口 ——

/** 平台鉴权失败时给用户看的话（中英并列：宿主管不到前端语言）。 */
const AUTH_HINTS = {
  unauthorized: '缺少或已过期的桌面会话凭据；请在应用窗口内操作。 / Missing or expired desktop session credential — operate from the app window.',
  forbidden: '平台判定请求来源不可信。 / The platform rejected this request origin.',
  rejected: '平台拒绝了该请求。 / The platform rejected this request.',
};

/**
 * 平台会话鉴权（v1.2.1）：围栏只能证明「来自本机回环」，挡不住本机任意进程 curl 动作口。
 * 返回 null = 放行；否则 { status, payload } 直接回给客户端。
 * bypassed / skipped / error 一律放行：平台服务缺席或自己抛异常时，插件不能整体不可用。
 */
async function gatePlatformAuth(ctx, req, cfg, kind) {
  const auth = await inspectPlatformAuth(ctx, req, { enforced: cfg.platformAuth !== false });
  const blocked = auth.verdict === 'unauthorized' || auth.verdict === 'forbidden' || auth.verdict === 'rejected';
  if (blocked || auth.error) {
    fenceDebugLog({
      t: new Date().toISOString(),
      kind: 'platform-auth:' + kind,
      verdict: auth.verdict,
      status: auth.status,
      error: auth.error,
      ...inspectRequest(req).detail,
    });
  }
  if (!blocked) return null;
  const status = auth.status || (auth.verdict === 'forbidden' ? 403 : 401);
  return {
    status,
    payload: {
      ok: false,
      reason: auth.verdict,
      platformStatus: auth.status || 0,
      hint: AUTH_HINTS[auth.verdict] || '',
    },
  };
}

/** 门禁 ①–⑤（restart 与 close 共用，顺序固定）：全部通过返回生效配置；任一失败已写响应并返回 null。
 *  kind 只用于留痕标签（围栏/鉴权 debug 日志）；restart 保持 v0.6 以来的无 kind 形态，close 单独标注。 */
async function gateCommon(req, res, ctx, config, kind) {
  const cfg = effectiveConfig(config, configFileFor(ctx));

  // ① 总开关
  if (cfg.allowRestart === false) {
    sendJson(res, 403, { ok: false, reason: 'disabled' });
    return null;
  }

  // ② 环境门禁：绝不在 web 环境杀 ppid（那是用户终端的进程树）
  if (detectEnvironment(ctx) !== 'desktop') {
    sendJson(res, 403, { ok: false, reason: 'non-desktop', hint: 'use dshmarket' });
    return null;
  }

  // ③ 平台门禁：停机链路有两套系统原语（win32: taskkill/WMI/PowerShell；darwin: 信号/ps/lsof/osascript）
  if (!supportedPlatform()) {
    sendJson(res, 403, { ok: false, reason: 'unsupported-platform', hint: 'Windows and macOS only' });
    return null;
  }

  // ④ 同源围栏（v0.6 桌面剥头代理感知，guard.js 头注释有完整论证）
  const verdict = inspectRequest(req);
  fenceDebugLog({
    t: new Date().toISOString(),
    ...(kind === 'restart' ? {} : { kind }),
    verdict: verdict.trusted ? 'trusted' : 'untrusted',
    notes: verdict.notes,
    ...verdict.detail,
    userAgent: req.headers?.['user-agent'],
  });
  if (!verdict.trusted) {
    sendJson(res, 403, { ok: false, reason: 'untrusted' });
    return null;
  }

  // ⑤ 平台会话鉴权（v1.2.1）：围栏之后、任何状态变更之前
  const denied = await gatePlatformAuth(ctx, req, cfg, kind);
  if (denied) {
    sendJson(res, denied.status, denied.payload);
    return null;
  }
  return cfg;
}

/** 门禁顺序（固定）：① allowRestart → ② desktop → ③ 受支持平台 → ④ 围栏 → ⑤ 平台鉴权 → ⑥ 安装锁 → ⑦ 活跃任务 */
async function handleRestart(req, res, ctx, config) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    return res.end();
  }
  let search = '';
  try { search = new URL(req.url || '/', 'http://127.0.0.1').search || ''; } catch { search = ''; }
  const query = new URLSearchParams(search);
  const force = query.get('force') === '1' || query.get('force') === 'true';
  const wantWait = query.get('wait') === '1' || query.get('wait') === 'true';
  const wantCancel = query.get('cancel') === '1' || query.get('cancel') === 'true';

  const cfg = await gateCommon(req, res, ctx, config, 'restart');
  if (!cfg) return undefined;

  // 撤销等待（不需要再走后面的守卫）
  if (wantCancel) {
    const wasActive = cancelWait();
    return sendJson(res, 200, { ok: true, cancelled: wasActive, ...waitSnapshot() });
  }

  // ⑥ 插件安装/卸载进行中：硬拦（此时停机会打断安装，profile 可能半残）
  const lock = inspectInstallLock(resolveProfileDir(ctx), {
    warn: (message) => fenceDebugLog({ t: new Date().toISOString(), kind: 'install-lock', message }),
  });
  if (lock.locked) {
    return sendJson(res, 409, { ok: false, reason: 'installing', pid: lock.pid, forceable: false });
  }

  // ⑦ 活跃任务：默认拒绝（可 force），或转入等待模式
  const tasksInfo = inspectActiveTasks(ctx);
  if (tasksInfo.active && !force) {
    if (wantWait) {
      const snapshot = startWait(ctx, config);
      return sendJson(res, 202, { ok: true, mode: 'waiting', ...snapshot, tasks: tasksInfo.tasks, jobs: tasksInfo.jobs });
    }
    return sendJson(res, 409, {
      ok: false, reason: 'busy', tasks: tasksInfo.tasks, jobs: tasksInfo.jobs, forceable: true,
    });
  }

  cancelWait();
  const result = await performRestart(ctx, config, { mode: force && tasksInfo.active ? 'forced' : 'now' });
  const { status, ...payload } = result;
  return sendJson(res, status, payload);
}

/**
 * 仅关闭口（POST /close，v1.3.1）：停机后不拉起，窗口由用户手动打开。
 * 门禁与 restart 完全同序同口径（鉴权/安装锁/活跃任务/冷却共用），但不提供 wait：
 * 等待模式的终局是一次重启，与「仅关闭」语义冲突——刻意不复用（close 绝不导致重启）。
 */
async function handleClose(req, res, ctx, config) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    return res.end();
  }
  let search = '';
  try { search = new URL(req.url || '/', 'http://127.0.0.1').search || ''; } catch { search = ''; }
  const query = new URLSearchParams(search);
  const force = query.get('force') === '1' || query.get('force') === 'true';
  // wait / cancel 在 close 上没有意义：不生效也不报错（客户端不会发）——等待终局是重启，绝不复用。

  const cfg = await gateCommon(req, res, ctx, config, 'close');
  if (!cfg) return undefined;

  // ⑥ 安装锁：与 restart 同口径
  const lock = inspectInstallLock(resolveProfileDir(ctx), {
    warn: (message) => fenceDebugLog({ t: new Date().toISOString(), kind: 'install-lock', message }),
  });
  if (lock.locked) {
    return sendJson(res, 409, { ok: false, reason: 'installing', pid: lock.pid, forceable: false });
  }

  // ⑦ 活跃任务：与 restart 同口径，但只有 force 一条出路（没有等待选项）
  const tasksInfo = inspectActiveTasks(ctx);
  if (tasksInfo.active && !force) {
    return sendJson(res, 409, {
      ok: false, reason: 'busy', tasks: tasksInfo.tasks, jobs: tasksInfo.jobs, forceable: true,
    });
  }

  // 挂着的等待重启会在停机后拉起新实例——发起关闭前必须撤销
  cancelWait();
  const result = await performClose(ctx, config, { mode: force && tasksInfo.active ? 'forced' : 'close' });
  const { status, ...payload } = result;
  return sendJson(res, status, payload);
}

// —— 配置读写 ——

function readBody(req, cap = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** v1.2.2：入口开关是否「已被明确表过态」——客户端据此决定要不要做一次性迁移。
 *  判据 = patch 条目自己写了 entry 键，或配置文件里写了 entry 键（旧键 hideSidebarButton 也算）。
 *  **绝不能用 effectiveConfig() 判**：它必然叠加 DEFAULTS 的四个 entry 键，恒为真。 */
export function entriesDeclared(patchConfig, file = resolveConfigFile()) {
  const patchHas = ENTRY_KEYS.some((key) => typeof patchConfig?.[key] === 'boolean');
  return patchHas || fileHasEntries(file);
}

/** GET /plugins/dsh-restart-now/config：只读，不分环境（web 读到的是 web profile 的文件，无害）。
 *  v1.3.0：文件路径改用 configFileFor(ctx)——profileContext 优先，macOS 上 env 全缺也能拿到。 */
function handleGetConfig(req, res, ctx, patchConfig) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' });
    return res.end();
  }
  const file = configFileFor(ctx);
  const eff = effectiveConfig(patchConfig, file);
  return sendJson(res, 200, {
    ok: true, file, config: eff,
    entriesDeclared: entriesDeclared(patchConfig, file),
    derivedExe: resolveExe(eff, process.execPath, process.platform),
  });
}

/** POST /plugins/dsh-restart-now/config：写配置文件。
 *  门禁：环境 desktop（写文件无意义于 web）+ Q6 围栏；**不设 allowRestart 门禁**——
 *  用户必须能经 UI 把总开关重新打开，否则自锁。 */
async function handleSetConfig(req, res, ctx, patchConfig) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    return res.end();
  }
  if (detectEnvironment(ctx) !== 'desktop') {
    return sendJson(res, 403, { ok: false, reason: 'non-desktop', hint: 'use dshmarket' });
  }
  const verdict = inspectRequest(req);
  fenceDebugLog({
    t: new Date().toISOString(), kind: 'config', verdict: verdict.trusted ? 'trusted' : 'untrusted',
    notes: verdict.notes, ...verdict.detail, userAgent: req.headers?.['user-agent'],
  });
  if (!verdict.trusted) {
    return sendJson(res, 403, { ok: false, reason: 'untrusted' });
  }
  // v1.2.1：写配置同样是状态变更，过平台鉴权。逃生门（platformAuth:false）无法经 UI 关闭时，
  // 用户可手动编辑 restart-now.config.json——那条路径不经过 HTTP，永远可用。
  const cfgNow = effectiveConfig(patchConfig, configFileFor(ctx));
  const denied = await gatePlatformAuth(ctx, req, cfgNow, 'config');
  if (denied) {
    return sendJson(res, denied.status, denied.payload);
  }
  let raw;
  try { raw = JSON.parse(await readBody(req) || '{}'); } catch (e) {
    return sendJson(res, 400, { ok: false, reason: 'bad-json', detail: String(e?.message ?? e) });
  }
  // v0.17 入口一：exePath 保存即校验——非空且不是已存在的普通文件 → 400，表单显示原因。
  if (typeof raw?.exePath === 'string' && raw.exePath.trim() !== '' && !isUsableExePath(raw.exePath)) {
    return sendJson(res, 400, {
      ok: false, reason: 'exe-path-invalid',
      detail: '该路径不是已存在的文件；留空则自动推导（Windows 为安装目录下的 exe，macOS 为 .app 内的可执行文件）',
    });
  }
  const file = configFileFor(ctx);
  if (!file) {
    return sendJson(res, 500, { ok: false, reason: 'config-path-unavailable' });
  }
  try { saveFileConfig(file, raw); } catch (e) {
    return sendJson(res, 500, { ok: false, reason: 'config-write-failed', detail: String(e?.message ?? e) });
  }
  return sendJson(res, 200, {
    ok: true, file, config: effectiveConfig(patchConfig, file),
    // 刚写完，配置文件必然已含 entry 键；回传同一字段让客户端无需再猜。
    entriesDeclared: entriesDeclared(patchConfig, file),
  });
}

// —— 斜杠命令（v1.1）：/restart [--force] [--wait] ——

const COMMAND_NAME = 'restart';
const COMMAND_DESCRIPTION = 'Restart the DSH desktop app / 重启 DSH 桌面版';

/** 斜杠命令回执文案：宿主管不到前端语言，统一中英并列，谁都读得懂。 */
function commandText() {
  return {
    busy: (tasks, jobs) => `还有 ${tasks} 个任务、${jobs} 个后台作业在运行；加 --force 强制重启，或加 --wait 等空闲后重启。
${tasks} task(s) and ${jobs} job(s) are still running — add --force to restart now or --wait to restart once idle.`,
    installing: () => '插件安装/卸载进行中，完成后再试。 / A plugin install is in progress; try again when it finishes.',
    disabled: () => '总开关已关闭（设置 → 重启应用）。 / Restart is disabled by the master switch (Settings → Restart).',
    nonDesktop: () => '仅在 DSH 桌面版中可用。 / Only available in the DSH desktop app.',
    unsupportedPlatform: () => '仅在 Windows 与 macOS 上可用。 / Only available on Windows and macOS.',
    started: (mode) => (mode === 'wait'
      ? '等待任务结束后自动重启… / Waiting for tasks to finish, then restarting…'
      : '正在重启桌面应用… / Restarting the desktop app…'),
    failed: (reason) => `重启失败：${reason} / Restart failed: ${reason}`,
  };
}

function registerCommand(ctx, config) {
  let commands;
  try { commands = ctx.get('commands'); } catch { commands = undefined; }
  if (!commands || typeof commands.register !== 'function') return undefined;
  try {
    return commands.register({
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      input: { hint: '[--force] [--wait]' },
      handler: async ({ rawInput }) => {
        const text = commandText();
        const raw = String(rawInput || '');
        const force = /(^|\s)--force(\s|$)/.test(raw);
        const wantWait = /(^|\s)--wait(\s|$)/.test(raw);

        const cfg = effectiveConfig(config, configFileFor(ctx));
        if (cfg.allowRestart === false) return { kind: 'error', text: text.disabled() };
        if (detectEnvironment(ctx) !== 'desktop') return { kind: 'error', text: text.nonDesktop() };
        if (!supportedPlatform()) return { kind: 'error', text: text.unsupportedPlatform() };

        const lock = inspectInstallLock(resolveProfileDir(ctx), {
          warn: (message) => fenceDebugLog({ t: new Date().toISOString(), kind: 'install-lock', message }),
        });
        if (lock.locked) return { kind: 'error', text: text.installing() };

        const tasksInfo = inspectActiveTasks(ctx);
        if (tasksInfo.active && !force) {
          if (wantWait) {
            startWait(ctx, config);
            return { kind: 'success', text: text.started('wait') };
          }
          return { kind: 'error', text: text.busy(tasksInfo.tasks, tasksInfo.jobs) };
        }

        cancelWait();
        const result = await performRestart(ctx, config, { mode: force && tasksInfo.active ? 'forced' : 'now' });
        if (!result.ok) return { kind: 'error', text: text.failed(result.reason || 'unknown') };
        return { kind: 'success', text: text.started('now') };
      },
    });
  } catch (error) {
    return undefined;
  }
}

export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (hostCtx) => {
    const host = hostCtx;
    host.effect(() => {
      // v0.20 残留清理（激活时一次）：历史积累在宿主启动时就清掉，不必等下一次重启
      try { pruneRestartArtifacts(tmpdir(), 10); } catch { /* 清理失败忽略 */ }
      const registrations = [
        // 探测口（GET）：客户端启动时据此决定是否挂载入口。
        // v0.21：同时回传生效配置 + 推导路径（挂载即得 liveCfg，不必等设置页）；
        // v1.1：再回传运行时版本判定与上次重启回执。
        // v1.2.1：额外回报平台鉴权结论——它是「按钮为什么会被拒」的唯一诊断口，所以永不拦截。
        host.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-restart-now/environment',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { allow: 'GET' });
              return res.end();
            }
            const configFile = configFileFor(ctx);
            const eff = effectiveConfig(config, configFile);
            const profileDir = resolveProfileDir(ctx);
            const auth = await inspectPlatformAuth(ctx, req, { enforced: eff.platformAuth !== false });
            return sendJson(res, 200, {
              ok: true,
              environment: detectEnvironment(ctx),
              platform: process.platform,
              // v1.3.1：仅关闭能力位——助手实现 action:'close'（CLOSE_HELPER_READY 翻 true）前恒为
              // false，客户端据此隐藏全部关闭入口；探测口永不拦截，这里同样如实回报。
              closeSupported: CLOSE_HELPER_READY,
              config: eff,
              // v1.2.2：入口开关「有没有被明确表过态」——客户端据此决定要不要做一次性迁移。
              // 不能用 config 判：eff 必然叠加 DEFAULTS 的四个 entry 键（恒为真）。
              entriesDeclared: entriesDeclared(config, configFile),
              configFile,
              platformAuth: summarizeAuth(auth),
              derivedExe: resolveExe(eff, process.execPath, process.platform),
              ...inspectVersion(),
              lastRestart: summarizeReceipt(readReceipt(profileDir)),
              wait: waitSnapshot(),
            });
          },
        }),
        // 动作口（POST）：?force / ?wait / ?cancel
        host.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-restart-now/restart',
          handler: (req, res) => handleRestart(req, res, ctx, config),
        }),
        // 仅关闭口（POST，v1.3.1）：停机不拉起；门禁与动作口同序，无 wait/cancel（等待终局是重启）。
        // CLOSE_HELPER_READY=false（助手未实现 action:'close'）时派发层 501 拒绝，绝不变成一次重启。
        host.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-restart-now/close',
          handler: (req, res) => handleClose(req, res, ctx, config),
        }),
        // 等待模式状态（GET）：v1.2.1 起同样过围栏 + 平台鉴权（它会暴露任务计数与等待状态）
        host.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-restart-now/status',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { allow: 'GET' });
              return res.end();
            }
            const verdict = inspectRequest(req);
            if (!verdict.trusted) {
              fenceDebugLog({
                t: new Date().toISOString(), kind: 'status', verdict: 'untrusted',
                notes: verdict.notes, ...verdict.detail, userAgent: req.headers?.['user-agent'],
              });
              return sendJson(res, 403, { ok: false, reason: 'untrusted' });
            }
            const cfg = effectiveConfig(config, configFileFor(ctx));
            const denied = await gatePlatformAuth(ctx, req, cfg, 'status');
            if (denied) {
              return sendJson(res, denied.status, denied.payload);
            }
            return sendJson(res, 200, { ok: true, ...waitSnapshot() });
          },
        }),
        // 配置口（单注册按 method 分派：GET 读 / POST 写；同路径双注册的路由行为未知，不赌）
        host.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-restart-now/config',
          handler: (req, res) => (req.method === 'GET'
            ? handleGetConfig(req, res, ctx, config)
            : handleSetConfig(req, res, ctx, config)),
        }),
      ];
      return () => {
        // 插件被卸载/禁用时：等待模式的 5s 定时器必须一起停掉，
        // 否则插件已经下线还会按原计划把应用重启一次（用户会莫名其妙掉会话）。
        try { cancelWait(); } catch { /* 未在等待 */ }
        registrations.forEach((d) => d());
      };
    }, 'dsh-restart-now: routes');
  });

  // 斜杠命令（v1.1）：服务可能晚于插件就绪，用 inject 等它出现；缺失时静默跳过
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => {
      const dispose = registerCommand(commandCtx, config);
      return () => { try { dispose?.(); } catch { /* 已卸载 */ } };
    }, 'dsh-restart-now: command');
  });
}
