// lib/helper-src.js —— 生成 Windows 重启助手（可单测的纯函数）。
// 机制沿革：v0.4 detached `node -e`（powershell -Command 在 DETACHED_PROCESS 下静默
// 不执行，bisect 实锤）→ **v0.7 WMI 逃逸树**：E1 真机失败证明 detached node 仍在本
// 进程树内，宿主 taskkill /T 连坐杀死助手（detached 只断控制台关系，不断父子关系）。
// v0.7 起宿主经 WMI Win32_Process.Create 拉起助手文件（父进程 = WmiPrvSE，脱离树），
// 杀树 + 等待 + 拉起全部由助手执行（单一杀手原则，宿主不再 taskkill）。
// v0.9 派发器从 powershell 换成 wscript+VBS（火绒「隐藏执行PowerShell」拦截 +
// WMI 助手黑框，见 buildDispatcherVbs 注释）。
import { join, dirname, isAbsolute, basename } from 'node:path';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';

/** exePath 优先；留空时从当前安装位置推导（不写死任何安装目录）。
 *  utility 宿主进程本身就是 DeepSeek Harness.exe，故 dirname(process.execPath)
 *  = 当前安装目录，装在任何位置都推得对。 */
export function resolveExe(config, execPath = process.execPath) {
  return config.exePath || join(dirname(execPath), 'DeepSeek Harness.exe');
}

/**
 * 解析可执行 `node -e` 的 node 解释器（注入式纯函数，便于单测）。
 * 优先级：
 *  1. process.execPath 本身就是 node.exe（CLI `dsh web` 这类 node 宿主场景）；
 *  2. process.argv 中的 DSH runtime 路径段推导真实 node.exe
 *     （桌面宿主 argv 形如 [..., <install>\app.asar\dsh, <home>\profiles\desktop,
 *      <install>\resources\runtime\primary-runtime, <install>\resources\runtime\pnpm\bin\pnpm.mjs,
 *      <install>\resources\runtime\bin]；
 *     实测 v44.0.0 真实解释器在 <runtime>\primary-runtime\dependencies\node\bin\node.exe，
 *     <runtime>\bin 下只有 node/node.cmd shim（shim 靠 DSH_DESKTOP_NODE_EXECUTABLE 指 Electron exe））；
 *  3. DSH_DESKTOP_NODE_EXECUTABLE 环境变量 + ELECTRON_RUN_AS_NODE=1（shim 同款方式，
 *     让 Electron exe 以 node 模式跑 -e 脚本）；
 *  4. 兜底 'node.exe'（PATH）。
 * 返回 { file, args, env }：情况 1/2/4 为普通 node 调用；情况 3 带 ELECTRON_RUN_AS_NODE。
 */
