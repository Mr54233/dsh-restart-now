// test/receipt.test.js —— v1.1 重启回执（上一次重启的结果，下次挂载时展示）
//
// 为什么要这个文件：重启会把界面连同会话一起打断，用户回来后无从判断「刚才是重启成功了，
// 还是我自己误触/崩溃了」。回执由宿主在派发前写「开始」段、助手在拉起后补「完成」段
// （或写 failed 段），完全依赖硬盘上的一个 json —— 损坏绝不能影响任何流程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECEIPT_FILE, beginReceipt, failReceipt, readReceipt, receiptPath, summarizeReceipt, writeReceipt,
} from '../lib/receipt.js';

const NOW = Date.parse('2026-10-22T08:00:00.000Z');

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'dsrn-receipt-'));
}

test('U19a receiptPath：profile 目录 + 固定文件名；无目录返回空串', () => {
  assert.equal(receiptPath('D:\\p'), join('D:\\p', RECEIPT_FILE));
  assert.equal(RECEIPT_FILE, 'restart-now.last.json');
  assert.equal(receiptPath(''), '');
});

test('U19b beginReceipt：派发前写「开始」段（含 host/main pid 与时间）', () => {
  const dir = tmpDir();
  try {
    const written = beginReceipt(dir, { stamp: 'S1', hostPid: 111, mainPid: 222, now: NOW });
    assert.equal(written.at, new Date(NOW).toISOString());
    assert.equal(written.atMs, NOW);
    assert.equal(written.hostPid, 111);
    assert.equal(written.mainPid, 222);
    // 覆盖上一次结果：先写一个成功的旧回执，再 begin 必须清掉 respawnedAt
    writeReceipt(dir, { at: 'old', respawnedAt: 'x', downtimeMs: 9999 });
    beginReceipt(dir, { stamp: 'S2', hostPid: 333, mainPid: 444, now: NOW });
    const after = readReceipt(dir);
    assert.equal(after.stamp, 'S2');
    assert.equal(after.respawnedAt, undefined, '新一次重启开始后旧结果必须失效');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('U19c readReceipt：缺失 / 损坏 / 非对象一律 null，绝不抛', () => {
  const dir = tmpDir();
  try {
    assert.equal(readReceipt(dir), null, '文件缺失');
    writeFileSync(receiptPath(dir), '{ not json');
    assert.equal(readReceipt(dir), null, '损坏内容');
    writeFileSync(receiptPath(dir), '"just a string"');
    assert.equal(readReceipt(dir), null, '非对象');
    assert.equal(readReceipt(''), null, '无目录');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('U19d summarizeReceipt：成功 → status ok 且带停机时长', () => {
  const summary = summarizeReceipt({
    at: new Date(NOW).toISOString(), atMs: NOW, hostPid: 111, respawnedAt: 'x', downtimeMs: 8300, newPid: 555,
  }, NOW + 60_000);
  assert.equal(summary.status, 'ok');
  assert.equal(summary.downtimeMs, 8300);
  assert.equal(summary.newPid, 555);
  assert.equal(summary.ageMs, 60_000);
});

test('U19e summarizeReceipt：失败 → status failed 且带原因（助手拉起失败）', () => {
  const summary = summarizeReceipt({
    at: new Date(NOW).toISOString(), atMs: NOW,
    failed: { at: 'x', reason: 'respawn-failed', detail: 'exited within 2500ms' },
  }, NOW + 1000);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.reason, 'respawn-failed');
  assert.equal(summary.detail, 'exited within 2500ms');
});

test('U19f summarizeReceipt：派发后没有任何结论 → unconfirmed（区别于 failed）', () => {
  const summary = summarizeReceipt({ at: new Date(NOW).toISOString(), atMs: NOW, hostPid: 111 }, NOW + 1000);
  assert.equal(summary.status, 'unconfirmed');
  assert.equal(summarizeReceipt(null).status, 'none');
  assert.equal(summarizeReceipt({}).status, 'unconfirmed', '空对象也算「有记录但无结论」');
});

test('U19g failReceipt：保留 begin 段，追加 failed 段（助手写盘路径）', () => {
  const dir = tmpDir();
  try {
    beginReceipt(dir, { stamp: 'S1', hostPid: 111, mainPid: 222, now: NOW });
    failReceipt(dir, { at: 'later', reason: 'respawn-failed' });
    const after = readReceipt(dir);
    assert.equal(after.hostPid, 111, 'begin 段保留');
    assert.equal(after.failed.reason, 'respawn-failed');
    assert.ok(existsSync(receiptPath(dir)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('U19h writeReceipt：写入失败静默返回 false（回执只是体验增强，绝不影响重启）', () => {
  const ok = writeReceipt('D:\\p', { a: 1 }, { writeFile: () => { throw new Error('EACCES'); } });
  assert.equal(ok, false);
  assert.equal(writeReceipt('', { a: 1 }), false, '无目录不写');
});
