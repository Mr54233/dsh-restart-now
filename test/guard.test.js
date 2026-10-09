// test/guard.test.js —— U5/U6 围栏测试（v0.6 桌面剥头代理感知语义）
// 围栏语义：loopback 对端硬条件 + Host/Origin 存在即校验 + 缺失/转发头容忍（notes 留痕）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedRequest, inspectRequest, loopbackAuthority } from '../lib/guard.js';

function fakeReq({ remote = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: remote }, headers };
}

const TRUSTED = {
  remote: '127.0.0.1',
  headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' },
};

test('U5a 放行：完整形态 loopback + Origin==Host（http）', () => {
  assert.equal(isTrustedRequest(fakeReq(TRUSTED)), true);
});

test('U5b 放行：https Origin 与 Host 同 authority（dshmarket trustedRestartRequest 同语义）', () => {
  assert.equal(isTrustedRequest(fakeReq({
    headers: { origin: 'https://127.0.0.1:19387', host: '127.0.0.1:19387' },
  })), true);
});

test('U5c 放行：桌面剥头代理形态 Host/Origin 均缺失（v0.6 勘误，notes 记录）', () => {
  const v = inspectRequest(fakeReq({ headers: {} }));
  assert.equal(v.trusted, true);
  assert.ok(v.notes.includes('host-absent') && v.notes.includes('origin-absent'));
});

test('U5d 放行：转发头存在仅容忍并记 notes（桌面代理会加，不再一票否决）', () => {
  const v = inspectRequest(fakeReq({
    ...TRUSTED,
    headers: { ...TRUSTED.headers, 'x-forwarded-for': '10.0.0.1' },
  }));
  assert.equal(v.trusted, true);
  assert.ok(v.notes.includes('forwarded-headers'));
  assert.deepEqual(v.detail.forwarded, ['x-forwarded-for']);
});

test('U6a 拒绝：非 loopback 来源', () => {
  assert.equal(isTrustedRequest(fakeReq({ ...TRUSTED, remote: '192.168.1.5' })), false);
});

test('U6b 拒绝：Host 存在但非 loopback authority（DNS rebinding #678）', () => {
  assert.equal(isTrustedRequest(fakeReq({
    headers: { origin: 'http://evil.example:19387', host: 'evil.example:19387' },
  })), false);
});

test('U6c 拒绝：Origin 与 Host 不同 authority（跨站伪造）', () => {
  assert.equal(isTrustedRequest(fakeReq({
    headers: { host: '127.0.0.1:19387', origin: 'http://evil.example' },
  })), false);
});

test('U6d 拒绝：Origin 畸形（null / 非 http(s) scheme）', () => {
  assert.equal(isTrustedRequest(fakeReq({
    headers: { host: '127.0.0.1:19387', origin: 'null' },
  })), false);
  assert.equal(isTrustedRequest(fakeReq({
    headers: { host: '127.0.0.1:19387', origin: 'app://somewhere' },
  })), false);
});

test('U6e 拒绝：Host 缺失时 Origin 自身非 loopback authority', () => {
  assert.equal(isTrustedRequest(fakeReq({
    headers: { origin: 'http://evil.example:19387' }, // Host 被剥，Origin 露馅
  })), false);
});

test('U6 补充：::1 与 ::ffff:127.0.0.1 视为 loopback（带方括号 IPv6 authority）', () => {
  assert.equal(isTrustedRequest(fakeReq({
    remote: '::1',
    headers: { origin: 'http://[::1]:19387', host: '[::1]:19387' },
  })), true);
  assert.equal(isTrustedRequest(fakeReq({
    remote: '::ffff:127.0.0.1',
    headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' },
  })), true);
});

test('U6 补充：localhost authority 放行；localhost.evil.com 不放行（RFC 6761 边界）', () => {
  assert.equal(loopbackAuthority('localhost:19387'), true);
  assert.equal(loopbackAuthority('LOCALHOST:19387'), true);
  assert.equal(loopbackAuthority('localhost.evil.com:19387'), false);
  assert.equal(isTrustedRequest(fakeReq({
    headers: { origin: 'http://localhost:19387', host: 'localhost:19387' },
  })), true);
});
