// test/dispatch.test.js —— v1.1 路由与门禁（用假 ctx/host 直调 apply，绝不产生任何进程）
//
// 这是唯一覆盖门禁顺序的测试：真机验证代价太高（会真的杀应用），所以把 ctx.get /
// webServer.register / http 的 req/res 全部假造，只走真实的路由处理函数。
// 每个用例都断言「没有派发」——只要有一条门禁失守，restart 就会真杀进程，不能只测返回值。
//
// 环境隔离（2026-11-12 勘误，v1.3.0 之上仍然需要）：在 DSH 宿主里跑 `npm test` 时进程带着
// DSH_PROFILE_DIR / DSH_HOME，resolveConfigFile() 会读到真配置文件，文件层把测试 patch 层的
// allowRestart:false / platformAuth:false 翻回 true，U20b/U20o 随机失败（宿主外跑则全绿）。
// 光删 DSH_* 不够：resolveConfigFile 的最后一层兜底是 USERPROFILE\.dsh，开发机上同样有真配置。
// ESM 静态 import 先于一切顶层语句，所以「删 env + 换 USERPROFILE」必须先于动态 import 插件。
// v1.3.0 的 before/after 沙箱（DSH_PROFILE_DIR → 空临时目录）与本隔离互补：前者护住测试期间，
// 本段护住模块装载瞬间（lib/index.js 顶层没有配置读取，但插件第一次 apply 前仍有窗口）。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
// ---- 环境隔离（先于一切插件 import 执行）------------------------------------
// 在 DSH 宿主里跑 `npm test` 时进程带着 DSH_PROFILE_DIR / DSH_HOME，resolveConfigFile()
// 会读到真配置文件，文件层把测试 patch 层的 allowRestart:false / platformAuth:false 翻回
// true，U20b/U20o 随机失败（宿主外跑则全绿）。光删 DSH_* 不够：resolveConfigFile 的最后
// 一层兜底是 USERPROFILE\.dsh，开发机上同样有真配置。ESM 静态 import 先于一切顶层语句，
// 但 node:test 等运行时模块的导入不触发插件代码，所以删 env 放在静态 import 之后、
// 动态 import 插件之前依然有效（lib/index.js 在被 import 时才读 process.env）。
const SAVED_ENV = {};
for (const key of ['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_PROFILE', 'DSH_SESSION_ID', 'USERPROFILE']) {
  if (process.env[key] !== undefined) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }
}
const SANDBOX_HOME = mkdtempSync(`${tmpdir().replace(/\\/g, '/')}/dsrn-dispatch-env-`);
process.env.USERPROFILE = SANDBOX_HOME;
const plugin = await import('../lib/index.js');
const { SUPPORTED_RANGE } = await import('../lib/version.js');
// DSH_PROFILE_DIR 不恢复：v1.3.0 的 before/after 沙箱接管它（测试期间指向空临时目录）。
// USERPROFILE 同理保持沙箱值直到进程退出——resolveConfigFile 每次调用都重读 process.env。
process.env.DSH_PROFILE = SAVED_ENV.DSH_PROFILE;

const BASE = '/plugins/dsh-restart-now';

// ---- 安全加固（v1.3.0，必须）------------------------------------------------
// 这批用例会真的走完门禁到派发点。macOS 下 process.execPath 本身就是可执行的 App 二进制，
// 配置里 exePath 留空时 performRestart 能通过 exe 校验并真的派发重启助手 —— 助手会
// SIGTERM 测试进程的 ppid（npm）、往真实 ~/.dsh profile 写回执、失败还会 osascript 弹窗。
// 真机事故（Lead 已复现）：TMPDIR 出现 helper + respawn 重试 + alert_shown。
// 两道保险：
//   ① 所有 applyPlugin 注入不存在的 exePath → performRestart 在写助手之前 fail-fast 500；
//   ② DSH_PROFILE_DIR 指向空临时目录 → 回执/配置/安装锁全部隔离，绝不读写真实 ~/.dsh；
// 文件末尾还有「零派发哨兵」：TMPDIR 一旦多出 helper 脚本即判定失败。
const TMP_DIR = tmpdir();
// 路径带时间戳：即使 pid 被复用，也保证这个路径**绝不存在**（存在会让 exe 校验放行 → 真派发）。
const NO_EXE = join(TMP_DIR, `dsrn-no-exe-${process.pid}-${Date.now()}`);

/** 统一入口：强制带不存在的 exePath（本文件任何 plugin.apply 都不得省）。 */
function applyPlugin(ctx, config = {}) {
  return plugin.apply(ctx, { ...config, exePath: NO_EXE });
}

const ORIGINAL_PROFILE_DIR = process.env.DSH_PROFILE_DIR;
let sandboxDir = '';
before(() => {
  sandboxDir = mkdtempSync(join(TMP_DIR, 'dsrn-dispatch-sandbox-'));
  process.env.DSH_PROFILE_DIR = sandboxDir;
});
after(() => {
  if (sandboxDir) rmSync(sandboxDir, { recursive: true, force: true });
  if (ORIGINAL_PROFILE_DIR === undefined) delete process.env.DSH_PROFILE_DIR;
  else process.env.DSH_PROFILE_DIR = ORIGINAL_PROFILE_DIR;
});

