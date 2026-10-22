// test/cooldown.test.js —— 重启冷却（v1.2.1 第 22 项）
//
// 纯函数，不碰进程也不碰文件：冷却判据只由「上一次时间戳 + 当前时间」决定，
// 这样才好在测试里摆布时间（真机等 5 秒太慢，也测不出边界）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COOLDOWN_MS, cooldownRemaining, receiptStartAt } from '../lib/cooldown.js';

test('U22a 冷却窗口：窗口内剩余递减，窗口外放行', () => {
  const now = 1_800_000_000_000;
  assert.equal(COOLDOWN_MS, 5000, '默认窗口 5 秒（够挡连点，又不至于让人等）');

  assert.equal(cooldownRemaining(now, now), COOLDOWN_MS, '刚派发 → 满窗口');
  assert.equal(cooldownRemaining(now - 1000, now), 4000);
  assert.equal(cooldownRemaining(now - 4999, now), 1);
  assert.equal(cooldownRemaining(now - 5000, now), 0, '边界正好到点即放行');
  assert.equal(cooldownRemaining(now - 60000, now), 0);
});

test('U22b 冷却是「放过」而不是「锁死」：时间戳缺失/非法/时钟回拨一律放行', () => {
  const now = 1_800_000_000_000;
  for (const bad of [0, -1, Number.NaN, Infinity, -Infinity, null, undefined, 'x']) {
    assert.equal(cooldownRemaining(bad, now), 0, `不该因为 ${String(bad)} 拦住重启`);
  }
  assert.equal(cooldownRemaining(now + 60000, now), 0, '时钟回拨（lastAt 在未来）不拦');
  assert.equal(cooldownRemaining(now - 100, now, 0), 0, '窗口为 0 等于不冷却');
});

test('U22c 窗口可配（测试/调优不必改常量）', () => {
  const now = 1_800_000_000_000;
  assert.equal(cooldownRemaining(now - 100, now, 200), 100);
  assert.equal(cooldownRemaining(now - 100, now, 50), 0);
});

test('U22d receiptStartAt：从回执里取「上次重启开始时间」，取不到就是 0', () => {
  assert.equal(receiptStartAt({ atMs: 1234 }), 1234);
  assert.equal(receiptStartAt({ atMs: '1234' }), 1234, '字符串数字也认');
  assert.equal(receiptStartAt({}), 0);
  assert.equal(receiptStartAt(null), 0);
  assert.equal(receiptStartAt({ atMs: -5 }), 0);
  assert.equal(receiptStartAt({ atMs: Number.NaN }), 0);
});
