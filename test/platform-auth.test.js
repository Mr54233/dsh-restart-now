// test/platform-auth.test.js —— 平台会话鉴权归一化（v1.2.1）
//
// 钉住的契约（改之前先读 lib/platform-auth.js 的头注释）：
//   P1 平台返回 undefined  → ok（放行）
//   P2 平台返回 401        → unauthorized（缺/过期凭据，与 403 语义必须分开）
//   P3 平台返回 403        → forbidden（来源不可信）
//   P4 其它状态码          → rejected（保留原始码，照原码回给客户端）
//   P5 配置 platformAuth:false → skipped，且绝不调用平台（逃生门）
//   P6 服务缺失 / 方法缺失 / 平台抛异常 → 一律放行（bypassed / error），插件不能整体不可用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPlatformAuth, resolveConnection, summarizeAuth } from '../lib/platform-auth.js';

const REQ = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

function ctxWith(connection) {
  return { get: (name) => (name === 'connection' ? connection : undefined) };
}

function connectionReturning(value, calls = []) {
  return {
    requestRejection: async (req) => { calls.push(req); return value; },
  };
}

test('P1 平台放行（undefined）→ ok', async () => {
  const calls = [];
  const auth = await inspectPlatformAuth(ctxWith(connectionReturning(undefined, calls)), REQ);
  assert.deepEqual(auth, { enforced: true, available: true, verdict: 'ok' });
  assert.equal(calls.length, 1, '须把原始 req 交给平台（凭据在 cookie/头里）');
  assert.equal(calls[0], REQ);
});

test('P2 平台返回 401 → unauthorized（缺/过期凭据）', async () => {
  const auth = await inspectPlatformAuth(ctxWith(connectionReturning(401)), REQ);
  assert.equal(auth.verdict, 'unauthorized');
  assert.equal(auth.status, 401);
  assert.equal(auth.enforced, true);
});

test('P3 平台返回 403 → forbidden（来源不可信），与 401 区分', async () => {
  const auth = await inspectPlatformAuth(ctxWith(connectionReturning(403)), REQ);
  assert.equal(auth.verdict, 'forbidden');
  assert.equal(auth.status, 403);
});

test('P4 其它状态码原样保留（例如反向代理的 429）', async () => {
  const auth = await inspectPlatformAuth(ctxWith(connectionReturning(429)), REQ);
  assert.equal(auth.verdict, 'rejected');
  assert.equal(auth.status, 429, '不能把未知状态码压成 401/403');
});

test('P4b 对象形态的拒绝也认（{ status } / { rejection }）', async () => {
  assert.equal((await inspectPlatformAuth(ctxWith(connectionReturning({ status: 401 })), REQ)).verdict, 'unauthorized');
  assert.equal((await inspectPlatformAuth(ctxWith(connectionReturning({ rejection: 403 })), REQ)).verdict, 'forbidden');
});

test('P5 platformAuth:false → skipped，且绝不调用平台（逃生门必须真的旁路）', async () => {
  let called = 0;
  const connection = { requestRejection: async () => { called += 1; return 401; } };
  const auth = await inspectPlatformAuth(ctxWith(connection), REQ, { enforced: false });
  assert.equal(auth.enforced, false);
  assert.equal(auth.verdict, 'skipped');
  assert.equal(auth.available, true, '即便跳过，也要回报平台方法是否存在');
  assert.equal(called, 0, '关掉鉴权时不得再打平台（否则关不掉）');
});

test('P6 服务缺失 / 方法缺失 / 抛异常 → 一律放行', async () => {
  const missing = await inspectPlatformAuth({ get: () => undefined }, REQ);
  assert.deepEqual(missing, { enforced: true, available: false, verdict: 'bypassed' });

  const noMethod = await inspectPlatformAuth(ctxWith({}), REQ);
  assert.equal(noMethod.verdict, 'bypassed');
  assert.equal(noMethod.available, false);

  const throwing = {
    requestRejection: () => { throw new Error('platform blew up'); },
  };
  const errored = await inspectPlatformAuth(ctxWith(throwing), REQ);
  assert.equal(errored.verdict, 'error');
  assert.equal(errored.available, false);
  assert.equal(errored.error, 'platform blew up', '须留错误原文（诊断用），但不得拦截');
});

test('P6b ctx.get 自己抛异常也不得外溢', async () => {
  const auth = await inspectPlatformAuth({ get: () => { throw new Error('no such service'); } }, REQ);
  assert.equal(auth.verdict, 'bypassed');
  assert.equal(resolveConnection({ get: () => { throw new Error('x'); } }), undefined);
});

test('P7 summarizeAuth：给环境口的形态固定（客户端据此显示诊断）', async () => {
  assert.deepEqual(summarizeAuth(undefined), {
    enforced: true, available: false, verdict: 'bypassed', error: '',
  });
  const auth = await inspectPlatformAuth(ctxWith(connectionReturning(401)), REQ);
  assert.deepEqual(summarizeAuth(auth), {
    enforced: true, available: true, verdict: 'unauthorized', error: '',
  });
  assert.deepEqual(summarizeAuth(null).verdict, 'bypassed', '缺失时按放行回报，绝不抛');
});