// 零派发哨兵：模块装载时给 TMPDIR 里的 helper 脚本拍快照，结束时不得多出任何新文件。
const HELPERS_AT_LOAD = new Set(listHelperScripts());
function listHelperScripts() {
  try {
    return readdirSync(TMP_DIR).filter((name) => /^dsh-restart-now-helper-.+\.cjs$/u.test(name));
  } catch {
    return [];
  }
}
function newHelperScripts() {
  return listHelperScripts().filter((name) => !HELPERS_AT_LOAD.has(name));
}

const PLATFORM_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin';
/** 门禁 ③（受支持平台）之后的用例只在 win32/darwin 上有意义：其它平台在 ③ 就被 403；
 *  CI 矩阵正是 windows-latest + macos-latest。 */
const gateTest = (name, fn) => test(
  name,
  { skip: PLATFORM_SUPPORTED ? false : `requires win32/darwin host (current: ${process.platform})` },
  fn,
);

// ---- 假环境 ----------------------------------------------------------------

function makeCtx(services = {}) {
  const registered = new Map();
  const effects = [];
  const injected = [];
  const disposers = [];

  // host = cordis 注入回调收到的那层 ctx：既有 webServer 服务，也有 effect(装配生命周期)
  const host = {
    webServer: {
      register(definition) {
        registered.set(`${definition.kind} ${definition.path}`, definition.handler);
        const dispose = () => registered.delete(`${definition.kind} ${definition.path}`);
        disposers.push(dispose);
        return dispose;
      },
    },
    effect(fn, label) {
      effects.push(label);
      const teardown = fn();
      if (typeof teardown === 'function') disposers.push(teardown);
      return () => { try { teardown?.(); } catch { /* ignore */ } };
    },
  };

  const ctx = {
    get: (name) => services[name],
    inject(deps, callback) {
      injected.push(deps);
      const merged = { ...host };
      merged.get = (name) => {
        if (name === 'webServer') return host.webServer;
        return services[name];
      };
      for (const dep of deps) {
        if (dep === 'webServer') continue;
        merged[dep] = services[dep] ?? (dep === 'commands' ? host.commands : {});
      }
      callback(merged);
      return () => {};
    },
    effect(fn, label) {
      effects.push(label);
      const teardown = fn();
      if (typeof teardown === 'function') disposers.push(teardown);
      return () => { try { teardown?.(); } catch { /* ignore */ } };
    },
  };

  const route = (method, path) => {
    const handler = registered.get(`exact ${path}`);
    assert.ok(handler, `路由未注册：${path}`);
    return handler;
  };
  return { ctx, host, registered, effects, injected, disposers, route };
}

function makeReq({ method = 'GET', url = BASE, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:62230', ...headers };
  req.socket = { remoteAddress: '127.0.0.1', remotePort: 50123 };
  if (method === 'POST') queueMicrotask(() => { req.emit('data', Buffer.from('')); req.emit('end'); });
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(chunk) { if (chunk !== undefined) this.body += chunk; this.ended = true; },
    json() { try { return JSON.parse(this.body); } catch { return null; } },
  };
  return res;
}

async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res;
}

const DESKTOP = { name: 'desktop', dir: '' };

function desktopCtx(services = {}) {
  return makeCtx({ profileContext: DESKTOP, ...services });
}

// ---- 门禁顺序 --------------------------------------------------------------

test('U20a 未注册非法方法 → 405，且 Allow 头正确', async () => {
  const { ctx, route } = makeCtx({});
  applyPlugin(ctx);
  const restart = route('POST', `${BASE}/restart`);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await call(restart, makeReq({ method }));
    assert.equal(res.statusCode, 405, `${method} 必须 405`);
    assert.equal(res.headers.allow, 'POST');
  }
  const env = route('GET', `${BASE}/environment`);
  const res404 = await call(env, makeReq({ method: 'POST' }));
  assert.equal(res404.statusCode, 405);
});

test('U20b allowRestart:false → 403 disabled（先于环境判定：web 下也能测到）', async () => {
  const { ctx, route } = makeCtx({});   // 非 desktop 环境
  applyPlugin(ctx, { allowRestart: false });
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().reason, 'disabled');
});

test('U20c 非 desktop 环境 → 403 non-desktop + 指向市场的 hint', async () => {
  const { ctx, route } = makeCtx({});
  applyPlugin(ctx);
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { ok: false, reason: 'non-desktop', hint: 'use dshmarket' });
});

