// test/mac-helper.test.js —— v1.3.0 macOS 助手脚本真实集成测试
//
// 为什么需要：helper.test.js 只校验生成脚本的文本契约；macOS 链路真正依赖信号语义、
// ps/lsof 的真实输出与 detached spawn，这些只有真跑一遍才能验证。
// 安全性（硬约束，绝不产生真实重启副作用）：
//  - fakeMain / fakeHost = 本测试自己 spawn 的 /bin/sleep 子进程，绝不碰真实 DSH 进程；
//  - fakeApp = 临时目录里的可执行 node shebang 脚本，记录 argv/env 后存活一段时间；
//  - 所有产物都在 mkdtemp 目录内，finally 杀光进程 + 删目录；非 darwin 平台整份 skip。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildHelperScript, RESPAWN_ENV_DROP } from '../lib/helper-src.js';

const DARWIN = process.platform === 'darwin';

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
}

function killQuiet(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* 进程已经不在了 */ }
}

function spawnSleeper() {
  return spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs);
    timer.unref?.();
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut: false }); });
  });
}

async function waitUntil(fn, timeoutMs = 3000, stepMs = 25) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}

/** 进程组 id：detached spawn 会 setsid，pgid === pid 是「已脱离宿主进程组」的铁证。 */
function processGroupOf(pid) {
  try {
    const text = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
    return Number(String(text).trim());
  } catch {
    return 0;
  }
}

