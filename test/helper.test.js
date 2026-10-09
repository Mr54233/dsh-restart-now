// test/helper.test.js —— U1–U4（buildHelperScript v0.7）+ U8（resolveExe）
//                   + U9（resolveNodeExecutable 矩阵）+ U11（v0.9 wscript/VBS 派发 / isStandaloneNode）
// 机制沿革：powershell -Command → node -e（v0.4）→ **v0.7 WMI 逃逸树**（E1 勘误：
// detached node 助手仍在宿主进程树内，taskkill /T 连坐杀死助手；v0.7 起宿主经
// Win32_Process.Create 派发助手文件，助手父进程 = WmiPrvSE，杀树/等待/拉起全归助手）
// → **v0.9 wscript+VBS 派发**（真机勘误：powershell -WindowStyle Hidden 被火绒
// 「隐藏执行PowerShell」HIPS 拦截；WMI Create 默认给助手开可见黑框）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHelperScript, buildVbsDispatch, buildDispatcherVbs, isStandaloneNode, resolveExe, resolveNodeExecutable,
} from '../lib/helper-src.js';

const EXE = 'D:\\dsh\\DeepSeek Harness.exe';

test('U1 助手脚本拼装（v0.7：助手全权杀树+等待+拉起）', () => {
  const script = buildHelperScript(EXE, 1234, { errLog: 'C:\\Temp\\e.log', delayMs: 500 });
  assert.ok(script.includes('const PPID = 1234'), '脚本须内嵌 ppid=1234');
  assert.ok(script.includes("'taskkill'"), '助手须发起 taskkill（单一杀手原则）');
  assert.ok(script.includes("'/PID', String(PPID), '/T', '/F'"), 'taskkill 须 /T 杀整树 /F 强制');
  assert.ok(script.includes('process.kill(PPID, 0)'), '脚本须轮询 ppid 存活');
  assert.ok(script.includes('30000'), '等待上限 30s');
  assert.ok(script.includes('const EXE = "D:\\\\dsh\\\\DeepSeek Harness.exe"'), '脚本须内嵌重拉 exe（JSON 转义）');
  assert.ok(script.includes('spawn(EXE'), '脚本须 detached 拉起 exe');
  assert.ok(script.includes("'Start-Process failed: '"), '失败须留痕 errLog');
  assert.ok(script.includes("'wait ppid timeout: '"), 'ppid 30s 未退须放弃而非双开');
  assert.ok(script.includes("'WMI'") === false, '助手本体不含 WMI 逻辑（WMI 在宿主派发层）');
});

test('U2 路径特殊字符安全（JSON.stringify 转义 + 脚本语法合法）', () => {
  const raw = "D:\\it's\\\"x\"\\DeepSeek Harness.exe";
  const script = buildHelperScript(raw, 1, { errLog: 'C:\\Temp\\e.log' });
  // 抽出内嵌字面量并 round-trip：JSON 解析回来必须等于原路径（转义无歧义）
  const m = script.match(/const EXE = ("(?:[^"\\]|\\.)*")/);
  assert.ok(m, '脚本须含 EXE 字面量');
  assert.equal(JSON.parse(m[1]), raw);
  // 生成的脚本是合法 JS
  assert.doesNotThrow(() => new Function(script.replace(/^'use strict';/, '')));
});

test('U3 delayMs 透传', () => {
  const script = buildHelperScript(EXE, 1, { errLog: 'C:\\Temp\\e.log', delayMs: 1500 });
  assert.ok(script.includes('const DELAY = 1500'), '延时参数须内嵌为 DELAY');
  assert.ok(script.includes('}, DELAY);'), '外层 setTimeout 引用 DELAY 常量');
});

test('U4 日志路径形如 dsh-restart-now-<stamp>.err.log（生成逻辑在 index.js，此处验证约定可拼装）', () => {
  const stamp = new Date('2026-10-08T17:30:00Z').toISOString().replace(/[:.]/g, '-').slice(0, 19);
  assert.equal(stamp, '2026-10-08T17-30-00');
  assert.match(`%TEMP%\\dsh-restart-now-${stamp}.err.log`, /dsh-restart-now-[\dT-]{19}\.err\.log$/);
});

