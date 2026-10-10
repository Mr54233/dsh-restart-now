// test/environment.test.js —— U7 环境判定（v0.5 真机勘误版）
// 判定链：① desktopProfiles（第三方壳）→ ② profileContext.name==='desktop' 且非 CLI 启动（官方桌面）
//        → ③ --profile 在 argv（CLI，永远 web）→ 其余 web。
// 事实依据：app.asar v44.0.0 全文无 desktopProfiles；dshmarket index.ts:183-204（#702/#729）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEnvironment, supportedPlatform } from '../lib/environment.js';

const OFFICIAL_DESKTOP_ARGV = [
  'D:\\dsh\\DeepSeek Harness.exe',
  '--expose-internals',
  'D:\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
  'D:\\dsh\\resources\\app.asar\\dsh',
  'C:\\Users\\54\\.dsh\\profiles\\desktop',
];

test('U7a desktopProfiles 存在 → desktop（第三方壳）', () => {
  const ctx = { get: (name) => (name === 'desktopProfiles' ? { current: { name: 'x' } } : undefined) };
  assert.equal(detectEnvironment(ctx), 'desktop');
});

test('U7b 官方桌面：desktopProfiles 缺失 + profileContext{name:desktop} + 无 --profile → desktop', () => {
  const realArgv = process.argv;
  process.argv = [...OFFICIAL_DESKTOP_ARGV];
  try {
    const ctx = { get: (name) => (name === 'profileContext' ? { name: 'desktop', dir: 'C:\\Users\\54\\.dsh\\profiles\\desktop' } : undefined) };
    assert.equal(detectEnvironment(ctx), 'desktop');
  } finally {
    process.argv = realArgv;
  }
});

test('U7c 官方桌面：profileContext.name 大小写不敏感（Desktop）→ desktop', () => {
  const realArgv = process.argv;
  process.argv = [...OFFICIAL_DESKTOP_ARGV];
  try {
    const ctx = { get: (name) => (name === 'profileContext' ? { name: 'Desktop' } : undefined) };
    assert.equal(detectEnvironment(ctx), 'desktop');
  } finally {
    process.argv = realArgv;
  }
});

test('U7d 全缺失 → web（纯 web 宿主）', () => {
  const ctx = { get: () => undefined };
  assert.equal(detectEnvironment(ctx), 'web');
});

test('U7e CLI 启动 `dsh --profile desktop`：有 profileContext 但 argv 含 --profile → web（杀终端属误伤，拒绝）', () => {
  const realArgv = process.argv;
  process.argv = ['C:\\nvm4w\\nodejs\\node.exe', 'D:\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd', '--profile', 'desktop'];
  try {
    const ctx = { get: (name) => (name === 'profileContext' ? { name: 'desktop' } : undefined) };
    assert.equal(detectEnvironment(ctx), 'web');
  } finally {
    process.argv = realArgv;
  }
});

test('U7f M4 测试宿主：cli.js --profile web + profileContext{name:web} → web', () => {
  const realArgv = process.argv;
  process.argv = ['D:\\dsh\\DeepSeek Harness.exe', '--expose-internals', 'D:\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js', '--profile', 'web', '--port', '0'];
  try {
    const ctx = { get: (name) => (name === 'profileContext' ? { name: 'web' } : undefined) };
    assert.equal(detectEnvironment(ctx), 'web');
  } finally {
    process.argv = realArgv;
  }
});

test('U7g 异常形状：全 null/非对象 ctx → web；desktopProfiles 为垃圾字符串 → desktop（marker 存在即第三方壳）', () => {
  const realArgv = process.argv;
  process.argv = [...OFFICIAL_DESKTOP_ARGV];
  try {
    // 两个服务都返回 null（cordis 不应出现，但防御）→ 双双跳过 → web
    assert.equal(detectEnvironment({ get: () => null }), 'web');
    // desktopProfiles 缺失，profileContext 是垃圾非对象 → ② 的 typeof 挡住 → web
    assert.equal(detectEnvironment({ get: (n) => (n === 'desktopProfiles' ? undefined : 'garbage') }), 'web');
    // ctx 都不是（防御）→ web
    assert.equal(detectEnvironment(undefined), 'web');
    assert.equal(detectEnvironment({}), 'web');
    // desktopProfiles 返回垃圾字符串 = marker 存在 → 第三方壳 → desktop（设计行为）
    assert.equal(detectEnvironment({ get: () => 'garbage' }), 'desktop');
  } finally {
    process.argv = realArgv;
  }
});

test('U7h supportedPlatform 矩阵：win32 → true；darwin/linux → false（v1.0.2 适用范围）', () => {
  assert.equal(supportedPlatform('win32'), true);
  assert.equal(supportedPlatform('darwin'), false);
  assert.equal(supportedPlatform('linux'), false);
  assert.equal(supportedPlatform(''), false);
  // undefined 触发默认参 → process.platform（JS 默认参语义），本机 Windows 即 true
  assert.equal(supportedPlatform(undefined), process.platform === 'win32');
  // 本仓库只在 Windows 上开发/测试，宿主真机断言当前平台可用
  assert.equal(supportedPlatform(), process.platform === 'win32');
});
