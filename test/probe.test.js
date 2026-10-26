// U15：探测口回传生效配置（v0.21）。
// 回归背景：此前探测口只回 {ok, environment}，客户端 liveCfg 只能靠设置表单
// GET /config 填充——用户不开设置页时 footer 用 patch 默认值，已关闭的二次确认
// 在每次重启后「复活」。修复后探测口一次回传 environment+config+derivedExe。
// 本测试用 fake ctx/host 直接调 apply()，不需要真实 DSH 宿主。
import test from 'node:test';
import { SUPPORTED_RANGE } from '../lib/version.js';
import assert from 'node:assert/strict';

function makeHost() {
  const routes = new Map();
  return {
    routes,
    effect(fn) { fn(); },
    webServer: {
      register(def) { routes.set(def.path, def.handler); return () => routes.delete(def.path); },
    },
  };
}

// desktopProfiles / profileContext 均缺失 → detectEnvironment 判定 web
function makeCtx(host) {
  return {
    get() { return undefined; },
    inject(_deps, fn) { fn(host); },
  };
}

function fakeRes() {
  const r = {
    statusCode: 0, headers: null, body: '', ended: false,
    writeHead(code, headers) { r.statusCode = code; r.headers = headers; },
    end(chunk) { r.ended = true; if (chunk) r.body += chunk; },
  };
  return r;
}

test('U15a: 探测口回传 environment + 生效配置（patch 值可见）+ derivedExe', async () => {
  const { apply } = await import('../lib/index.js');
  const host = makeHost();
  apply(makeCtx(host), { confirm: false });
  const handler = host.routes.get('/plugins/dsh-restart-now/environment');
  assert.ok(handler, '探测路由已注册');
  const res = fakeRes();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.environment, 'web');
  assert.equal(body.platform, process.platform, 'v1.0.2 起探测口回传平台（客户端据此在非 win32 零挂载）');
  assert.equal(body.config.confirm, false, 'patch 层配置进入生效配置');
  assert.equal(typeof body.config.allowRestart, 'boolean');
  assert.ok(!('delayMs' in body.config), 'v1.1 删掉 delayMs（用户：不给反悔机会，尽可能快）');
  assert.ok('exePath' in body.config);
  assert.equal('hideSidebarButton' in body.config, false, 'v1.2.2：旧键不再出现在生效配置里');
  assert.equal(body.config.entryFooter, true, 'v1.2.2：入口开关进配置层（默认全开）');
  assert.equal(body.config.entryPanel, true);
  assert.equal(body.config.platformAuth, true, 'v1.2.1 平台鉴权默认强制');
  assert.equal(body.platformAuth.enforced, true, '探测口须回报鉴权是否强制');
  assert.equal(body.platformAuth.available, false, '无 connection 服务 → 不可用（按放行处理）');
  assert.equal(body.platformAuth.verdict, 'bypassed');
  assert.equal(typeof body.configFile, 'string', 'v1.2.1 回报配置文件名（逃生门要手改它）');
  assert.equal(typeof body.derivedExe, 'string');
  assert.ok(body.derivedExe.length > 0, 'derivedExe 非空（resolveExe 总有输出）');
  // v1.1 新增：版本判定 + 上次重启回执 + 等待模式快照
  assert.equal(body.supportedRange, SUPPORTED_RANGE);
  assert.ok('version' in body && 'supported' in body);
  assert.ok('lastRestart' in body && typeof body.lastRestart === 'object');
  assert.equal(body.wait.state, 'idle');
});

test('U15b: 探测口方法白名单 GET（POST → 405）', async () => {
  const { apply } = await import('../lib/index.js');
  const host = makeHost();
  apply(makeCtx(host), {});
  const handler = host.routes.get('/plugins/dsh-restart-now/environment');
  const res = fakeRes();
  handler({ method: 'POST' }, res);
  assert.equal(res.statusCode, 405);
});

// —— v1.2.2（issue #1）：迁移判据必须由宿主回报，客户端不能自己看 config ——
// 真 bug：探测口回的是 effectiveConfig()，它必然叠加 DEFAULTS 的四个 entry 键，
// 客户端若用「config 里有没有 entry 键」当迁移判据会恒为真 → 老用户的 localStorage
// 旧值永远迁不进配置文件（本地单测当时直接喂裸配置，绕过了服务端合并，所以没抓到）。
// 下面两条钉住服务端的 entriesDeclared 语义：只认「配置文件 / patch 里写没写过」。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function probeWithEnv(envDir) {
  const { apply } = await import('../lib/index.js');
  const host = makeHost();
  apply(makeCtx(host), {});
  const handler = host.routes.get('/plugins/dsh-restart-now/environment');
  const prev = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = envDir;
  try {
    const res = fakeRes();
    await handler({ method: 'GET' }, res);
    return JSON.parse(res.body);
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = prev;
  }
}

test('U15c: 配置文件没写过 entry 键 → entriesDeclared:false（config 里仍然全是默认 true）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-probe-'));
  try {
    writeFileSync(join(dir, 'restart-now.config.json'),
      JSON.stringify({ confirm: false, exePath: '', platformAuth: true }) + '\n');
    const body = await probeWithEnv(dir);
    assert.equal(body.entriesDeclared, false,
      '配置文件没写过 entry 键就必须回报 false，否则一次性迁移永不触发');
    // 这正是那个坑：生效配置把 DEFAULTS 叠上来了，客户端看 config 会以为「已表态」
    assert.equal(body.config.entryFooter, true, '生效配置含默认值（所以不能拿它当判据）');
    assert.equal(body.config.confirm, false, '文件层其它键照常生效');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('U15d: 配置文件写过任一 entry 键（或旧键）→ entriesDeclared:true，迁移永不重跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrn-probe-'));
  try {
    const file = join(dir, 'restart-now.config.json');
    writeFileSync(file, JSON.stringify({ entryHeader: false }) + '\n');
    assert.equal((await probeWithEnv(dir)).entriesDeclared, true, '写了新键 → 已表态');

    // 旧键 hideSidebarButton 也算表过态：否则老用户配置会被迁移逻辑翻盘
    writeFileSync(file, JSON.stringify({ hideSidebarButton: true }) + '\n');
    const body = await probeWithEnv(dir);
    assert.equal(body.entriesDeclared, true, '旧键 hideSidebarButton 同样算已表态');
    assert.equal(body.config.entryFooter, false, '旧键读时映射成 entryFooter:false');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
