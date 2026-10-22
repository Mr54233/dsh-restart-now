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
  ARTIFACT_RE, artifactPaths, buildHelperScript, buildHelperSpawn, resolveExe,
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

  // 拉起：干净环境（否则新实例退化成 node 没有窗口）+ detached + 存活验证 + 重试
  assert.ok(script.includes('delete env.ELECTRON_RUN_AS_NODE'), '拉起前必须删 ELECTRON_RUN_AS_NODE');
  assert.ok(script.includes('spawn(EXE, []'), '拉起目标是 exe 本体');
  assert.ok(script.includes('detached: true'), '新实例须 detached');
  assert.ok(script.includes('ALIVE_MS'), '每次拉起后须做存活验证');
  assert.ok(script.includes('ATTEMPTS'), '失败须重试');

  // v1.1 回归哨兵：WMI / VBS / PowerShell 派发层必须彻底消失
  const lowered = script.toLowerCase();
  for (const gone of ['wscript', 'invoke-cimmethod', 'win32_process', 'powershell', '.vbs']) {
    assert.ok(!lowered.includes(gone), `v1.1 起不应再出现 ${gone}`);
  }
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