test('U8a exe 自动推导（安装位置无关）', () => {
  const exe = resolveExe({}, 'C:\\Apps\\DSH\\DeepSeek Harness.exe');
  assert.equal(exe, 'C:\\Apps\\DSH\\DeepSeek Harness.exe');
});

test('U8b exePath 配置优先于推导', () => {
  const exe = resolveExe({ exePath: 'D:\\自定义\\x.exe' }, 'C:\\Apps\\DSH\\DeepSeek Harness.exe');
  assert.equal(exe, 'D:\\自定义\\x.exe');
});

// —— resolveNodeExecutable（U9 系列：node 解释器解析优先级）——

const fakeExists = (cands) => (p) => cands.has(p.replaceAll('/', '\\'));

test('U9a execPath 是 node.exe 时直接用', () => {
  const r = resolveNodeExecutable({
    execPath: 'C:\\node\\node.exe', argv: ['whatever'], env: {}, exists: () => true,
  });
  assert.deepEqual(r, { file: 'C:\\node\\node.exe', args: [], env: {} });
});

test('U9b 从 argv 的 primary-runtime 段解析真实 node.exe', () => {
  const cand = 'D:\\dsh\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe';
  const r = resolveNodeExecutable({
    execPath: 'D:\\dsh\\DeepSeek Harness.exe',
    argv: ['DeepSeek Harness.exe', '--expose-internals', 'D:\\dsh\\resources\\app.asar\\dsh',
      'C:\\Users\\54\\.dsh\\profiles\\desktop',
      'D:\\dsh\\resources\\runtime\\primary-runtime',
      'D:\\dsh\\resources\\runtime\\pnpm\\bin\\pnpm.mjs',
      'D:\\dsh\\resources\\runtime\\bin'],
    env: {},
    exists: fakeExists(new Set([cand])),
  });
  assert.equal(r.file, cand);
  assert.deepEqual(r.env, {});
});

test('U9c runtime\\bin 段回推两级', () => {
  const cand = 'D:\\dsh\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe';
  const r = resolveNodeExecutable({
    execPath: 'D:\\dsh\\DeepSeek Harness.exe',
    argv: ['x.exe', 'D:\\dsh\\resources\\runtime\\bin'],
    env: {},
    exists: fakeExists(new Set([cand])),
  });
  assert.equal(r.file, cand);
});