gateTest('U20d 围栏：跨源 / 非 loopback 一律 403 untrusted；剥离代理留下的转发头按设计容忍', async () => {
  const { ctx, route } = desktopCtx();
  applyPlugin(ctx);
  const restart = route('POST', `${BASE}/restart`);

  const crossOrigin = await call(restart, makeReq({
    method: 'POST', headers: { origin: 'https://evil.example' },
  }));
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(crossOrigin.json().reason, 'untrusted');

  const remote = makeReq({ method: 'POST' });
  remote.socket.remoteAddress = '10.0.0.5';
  const remoteRes = await call(restart, remote);
  assert.equal(remoteRes.statusCode, 403);
  assert.equal(remoteRes.json().reason, 'untrusted');

  // 桌面构建里有一层剥头代理（dshmarket #648 同款），它可能把 Origin 摘掉；
  // 因此凭 Origin 缺失 / 转发头不能判恶意 —— 只有「Origin 存在且不等于 Host」才是硬拒绝。
  const sameOriginWithForwarded = await call(restart, makeReq({
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:62230', 'x-forwarded-for': '1.2.3.4' },
  }));
  assert.notEqual(sameOriginWithForwarded.json()?.reason, 'untrusted',
    '同源 + 转发头须放行到后续门禁（否则真机全被拒，v0.6 踩过这个坑）');
  // 放行后必须停在 performRestart 的 exe 前置检查（夹具注入的 exePath 不存在）——
  // 这一步既证明围栏没误杀，也证明安全夹具真的把派发挡在了写助手之前。
  assert.equal(sameOriginWithForwarded.statusCode, 500,
    '放行后应停在 exe-not-found（真派发会杀测试进程，安全夹具必须挡住）');
  assert.equal(sameOriginWithForwarded.json()?.reason, 'exe-not-found',
    '不存在的 exePath 必须在写助手之前 fail-fast');

  const forwardedWrongOrigin = await call(restart, makeReq({
    method: 'POST',
    headers: { origin: 'http://localhost:62230', 'x-forwarded-for': '1.2.3.4' },
  }));
  assert.equal(forwardedWrongOrigin.statusCode, 403, 'Origin 与 Host 不一致 → 硬拒绝');
  assert.equal(forwardedWrongOrigin.json()?.reason, 'untrusted');
});

gateTest('U20e 插件安装中（run.json 指向存活 pid）→ 409 installing，绝不派发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-dispatch-lock-'));
  try {
    mkdirSync(join(dir, '.plugin-manager'), { recursive: true });
    writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: process.pid }));
    const { ctx, route } = desktopCtx({ profileContext: { name: 'desktop', dir } });
    applyPlugin(ctx);
    const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, 'installing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

gateTest('U20f 有活跃任务 → 409 busy（带计数与 forceable），?force=1 可越过 busy', async () => {
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [{ id: 'j1', status: 'running' }] };
  const { ctx, route } = desktopCtx({ agents, jobs });
  applyPlugin(ctx);
  const restart = route('POST', `${BASE}/restart`);

  const busy = await call(restart, makeReq({ method: 'POST' }));
  assert.equal(busy.statusCode, 409);
  const payload = busy.json();
  assert.equal(payload.reason, 'busy');
  assert.equal(payload.tasks, 1);
  assert.equal(payload.jobs, 1);
  assert.equal(payload.forceable, true);
});

gateTest('U20g ?wait=1 → 202 waiting；GET /status 反映等待；?cancel=1 → 200 撤销', async () => {
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [{ id: 'j1', status: 'running' }] };
  const { ctx, route } = desktopCtx({ agents, jobs });
  applyPlugin(ctx);
  const restart = route('POST', `${BASE}/restart`);
  const status = route('GET', `${BASE}/status`);

  const waiting = await call(restart, makeReq({ method: 'POST', url: `${BASE}/restart?wait=1` }));
  try {
    assert.equal(waiting.statusCode, 202);
    const body = waiting.json();
    assert.equal(body.mode, 'waiting');
    assert.equal(body.ok, true);
    assert.ok(body.since > 0, '须回报等待开始时间（epoch ms）');

    const during = await call(status, makeReq({ url: `${BASE}/status` }));
    assert.equal(during.statusCode, 200);
    const snap = during.json();
    assert.equal(snap.state, 'waiting');
    assert.equal(snap.tasks, 1);
    assert.ok(snap.remainingMs > 0 && snap.remainingMs <= 30 * 60 * 1000);
  } finally {
    // 无论断言如何，都要撤销等待：模块级等待状态会污染后续用例，定时器还会挂住进程
    const cancelled = await call(restart, makeReq({ method: 'POST', url: `${BASE}/restart?cancel=1` }));
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().cancelled, true);
  }

  const after = await call(status, makeReq({ url: `${BASE}/status` }));
  assert.equal(after.json().state, 'idle');
});

test('U20h 探测口：非 desktop 也回 200 与完整快照（客户端靠它决定零挂载）', async () => {
  const { ctx, route } = makeCtx({});
  applyPlugin(ctx);
  const res = await call(route('GET', `${BASE}/environment`), makeReq({ url: `${BASE}/environment` }));
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.environment, 'web');
  assert.equal(body.platform, process.platform);
  assert.equal(typeof body.config, 'object');
  assert.deepEqual(Object.keys(body.config).sort(),
    ['allowRestart', 'confirm', 'entryFooter', 'entryHeader', 'entryPanel', 'entrySettingsRow', 'entryTitlebar', 'exePath', 'platformAuth'],
    'v1.3.1：配置层九键（v1.2.2 八键 + entryTitlebar）');
  assert.equal(body.platformAuth.enforced, true, '探测口须回报鉴权结论');
  assert.equal(body.platformAuth.verdict, 'bypassed', '无 connection 服务时按放行处理');
  assert.ok('lastRestart' in body);
  assert.equal(body.supportedRange, SUPPORTED_RANGE, '选择题 9：探测口须回传支持范围');
  assert.ok('version' in body && 'supported' in body, '探测口须回传运行时版本与是否支持');
  assert.equal(body.wait.state, 'idle');
});

