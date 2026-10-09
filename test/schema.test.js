// test/schema.test.js —— Config 导出冒烟（v0.6 新增）
// 断言：schema.js 在本机任一解析链命中时导出 schemastery schema（函数形态），
// 全部失败时导出 undefined 且绝不抛异常（可选依赖契约）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Config } from '../lib/schema.js';

test('U10 Config 导出：undefined 或 schemastery schema（函数），绝不抛异常', () => {
  assert.ok(Config === undefined || typeof Config === 'function',
    `Config 应为 undefined 或 schemastery schema（函数），实际：${typeof Config}`);
});

test('U10 补充：本机（DSH_HOME/DSH_PROFILE 或默认位置存在 schemastery）应命中解析链', () => {
  // 本机部署形态下 profile node_modules 必有 @deepseek-ai/schemastery；
  // 若此断言失败说明解析链退化，设置页将无配置表单（真机勘误 v0.6 的回归哨兵）
  const home = process.env.DSH_HOME;
  const profile = process.env.DSH_PROFILE || 'desktop';
  const hasProfileSchemastery = home
    ? existsSync(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'schemastery'))
    : false;
  if (hasProfileSchemastery) {
    assert.equal(typeof Config, 'function', 'profile 里有 schemastery 时 Config 必须解析成功');
  }
});
