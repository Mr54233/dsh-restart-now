// test/version.test.js —— v1.1 版本探测与兼容判定
//
// 用户原话：「我更新了一下都不知道要支持什么版本了」——所以这里钉三件事：
//   1) package.json 的 engines.dsh 必须等于 SUPPORTED_RANGE（单测强同步，防止声明漂移）
//   2) 范围判定与 semver 常见写法等价（>=、^、~、精确、空格 AND、`||` OR）
//   3) 版本探测优先读 app.asar/package.json（DSH 不用环境变量暴露版本）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_RANGE, compareVersions, detectDshVersion, inspectVersion, parseVersion, satisfiesRange,
} from '../lib/version.js';

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));

test('U18a package.json engines.dsh 与 SUPPORTED_RANGE 强同步', () => {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.engines.dsh, SUPPORTED_RANGE,
    'engines.dsh 是安装期硬闸（官方 unmetRequirements 读它），必须与运行时判定同源');
  assert.equal(pkg.os[0], 'win32');
});

test('U18b parseVersion：接受 x.y.z / 预发布 / v 前缀，拒绝垃圾', () => {
  assert.deepEqual(parseVersion('0.2.1-rc.2'), { major: 0, minor: 2, patch: 1, pre: ['rc', '2'] });
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion('1.2.3+build.9'), { major: 1, minor: 2, patch: 3, pre: [] });
  for (const bad of ['', '1.2', 'x.y.z', '1.2.3.4', null, undefined, 42]) {
    assert.equal(parseVersion(bad), null, `${String(bad)} 应被拒绝`);
  }
});

test('U18c compareVersions：正式版 > 预发布，数字段按数值比', () => {
  const cmp = (a, b) => compareVersions(parseVersion(a), parseVersion(b));
  assert.equal(cmp('0.2.1', '0.2.1'), 0);
  assert.equal(cmp('0.2.2', '0.2.1'), 1);
  assert.equal(cmp('0.10.0', '0.9.9'), 1, '数值比较不是字典序');
  assert.equal(cmp('1.0.0', '1.0.0-rc.1'), 1, '正式版大于预发布');
  assert.equal(cmp('1.0.0-rc.10', '1.0.0-rc.9'), 1, '预发布数字段按数值');
});

test('U18d satisfiesRange：>= / > / <= / < / 精确 / ^ / ~ / 空格 AND / || OR', () => {
  assert.equal(satisfiesRange('0.2.1-rc.2', '>=0.2.0'), true, '预发布也满足 >= 下界（includePrerelease 语义）');
  assert.equal(satisfiesRange('0.2.1', '>=0.2.0'), true);
  assert.equal(satisfiesRange('0.1.9', '>=0.2.0'), false);
  assert.equal(satisfiesRange('0.2.0', '>0.2.0'), false);
  assert.equal(satisfiesRange('0.2.1', '>0.2.0'), true);
  assert.equal(satisfiesRange('0.2.1', '<=0.2.1'), true);
  assert.equal(satisfiesRange('0.2.2', '<0.2.2'), false);
  assert.equal(satisfiesRange('0.2.1', '0.2.1'), true);
  assert.equal(satisfiesRange('0.2.1', '=0.2.1'), true);
  assert.equal(satisfiesRange('0.3.0', '^0.2.0'), false, '^0.2.0 上界 0.3.0（不含）');
  assert.equal(satisfiesRange('0.2.9', '^0.2.0'), true);
  assert.equal(satisfiesRange('1.9.0', '^1.2.0'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.2.0'), false);
  assert.equal(satisfiesRange('0.2.5', '~0.2.0'), true);
  assert.equal(satisfiesRange('0.3.0', '~0.2.0'), false);
  assert.equal(satisfiesRange('0.2.5', '>=0.2.0 <0.3.0'), true, '空格 = AND');
  assert.equal(satisfiesRange('0.3.1', '>=0.2.0 <0.3.0'), false);
  assert.equal(satisfiesRange('0.3.1', '>=0.3.0 <0.4.0 || >=0.2.0 <0.3.0'), true, '|| = OR');
  assert.equal(satisfiesRange('0.2.1', '*'), true);
  assert.equal(satisfiesRange('0.2.1', ''), true);
  assert.equal(satisfiesRange('garbage', '>=0.2.0'), false, '非法版本一律不满足');
});

test('U18e detectDshVersion：读 app.asar/package.json，失败回退下一个候选', () => {
  const readFile = (path) => {
    if (path.endsWith('app.asar\\package.json')) return JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.2' });
    throw new Error('ENOENT');
  };
  const found = detectDshVersion({ resourcesPath: 'D:\\dsh\\resources', readFile });
  assert.equal(found.version, '0.2.1-rc.2');
  assert.equal(found.name, '@deepseek-ai/dsh-desktop');

  const fallback = detectDshVersion({
    resourcesPath: 'D:\\dsh\\resources',
    readFile: (path) => {
      if (path.endsWith('app\\package.json')) return JSON.stringify({ version: '0.3.0' });
      throw new Error('ENOENT');
    },
  });
  assert.equal(fallback.version, '0.3.0', 'app.asar 缺失时回退 resources/app');

  const none = detectDshVersion({ resourcesPath: '', readFile: () => { throw new Error('x'); } });
  assert.deepEqual(none, { version: null, source: null, name: '' });

  const broken = detectDshVersion({ resourcesPath: 'D:\\r', readFile: () => '{ not json' });
  assert.equal(broken.version, null, '损坏的 manifest 不得抛异常');
});

test('U18f inspectVersion：组合探测结果（软件不支持的版本给出 supported:false）', () => {
  const ok = inspectVersion({ resourcesPath: 'D:\\r', readFile: () => JSON.stringify({ version: '0.2.1-rc.2' }) });
  assert.deepEqual(ok, { version: '0.2.1-rc.2', supportedRange: SUPPORTED_RANGE, supported: true });

  const old = inspectVersion({ resourcesPath: 'D:\\r', readFile: () => JSON.stringify({ version: '0.1.9' }) });
  assert.equal(old.supported, false);

  const unknown = inspectVersion({ resourcesPath: '', readFile: () => { throw new Error('x'); } });
  assert.equal(unknown.supported, null, '探测不到版本时既不声称支持也不声称不支持');
});
