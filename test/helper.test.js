// test/helper.test.js —— 助手脚本与派发参数（v1.1 全量重写）
//
// 机制沿革（每一版都对应一次真机故障，改动须守住这些结论）：
//   v0.4  node -e 助手 → v0.7 WMI 逃逸树（taskkill /T 连坐杀死 detached 助手）
//   → v0.9 wscript+VBS（火绒拦「隐藏执行 PowerShell」+ WMI 给助手开黑框）
//   → **v1.1 删除 WMI/VBS 整层**：实验（.m4/exp-kill 三组）证明 detached 子进程在
//     「只杀主进程、不带 /T」时存活；助手改为 spawn(应用自身 exe, ELECTRON_RUN_AS_NODE=1)，
//     杀法改为「只结束 Electron 主进程 → 等宿主优雅退出 → 超时定点补刀」。
// 本文件钉住的硬约束：
//   U1 助手时序与关键调用（含「绝不带 /T」「拉起前删 ELECTRON_RUN_AS_NODE」）
//   U2 路径转义安全 + 生成脚本语法合法
//   U3 可调参数真正写进脚本
//   U4 失败路径都留痕（日志 / 回执）
//   U5 派发参数（应用 exe 当 node）
//   U8 resolveExe、U9 artifactPaths
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_RE, artifactPaths, buildHelperScript, buildHelperSpawn, resolveExe, RESPAWN_ENV_DROP,
  portFromWebUrl, relaunchArgsFrom, tokenizeCommandLine,
} from '../lib/helper-src.js';

const EXE = 'D:\\dsh\\DeepSeek Harness.exe';

function makeScript(overrides = {}) {
  return buildHelperScript({
    exe: EXE,
    mainPid: 1234,
    hostPid: 5678,
    errLog: 'C:\\Temp\\dsh-restart-now-x.err.log',
    ack: 'C:\\Temp\\dsh-restart-now-helper-x.ack',
    receipt: 'C:\\Users\\54\\.dsh\\profiles\\desktop\\restart-now.last.json',
    ...overrides,
  });
}