test('U9d 兜底 DSH_DESKTOP_NODE_EXECUTABLE（ELECTRON_RUN_AS_NODE shim 方式）', () => {
  const r = resolveNodeExecutable({
    execPath: 'D:\\dsh\\DeepSeek Harness.exe',
    argv: ['x.exe'],
    env: { DSH_DESKTOP_NODE_EXECUTABLE: 'D:\\dsh\\DeepSeek Harness.exe' },
    exists: fakeExists(new Set(['D:\\dsh\\DeepSeek Harness.exe'])),
  });
  assert.equal(r.file, 'D:\\dsh\\DeepSeek Harness.exe');
  assert.deepEqual(r.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('U9e 全部落空回退 PATH node.exe', () => {
  const r = resolveNodeExecutable({ execPath: 'x:\\e.exe', argv: ['x.exe'], env: {}, exists: () => false });
  assert.deepEqual(r, { file: 'node.exe', args: [], env: {} });
});

// —— v0.9 wscript+VBS 派发（U11 系列）——

test('U11a buildVbsDispatch 组装 wscript（零 powershell）', () => {
  const cmd = buildVbsDispatch(
    { file: 'C:\\node\\node.exe', args: [], env: {} },
    'C:\\Temp\\dsh-restart-now-helper-20261009.cjs',
    'C:\\Temp\\dsh-restart-now-20261009.err.log',
    'C:\\Temp\\dsh-restart-now-dispatch-20261009.vbs',
    { systemRoot: 'C:\\WinMock' },
  );
  assert.equal(cmd.file, 'C:\\WinMock\\System32\\wscript.exe', '派发器 = System32 下 wscript.exe（GUI 子系统，零控制台）');
  assert.deepEqual(cmd.args.slice(0, 2), ['//B', '//Nologo'], '批模式 + 无徽标');
  assert.equal(cmd.args[2], 'C:\\Temp\\dsh-restart-now-dispatch-20261009.vbs');
  assert.deepEqual(cmd.args.slice(3), ['C:\\node\\node.exe',
    'C:\\Temp\\dsh-restart-now-helper-20261009.cjs',
    'C:\\Temp\\dsh-restart-now-20261009.err.log'], 'node/helper/errLog 经 wscript 位置参数传入');
  assert.equal(cmd.options.detached, undefined, '派发器不需要 detached');
  assert.equal(cmd.options.windowsHide, true);
  assert.equal(cmd.options.stdio, 'ignore');
  // 全链路无 powershell（火绒「隐藏执行PowerShell」HIPS 规则规避，v0.9 核心）
  const flattened = [cmd.file, ...cmd.args].join(' ');
  assert.ok(flattened.includes('powershell') === false, '命令行不得出现 powershell');
});

test('U11b buildDispatcherVbs：WMI Create + 无窗口标志 + 纯 ASCII + errLog 留痕', () => {
  const vbs = buildDispatcherVbs();
  assert.ok(vbs.includes('Win32_ProcessStartup'), '须设进程启动配置');
  assert.ok(vbs.includes('SpawnInstance_'), 'SpawnInstance_');
  assert.ok(vbs.includes('ShowWindow = 0'), 'SW_HIDE（控制台以隐藏态创建，消黑框）');
  assert.ok(vbs.includes('CreateFlags') === false, 'CreateFlags=134217728 与 ShowWindow=0 组合被 WMI 拒（rc=21 矩阵实测），不得出现');
  assert.ok(vbs.includes('Win32_Process"'), '目标类');
  assert.ok(vbs.includes('.Create('), 'Create 派发');
  assert.ok(vbs.includes('WScript.Arguments(0)'), 'node 路径经参数传入（VBS 文件本身零路径 → 纯 ASCII）');
  assert.ok(vbs.includes('WScript.Arguments(1)'), 'helper 路径经参数传入');
  assert.ok(vbs.includes('WScript.Arguments(2)'), 'errLog 路径经参数传入');
  assert.ok(vbs.includes('WMI create failed'), 'Create 非零返回码写 errLog');
  assert.ok(vbs.includes('WMI get failed'), 'GetObject 失败写 errLog');
  // CommandLine 引号形态："node" "helper"（VBS 内 "" 转义）
  assert.ok(vbs.includes('proc.Create("""" & node & """ """ & helper & """", Null, startup, pid)'),
    'CommandLine 须为 "node" "helper" 形态');
  // VBS 文件必须纯 ASCII（ASCII 编码写入即可，绝无乱码风险）
  assert.match(vbs, /^[\x00-\x7F]*$/, 'VBS 源码须纯 ASCII');
  assert.ok(vbs.includes('powershell') === false, 'VBS 不得出现 powershell');
  // CRLF 行尾（VBS 对 LF 兼容，但规范化起见）
  assert.ok(vbs.includes('\r\n'), 'CRLF 行尾');
});

test('U11c isStandaloneNode 守卫（WMI Create 无法设环境变量）', () => {
  assert.equal(isStandaloneNode({ file: 'C:\\node\\node.exe', env: {} }), true);
  assert.equal(isStandaloneNode({ file: 'D:\\dsh\\DeepSeek Harness.exe', env: { ELECTRON_RUN_AS_NODE: '1' } }), false,
    'Electron-shim 方案（带 ELECTRON_RUN_AS_NODE）不能走 WMI 派发');
  assert.equal(isStandaloneNode(null), false);
  assert.equal(isStandaloneNode({}), false);
});
