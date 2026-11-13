// test/helper.test.js —— 助手脚本与派发参数（v1.1 全量重写；v1.3.0 增加 Windows/macOS 双平台）
//
// v1.3.0：Windows 用例全部显式 platform:'win32'（脚本内容不得弱化），另加 U11c/U14 darwin 用例；
// 真实信号与 spawn 行为由 test/mac-helper.test.js 的 macOS 集成测试覆盖。
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
//   U8 resolveExe（win32 目录推导 / darwin execPath 本体）、U9 artifactPaths（跨平台构造）
//   U11/U11c 启动参数复用（win32 分词 / darwin exe 前缀匹配 + POSIX 分词）
//   U14a–U14d darwin 助手脚本契约与纯函数（信号停机 / ps / lsof / osascript / 转义）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import {
  appleScriptLiteral, ARTIFACT_RE, artifactPaths, buildHelperScript, buildHelperSpawn,
  collectDescendants, HELPER_PLATFORMS, MAC_TOOLS, MAIN_STOP_GRACE_MS, macAlertScript,
  macListenArgs, macPsArgs, normalizePath, parseLsofListenPort, parsePsProcessTable,
  resolveExe, RESPAWN_ENV_DROP, relaunchArgsFrom, tokenizeCommandLine, tokenizePosixCommandLine,
  webListenScript,
} from '../lib/helper-src.js';

const EXE = 'D:\\dsh\\DeepSeek Harness.exe';
/** macOS 真实主进程路径（含空格）：<App>.app/Contents/MacOS/<App>，由 Electron 以 ELECTRON_RUN_AS_NODE 启动。 */
const MAC_EXE = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';

function makeScript(overrides = {}) {
  return buildHelperScript({
    platform: 'win32', // 显式钉平台：本组用例校验 Windows 助手脚本，与运行测试的宿主平台无关
    exe: EXE,
    mainPid: 1234,
    hostPid: 5678,
    errLog: 'C:\\Temp\\dsh-restart-now-x.err.log',
    ack: 'C:\\Temp\\dsh-restart-now-helper-x.ack',
    receipt: 'C:\\Users\\54\\.dsh\\profiles\\desktop\\restart-now.last.json',
    ...overrides,
  });
}