export function resolveNodeExecutable({
  execPath = process.execPath,
  argv = process.argv,
  env = process.env,
  exists = existsSync,
} = {}) {
  if (basename(execPath).toLowerCase() === 'node.exe' && exists(execPath)) {
    return { file: execPath, args: [], env: {} };
  }
  const segs = [...argv].reverse();
  for (const seg of segs) {
    if (typeof seg !== 'string' || !isAbsolute(seg)) continue;
    const norm = seg.replaceAll('/', '\\');
    // <...\primary-runtime> → dependencies\node\bin\node.exe
    if (norm.toLowerCase().endsWith('primary-runtime')) {
      const cand = join(dirname(norm), 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
      if (exists(cand)) return { file: cand, args: [], env: {} };
    }
    // <...\runtime\bin> → 上一级即 runtime 根（其下就是 primary-runtime）
    if (norm.toLowerCase().endsWith('runtime\\bin')) {
      const root = dirname(norm); // ...\resources\runtime
      const cand = join(root, 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
      if (exists(cand)) return { file: cand, args: [], env: {} };
    }
  }
  const shim = env.DSH_DESKTOP_NODE_EXECUTABLE;
  if (shim && exists(shim)) {
    return { file: shim, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { file: 'node.exe', args: [], env: {} };
}

/**
 * 纯函数可单测：给定 exe 与 ppid，产出助手脚本源码（v0.7：写入 .cjs 文件执行）。
 * 职责（v0.7 勘误：杀树从宿主移交本助手，单一杀手原则）：
 *   延时 → taskkill /T 杀整树（本进程经 WMI 拉起、父进程是 WmiPrvSE，
 *   不在目标树内，/T 连坐不到自己——E1 失败现场勘误：宿主 taskkill /T
 *   会把树内 detached 助手一并杀死，助手没来得及拉起 exe）
 *   → 轮询等旧主进程退出（process.kill(ppid,0)，30s 上限，超时放弃绝不双开）
 *   → 800ms 缓冲 → detached 拉起 exe → 失败留痕 errLog。
 */
export function buildHelperScript(exe, ppid, { errLog, delayMs = 50 } = {}) {
  const j = JSON.stringify;
  return `// dsh-restart-now helper (generated, v0.7)
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const EXE = ${j(exe)};
const PPID = ${j(ppid)};
const ERR_LOG = ${j(errLog)};
const DELAY = ${j(delayMs)};
const fail = (msg) => { try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' ' + msg + '\\n'); } catch {} };
// v0.15 性能计时：每次重启把各阶段耗时落 errLog 文件（宿主端另有 202 应答时间戳可对照），
// 用于定位「有时很慢」：kill→树死透的耗时、缓冲、拉起。TS0=助手进程起点。
const TS0 = Date.now();
setTimeout(() => {
  const T1 = Date.now();
  try {
    spawn('taskkill', ['/PID', String(PPID), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch (e) { fail('taskkill spawn failed: ' + (e && e.message)); }
  const deadline = Date.now() + 30000;
  const poll = () => {
    let alive = false;
    try { process.kill(PPID, 0); alive = true; } catch (e) { alive = e && e.code === 'EPERM'; }
    if (alive && Date.now() < deadline) { setTimeout(poll, 300); return; }
    // 30s 超时仍存活 = taskkill 未生效：放弃重启，绝不双开第二实例
    if (alive) { fail('wait ppid timeout: ' + PPID); return; }
    const T2 = Date.now();
    try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' perf: dispatch_to_kill=' + (T1 - TS0) + 'ms kill_to_ppid_dead=' + (T2 - T1) + 'ms\\n'); } catch {}
    setTimeout(() => {
      try {
        const c = spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: require('node:path').dirname(EXE) });
        c.on('error', (e) => fail('Start-Process failed: ' + (e && e.message)));
        c.unref();
        try { fs.appendFileSync(ERR_LOG, new Date().toISOString() + ' perf: respawn issued (total helper ' + (Date.now() - TS0) + 'ms; 应用自身启动耗时另计)\\n'); } catch {}
      } catch (e) { fail('Start-Process failed: ' + (e && e.message)); }
    }, 800);
  };
  poll();
}, DELAY);
`;
}

/** WMI 能否派发该 node（WMI Create 无法设置环境变量，Electron-shim 方案不可用） */
export function isStandaloneNode(nodeExec) {
  return !!(nodeExec && nodeExec.file && !(nodeExec.env && nodeExec.env.ELECTRON_RUN_AS_NODE));
}

/**
 * v0.9 派发器 VBS 源码（静态、纯 ASCII——路径一律经 wscript 位置参数传入，
 * VBS 文件本身不含任何路径，杜绝非 ASCII 编码问题）。
 *
 * 为什么是 wscript.exe：
 *  - v0.7 用 `powershell -WindowStyle Hidden` 作派发器，E1 真机（2026-10-09 11:15）
 *    被火绒「隐藏执行PowerShell」HIPS 规则拦截——DeepSeek Harness.exe 隐藏拉起
 *    powershell.exe 正是典型恶意行为特征；v0.9 全链路不再出现 powershell。
 *  - wscript.exe 是 GUI 子系统可执行：自身永不创建控制台（零黑框）。
 *
 * 派发动作：WMI Win32_Process.Create 拉起 node 助手（父进程 = WmiPrvSE，
 * 脱离本进程树，taskkill /T 连坐不到——v0.7 已真机验证），并经
 * Win32_ProcessStartup 设 ShowWindow=0（SW_HIDE）——消掉 v0.7 的可见黑框
 * （WMI Create 默认给控制台程序开可见窗口，用户 11:20 截图实证）。
 * 现场勘误（矩阵实测）：ShowWindow=0 与 CreateFlags=0x08000000(CREATE_NO_WINDOW)
 * 各自单独可用，但两者组合 WMI 拒之门外（Win32_Process.Create 返回 21 无效参数），
 * 故只设 ShowWindow=0——SW_HIDE 经 STARTF_USESHOWWINDOW 让控制台以隐藏态创建。
 *
 * 失败全部写 errLog 后静默退出：应用保持存活，用户可重试（安全失败方向）。
 */
export function buildDispatcherVbs() {
  return [
    "Option Explicit",
    "Dim node, helper, errLog, wmi, startup, proc, rc, pid, fso, ts",
    "If WScript.Arguments.Count < 3 Then WScript.Quit 1",
    "node = WScript.Arguments(0)",
    "helper = WScript.Arguments(1)",
    "errLog = WScript.Arguments(2)",
    "On Error Resume Next",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2")',
    "If Err.Number <> 0 Then",
    "  Set ts = fso.OpenTextFile(errLog, 8, True)",
    '  ts.WriteLine Now & " WMI get failed: " & Err.Number & " " & Err.Description',
    "  ts.Close",
    "  WScript.Quit 1",
    "End If",
    'Set startup = wmi.Get("Win32_ProcessStartup").SpawnInstance_',
    "startup.ShowWindow = 0",
    'Set proc = wmi.Get("Win32_Process")',
    'rc = proc.Create("""" & node & """ """ & helper & """", Null, startup, pid)',
    "If rc <> 0 Then",
    "  Set ts = fso.OpenTextFile(errLog, 8, True)",
    '  ts.WriteLine Now & " WMI create failed: " & rc',
    "  ts.Close",
    "End If",
    "",
  ].join("\r\n");
}

/**
 * 纯函数可单测（v0.9）：组装 VBS 派发命令。
 * wscript.exe [//B //Nologo] <vbs> <node> <helper> <errLog>
 *  - //B 批处理模式（脚本错误不弹窗）；//Nologo 不显示徽标。
 *  - wscript 为 GUI 子系统：派发器本身零控制台、瞬时退出、不驻留。
 *  - WMI Create 无法设置环境变量 → node 必须是独立解释器（见 isStandaloneNode）。
 */
export function buildVbsDispatch(nodeExec, helperPath, errLog, vbsPath, { systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  return {
    file: join(systemRoot, 'System32', 'wscript.exe'),
    args: ['//B', '//Nologo', vbsPath, nodeExec.file, helperPath, errLog],
    options: { windowsHide: true, stdio: 'ignore' },
  };
}

/**
 * v0.20 运行时残留自动清理（用户要求「保留最近十次」）。
 * 每次重启在 %TEMP% 留一组带时间戳的文件（helper-<stamp>.cjs / dispatch-<stamp>.vbs /
 * <stamp>.err.log，stamp 形如 2026-10-09T08-34-07，字典序即时间序）——不清理会无限积累。
 * 按 stamp 分组，只保留最近 keep 组；只匹配本插件前缀，绝不碰别的临时文件。
 * 逐文件吞错：旧助手可能仍在写 errLog（Windows 删除打开中的文件会抛错），下轮再删。
 * 返回 { removed, kept } 供日志；目录不存在/读失败静默返回零。调用方在写新文件**之前**
 * 调用，当前这次的时间戳尚未存在，永无误删风险。
 */
const ARTIFACT_RE = /^dsh-restart-now-(?:helper-|dispatch-)?(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.(?:cjs|vbs|err\.log)$/;

export function pruneRestartArtifacts(dir, keep = 10) {
  let names;
  try { names = readdirSync(dir); } catch { return { removed: 0, kept: 0 }; }
  const byStamp = new Map();
  for (const n of names) {
    const m = ARTIFACT_RE.exec(n);
    if (!m) continue;
    if (!byStamp.has(m[1])) byStamp.set(m[1], []);
    byStamp.get(m[1]).push(n);
  }
  const keepSet = new Set([...byStamp.keys()].sort().reverse().slice(0, Math.max(0, keep)));
  let removed = 0;
  for (const [stamp, files] of byStamp) {
    if (keepSet.has(stamp)) continue;
    for (const n of files) {
      try { unlinkSync(join(dir, n)); removed++; } catch { /* 被旧助手占用：下一轮再删 */ }
    }
  }
  return { removed, kept: keepSet.size };
}
