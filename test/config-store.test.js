// test/config-store.test.js —— U12 系列：配置持久层（v0.8 自绘表单底层）。
// 覆盖：DEFAULTS / resolveConfigFile / clampConfig / loadFileConfig / saveFileConfig / effectiveConfig。
// 全部用临时目录真实读写（node:fs.mkdtempSync），无副作用残留。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULTS, resolveConfigFile, clampConfig, loadFileConfig, saveFileConfig, effectiveConfig,
} from '../lib/config-store.js';

let dir = '';

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-restart-now-u12-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('U12a DEFAULTS 冻结且五键正确（v1.1 删 delayMs；v1.2.1 加 platformAuth）', () => {
  assert.deepEqual({ ...DEFAULTS }, {
    allowRestart: true, confirm: true, exePath: '', hideSidebarButton: false, platformAuth: true,
  });
  assert.throws(() => { 'use strict'; DEFAULTS.allowRestart = false; }, TypeError);
});

test('U12b resolveConfigFile 优先级 DSH_PROFILE_DIR > DSH_HOME/profiles/<name> > USERPROFILE/.dsh > null', () => {
  assert.equal(
    resolveConfigFile({ DSH_PROFILE_DIR: 'D:\\p', DSH_HOME: 'D:\\h', DSH_PROFILE: 'web', USERPROFILE: 'D:\\u' }),
    join('D:\\p', 'restart-now.config.json'),
  );
  assert.equal(
    resolveConfigFile({ DSH_HOME: 'D:\\h', DSH_PROFILE: 'web', USERPROFILE: 'D:\\u' }),
    join('D:\\h', 'profiles', 'web', 'restart-now.config.json'),
  );
  assert.equal(
    resolveConfigFile({ DSH_HOME: 'D:\\h', USERPROFILE: 'D:\\u' }),
    join('D:\\h', 'profiles', 'desktop', 'restart-now.config.json'),
    'DSH_PROFILE 缺省视为 desktop',
  );
  assert.equal(
    resolveConfigFile({ USERPROFILE: 'D:\\u' }),
    join('D:\\u', '.dsh', 'restart-now.config.json'),
  );
  assert.equal(resolveConfigFile({}), null, '全空环境返回 null（调用方须容忍）');
});

test('U12c clampConfig 只收合法键并收紧类型', () => {
  assert.deepEqual(clampConfig({ allowRestart: false, confirm: true, delayMs: 123.7, exePath: '  x.exe  ' }),
    { allowRestart: false, confirm: true, exePath: 'x.exe' }, 'v1.1 起 delayMs 属未知键，被丢弃');
  assert.deepEqual(clampConfig({ hideSidebarButton: true }), { hideSidebarButton: true }, 'v0.12 第 5 键');
  assert.deepEqual(clampConfig({ platformAuth: false }), { platformAuth: false }, 'v1.2.1 逃生门键');
  assert.deepEqual(clampConfig({ platformAuth: 'no' }), {}, '非布尔值的逃生门丢弃（默认保持强制）');
  assert.deepEqual(clampConfig({ delayMs: 999999 }), {}, 'delayMs 已是未知键');
  assert.deepEqual(clampConfig({ evil: 1, delayMs: '100', hideSidebarButton: 'yes' }), {}, '未知键与非布尔值丢弃');
  assert.deepEqual(clampConfig(null), {});
  assert.deepEqual(clampConfig('x'), {});
});

test('U12d loadFileConfig 缺失/损坏 → {}', () => {
  assert.deepEqual(loadFileConfig(join(dir, 'nope.json')), {});
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.deepEqual(loadFileConfig(bad), {});
  const junk = join(dir, 'junk.json');
  writeFileSync(junk, JSON.stringify({ allowRestart: 'yes', unknown: 2 }));
  assert.deepEqual(loadFileConfig(junk), {}, '损坏类型被 clamp 掉');
});

test('U12e saveFileConfig 原子语义（写即合法 JSON）+ 返回 clamp 结果', () => {
  const f = join(dir, 'restart-now.config.json');
  const saved = saveFileConfig(f, { allowRestart: false, confirm: false, junk: 'x' });
  assert.deepEqual(saved, { allowRestart: false, confirm: false });
  assert.ok(existsSync(f));
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { allowRestart: false, confirm: false });
});

test('U12f effectiveConfig 三层合并：默认 < patch < 文件', () => {
  const f = join(dir, 'restart-now.config.json');
  saveFileConfig(f, { confirm: false, hideSidebarButton: true });
  const eff = effectiveConfig({ allowRestart: false, exePath: 'patch.exe' }, f);
  assert.deepEqual(eff, {
    allowRestart: false,        // patch 层
    confirm: false,             // 文件层压过默认
    exePath: 'patch.exe',       // patch 层
    hideSidebarButton: true,    // 文件层压过默认
    platformAuth: true,         // v1.2.1 默认强制
  });
  // 无文件时 patch 直接生效（v1.2.1：五键，无 delayMs）
  assert.deepEqual(effectiveConfig({ confirm: false }, join(dir, 'none.json')),
    { allowRestart: true, confirm: false, exePath: '', hideSidebarButton: false, platformAuth: true });
});

// —— U13 系列（v0.17）：isUsableExePath —— exePath 双闸的判据 ——
import { isUsableExePath } from '../lib/config-store.js';
import { fileURLToPath } from 'node:url';

test('U13a: 空值/非字符串 → false（留空 = 自动推导语义，由 resolveExe 兜底）', () => {
  assert.equal(isUsableExePath(''), false);
  assert.equal(isUsableExePath('   '), false);
  assert.equal(isUsableExePath(undefined), false);
  assert.equal(isUsableExePath(null), false);
  assert.equal(isUsableExePath(42), false);
});

test('U13b: 已存在的普通文件 → true（自身即真实文件，绝对路径）', () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isUsableExePath(self), true);
  assert.equal(isUsableExePath('  ' + self + '  '), true); // clamp 已 trim，但函数自身也容忍空白
});

test('U13c: 已存在的目录 → false（isFile 闸——existsSync 会放行目录，本函数不放）', () => {
  assert.equal(isUsableExePath(tmpdir()), false);
});

test('U13d: 真机教训值 c/ → false（Windows 下被当相对路径解析，不存在）', () => {
  assert.equal(isUsableExePath('c/'), false);
  assert.equal(isUsableExePath('Z:\\definitely-not-exist\\nope.exe'), false);
});

