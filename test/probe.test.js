// U15：探测口回传生效配置（v0.21）。
// 回归背景：此前探测口只回 {ok, environment}，客户端 liveCfg 只能靠设置表单
// GET /config 填充——用户不开设置页时 footer 用 patch 默认值，已关闭的二次确认
// 在每次重启后「复活」。修复后探测口一次回传 environment+config+derivedExe。
// 本测试用 fake ctx/host 直接调 apply()，不需要真实 DSH 宿主。
import test from 'node:test';
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
  handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.environment, 'web');
  assert.equal(body.platform, process.platform, 'v1.0.2 起探测口回传平台（客户端据此在非 win32 零挂载）');
  assert.equal(body.config.confirm, false, 'patch 层配置进入生效配置');
  assert.equal(typeof body.config.allowRestart, 'boolean');
  assert.equal(typeof body.config.delayMs, 'number');
  assert.ok('exePath' in body.config);
  assert.ok('hideSidebarButton' in body.config);
  assert.equal(typeof body.derivedExe, 'string');
  assert.ok(body.derivedExe.length > 0, 'derivedExe 非空（resolveExe 总有输出）');
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