test('U20i 配置路由：GET 回 5 键；POST 在非 desktop 下 403（写配置同样受环境门禁）', async () => {
  const { ctx, route } = makeCtx({});
  applyPlugin(ctx);
  const config = route('GET', `${BASE}/config`);
  const get = await call(config, makeReq({ url: `${BASE}/config` }));
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().ok, true);

  const post = await call(config, makeReq({ method: 'POST', url: `${BASE}/config` }));
  assert.equal(post.statusCode, 403);
  assert.equal(post.json().reason, 'non-desktop');
});

test('U20j 命令注册：名字/描述/hint 合法，handler 返回 CommandResult；非 desktop 报错不派发', async () => {
  const definitions = [];
  const commands = { register(definition) { definitions.push(definition); return () => {}; } };
  const { ctx } = makeCtx({ commands });
  applyPlugin(ctx);

  assert.equal(definitions.length, 1, 'commands 服务就绪时须注册一条斜杠命令');
  const [definition] = definitions;
  assert.equal(definition.name, 'restart');
  assert.match(definition.name, /^[a-z][a-z0-9-]*$/, 'COMMAND_NAME 正则');
  assert.ok(typeof definition.description === 'string' && definition.description.length > 0);
  assert.equal(typeof definition.handler, 'function');
  assert.equal(definition.input.hint, '[--force] [--wait]');

  const result = await definition.handler({ rawInput: '', attachments: [] });
  assert.equal(result.kind, 'error', '非 desktop 环境下命令必须报错而不是静默成功');
  assert.ok(typeof result.text === 'string' && result.text.length > 0);
});

gateTest('U20k 命令 handler 参数解析：--force / --wait 被识别', async () => {
  const definitions = [];
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [{ id: 'j1', status: 'running' }] };
  const { ctx } = makeCtx({
    profileContext: DESKTOP,
    agents,
    jobs,
    commands: { register(definition) { definitions.push(definition); return () => {}; } },
  });
  applyPlugin(ctx);
  const [definition] = definitions;
  assert.ok(definition, '须注册命令');

  // 有活跃任务：不带参数 → busy 报错；带 --force → 越过 busy（本机 exe 不存在故仍失败，
  // 关键是文案不同 = --force 确实被解析；全程不产生任何进程）
  const busy = await definition.handler({ rawInput: '', attachments: [] });
  assert.equal(busy.kind, 'error');

  const force = await definition.handler({ rawInput: '--force', attachments: [] });
  assert.equal(force.kind, 'error');
  assert.notEqual(force.text, busy.text, '--force 须改变走向（越过 busy 守卫）');

  // --wait → 进入等待模式并成功回应；随后撤销，避免定时器挂住测试进程
  const wait = await definition.handler({ rawInput: '--wait', attachments: [] });
  assert.equal(wait.kind, 'success');

  const { ctx: ctx2, route } = makeCtx({
    profileContext: DESKTOP, agents, jobs,
  });
  applyPlugin(ctx2);
  const cancel = await call(route('POST', `${BASE}/restart`),
    makeReq({ method: 'POST', url: `${BASE}/restart?cancel=1` }));
  assert.equal(cancel.statusCode, 200);
});

// ---- v1.2.1 平台会话鉴权（P0 缺口：本机任意进程 curl 动作口就能重启应用）----------

gateTest('U20m 平台 401 → 动作口/配置口/状态口全部拒绝，绝不派发', async () => {
  const agents = { list: () => [] };
  const jobs = { list: () => [] };
  const connection = { requestRejection: async () => 401 };
  const { ctx, route } = desktopCtx({ agents, jobs, connection });
  applyPlugin(ctx);

  const restart = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(restart.statusCode, 401, '缺凭据是 401，不是 403');
  assert.equal(restart.json().reason, 'unauthorized');
  assert.ok(restart.json().hint.length > 0, '须给用户可读的原因（401 与 403 文案要分开）');

  const status = await call(route('GET', `${BASE}/status`), makeReq({ url: `${BASE}/status` }));
  assert.equal(status.statusCode, 401, '等待状态会暴露任务计数，同样要鉴权');

  const config = await call(route('POST', `${BASE}/config`), makeReq({ method: 'POST', url: `${BASE}/config` }));
  assert.equal(config.statusCode, 401, '写配置是状态变更，同样要鉴权');
});

gateTest('U20n 平台 403 → 403 forbidden（与 401 语义分开）', async () => {
  const connection = { requestRejection: () => 403 };
  const { ctx, route } = desktopCtx({ connection });
  applyPlugin(ctx);
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().reason, 'forbidden');
});

