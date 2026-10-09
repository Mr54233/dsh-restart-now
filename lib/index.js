// lib/index.js —— 宿主半边：路由注册 + 门禁 + 重启编排。
// 实现依据《02-实施文档》§5（M1 已核实 API：dshmarket/src/index.ts:180 生命周期模式、
// routes.ts:1720 webServer.register 返回 disposer、RAW node http handler 签名）。
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildHelperScript, buildVbsDispatch, buildDispatcherVbs, isStandaloneNode, resolveExe, resolveNodeExecutable,
  pruneRestartArtifacts,
} from './helper-src.js';
import { detectEnvironment } from './environment.js';
import { inspectRequest } from './guard.js';
import {
  resolveConfigFile, loadFileConfig, saveFileConfig, effectiveConfig, isUsableExePath,
} from './config-store.js';

export const name = 'dsh-restart-now';

// 设置页表单 schema（可选依赖；解析失败时为 undefined，不影响功能）
export { Config } from './schema.js';

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
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

/** 门禁顺序（v0.2/v0.3 定案）：① allowRestart → ② environment → ③ Q6 围栏 → exe fail-fast
 *  v0.17 勘误：动作口此前只认 patch 配置，设置页保存的文件值（delayMs/exePath/allowRestart）
 *  根本不参与执行——真机实证：exePath='c/' 已入文件但两次重启的 helper 实参仍是自动推导
 *  路径。现在合并三层配置（DEFAULTS < patch < 文件）后再走门禁与派发。 */
function handleRestart(req, res, ctx, config) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    return res.end();
  }
  const cfg = effectiveConfig(config, resolveConfigFile());

  // ① 总开关（在前，保证 web 下 allowRestart=false 的 'disabled' 语义可测，《03-测试文档》I3；
  //    v0.17 起文件层开关同样被服务端强制，不再只靠客户端预检）
  if (cfg.allowRestart === false) {
    return sendJson(res, 403, { ok: false, reason: 'disabled' });
  }

  // ② 环境门禁：绝不在 web 环境杀 ppid（那是用户终端的进程树）
  const env = detectEnvironment(ctx);
  if (env !== 'desktop') {
    return sendJson(res, 403, { ok: false, reason: 'non-desktop', hint: 'use dshmarket' });
  }

  // ③ Q6 围栏 v0.6（桌面剥头代理感知，guard.js 头注释有完整论证）：
  //    loopback 对端硬条件 + Host/Origin 存在即校验 + 缺失/转发头容忍留痕
  const verdict = inspectRequest(req);
  fenceDebugLog({
    t: new Date().toISOString(),
    verdict: verdict.trusted ? 'trusted' : 'untrusted',
    notes: verdict.notes,
    ...verdict.detail,
    userAgent: req.headers?.['user-agent'],
  });
  if (!verdict.trusted) {
    return sendJson(res, 403, { ok: false, reason: 'untrusted' });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // v0.20 残留清理：在写本次新文件**之前**跑——本次 stamp 尚不存在，永无误删风险；
  // 保留最近 10 次（含各次 helper/dispatch/errLog），失败绝不影响重启。
  try { pruneRestartArtifacts(tmpdir(), 10); } catch { /* 清理失败忽略 */ }
  const errLog = join(tmpdir(), `dsh-restart-now-${stamp}.err.log`);

  // exe 决策（§1）：patch/文件层 exePath 优先，留空自动推导（v0.17 起文件层生效）。
  // fail-fast 升级为 isFile（isUsableExePath）：'c/' 垃圾值、'C:\Windows' 目录都在这里
  // 干净拒绝且**不派发助手**——窗口绝不会因坏路径被杀掉不回来。
  const exe = resolveExe(cfg, process.execPath);
  if (!isUsableExePath(exe)) {
    writeFileSync(errLog, `exe not usable (missing or not a file): ${exe}`);
    return sendJson(res, 500, { ok: false, reason: 'exe-not-found', errLog });
  }

  const ppid = process.ppid;
  // v0.9 勘误（E1 真机 2026-10-09）：v0.7 的 powershell 派发器被火绒「隐藏执行PowerShell」
  // HIPS 规则拦截，且 WMI Create 默认给助手 node 开可见黑框。改为：宿主把 helper.cjs 与
  // 静态 dispatch.vbs 写到 %TEMP%，spawn wscript.exe（GUI 子系统，零控制台）执行——
  // VBS 经 WMI Win32_Process.Create + Win32_ProcessStartup{ShowWindow=0,
  // CreateFlags=0x08000000} 拉起助手（父进程 = WmiPrvSE，脱离本树且无窗口）。
  // 杀树/等待/拉起仍全部由助手执行（单一杀手）；宿主不再 taskkill。
  const delayMs = cfg.delayMs ?? 50;
  const nodeExec = resolveNodeExecutable();
  if (!isStandaloneNode(nodeExec)) {
    // WMI Create 无法设置环境变量，Electron-shim node（ELECTRON_RUN_AS_NODE）派发不了
    writeFileSync(errLog, 'no standalone node.exe available for WMI dispatch');
    return sendJson(res, 500, { ok: false, reason: 'helper-dispatch-unavailable', errLog });
  }
  const helperPath = join(tmpdir(), `dsh-restart-now-helper-${stamp}.cjs`);
  const vbsPath = join(tmpdir(), `dsh-restart-now-dispatch-${stamp}.vbs`);
  writeFileSync(helperPath, buildHelperScript(exe, ppid, { errLog, delayMs }));
  writeFileSync(vbsPath, buildDispatcherVbs());
  const disp = buildVbsDispatch(nodeExec, helperPath, errLog, vbsPath);
  try {
    const dispatcher = spawn(disp.file, disp.args, disp.options);
    dispatcher.on('error', (e) => {
      try { writeFileSync(errLog, 'dispatcher spawn failed: ' + String(e?.stack ?? e)); } catch { /* 已无计可施 */ }
    });
    dispatcher.unref();
  } catch (e) {
    writeFileSync(errLog, String(e?.stack ?? e));
    return sendJson(res, 500, { ok: false, reason: 'helper-dispatch-failed', errLog });
  }

  return sendJson(res, 202, { ok: true, boot: stamp });
}