test('U10 拉起环境清理清单（v1.2.1）：只清「上一次运行」的事实，保留安装身份', () => {
  // 判据：这些变量描述某一次运行/会话，跨进程继承等于把上一轮的事实带进下一轮。
  assert.deepEqual([...RESPAWN_ENV_DROP],
    ['ELECTRON_RUN_AS_NODE', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL'],
    '清单内容须锁定（改一项就是改行为）');
  assert.ok(Object.isFrozen(RESPAWN_ENV_DROP), '清单须冻结，防止运行时被改');

  // 安装身份必须保留：删掉它们新实例会退回默认 home / 默认 profile
  for (const keep of ['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR']) {
    assert.ok(!RESPAWN_ENV_DROP.includes(keep), `${keep} 属安装身份，绝不能删`);
  }

  // 生成的脚本必须内嵌同一份清单（单一事实来源），并记录实际删掉了哪几个
  const script = makeScript();
  assert.ok(script.includes(JSON.stringify([...RESPAWN_ENV_DROP])), '脚本内嵌的清单须与常量一致');
  assert.ok(script.includes("perf('env_dropped='"), '须在日志里留证：实际删掉了哪些键');
});

test('U1 助手时序与关键调用', () => {
  const script = makeScript();
  assert.ok(script.includes('const EXE = "D:\\\\dsh\\\\DeepSeek Harness.exe"'), '须内嵌目标 exe（JSON 转义）');
  assert.ok(script.includes('const MAIN = 1234'), '须内嵌主进程 pid');
  assert.ok(script.includes('const HOST = 5678'), '须内嵌宿主 pid（用于优雅退出等待）');
  assert.ok(script.includes('const ACK = '), '须内嵌 ack 路径');
  assert.ok(script.includes('const RECEIPT = '), '须内嵌回执路径');

  // ack 必须最先写：宿主据此判定「助手活着且马上动手」，拿不到 ack 就不杀任何进程
  const ackIndex = script.indexOf('fs.writeFileSync(ACK');
  const killIndex = script.indexOf("kill(MAIN, 'main')");
  assert.ok(ackIndex > 0 && killIndex > ackIndex, 'ack 写入必须早于杀主进程');

  // 杀法：只杀主进程，绝不带 /T（带 /T 会把宿主一起强杀，丢掉未落盘的会话）
  assert.ok(script.includes("execFileSync('taskkill', ['/PID', String(pid), '/F']"), 'taskkill 只带 /PID + /F');
  assert.ok(!/['"]\/T['"]/.test(script), '绝不允许出现 /T（v1.1 核心约束）');

  // 等待：主进程 30s 上限；随后给宿主 hostGraceMs 优雅退出窗口，超时才补刀
  assert.ok(script.includes('30000'), '主进程等待上限 30s');
  assert.ok(script.includes('HOST_GRACE_MS'), '宿主优雅关闭窗口');
  assert.ok(script.includes("kill(HOST, 'host')"), '宿主超时须定点补刀');
  assert.ok(script.includes('process.kill(pid, 0)'), '存活判定用 signal 0');
  assert.ok(script.includes("error.code === 'EPERM'"), 'EPERM 视为存活');

  // 拉起：干净环境（否则新实例退化成 node 没有窗口，且会继承上一次运行的 DSH_* 事实）
  //         + detached + 存活验证 + 重试
  assert.ok(script.includes('const ENV_DROP = '), '删除清单须注入脚本（v1.2.1）');
  assert.ok(script.includes('for (const key of ENV_DROP)'), '按清单循环删除，避免逐条手写漏项');
  assert.ok(script.includes('delete env[key]'), '逐键删除而不是整块覆盖（保留 DSH_HOME 等安装身份）');
  assert.ok(script.includes('spawn(EXE, args, '), '拉起目标是 exe 本体（v1.2.1 起带原始启动参数）');
  assert.ok(script.includes('detached: true'), '新实例须 detached');
  assert.ok(script.includes('ALIVE_MS'), '每次拉起后须做存活验证');
  assert.ok(script.includes('ATTEMPTS'), '失败须重试');

  // v1.1 回归哨兵：WMI/VBS/PowerShell 的**派发层**必须彻底消失。
  // v1.2.1 起允许一处只读探测（readLaunchArgs 读主进程命令行），但那不参与派发：
  // 派发仍是 detached spawn(应用 exe)。所以这里禁的是派发形态（wscript / Invoke-CimMethod / .vbs），
  // 以及编码不可靠的 wmic（OEM 码页会毁掉带中文的启动参数）。
  const lowered = script.toLowerCase();
  for (const gone of ['wscript', 'invoke-cimmethod', '.vbs', 'wmic']) {
    assert.ok(!lowered.includes(gone), `v1.1 起不应再出现 ${gone}`);
  }
  // 探测只允许出现一次，且必须带超时（不能卡住重启）
  assert.equal(lowered.split('get-ciminstance').length - 1, 1, 'WMI 只允许这一处只读探测');
});

test('U2 路径转义安全（JSON round-trip）+ 生成脚本语法合法', () => {
  const raw = "D:\\it's\\\"x\"\\DeepSeek Harness.exe";
  const script = makeScript({ exe: raw });
  const matched = script.match(/const EXE = ("(?:[^"\\]|\\.)*")/);
  assert.ok(matched, '脚本须含 EXE 字面量');
  assert.equal(JSON.parse(matched[1]), raw, 'JSON 解析回来必须等于原路径');
  assert.doesNotThrow(() => new Function(script.replace(/^'use strict';/, '')), '生成的脚本须是合法 JS');
});

test('U3 可调参数真正写进脚本', () => {
  const script = makeScript({ hostGraceMs: 2222, attempts: 7, aliveMs: 999 });
  assert.ok(script.includes('const HOST_GRACE_MS = 2222'), '优雅关闭窗口可调（调优/测试用）');
  assert.ok(script.includes('const ATTEMPTS = 7'));
  assert.ok(script.includes('const ALIVE_MS = 999'));
});

test('U4 失败路径都留痕（日志 / 回执）', () => {
  const script = makeScript();
  assert.ok(script.includes("'ack write failed: '"), 'ack 写失败须留痕');
  assert.ok(script.includes("'wait main timeout: '"), '主进程没退须放弃（绝不双开）');
  assert.ok(script.includes("'respawn failed after '"), '拉起全失败须留痕');
  assert.ok(script.includes('respawn-failed'), '拉起失败须写进回执（下次挂载提示）');
  assert.ok(script.includes('perf: '), '须记录分段耗时（排查「有时很慢」）');
  assert.ok(script.includes("'main-not-stopped'"), '主进程没停须写回执原因');
});

test('U5 派发参数：应用自身 exe 当 node（不再依赖系统 Node / WMI）', () => {
  const spawnArgs = buildHelperSpawn('D:\\dsh\\DeepSeek Harness.exe', 'C:\\Temp\\h.cjs', { PATH: 'x' });
  assert.equal(spawnArgs.file, 'D:\\dsh\\DeepSeek Harness.exe', '用应用 exe 当解释器');
  assert.deepEqual(spawnArgs.args, ['C:\\Temp\\h.cjs'], '脚本路径经 argv 传入');
  assert.equal(spawnArgs.options.detached, true, '必须 detached（脱离宿主进程组，杀 main 时不连坐）');
  assert.equal(spawnArgs.options.stdio, 'ignore');
  assert.equal(spawnArgs.options.env.ELECTRON_RUN_AS_NODE, '1', '助手必须以 node 模式运行');
  assert.equal(spawnArgs.options.env.PATH, 'x', '继承宿主环境（保留 PATH 等）');
});

test('U8 resolveExe：配置优先，留空按 execPath 目录推导', () => {
  assert.equal(resolveExe({ exePath: 'D:\\other\\App.exe' }, 'D:\\dsh\\DeepSeek Harness.exe'), 'D:\\other\\App.exe');
  assert.equal(resolveExe({ exePath: '   ' }, 'D:\\dsh\\DeepSeek Harness.exe'), 'D:\\dsh\\DeepSeek Harness.exe');
  assert.equal(resolveExe({}, 'D:\\dsh\\DeepSeek Harness.exe'), 'D:\\dsh\\DeepSeek Harness.exe');
});

test('U9 artifactPaths：helper/ack/errLog 共用同一 stamp（便于成组清理）', () => {
  const stamp = '2026-10-22T08-15-30';
  const paths = artifactPaths('C:\\Temp', stamp);
  assert.equal(paths.helper, 'C:\\Temp\\dsh-restart-now-helper-2026-10-22T08-15-30.cjs');
  assert.equal(paths.ack, 'C:\\Temp\\dsh-restart-now-helper-2026-10-22T08-15-30.ack');
  assert.equal(paths.errLog, 'C:\\Temp\\dsh-restart-now-2026-10-22T08-15-30.err.log');
  for (const file of [paths.helper, paths.ack, paths.errLog]) {
    const name = file.split('\\').pop();
    assert.ok(ARTIFACT_RE.test(name), `prune 正则须能识别 ${name}`);
  }
});

test('U11 启动参数复用（v1.2.1）：从主进程命令行里取，三重校验不过就放弃', () => {
  const exe = 'D:\dsh\DeepSeek Harness.exe';
  // 正常形态：引号包裹的 exe + 用户参数
  assert.deepEqual(
    tokenizeCommandLine('"D:\dsh\DeepSeek Harness.exe" --user-data-dir="D:\my data" -x'),
    ['D:\dsh\DeepSeek Harness.exe', '--user-data-dir=D:\my data', '-x'],
    '引号包裹的参数要被还原成一个 token',
  );
  assert.deepEqual(tokenizeCommandLine('  a   b\tc  '), ['a', 'b', 'c'], '连续空白不产生空 token');
  assert.deepEqual(tokenizeCommandLine(''), [], '空串没有 token');

  assert.deepEqual(
    relaunchArgsFrom('"D:\dsh\DeepSeek Harness.exe" --user-data-dir=D:\my', exe),
    ['--user-data-dir=D:\my'],
    '同一个 exe 的普通参数原样复用',
  );
  assert.deepEqual(relaunchArgsFrom('"D:\dsh\DeepSeek Harness.exe"', exe), [],
    '没有参数也要复用「确实是这个 exe」这个结论（返回空数组而非 null）');
  assert.equal(relaunchArgsFrom(null, exe), null, '问不出来（WMI 失败）→ 放弃');
  assert.equal(relaunchArgsFrom('   ', exe), null, '空命令行 → 放弃');
  assert.equal(relaunchArgsFrom('"D:\other\App.exe" --x', exe), null,
    '第 0 段不是同一个 exe → 放弃（同名多份安装时别拉错程序）');
  assert.equal(relaunchArgsFrom('"D:\dsh\DeepSeek Harness.exe" --type=renderer', exe), null,
    '--type= 说明抓到的是 Chromium 子进程，不是用户启动 → 放弃');
  assert.equal(relaunchArgsFrom('"D:\dsh\DeepSeek Harness.exe" --expose-internals x.js', exe), null,
    '--expose-internals 说明抓到的是 desktop-host，转发会拉起无窗口进程 → 放弃');
  assert.equal(relaunchArgsFrom('"D:\dsh\DeepSeek Harness.exe" "a\\"b"', exe), null,
    '带转义引号的命令行不做有损解析 → 放弃');
});

test('U11b 助手脚本真的会去问 WMI、并把结果当参数拉起（而不是用空参数）', () => {
  const script = makeScript();
  assert.ok(script.includes('Get-CimInstance -ClassName Win32_Process -Filter'), '须从进程表读主进程命令行');
  assert.ok(script.includes('readLaunchArgs()'), '须有探测调用');
  assert.ok(script.includes('relaunchArgsFrom(rawCommandLine, EXE)'), '须经三重校验');
  assert.ok(script.includes('spawn(EXE, args, '), '拉起时须带参数，不再写死空数组');
  assert.ok(script.includes("'launch_args=unavailable'"), '问不到须留痕（区分「没参数」与「没问到」）');
  assert.ok(/function (?:tokenizeCommandLine|relaunchArgsFrom)\(/.test(script),
    '解析逻辑须内联进脚本（助手不能 import 模块）');
  assert.doesNotThrow(() => new Function(script.replace(/^'use strict';/, '')), '注入后仍是合法 JS');
});

test('U12 拉起全失败时弹窗告知（v1.2.1 第 5 项）：应用已死，弹窗是唯一能说话的通道', () => {
  const script = makeScript();
  assert.ok(script.includes('async function alertUser('), '须有弹窗函数');
  assert.ok(script.includes('System.Windows.MessageBox'), '用系统消息框，不引入自绘窗口');
  assert.ok(script.includes("'utf16le'"), '中文必须走 UTF-16LE base64（命令行直接传会乱码）');
  assert.ok(script.includes("'-EncodedCommand'"), '用 -EncodedCommand 传脚本，避免引号/空格解析问题');
  assert.ok(script.includes("['powershell.exe', 'pwsh.exe']"), 'powerShell 不在时换 pwsh（7.x 用户）');
  assert.ok(script.includes('await alertUser('), '弹窗须 await（否则进程先退，弹不出来）');
  assert.ok(script.includes("'alert_shown='"), '弹没弹成功都要留痕（排查「为什么没提示」）');
  // 顺序：先写回执再弹窗 —— 回执是「下次启动能看到」的唯一凭据，不能被弹窗失败连累
  const receiptIndex = script.indexOf("reason: 'respawn-failed'");
  const alertIndex = script.indexOf('await alertUser(');
  assert.ok(receiptIndex > 0 && alertIndex > receiptIndex, '回执必须先写，弹窗只是尽力而为');
  assert.doesNotThrow(() => new Function(script.replace(/^'use strict';/, '')), '注入后仍是合法 JS');
});

test('U12b 弹窗文案的引号必须按 PowerShell 规则转义（反斜杠不是转义符）', () => {
  const script = makeScript();
  // 反例：用 JSON.stringify 拼 PowerShell 字面量，Windows 路径会显示成 C:\Temp（双反斜杠）
  assert.ok(!script.includes('JSON.stringify(message)'), '不得用 JSON 转义拼 PowerShell 字符串');
  assert.ok(script.includes(".replace(/'/g, \"''\")"), '单引号字面量里须把 \' 写成 \'\'');
  assert.ok(script.includes('Add-Type -AssemblyName PresentationFramework'), '消息框来自 WPF 程序集');
});

test('U13 端口回探（v1.2.1 第 6 项）：只观测「服务回来了没」，绝不当成功判据', () => {
  // 端口解析：只认 DSH_WEB_URL 里的端口
  assert.equal(portFromWebUrl('http://127.0.0.1:56355/?token=abc'), 56355, '带 token 也要取到端口');
  assert.equal(portFromWebUrl('https://127.0.0.1:1234'), 1234);
  assert.equal(portFromWebUrl('http://127.0.0.1'), 80, '省略端口时按协议默认');
  assert.equal(portFromWebUrl('https://127.0.0.1'), 443);
  for (const bad of ['', '   ', 'nonsense', null, undefined, 'http://127.0.0.1:0', 'http://127.0.0.1:70000 x']) {
    assert.equal(portFromWebUrl(bad), null, `解析不出来就跳过观测：${String(bad)}`);
  }

  const withPort = makeScript({ webUrl: 'http://127.0.0.1:56355/?token=abc' });
  assert.ok(withPort.includes('const PORT = 56355'), '端口须注入脚本');
  assert.ok(withPort.includes("'port_relisten='"), '观测结论须进日志');
  assert.ok(withPort.includes("skipped (no web url)"), '没有 web 地址时要明确跳过，不能静默');
  assert.ok(withPort.includes('net.connect'), '用真实 TCP 连接判定，不靠端口文件或 netstat');
  assert.ok(withPort.includes('RELISTEN_MS'), '等待窗口须可配（测试/调优）');

  const noUrl = makeScript();
  assert.ok(noUrl.includes('const PORT = null'), '拿不到地址时 PORT 为 null（跳过）');

  // 顺序：先写回执（重启成不成已经定了）再观测端口 —— 观测慢不能拖着回执不写
  const receiptIndex = withPort.indexOf('respawnedAt');
  const probeIndex = withPort.indexOf("perf('port_relisten=");
  assert.ok(receiptIndex > 0 && probeIndex > receiptIndex, '回执先落，再观测');
  assert.doesNotThrow(() => new Function(withPort.replace(/^'use strict';/, '')), '注入后仍是合法 JS');
});
