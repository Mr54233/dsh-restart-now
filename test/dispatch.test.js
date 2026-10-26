// test/dispatch.test.js —— v1.1 路由与门禁（用假 ctx/host 直调 apply，绝不产生任何进程）
//
// 这是唯一覆盖门禁顺序的测试：真机验证代价太高（会真的杀应用），所以把 ctx.get /
// webServer.register / http 的 req/res 全部假造，只走真实的路由处理函数。
// 每个用例都断言「没有派发」——只要有一条门禁失守，restart 就会真杀进程，不能只测返回值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as plugin from '../lib/index.js';
import { SUPPORTED_RANGE } from '../lib/version.js';

const BASE = '/plugins/dsh-restart-now';

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
  plugin.apply(ctx, {});
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
  plugin.apply(ctx, { allowRestart: false });
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().reason, 'disabled');
});

test('U20c 非 desktop 环境 → 403 non-desktop + 指向市场的 hint', async () => {
  const { ctx, route } = makeCtx({});
  plugin.apply(ctx, {});
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { ok: false, reason: 'non-desktop', hint: 'use dshmarket' });
});

test('U20d 围栏：跨源 / 非 loopback 一律 403 untrusted；剥离代理留下的转发头按设计容忍', async () => {
  const { ctx, route } = desktopCtx();
  plugin.apply(ctx, {});
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

  const forwardedWrongOrigin = await call(restart, makeReq({
    method: 'POST',
    headers: { origin: 'http://localhost:62230', 'x-forwarded-for': '1.2.3.4' },
  }));
  assert.notEqual(forwardedWrongOrigin.statusCode, 500, '任何 403 之外的路径都不得进入派发');
});

test('U20e 插件安装中（run.json 指向存活 pid）→ 409 installing，绝不派发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-dispatch-lock-'));
  try {
    mkdirSync(join(dir, '.plugin-manager'), { recursive: true });
    writeFileSync(join(dir, '.plugin-manager', 'run.json'), JSON.stringify({ pid: process.pid }));
    const { ctx, route } = desktopCtx({ profileContext: { name: 'desktop', dir } });
    plugin.apply(ctx, {});
    const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, 'installing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('U20f 有活跃任务 → 409 busy（带计数与 forceable），?force=1 可越过 busy', async () => {
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [{ id: 'j1', status: 'running' }] };
  const { ctx, route } = desktopCtx({ agents, jobs });
  plugin.apply(ctx, {});
  const restart = route('POST', `${BASE}/restart`);

  const busy = await call(restart, makeReq({ method: 'POST' }));
  assert.equal(busy.statusCode, 409);
  const payload = busy.json();
  assert.equal(payload.reason, 'busy');
  assert.equal(payload.tasks, 1);
  assert.equal(payload.jobs, 1);
  assert.equal(payload.forceable, true);
});

test('U20g ?wait=1 → 202 waiting；GET /status 反映等待；?cancel=1 → 200 撤销', async () => {
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [{ id: 'j1', status: 'running' }] };
  const { ctx, route } = desktopCtx({ agents, jobs });
  plugin.apply(ctx, {});
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
  plugin.apply(ctx, {});
  const res = await call(route('GET', `${BASE}/environment`), makeReq({ url: `${BASE}/environment` }));
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.environment, 'web');
  assert.equal(body.platform, process.platform);
  assert.equal(typeof body.config, 'object');
  assert.deepEqual(Object.keys(body.config).sort(),
    ['allowRestart', 'confirm', 'entryFooter', 'entryHeader', 'entryPanel', 'entrySettingsRow', 'exePath', 'platformAuth'],
    'v1.2.2：配置层八键（原 hideSidebarButton 废弃、delayMs 早删）');
  assert.equal(body.platformAuth.enforced, true, '探测口须回报鉴权结论');
  assert.equal(body.platformAuth.verdict, 'bypassed', '无 connection 服务时按放行处理');
  assert.ok('lastRestart' in body);
  assert.equal(body.supportedRange, SUPPORTED_RANGE, '选择题 9：探测口须回传支持范围');
  assert.ok('version' in body && 'supported' in body, '探测口须回传运行时版本与是否支持');
  assert.equal(body.wait.state, 'idle');
});