// —— 配置读写（v0.8：宿主不渲染 schemastery 表单，四个配置项由插件自绘表单，见 client.js）——

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

/** GET /plugins/dsh-restart-now/config：只读，不分环境（web 读到的是 web profile 的文件，无害） */
function handleGetConfig(req, res, patchConfig) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' });
    return res.end();
  }
  const file = resolveConfigFile();
  // v0.18：回传自动推导结果（resolveExe 对生效配置的输出），表单据此展示「当前推导」，
  // 用户不必盲填 exePath——这是「不让他手动填」诉求的插件侧可行解（原生文件对话框属
  // 主进程能力，插件够不着；<input type=file> 在 Electron 32+ 不再返回真实路径）。
  const eff = effectiveConfig(patchConfig, file);
  return sendJson(res, 200, {
    ok: true, file, config: eff,
    derivedExe: resolveExe(eff, process.execPath),
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
  let raw;
  try { raw = JSON.parse(await readBody(req) || '{}'); } catch (e) {
    return sendJson(res, 400, { ok: false, reason: 'bad-json', detail: String(e?.message ?? e) });
  }
  // v0.17 入口一：exePath 保存即校验——非空且不是已存在的普通文件 → 400，表单显示原因。
  // （入口二在 handleRestart 的 fail-fast；两道闸保证坏路径绝到不了「杀树」那一步。）
  if (typeof raw?.exePath === 'string' && raw.exePath.trim() !== '' && !isUsableExePath(raw.exePath)) {
    return sendJson(res, 400, {
      ok: false, reason: 'exe-path-invalid',
      detail: '该路径不是已存在的文件；留空则自动使用当前 DeepSeek Harness.exe',
    });
  }
  const file = resolveConfigFile();
  if (!file) {
    return sendJson(res, 500, { ok: false, reason: 'config-path-unavailable' });
  }
  try { saveFileConfig(file, raw); } catch (e) {
    return sendJson(res, 500, { ok: false, reason: 'config-write-failed', detail: String(e?.message ?? e) });
  }
  return sendJson(res, 200, { ok: true, file, config: effectiveConfig(patchConfig, file) });
}

export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (hostCtx) => {
    const host = hostCtx;
    host.effect(() => {
      // v0.20 残留清理（激活时一次）：历史积累在宿主启动时就清掉，不必等下一次重启；
      // 只清本插件带时间戳的运行时文件（保留最近 10 次），失败不影响任何功能。
      try { pruneRestartArtifacts(tmpdir(), 10); } catch { /* 清理失败忽略 */ }
      const registrations = [
        // 探测口（GET）：客户端启动时据此决定是否挂载入口（§6）。
        // v0.14–v0.18 曾兼作导航图标排查遥测回传（?navdiag=），v0.19 遥测移除后还原为纯探测。
        // v0.21：同时回传生效配置 + 推导路径——客户端挂载时一次请求即得 liveCfg。
        // 此前 liveCfg 只由设置表单 GET /config 填充：不开设置页就一直为 null，footer 的
        // doRestart 退回 patch 默认值（confirm:true），已关闭的二次确认在每次重启后「复活」。
        host.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-restart-now/environment',
          handler: (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405, { allow: 'GET' });
              return res.end();
            }
            const eff = effectiveConfig(config, resolveConfigFile());
            return sendJson(res, 200, {
              ok: true,
              environment: detectEnvironment(ctx),
              config: eff,
              derivedExe: resolveExe(eff, process.execPath),
            });
          },
        }),
        // 动作口（POST）
        host.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-restart-now/restart',
          handler: (req, res) => handleRestart(req, res, ctx, config),
        }),
        // 配置口（单注册按 method 分派：GET 读 / POST 写；同路径双注册的路由行为未知，不赌）
        host.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-restart-now/config',
          handler: (req, res) => (req.method === 'GET'
            ? handleGetConfig(req, res, config)
            : handleSetConfig(req, res, ctx, config)),
        }),
      ];
      return () => { registrations.forEach((d) => d()); };
    }, 'dsh-restart-now: routes');
  });
}