/** darwin 助手脚本（v1.3.0）：与 Windows 版同一契约，系统原语换成信号 / ps / lsof / osascript。 */
function makeMacScript(overrides = {}) {
  return buildHelperScript({
    platform: 'darwin',
    exe: MAC_EXE,
    mainPid: 4242,
    hostPid: 4343,
    errLog: '/tmp/dsh-restart-now-x.err.log',
    ack: '/tmp/dsh-restart-now-helper-x.ack',
    receipt: '/Users/54/.dsh/profiles/desktop/restart-now.last.json',
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
  // v1.2.1 起允许只读探测，但那不参与派发：派发仍是 detached spawn(应用 exe)。
  // 所以这里禁的是派发形态（wscript / Invoke-CimMethod / .vbs），
  // 以及编码不可靠的 wmic（OEM 码页会毁掉带中文的启动参数）。
  const lowered = script.toLowerCase();
  for (const gone of ['wscript', 'invoke-cimmethod', '.vbs', 'wmic']) {
    assert.ok(!lowered.includes(gone), `v1.1 起不应再出现 ${gone}`);
  }
  // v1.2.1 起允许只读探测（waitWebListen 查进程树监听），二者都不参与派发。
  // v1.3.1 起身份与启动参数合并成一次探测（identitySnapshot 的 mainCmd 字段），
  // 所以 Get-CimInstance 恰好 4 处：身份 2（main+host）+ hostMatches 1 + 监听 1。
  // 探测必须带超时（不能卡住重启）。
  assert.equal(lowered.split('get-ciminstance').length - 1, 4, 'WMI 仅供只读身份/参数合并探测与监听探测');
  assert.ok(lowered.includes('timeout:'), '探测须带超时，不能卡住重启');
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

test('U8 resolveExe：配置优先，留空按平台推导（win32 拼固定文件名；darwin 用 execPath 本体）', () => {
  // —— Windows：execPath 是 app 目录里的可执行文件，主程序固定叫 DeepSeek Harness.exe ——
  assert.equal(resolveExe({ exePath: 'D:\\other\\App.exe' }, EXE, 'win32'), 'D:\\other\\App.exe');
  assert.equal(resolveExe({ exePath: '   ' }, EXE, 'win32'), EXE);
  assert.equal(resolveExe({}, EXE, 'win32'), EXE);
  // —— macOS：宿主就是 .app 内的主进程二进制，process.execPath 直接可用；
  //    旧逻辑拼 .../MacOS/DeepSeek Harness.exe 必然不存在（真机已验证）——
  assert.equal(resolveExe({}, MAC_EXE, 'darwin'), MAC_EXE);
  assert.equal(resolveExe({ exePath: '/tmp/other-app' }, MAC_EXE, 'darwin'), '/tmp/other-app');
  assert.equal(resolveExe({ exePath: '   ' }, MAC_EXE, 'darwin'), MAC_EXE);
});

test('U9 artifactPaths：helper/ack/errLog 共用同一 stamp（便于成组清理）；跨平台构造', () => {
  const stamp = '2026-10-22T08-15-30';
  // 不再写死 Windows 路径：目录用 tmpdir()+join 构造，文件名由平台 path 实现决定
  const dir = join(tmpdir(), 'dsrn-artifacts');
  const paths = artifactPaths(dir, stamp);
  assert.equal(paths.helper, join(dir, 'dsh-restart-now-helper-' + stamp + '.cjs'));
  assert.equal(paths.ack, join(dir, 'dsh-restart-now-helper-' + stamp + '.ack'));
  assert.equal(paths.errLog, join(dir, 'dsh-restart-now-' + stamp + '.err.log'));
  for (const file of [paths.helper, paths.ack, paths.errLog]) {
    const name = basename(file);
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

test('U11c 启动参数复用（darwin）：exe 前缀匹配 + POSIX 分词（路径含空格也不拆错）', () => {
  // macOS 的 ps -ww 输出是 argv 用空格拼接后的原文（不会重新加引号），而应用 exe 路径本身含空格，
  // 无法靠分词还原第 0 段 → 先用「已知 exe 字符串前缀」切出参数区，再按 POSIX 规则分词。
  assert.deepEqual(relaunchArgsFrom(MAC_EXE, MAC_EXE, 'darwin'), [],
    '命令行就等于 exe → 「确实是这个 exe 且没有参数」，返回空数组而非 null');
  assert.deepEqual(relaunchArgsFrom(MAC_EXE + ' --no-sandbox --lang=zh-CN', MAC_EXE, 'darwin'),
    ['--no-sandbox', '--lang=zh-CN'], '同一个 exe 的普通参数原样复用');
  assert.deepEqual(
    relaunchArgsFrom(MAC_EXE + " --user-data-dir='/Users/a b/Library' --flag=\"x y\"", MAC_EXE, 'darwin'),
    ['--user-data-dir=/Users/a b/Library', '--flag=x y'],
    'POSIX 单/双引号参数须正确分词（引号内空格不拆 token）');
  assert.equal(relaunchArgsFrom(MAC_EXE + ' --type=renderer', MAC_EXE, 'darwin'), null,
    '--type= 说明抓到的是 Chromium 子进程 → 放弃');
  assert.equal(relaunchArgsFrom(MAC_EXE + ' --expose-internals x.js', MAC_EXE, 'darwin'), null,
    '--expose-internals 说明抓到的是 desktop-host → 放弃');
  assert.equal(relaunchArgsFrom('/Applications/Other.app/Contents/MacOS/Other --x', MAC_EXE, 'darwin'), null,
    'exe 不同 → 放弃（同机多份安装时别拉错程序）');
  assert.equal(relaunchArgsFrom(MAC_EXE + '2 --x', MAC_EXE, 'darwin'), null,
    '前缀相同但不是同一个 exe（Harness2）→ 放弃，绝不猜');
  assert.equal(relaunchArgsFrom(null, MAC_EXE, 'darwin'), null, '问不出来 → 放弃');
  assert.equal(relaunchArgsFrom('   ', MAC_EXE, 'darwin'), null, '空命令行 → 放弃');
  // 分词函数本体：引号包裹、反斜杠转义、连续空白、空串
  assert.deepEqual(tokenizePosixCommandLine("a 'b c' \"d e\" f\\ g"), ['a', 'b c', 'd e', 'f g']);
  assert.deepEqual(tokenizePosixCommandLine('  a   b\tc  '), ['a', 'b', 'c']);
  assert.deepEqual(tokenizePosixCommandLine(''), []);
});

test('U11b 助手脚本真的会去问 WMI、并把结果当参数拉起（而不是用空参数）', () => {
  const script = makeScript();
  assert.ok(script.includes('Get-CimInstance -ClassName Win32_Process -Filter'), '须从进程表读主进程命令行');
  // v1.3.1 合并探测：启动参数取自身份探测带回的 mainCmd，不再单独起一次 powershell
  assert.ok(script.includes('mainCmd=$m.CommandLine'), '合并探测须带回主进程命令行');
  assert.ok(script.includes('identity.mainCmd'), '启动参数须取自合并探测结果');
  assert.ok(!script.includes('launch-args probe failed'), '旧的独立启动参数探针须已移除');
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

test('U13 web 服务回探（v1.2.1 第 6 项）：查新实例进程树有没有人在 LISTEN，绝不当成功判据', () => {
  // 判据不看端口号：实测每次启动端口都变（56355 → 57042 → 55843），
  // 连旧端口只会在每次成功重启后误报超时。
  const script = makeScript();
  assert.ok(script.includes("'web_listen='"), '观测结论须进日志');
  assert.ok(script.includes('Get-NetTCPConnection -State Listen'), '用系统监听表判定，不猜端口');
  assert.ok(script.includes('ParentProcessId='), 'web 服务在宿主子进程里，须按进程树查');
  assert.ok(script.includes('WEB_LISTEN_MS'), '等待窗口须可配（测试/调优）');
  assert.ok(!script.includes('port_relisten'), '旧的「连旧端口」判据须已移除');
  assert.ok(!script.includes('portFromWebUrl'), '不再依赖 DSH_WEB_URL 取端口');

  // 探测脚本本身：pid / 超时 / 轮询都会被固化进脚本，且只回 ok|timeout
  const probe = webListenScript(1234, 5000, 250);
  assert.ok(probe.indexOf('$main = 1234') >= 0, 'pid 须固化');
  assert.ok(probe.indexOf('AddMilliseconds(5000)') >= 0, '超时须固化');
  assert.ok(probe.indexOf('Start-Sleep -Milliseconds 250') >= 0, '轮询间隔须固化');
  assert.ok(probe.indexOf('"ok " + $hit.LocalPort') >= 0, '命中须回 ok 与端口');
  assert.ok(probe.indexOf('"timeout"') >= 0, '未命中须回 timeout');
  assert.doesNotThrow(() => webListenScript('not-a-number', 0, 0), '脏输入不得抛');

  // 顺序：先写回执（重启成不成已经定了）再观测 —— 观测慢不能拖着回执不写
  const receiptIndex = script.indexOf('respawnedAt');
  const probeIndex = script.indexOf("perf('web_listen=");
  assert.ok(receiptIndex > 0 && probeIndex > receiptIndex, '回执先落，再观测');
  assert.doesNotThrow(() => new Function(script.replace(/^'use strict';/, '')), '注入后仍是合法 JS');
});

// —— v1.3.0：darwin 助手脚本（真实信号/spawn 行为见 test/mac-helper.test.js 的集成测试）——
// 本组只钉「生成脚本的契约、注入内容与注入后语法」；Windows 断言（U1/U2/U13…）不得被弱化。

test('U14a darwin 助手脚本：ack 先写、SIGTERM→SIGKILL 停机、绝不用 Windows 原语', () => {
  const script = makeMacScript();
  assert.ok(script.startsWith("'use strict';"), '生成脚本是可独立运行的 CJS');

  // 时序：ack 必须先落盘（宿主据此判定派发成功），再探启动参数，最后才杀进程
  const ackIndex = script.indexOf('fs.writeFileSync(ACK');
  const probeIndex = script.indexOf('readLaunchArgs();');
  const termIndex = script.indexOf("signal(MAIN, 'SIGTERM', 'main')");
  const killIndex = script.indexOf("signal(MAIN, 'SIGKILL', 'main')");
  assert.ok(ackIndex > 0, 'ack 写入步骤缺失');
  assert.ok(probeIndex > ackIndex, 'ack 写入必须早于探启动参数');
  assert.ok(termIndex > probeIndex, '探完启动参数才停主进程');
  assert.ok(killIndex > termIndex, 'SIGKILL 是 SIGTERM 宽限超时后的升级手段');

  // 停机：只停主进程（绝不按进程树），先 SIGTERM 宽限，再 SIGKILL
  assert.ok(script.includes('STOP_GRACE_MS'), '宽限窗口须可配（测试/调优）');
  assert.ok(script.includes('const STOP_GRACE_MS = 10000'), '默认宽限 = MAIN_STOP_GRACE_MS（10s）');
  assert.ok(script.includes("signal(HOST, 'SIGKILL', 'host')"), '宿主超时须定点补刀');
  assert.ok(script.includes('waitGone('), '须「等进程消失」而不是固定 sleep');
  assert.ok(script.includes("error.code === 'EPERM'"), 'EPERM 视为存活');
  assert.ok(script.includes('invalid main pid: '), 'v1.3.0 pid 健全性：ppid 变 0/1 时绝不 kill');
  // 绝不允许 Windows 原语混进 darwin 脚本
  assert.ok(!script.includes('taskkill'), 'darwin 版不得出现 taskkill');
  assert.ok(!script.toLowerCase().includes('powershell'), 'darwin 版不得出现 PowerShell');
  assert.ok(!script.includes('Get-CimInstance'), 'darwin 版不得出现 WMI');
  assert.ok(!script.includes('Get-NetTCPConnection'), 'darwin 监听观测用 lsof，不用 PowerShell');
});

test('U14b darwin 助手脚本：ps 读启动参数、lsof 观测监听、osascript 弹窗、spawn(EXE,args,...) 拉起', () => {
  const script = makeMacScript();

  // 启动参数复用：/bin/ps -ww 读主进程命令行 → exe 前缀匹配 + POSIX 分词（三重校验）
  assert.ok(script.includes('execFileSync(PS, macPsArgs(MAIN)'), '用绝对路径 ps 读主进程启动参数');
  assert.ok(script.includes("relaunchArgsFrom(rawCommandLine, EXE, 'darwin')"), '须走 darwin 解析规则');
  assert.ok(script.includes('function tokenizePosixCommandLine('), 'POSIX 分词逻辑须内联（助手不能 import 模块）');
  assert.ok(script.includes("'launch_args=unavailable'"), '问不到/不敢用须留痕（区分「没参数」与「没问到」）');

  // 监听观测：ps 取进程树 → lsof 查 LISTEN（只进日志，绝不当成功判据）
  assert.ok(script.includes("execFileSync(PS, ['-axo', 'pid=,ppid=']"), '用 ps 取父子表');
  assert.ok(script.includes('collectDescendants(parsePsProcessTable(table), mainPid)'), '按新实例进程树收集 pid');
  assert.ok(script.includes('execFileSync(LSOF, macListenArgs(pids)'), '用 lsof 查这些 pid 的监听');
  assert.ok(script.includes("'web_listen='"), '观测结论须进日志');

  // 失败弹窗：osascript display alert（应用已死，弹窗是唯一通道）
  assert.ok(script.includes("spawn(OSASCRIPT, ['-e', macAlertScript(message)]"), '失败用 osascript 弹窗');
  assert.ok(script.includes('function macAlertScript('), '弹窗脚本生成逻辑须内联');
  assert.ok(script.includes('await alertUser('), '弹窗须 await（否则进程先退，弹不出来）');

  // 拉起：应用自身二进制当程序 + detached + 干净环境 + 存活验证/重试
  assert.ok(script.includes("spawn(EXE, args, { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env })"),
    '拉起目标是 exe 本体：detached、继承环境（已删 ENV_DROP）、cwd 为 exe 目录');
  assert.ok(script.includes('for (const key of ENV_DROP)') && script.includes('delete env[key]'),
    '拉起前按清单删「上一次运行」的 env 事实');
  assert.ok(script.includes('const ENV_DROP = '), '删除清单须注入脚本');
  assert.ok(script.includes('ALIVE_MS'), '每次拉起后须做存活验证');
  assert.ok(script.includes('ATTEMPTS'), '失败须重试');

  // 系统工具必须绝对路径（detached 进程不赌 PATH）
  for (const tool of [MAC_TOOLS.ps, MAC_TOOLS.lsof, MAC_TOOLS.osascript]) {
    assert.ok(script.includes(JSON.stringify(tool)), tool + ' 须以绝对路径注入');
  }

  // 收尾：回执先落盘，再观测监听（观测慢不能拖着回执不写）
  const receiptIndex = script.indexOf('respawnedAt');
  const listenIndex = script.indexOf("perf('web_listen=");
  assert.ok(receiptIndex > 0 && listenIndex > receiptIndex, '回执先落，再观测');

  assert.doesNotThrow(() => new Function(script.replace(/^'use strict';/, '')), '生成的脚本须是合法 JS');
});

test('U14c darwin 助手脚本：路径转义安全（空格/单引号/双引号 JSON round-trip）+ 参数可调', () => {
  const raw = "/Applications/it's \"x\"/DeepSeek Harness";
  const script = makeMacScript({
    exe: raw,
    hostGraceMs: 2222,
    stopGraceMs: 333,
    attempts: 7,
    aliveMs: 999,
    webListenMs: 111,
    webListenPollMs: 22,
  });
  const matched = script.match(/const EXE = ("(?:[^"\\]|\\.)*")/);
  assert.ok(matched, '脚本须含 EXE 字面量');
  assert.equal(JSON.parse(matched[1]), raw, 'JSON 解析回来必须等于原路径');
  assert.ok(script.includes('const HOST_GRACE_MS = 2222'), '宿主优雅关闭窗口可调');
  assert.ok(script.includes('const STOP_GRACE_MS = 333'), 'macOS 停机宽限可调（默认 10s）');
  assert.ok(script.includes('const ATTEMPTS = 7'));
  assert.ok(script.includes('const ALIVE_MS = 999'));
  assert.ok(script.includes('const WEB_LISTEN_MS = 111'), '监听观测窗口可调（缩短后集成测试才跑得快）');
  assert.ok(script.includes('const WEB_LISTEN_POLL_MS = 22'));
  assert.doesNotThrow(() => new Function(script.replace(/^'use strict';/, '')), '注入后仍是合法 JS');
});

test('U14d darwin 纯函数：AppleScript 转义 / 弹窗 / lsof 端口 / ps 进程树 / 路径归一化', () => {
  // AppleScript 方言不认 JSON 的 \uXXXX：反斜杠与双引号各自转义，换行写成 \n
  assert.equal(appleScriptLiteral('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  const alert = macAlertScript('重启失败：x', 'DeepSeek Harness');
  assert.equal(alert, 'display alert "DeepSeek Harness" message "重启失败：x" as critical');
  assert.ok(alert.endsWith('as critical'), '弹窗是 critical 级（应用已死，必须让人看见）');

  // lsof 输出 → 第一个 LISTEN 端口；没有监听返回 0
  assert.equal(parseLsofListenPort('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 1 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:50508 (LISTEN)'), 50508);
  assert.equal(parseLsofListenPort('node 1 u 20u IPv4 0x1 0t0 TCP *:443 (LISTEN)'), 443);
  assert.equal(parseLsofListenPort('node 1 u 20u IPv6 0x1 0t0 TCP [::1]:3000 (LISTEN)'), 3000);
  assert.equal(parseLsofListenPort('no listeners here'), 0);

  // ps 进程树 → 父子索引 → 整棵树（含自身，防脏数据成环）
  const table = parsePsProcessTable('  1     0\n  2     1\n  3     1\n  4     3\n');
  assert.deepEqual(collectDescendants(table, 1), [1, 2, 3, 4]);
  assert.deepEqual(collectDescendants(table, 4), [4]);
  assert.deepEqual(collectDescendants(table, 0), []);
  assert.deepEqual(collectDescendants(new Map(), 42), [42]);

  // 系统工具参数
  assert.deepEqual(macPsArgs(42), ['-ww', '-p', '42', '-o', 'command=']);
  assert.deepEqual(macListenArgs([42, 0, 7]), ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', '42', '-p', '7']);

  // 路径归一化：win32 统一分隔符 + 忽略大小写；darwin 保留大小写（宁可不带参数也不拉错程序）
  assert.equal(normalizePath('D:\\dsh\\App.exe/', 'win32'), 'd:\\dsh\\app.exe');
  assert.equal(normalizePath('D:\\dsh\\App.exe\\', 'win32'), 'd:\\dsh\\app.exe');
  assert.equal(normalizePath('/Applications/App////', 'darwin'), '/Applications/App');
  assert.equal(normalizePath('/Applications/App', 'darwin'), '/Applications/App');
  assert.notEqual(normalizePath('/Applications/App', 'darwin'), '/applications/app');

  // 平台清单与默认常量（与 environment.SUPPORTED_PLATFORMS 同口径）
  assert.deepEqual([...HELPER_PLATFORMS], ['win32', 'darwin']);
  assert.equal(MAIN_STOP_GRACE_MS, 10000, 'macOS 停机宽限默认 10s：给 Electron 体面退出的机会');
  assert.throws(() => buildHelperScript({ platform: 'linux' }), TypeError, '不支持的平台必须显式抛错');
});

// 在隔离 VM 中执行生成的脚本：所有系统调用均为 mock，绝无真实 kill/spawn。
async function simulateIdentity(platform, mode) {
  const files = new Map();
  const kills = [];
  let probes = 0;
  let mainAlive = true;
  const actual = platform === 'win32' ? 'C:\\App\\Harness.exe' : '/Applications/App.app/Contents/MacOS/App';
  const target = platform === 'win32' ? 'D:\\Other\\Other.exe' : '/tmp/other';
  const snap = { mainPath: actual, hostPath: actual, mainStart: 'start1', hostStart: 'start2', hostParent: 1234 };
  const fs = {
    writeFileSync: (file, text) => files.set(file, String(text)),
    appendFileSync: (file, text) => files.set(file, (files.get(file) || '') + text),
    readFileSync: (file) => { if (!files.has(file)) throw new Error('missing'); return files.get(file); },
  };
  const cp = {
    execFileSync: (file, args) => {
      if (file === 'taskkill') { kills.push(args); mainAlive = false; return ''; }
      if (platform === 'win32') {
        const command = args.at(-1);
        if (command.includes('mainPath=')) {
          probes++;
          if (mode === 'unavailable') throw new Error('access denied');
          return JSON.stringify({ ...snap, mainPath: mode === 'wrong' ? target : actual,
            mainStart: mode === 'reuse' && probes > 1 ? 'new-start' : 'start1' });
        }
        return '';
      }
      if (file === '/bin/ps' && args.includes('lstart=')) {
        const pid = Number(args[1]);
        if (pid === 1234) probes++;
        if (mode === 'unavailable') throw new Error('access denied');
        const start = mode === 'reuse' && pid === 1234 && probes > 1 ? 'new-start' : 'start1';
        return (pid === 1234 ? '1 ' : '1234 ') + start;
      }
      if (file === '/usr/sbin/lsof' && args.includes('txt')) {
        const pid = Number(args[args.indexOf('-p') + 1]);
        return 'p' + pid + '\nftxt\nn' + (mode === 'wrong' ? target : actual) + '\n';
      }
      return '';
    },
    spawn: () => { throw new Error('unexpected spawn'); },
  };
  const proc = { execPath: actual, pid: 9000, env: {}, exit() {}, kill(pid, sig) {
    if (sig === 0) { if (pid === 1234 && mainAlive) return; const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
    kills.push([pid, sig]); if (pid === 1234) mainAlive = false;
  } };
  const script = buildHelperScript({ platform, exe: target, mainPid: 1234, hostPid: 5678,
    ack: 'ack', errLog: 'log', receipt: 'receipt', attempts: 0, hostGraceMs: 0 });
  runInNewContext(script, { require: (name) => name === 'node:fs' ? fs : name === 'node:child_process' ? cp : { dirname: () => '/' },
    process: proc, setTimeout: (fn) => { queueMicrotask(fn); }, Buffer, console });
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
  return { files, kills };
}

test('双平台身份校验失败、PID 复用时不杀也不拉起；目标 exe 不参与身份判定', async () => {
  for (const platform of ['win32', 'darwin']) {
    for (const mode of ['unavailable', 'wrong', 'reuse']) {
      const { files, kills } = await simulateIdentity(platform, mode);
      assert.deepEqual(kills, [], platform + ' ' + mode);
      assert.equal(JSON.parse(files.get('receipt')).failed.reason, 'identity-verification-failed');
      assert.match(files.get('log'), /identity/);
    }
    const { kills } = await simulateIdentity(platform, 'ok');
    assert.equal(kills.length, 1, platform + ' 实际运行 exe 与重启目标不同时仍应通过身份判定');
  }
});