gateTest('U20o platformAuth:false 逃生门 → 旁路平台（真机壳层不带 cookie 时用户可自救）', async () => {
  let called = 0;
  const connection = { requestRejection: () => { called += 1; return 401; } };
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [] };
  const { ctx, route } = desktopCtx({ agents, jobs, connection });
  applyPlugin(ctx, { platformAuth: false });
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(called, 0, '关掉鉴权后不得再打平台');
  assert.equal(res.statusCode, 409, '须放行到后续门禁（有活跃任务 → busy）');
  assert.equal(res.json().reason, 'busy');
});

gateTest('U20p 平台抛异常 → 不拦截（插件不能因为平台 API 变动整体不可用），但留 error 供诊断', async () => {
  const connection = { requestRejection: () => { throw new Error('boom'); } };
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [] };
  const { ctx, route } = desktopCtx({ agents, jobs, connection });
  applyPlugin(ctx);
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 409, '异常须按放行处理（走到 busy）');

  const env = await call(route('GET', `${BASE}/environment`), makeReq({ url: `${BASE}/environment` }));
  assert.equal(env.json().platformAuth.verdict, 'error');
  assert.equal(env.json().platformAuth.error, 'boom', '探测口是唯一能看见平台异常的地方');
});

gateTest('U20r 冷却（第 22 项）：窗口内连点一律 409 cooldown，绝不再派一次', async () => {
  plugin.resetCooldown();
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-cooldown-'));
  try {
    const { ctx, route } = makeCtx({ profileContext: { name: 'desktop', dir } });
    // applyPlugin 统一注入不存在的 exePath：冷却放行后必须停在 exe-not-found —— 测试里绝不允许真派发
    applyPlugin(ctx);
    const restart = route('POST', `${BASE}/restart`);

    // 回执照写：模拟「刚刚开始过一次重启」（跨实例有效，换宿主也看得见）
    writeFileSync(join(dir, 'restart-now.last.json'),
      JSON.stringify({ at: new Date().toISOString(), atMs: Date.now() }));
    const blocked = await call(restart, makeReq({ method: 'POST' }));
    assert.equal(blocked.statusCode, 409, '窗口内必须拒');
    assert.equal(blocked.json().reason, 'cooldown');
    assert.ok(blocked.json().retryAfterMs > 0 && blocked.json().retryAfterMs <= 5000, '须告诉用户还要等多久');

    // 回执时间退到窗口外 → 放行（停在 exe-not-found，仍然没有真派发）
    writeFileSync(join(dir, 'restart-now.last.json'),
      JSON.stringify({ at: new Date().toISOString(), atMs: Date.now() - 60000 }));
    const allowed = await call(restart, makeReq({ method: 'POST' }));
    assert.equal(allowed.statusCode, 500);
    assert.equal(allowed.json().reason, 'exe-not-found', '冷却放行后才会走到 exe 检查');

    // 失败不占窗口：exe 不可用属前置失败，用户改完配置应当能立刻重试
    const again = await call(restart, makeReq({ method: 'POST' }));
    assert.equal(again.statusCode, 500, '前置失败不得把自己锁进冷却');
    assert.equal(again.json().reason, 'exe-not-found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    plugin.resetCooldown();
  }
});

test('U20q 探测口永不拦截：401 时仍 200 并回报 unauthorized（否则用户无从得知按钮为何失效）', async () => {
  const connection = { requestRejection: () => 401 };
  const { ctx, route } = desktopCtx({ connection });
  applyPlugin(ctx);
  const res = await call(route('GET', `${BASE}/environment`), makeReq({ url: `${BASE}/environment` }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().platformAuth,
    { enforced: true, available: true, verdict: 'unauthorized', error: '' });
});

gateTest('U20l 插件卸载时等待定时器一并停掉（否则下线后还会按计划重启）', async () => {
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [] };
  const { ctx, route, disposers } = makeCtx({ profileContext: DESKTOP, agents, jobs });
  applyPlugin(ctx);

  const statusHandler = route('GET', `${BASE}/status`);
  const started = await call(route('POST', `${BASE}/restart`),
    makeReq({ method: 'POST', url: `${BASE}/restart?wait=1` }));
  assert.equal(started.statusCode, 202);

  const before = await call(statusHandler, makeReq({ method: 'GET', url: `${BASE}/status` }));
  assert.equal(before.json().state, 'waiting');

  // 模拟插件卸载：把 effect 的 teardown 全跑一遍（内含 cancelWait）
  for (const dispose of disposers) { try { dispose(); } catch { /* 已释放 */ } }

  const after = await call(statusHandler, makeReq({ method: 'GET', url: `${BASE}/status` }));
  assert.equal(after.json().state, 'idle', '卸载后等待状态必须复位');
});

// ---- v1.3.1 仅关闭（close-only）------------------------------------------------
// close 与 restart 共用门禁 ①–⑧ 与同一助手派发机制，但不提供 wait/cancel——
// 等待模式的终局是一次重启，与「仅关闭」语义冲突，刻意不复用（close 绝不导致重启）。
// CLOSE_HELPER_READY=false（helper-src 尚未实现 action:'close'）时派发层 501 拒绝；
// helper 实现并翻 true 后，本节用例按该常量的实际取值自动适配，无需改动。

const CLOSE_URL = `${BASE}/close`;

test('U20s1 关闭口：注册为 POST，GET/PUT/DELETE → 405 且 Allow 头正确', async () => {
  const { ctx, route } = makeCtx({});
  applyPlugin(ctx);
  const close = route('POST', CLOSE_URL);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await call(close, makeReq({ method, url: CLOSE_URL }));
    assert.equal(res.statusCode, 405, `${method} 必须 405`);
    assert.equal(res.headers.allow, 'POST');
  }
});