test('U22 macOS 助手真实集成：ack → 停 main/host → detached 拉起新实例 → 回执（参数缩短 <8s）',
  { skip: DARWIN ? false : 'macOS only（darwin 助手集成测试）' },
  async () => {
    // 临时目录名故意带空格与单引号：路径注入/传递必须原样可用（macOS 真实路径也含空格）
    const dir = mkdtempSync(join(tmpdir(), "dsrn mac helper-'"));
    const ack = join(dir, 'helper.ack');
    const errLog = join(dir, 'helper.err.log');
    const receipt = join(dir, 'restart-now.last.json');
    const calls = join(dir, 'fake-app.calls.jsonl');
    const fakeApp = join(dir, 'Fake App');
    const pids = [];

    try {
      // fakeApp：可执行 node shebang 脚本。记录 argv/env 后存活 8s（> aliveMs，让助手判定拉起成功；
      // 也给「助手退出后新实例仍存活」的断言留足慢机器余量）。
      const shebang = /\s/u.test(process.execPath) ? '#!/usr/bin/env node' : '#!' + process.execPath;
      const fakeAppSource = shebang + `
'use strict';
const fs = require('node:fs');
const pick = (name) => (Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : null);
fs.appendFileSync(process.env.DSRN_CALLS, JSON.stringify({
  pid: process.pid,
  ppid: process.ppid,
  argv: process.argv.slice(2),
  env: {
    ELECTRON_RUN_AS_NODE: pick('ELECTRON_RUN_AS_NODE'),
    DSH_SESSION_ID: pick('DSH_SESSION_ID'),
    DSH_WEB_URL: pick('DSH_WEB_URL'),
    DSH_SHELL: pick('DSH_SHELL'),
    DSH_HOME: pick('DSH_HOME'),
    DSH_PROFILE_DIR: pick('DSH_PROFILE_DIR'),
    DSRN_CALLS: pick('DSRN_CALLS'),
  },
}) + '\\n');
setTimeout(() => process.exit(0), 8000);
`;
      writeFileSync(fakeApp, fakeAppSource);
      chmodSync(fakeApp, 0o755);

      // ① fakeMain / fakeHost：本测试 spawn 的 sleep 进程（绝不碰真实 DSH/宿主进程）
      const fakeMain = spawnSleeper();
      const fakeHost = spawnSleeper();
      const fakeMainPid = fakeMain.pid;
      const fakeHostPid = fakeHost.pid;
      pids.push(fakeMainPid, fakeHostPid);
      assert.ok(fakeMainPid > 1 && fakeHostPid > 1, '假进程须真的起来（sleep）');

      // ② 生成 darwin 助手脚本：全部等待窗口缩短，整条链路目标 < 8s
      const helperPath = join(dir, 'helper.cjs');
      writeFileSync(helperPath, buildHelperScript({
        platform: 'darwin',
        exe: fakeApp,
        mainPid: fakeMainPid,
        hostPid: fakeHostPid,
        errLog,
        ack,
        receipt,
        hostGraceMs: 500,
        stopGraceMs: 1000,
        attempts: 1,
        aliveMs: 600,
        probeTimeoutMs: 3000,
        webListenMs: 100,
        webListenPollMs: 50,
      }));

      // ③ 用 node 直接执行 .cjs 助手 = 生产里「应用自身二进制 + ELECTRON_RUN_AS_NODE=1」的等价形态。
      //    顺带注入 ENV_DROP 要删的四个键，验证新实例环境真的被清理。
      const helper = spawn(process.execPath, [helperPath], {
        stdio: 'ignore',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_SESSION_ID: 'sess-integration',
          DSH_WEB_URL: 'http://127.0.0.1:1',
          DSH_SHELL: '1',
          DSH_HOME: join(dir, 'home'),
          DSH_PROFILE_DIR: join(dir, 'profile'),
          DSRN_CALLS: calls,
        },
      });
      const helperPid = helper.pid;
      pids.push(helperPid);

      const exit = await waitExit(helper, 15000);
      assert.equal(exit.timedOut, false, '助手须在 15s 内退出（窗口已缩短，超时说明卡死）');
      assert.equal(exit.code, 0, '助手主路径须 exit 0');

      // ④ ack：宿主据此判定派发成功；helperPid 就是刚跑完的进程
      assert.ok(existsSync(ack), 'ack 必须落盘（否则宿主报 helper-not-responding）');
      const ackBody = JSON.parse(readFileSync(ack, 'utf8'));
      assert.equal(ackBody.helperPid, helperPid, 'ack 里的 helperPid 须是助手自身');
      assert.ok(Date.parse(ackBody.at) > 0, 'ack 须带 ISO 时间戳');

      // ⑤ 停机：fakeMain 被 SIGTERM 在宽限内退出；fakeHost 超过 hostGraceMs 被 SIGKILL 补刀
      assert.equal(alive(fakeMainPid), false, '假主进程必须被停掉');
      assert.equal(alive(fakeHostPid), false, '假宿主必须被停掉（优雅窗口过后补刀）');

      // ⑥ 拉起：fakeApp 被助手 detached 拉起，记录到 argv/env
      assert.ok(await waitUntil(() => existsSync(calls), 3000), 'fakeApp 必须被拉起并写下调用记录');
      const records = readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(records.length, 1, 'attempts=1 时只应拉起一次');
      const call = records[0];
      pids.push(call.pid);
      assert.deepEqual(call.argv, [],
        'ps 读到的是 sleep 的命令行（不是本 exe）→ 助手须保守地不带参数拉起');
      // 注意：这里**不能**写死 call.ppid === helperPid。助手 spawn 后只等 aliveMs(600ms) 就收尾，
      // 慢机器/高负载下 fakeApp 的 node 冷启动可能晚于助手退出 → 子进程被 launchd 收养，ppid 变成 1。
      // 两种形态都合法：助手里程碑（ppid=helperPid）或助手已退出（ppid=1）；只要不是测试进程直接拉起即可。
      assert.ok(call.ppid === helperPid || call.ppid === 1,
        `新实例须由助手拉起（或助手已退出、被 init 收养）；实际 ppid=${call.ppid}`);

      // ENV_DROP 生效：上一次运行/会话的事实全部清掉，安装身份保留
      for (const key of RESPAWN_ENV_DROP) {
        assert.equal(call.env[key], null, key + ' 必须从新实例环境里删掉');
      }
      assert.equal(call.env.DSH_HOME, join(dir, 'home'), 'DSH_HOME 属安装身份，必须保留');
      assert.equal(call.env.DSH_PROFILE_DIR, join(dir, 'profile'), 'DSH_PROFILE_DIR 属安装身份，必须保留');
      assert.equal(call.env.DSRN_CALLS, calls, '普通环境变量照常继承');

      // ⑦ detached：新实例自成进程组（pgid === pid），且助手退出后仍存活
      //    （旧实现继承宿主进程组，会被「只杀主进程」连坐）
      assert.equal(processGroupOf(call.pid), call.pid, 'detached 子进程须是进程组组长（pgid === pid）');
      assert.equal(alive(call.pid), true, '助手退出后新实例必须仍存活（detached 的核心目的）');

      // ⑧ 回执：respawnedAt + newPid + downtimeMs，供下次挂载展示「上次重启成功」
      const receiptBody = JSON.parse(readFileSync(receipt, 'utf8'));
      assert.ok(Date.parse(receiptBody.respawnedAt) > 0, '回执须写 respawnedAt');
      assert.equal(receiptBody.newPid, call.pid, '回执的 newPid 须是新实例');
      assert.equal(receiptBody.failed, undefined, '成功路径不得写 failed 段');
      assert.ok(Number.isFinite(Number(receiptBody.downtimeMs)) && Number(receiptBody.downtimeMs) >= 0,
        'downtimeMs 须是非负数字');

      // ⑨ 日志：分段耗时 + env 清理 + 监听观测（fakeApp 不监听 → timeout 是预期；只观测不判失败）
      const log = readFileSync(errLog, 'utf8');
      assert.match(log, /env_dropped=ELECTRON_RUN_AS_NODE,DSH_SESSION_ID,DSH_WEB_URL,DSH_SHELL/u);
      assert.match(log, /launch_args=unavailable/u, 'ps 读到的不是本 exe → 不带参数');
      assert.match(log, /main_stop=\d+ms host_grace=\d+ms respawn=\d+ms total=\d+ms/u);
      assert.match(log, /web_listen=(?:timeout|ok|unsupported)/u);
    } finally {
      // 无论断言如何都要清理：杀光本测试拉起的所有进程（含 helper 与 fakeApp），删临时目录
      for (const pid of pids) killQuiet(pid);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
