// U14 系列（v0.20）：pruneRestartArtifacts —— %TEMP% 运行时残留自动清理（保留最近 N 次）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneRestartArtifacts } from '../lib/helper-src.js';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-prune-test-'));
}

/** 写一组某次重启的三个运行时文件，返回文件名列表 */
function writeStampSet(dir, stamp) {
  const names = [
    `dsh-restart-now-helper-${stamp}.cjs`,
    `dsh-restart-now-dispatch-${stamp}.vbs`,
    `dsh-restart-now-${stamp}.err.log`,
  ];
  for (const n of names) writeFileSync(join(dir, n), 'x');
  return names;
}

test('U14a: 12 组只留最近 10 组，按时间戳分组删除（组内三个文件同进退）', () => {
  const dir = makeDir();
  const stamps = [];
  for (let d = 1; d <= 12; d++) {
    // 2026-10-01T00:00:01 … 递增秒，字典序=时间序
    const stamp = `2026-10-01T00-00-${String(d).padStart(2, '0')}`;
    stamps.push(stamp);
    writeStampSet(dir, stamp);
  }
  const r = pruneRestartArtifacts(dir, 10);
  assert.deepEqual(r, { removed: 6, kept: 10 }); // 2 组 × 3 文件
  const left = readdirSync(dir);
  assert.equal(left.length, 30);
  assert.ok(!left.some((n) => n.includes(stamps[0])), '最早一组应被删');
  assert.ok(!left.some((n) => n.includes(stamps[1])), '第 2 早的组应被删');
  assert.ok(left.some((n) => n.includes(stamps[2])), '第 3 早的组（保留区最早）应在');
  assert.ok(left.some((n) => n.includes(stamps[11])), '最新一组应保留');
  rmSync(dir, { recursive: true, force: true });
});

test('U14b: 只匹配本插件前缀 + 时间戳形态，别的临时文件（含 debug.log）绝不碰', () => {
  const dir = makeDir();
  writeStampSet(dir, '2026-10-01T00-00-01');
  writeStampSet(dir, '2026-10-01T00-00-02');
  writeStampSet(dir, '2026-10-01T00-00-03');
  const innocents = [
    'dsh-restart-now-debug.log',            // 追加型日志，无时间戳，不走清理
    'dsh-restart-now-random.txt',           // 本插件但非运行时产物形态
    'dsh-market-restart-x.out.log',         // 别的插件/工具
    'node.exe',                             // 完全无关
    'dsh-restart-now-helper-bad.cjs',       // 无时间戳段
    'dsh-restart-now-2026-10-01T00-00-99.cjs.tmp', // 后缀不符
  ];
  for (const n of innocents) writeFileSync(join(dir, n), 'keep-me');
  const r = pruneRestartArtifacts(dir, 2);
  assert.equal(r.removed, 3); // 只删最早一组的 3 个文件
  for (const n of innocents) {
    assert.equal(readFileSync(join(dir, n), 'utf8'), 'keep-me', `${n} 不应被动`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('U14c: 目录不存在 / 空目录 → 零删除不抛错', () => {
  assert.deepEqual(pruneRestartArtifacts(join(tmpdir(), 'dsh-prune-no-such-dir-xyz'), 10),
    { removed: 0, kept: 0 });
  const empty = makeDir();
  assert.deepEqual(pruneRestartArtifacts(empty, 10), { removed: 0, kept: 0 });
  rmSync(empty, { recursive: true, force: true });
});

test('U14d: keep=0 清空全部；keep 超过组数时一个不删', () => {
  const dir = makeDir();
  writeStampSet(dir, '2026-10-01T00-00-01');
  writeStampSet(dir, '2026-10-01T00-00-02');
  let r = pruneRestartArtifacts(dir, 5);
  assert.deepEqual(r, { removed: 0, kept: 2 });
  r = pruneRestartArtifacts(dir, 0);
  assert.deepEqual(r, { removed: 6, kept: 0 });
  assert.equal(readdirSync(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('U14e: 真实 %TEMP% 冒烟——不抛错且返回形状正确（不动真文件内容断言，只验证可运行）', () => {
  const r = pruneRestartArtifacts(tmpdir(), 10);
  assert.equal(typeof r.removed, 'number');
  assert.equal(typeof r.kept, 'number');
});