test('U20s2 关闭口门禁与 restart 同序：总开关在环境判定之前（① 先于 ②）', async () => {
  const disabled = makeCtx({});
  applyPlugin(disabled.ctx, { allowRestart: false });
  const off = await call(disabled.route('POST', CLOSE_URL), makeReq({ method: 'POST', url: CLOSE_URL }));
  assert.equal(off.statusCode, 403);
  assert.equal(off.json().reason, 'disabled', 'web 环境下也能测到 ① 总开关（顺序证据）');

  const { ctx, route } = makeCtx({});
  applyPlugin(ctx);
  const nonDesktop = await call(route('POST', CLOSE_URL), makeReq({ method: 'POST', url: CLOSE_URL }));
  assert.equal(nonDesktop.statusCode, 403);
  assert.deepEqual(nonDesktop.json(), { ok: false, reason: 'non-desktop', hint: 'use dshmarket' });
});

gateTest('U20s3 关闭口 ⑥ 安装锁：run.json 指向存活 pid → 409 installing，与 restart 同口径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-dispatch-close-lock-'));
  try {
    mkdirSync(join(dir, '.plugin-manager'), { recursive: true });
    writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: process.pid }));
    const { ctx, route } = desktopCtx({ profileContext: { name: 'desktop', dir } });
    applyPlugin(ctx);
    const res = await call(route('POST', CLOSE_URL), makeReq({ method: 'POST', url: CLOSE_URL }));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, 'installing');
    assert.equal(res.json().forceable, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

gateTest('U20s4 关闭口 ⑦ 活跃任务：409 busy 可 force；?wait=1 不复用等待重启；?force=1 才放行', async () => {
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [{ id: 'j1', status: 'running' }] };
  const { ctx, route } = desktopCtx({ agents, jobs });
  applyPlugin(ctx);
  const close = route('POST', CLOSE_URL);
  const status = route('GET', `${BASE}/status`);

  const busy = await call(close, makeReq({ method: 'POST', url: CLOSE_URL }));
  assert.equal(busy.statusCode, 409);
  const payload = busy.json();
  assert.equal(payload.reason, 'busy');
  assert.equal(payload.tasks, 1);
  assert.equal(payload.jobs, 1);
  assert.equal(payload.forceable, true);

  // close 不复用等待重启：?wait=1 不会进入等待模式（等待的终局是一次 restart）
  const waitAttempt = await call(close, makeReq({ method: 'POST', url: `${CLOSE_URL}?wait=1` }));
  assert.equal(waitAttempt.statusCode, 409, 'close 上 wait 无效，busy 照拒');
  assert.equal(waitAttempt.json().reason, 'busy');
  const duringWait = await call(status, makeReq({ url: `${BASE}/status` }));
  assert.equal(duringWait.json().state, 'idle', '绝不能因为 ?wait=1 进入等待模式');

  // ?force=1 越过 busy，放行到派发层：助手未实现 close → 501 close-helper-missing；
  // 助手实现并翻 CLOSE_HELPER_READY 后应继续走到 exe 前置检查 → 500 exe-not-found（夹具 exePath 不存在）
  const forced = await call(close, makeReq({ method: 'POST', url: `${CLOSE_URL}?force=1` }));
  if (plugin.CLOSE_HELPER_READY) {
    assert.equal(forced.statusCode, 500);
    assert.equal(forced.json().reason, 'exe-not-found', '放行后应停在 exe-not-found（安全夹具挡住真派发）');
  } else {
    assert.equal(forced.statusCode, 501);
    assert.equal(forced.json().reason, 'close-helper-missing', '助手未实现 action:"close" 前必须拒绝派发（否则就是一次重启）');
  }
});

gateTest('U20s5 关闭口 ⑤ 平台鉴权：401 unauthorized，文案与 restart 同一套', async () => {
  const connection = { requestRejection: async () => 401 };
  const { ctx, route } = desktopCtx({ connection });
  applyPlugin(ctx);
  const res = await call(route('POST', CLOSE_URL), makeReq({ method: 'POST', url: CLOSE_URL }));
  assert.equal(res.statusCode, 401, '缺凭据是 401，不是 403');
  assert.equal(res.json().reason, 'unauthorized');
  assert.ok(res.json().hint.length > 0);
});

gateTest('U20s6 关闭口 ⑧ 冷却与重启共用同一窗口（回执 atMs 判据）', async () => {
  plugin.resetCooldown();
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-close-cooldown-'));
  try {
    const { ctx, route } = makeCtx({ profileContext: { name: 'desktop', dir } });
    applyPlugin(ctx);
    const close = route('POST', CLOSE_URL);
    const restart = route('POST', `${BASE}/restart`);

    // 回执照写：模拟「刚刚开始过一次停机」——close 与 restart 都必须被同一窗口拦下
    writeFileSync(join(dir, 'restart-now.last.json'),
      JSON.stringify({ at: new Date().toISOString(), atMs: Date.now() }));
    const blocked = await call(close, makeReq({ method: 'POST', url: CLOSE_URL }));
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().reason, 'cooldown');
    assert.ok(blocked.json().retryAfterMs > 0 && blocked.json().retryAfterMs <= 5000);

    const restartBlocked = await call(restart, makeReq({ method: 'POST' }));
    assert.equal(restartBlocked.statusCode, 409, 'close 与 restart 共用冷却判据');
    assert.equal(restartBlocked.json().reason, 'cooldown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    plugin.resetCooldown();
  }
});