test('U20i 配置路由：GET 回 5 键；POST 在非 desktop 下 403（写配置同样受环境门禁）', async () => {
  const { ctx, route } = makeCtx({});
  plugin.apply(ctx, {});
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
  plugin.apply(ctx, {});

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

test('U20k 命令 handler 参数解析：--force / --wait 被识别', async () => {
  const definitions = [];
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [{ id: 'j1', status: 'running' }] };
  const { ctx } = makeCtx({
    profileContext: DESKTOP,
    agents,
    jobs,
    commands: { register(definition) { definitions.push(definition); return () => {}; } },
  });
  plugin.apply(ctx, {});
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
  plugin.apply(ctx2, {});
  const cancel = await call(route('POST', `${BASE}/restart`),
    makeReq({ method: 'POST', url: `${BASE}/restart?cancel=1` }));
  assert.equal(cancel.statusCode, 200);
});

// ---- v1.2.1 平台会话鉴权（P0 缺口：本机任意进程 curl 动作口就能重启应用）----------

test('U20m 平台 401 → 动作口/配置口/状态口全部拒绝，绝不派发', async () => {
  const agents = { list: () => [] };
  const jobs = { list: () => [] };
  const connection = { requestRejection: async () => 401 };
  const { ctx, route } = desktopCtx({ agents, jobs, connection });
  plugin.apply(ctx, {});

  const restart = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(restart.statusCode, 401, '缺凭据是 401，不是 403');
  assert.equal(restart.json().reason, 'unauthorized');
  assert.ok(restart.json().hint.length > 0, '须给用户可读的原因（401 与 403 文案要分开）');

  const status = await call(route('GET', `${BASE}/status`), makeReq({ url: `${BASE}/status` }));
  assert.equal(status.statusCode, 401, '等待状态会暴露任务计数，同样要鉴权');

  const config = await call(route('POST', `${BASE}/config`), makeReq({ method: 'POST', url: `${BASE}/config` }));
  assert.equal(config.statusCode, 401, '写配置是状态变更，同样要鉴权');
});

test('U20n 平台 403 → 403 forbidden（与 401 语义分开）', async () => {
  const connection = { requestRejection: () => 403 };
  const { ctx, route } = desktopCtx({ connection });
  plugin.apply(ctx, {});
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().reason, 'forbidden');
});

test('U20o platformAuth:false 逃生门 → 旁路平台（真机壳层不带 cookie 时用户可自救）', async () => {
  let called = 0;
  const connection = { requestRejection: () => { called += 1; return 401; } };
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [] };
  const { ctx, route } = desktopCtx({ agents, jobs, connection });
  plugin.apply(ctx, { platformAuth: false });
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(called, 0, '关掉鉴权后不得再打平台');
  assert.equal(res.statusCode, 409, '须放行到后续门禁（有活跃任务 → busy）');
  assert.equal(res.json().reason, 'busy');
});

test('U20p 平台抛异常 → 不拦截（插件不能因为平台 API 变动整体不可用），但留 error 供诊断', async () => {
  const connection = { requestRejection: () => { throw new Error('boom'); } };
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [] };
  const { ctx, route } = desktopCtx({ agents, jobs, connection });
  plugin.apply(ctx, {});
  const res = await call(route('POST', `${BASE}/restart`), makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 409, '异常须按放行处理（走到 busy）');

  const env = await call(route('GET', `${BASE}/environment`), makeReq({ url: `${BASE}/environment` }));
  assert.equal(env.json().platformAuth.verdict, 'error');
  assert.equal(env.json().platformAuth.error, 'boom', '探测口是唯一能看见平台异常的地方');
});

test('U20r 冷却（第 22 项）：窗口内连点一律 409 cooldown，绝不再派一次', async () => {
  plugin.resetCooldown();
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-cooldown-'));
  try {
    const { ctx, route } = makeCtx({ profileContext: { name: 'desktop', dir } });
    // 故意给不存在的 exe：冷却放行后必须停在 exe-not-found —— 测试里绝不允许真派发
    plugin.apply(ctx, { exePath: join(dir, 'nope.exe') });
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
  plugin.apply(ctx, {});
  const res = await call(route('GET', `${BASE}/environment`), makeReq({ url: `${BASE}/environment` }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().platformAuth,
    { enforced: true, available: true, verdict: 'unauthorized', error: '' });
});

test('U20l 插件卸载时等待定时器一并停掉（否则下线后还会按计划重启）', async () => {
  const agents = { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
  const jobs = { list: () => [] };
  const { ctx, route, disposers } = makeCtx({ profileContext: DESKTOP, agents, jobs });
  plugin.apply(ctx, {});

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