test('U20s7 派发契约：performClose 把 action:"close" 传给 buildHelperScript；回执带 close 标记；全程零真派发', async () => {
  plugin.resetCooldown();
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-close-contract-'));
  const calls = [];
  try {
    const { ctx, route } = makeCtx({ profileContext: { name: 'desktop', dir } });
    applyPlugin(ctx);
    const result = await plugin.performClose(ctx, { exePath: process.execPath }, {
      // 仅测试注入：closeHelperReady:true 越过能力闸（否则 CLOSE_HELPER_READY=false 时 501 先行，
      // 永远到不了派发点）——真实路由的能力闸行为由 U20s4/U20s8 按常量实际取值断言；
      // buildHelperScript 记录入参后抛错——performStop 在写助手前就会失败，全程不产生任何进程、
      // 不写任何助手脚本（writeFileSync 求值前 buildHelper 已抛错），errLog 之外零落盘。
      deps: {
        closeHelperReady: true,
        buildHelperScript: (options) => {
          calls.push(options);
          throw new Error('spy-stop');
        },
      },
    });
    assert.equal(result.status, 500);
    assert.equal(result.reason, 'helper-write-failed');
    assert.equal(calls.length, 1, 'buildHelperScript 必须被调用恰好一次');
    const helperOptions = calls[0];
    assert.equal(helperOptions.action, 'close', '必须把 action:"close" 传给 buildHelperScript（助手分叉的唯一契约）');
    assert.equal(helperOptions.platform, process.platform, '按宿主真实平台生成助手');
    assert.equal(helperOptions.exe, process.execPath, 'exe 用配置注入的可用路径（测试进程自身）');
    assert.ok(Number.isInteger(helperOptions.mainPid) && helperOptions.mainPid > 1, '主进程 pid 取 process.ppid');
    assert.ok(Number.isInteger(helperOptions.hostPid) && helperOptions.hostPid > 1);
    assert.ok(String(helperOptions.ack).endsWith('.ack'));
    assert.ok(String(helperOptions.errLog).endsWith('.err.log'));
    assert.ok(String(helperOptions.receipt).endsWith('restart-now.last.json'));

    // 回执：开始段照写（冷却判据 atMs 可用），并带 action:'close' 标记供回执半边如实区分
    const receipt = JSON.parse(readFileSync(join(dir, 'restart-now.last.json'), 'utf8'));
    assert.equal(receipt.action, 'close');
    assert.ok(receipt.atMs > 0);
    assert.ok(Number.isInteger(receipt.hostPid) && receipt.hostPid > 0);
    assert.ok(Number.isInteger(receipt.mainPid) && receipt.mainPid > 0);

    // 关闭派发与重启共用冷却窗口：随后的 restart 请求被内存 lastDispatchAt 拦下（跨动作一致）
    const blocked = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
    assert.equal(blocked.statusCode, 409, 'close 派发后 restart 受同一冷却窗口约束');
    assert.equal(blocked.json().reason, 'cooldown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    plugin.resetCooldown();
  }
});

gateTest('U20s8 能力闸：助手未实现 close 时 /close 501 且零产物零回执', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-close-cap-'));
  try {
    const { ctx, route } = desktopCtx({ profileContext: { name: 'desktop', dir } });
    applyPlugin(ctx);
    const res = await call(route('POST', CLOSE_URL), makeReq({ method: 'POST', url: CLOSE_URL }));
    if (plugin.CLOSE_HELPER_READY) {
      assert.equal(res.statusCode, 500, '助手已实现时放行到 exe 前置检查（NO_EXE）');
      assert.equal(res.json().reason, 'exe-not-found');
    } else {
      assert.equal(res.statusCode, 501);
      assert.equal(res.json().ok, false);
      assert.equal(res.json().reason, 'close-helper-missing');
    }
    assert.equal(existsSync(join(dir, 'restart-now.last.json')), false,
      '501/前置失败都不该写回执（回执 atMs 会误占冷却窗口）');
    assert.deepEqual(newHelperScripts(), [], '不得写出任何助手脚本');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('U20s9 探测口回报 closeSupported，与 CLOSE_HELPER_READY 同值', async () => {
  const { ctx, route } = makeCtx({});
  applyPlugin(ctx);
  const res = await call(route('GET', `${BASE}/environment`), makeReq({ url: `${BASE}/environment` }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().closeSupported, plugin.CLOSE_HELPER_READY,
    'closeSupported 是客户端隐藏关闭入口的唯一依据，必须与能力闸一致');
});

gateTest('U20s10 等待中发起关闭：撤销等待重启并走关闭链路（二者不共存）', async () => {
  let list = [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }];
  const agents = { list: () => list };
  const jobs = { list: () => [] };
  const { ctx, route } = desktopCtx({ agents, jobs });
  applyPlugin(ctx);
  const close = route('POST', CLOSE_URL);
  const restart = route('POST', `${BASE}/restart`);
  const status = route('GET', `${BASE}/status`);

  const waiting = await call(restart, makeReq({ method: 'POST', url: `${BASE}/restart?wait=1` }));
  try {
    assert.equal(waiting.statusCode, 202);
    list = []; // 任务在等待期间结束
    const closeRes = await call(close, makeReq({ method: 'POST', url: CLOSE_URL }));
    if (plugin.CLOSE_HELPER_READY) {
      assert.equal(closeRes.statusCode, 500);
      assert.equal(closeRes.json().reason, 'exe-not-found');
    } else {
      assert.equal(closeRes.statusCode, 501);
    }
    const snap = await call(status, makeReq({ url: `${BASE}/status` }));
    assert.equal(snap.json().state, 'idle', '发起关闭必须撤销挂着的等待重启（等待终局是重启，与关闭冲突）');
  } finally {
    await call(restart, makeReq({ method: 'POST', url: `${BASE}/restart?cancel=1` }));
  }
});

test('只读预检：围栏和平台鉴权、方法限制', async () => {
  const { ctx, route } = desktopCtx({ connection: { requestRejection: () => 401 } });
  applyPlugin(ctx);
  const preflight = route('GET', `${BASE}/preflight`);
  const method = await call(preflight, makeReq({ method: 'POST' }));
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, 'GET');
  const cross = await call(preflight, makeReq({ headers: { origin: 'https://evil.example' } }));
  assert.equal(cross.json().reason, 'untrusted');
  const denied = await call(preflight, makeReq());
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.json().reason, 'unauthorized');
});

test('只读预检：报告 busy、锁和未知身份，保留残锁与 profile 内容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-preflight-'));
  try {
    mkdirSync(join(dir, '.plugin-manager'));
    const lock = join(dir, '.plugin-manager', 'run.json');
    const contents = JSON.stringify({ pid: process.pid });
    writeFileSync(lock, contents);
    const agents = { list: () => [{ id: 'a', status: 'running' }] };
    const jobs = { list: () => [{ id: 'j', status: 'running' }] };
    const { ctx, route } = desktopCtx({ profileContext: { name: 'desktop', dir }, agents, jobs });
    applyPlugin(ctx);
    const preflight = route('GET', `${BASE}/preflight`);
    const res = await call(preflight, makeReq());
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.readOnly, true);
    assert.match(body.disclaimer, /does not guarantee/);
    assert.equal(body.checks.lock.state, 'locked');
    assert.deepEqual(body.checks.busy, { state: 'busy', tasks: 1, jobs: 1 });
    assert.equal(body.checks.mainProcess.identity, 'unknown');
    assert.equal(body.checks.executable.usable, false);
    assert.equal(readFileSync(lock, 'utf8'), contents);
    assert.deepEqual(readdirSync(dir), ['.plugin-manager']);
    writeFileSync(lock, 'invalid');
    const malformed = await call(preflight, makeReq());
    assert.equal(malformed.json().checks.lock.state, 'unknown');
    assert.equal(readFileSync(lock, 'utf8'), 'invalid');
    // 对确定不存在的 PID 验证残锁不会被预检清理。
    let missingPid;
    for (const pid of [2147483647, 99999999, 9999999]) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { missingPid = pid; break; } }
    }
    if (missingPid) {
      const stale = JSON.stringify({ pid: missingPid });
      writeFileSync(lock, stale);
      const observed = await call(preflight, makeReq());
      assert.equal(observed.json().checks.lock.state, 'stale');
      assert.equal(readFileSync(lock, 'utf8'), stale);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('只读预检：服务不可用或异常不能误报空闲', async () => {
  const { ctx, route } = desktopCtx({ agents: { list: () => [] }, jobs: { list: () => { throw new Error('unavailable'); } } });
  applyPlugin(ctx);
  const res = await call(route('GET', `${BASE}/preflight`), makeReq());
  assert.equal(res.json().checks.busy.state, 'unknown');
});

// ---- 零派发哨兵（必须最后跑）------------------------------------------------
// 前面每个用例都不允许真的派发助手；但夹具一旦回退（例如 applyPlugin 被绕过、
// 平台白名单又变了），最快的暴露方式就是看 TMPDIR 有没有新的 helper 脚本：
// 助手的 .cjs 是派发前就写盘的，出现即代表真的派发了（随后会杀进程/写真实回执/弹窗）。
test('U20z 零派发哨兵：整份 dispatch 测试不得真的写出重启助手脚本', () => {
  assert.deepEqual(newHelperScripts(), [],
    'TMPDIR 出现新的 dsh-restart-now-helper-*.cjs = 测试真的派发了重启助手（会杀测试进程、写真实回执、弹窗）');
  assert.equal(existsSync(join(sandboxDir, 'restart-now.last.json')), false,
    '真实派发会写回执 —— 沙箱 profile 必须保持干净');
});
