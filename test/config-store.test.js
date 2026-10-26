// test/config-store.test.js —— U12 系列：配置持久层（v0.8 自绘表单底层）。
// 覆盖：DEFAULTS / resolveConfigFile / clampConfig / loadFileConfig / saveFileConfig / effectiveConfig。
// 全部用临时目录真实读写（node:fs.mkdtempSync），无副作用残留。
// v1.2.2（issue #1）：hideSidebarButton 废弃 → 四个 entry 键进配置层，旧键只做读时映射。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULTS, ENTRY_KEYS, resolveConfigFile, clampConfig, loadFileConfig, saveFileConfig, effectiveConfig,
} from '../lib/config-store.js';

let dir = '';

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-restart-now-u12-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const EIGHT = (patch = {}) => ({
  allowRestart: true, confirm: true, exePath: '', platformAuth: true,
  entryPanel: true, entryFooter: true, entryHeader: true, entrySettingsRow: true,
  ...patch,
});

test('U12a DEFAULTS 冻结且八键正确（v1.2.2：删 hideSidebarButton，加四个 entry 键）', () => {
  assert.deepEqual({ ...DEFAULTS }, EIGHT());
  assert.deepEqual(Object.keys(DEFAULTS).sort(), Object.keys(EIGHT()).sort(), '键集合不多不少');
  assert.throws(() => { 'use strict'; DEFAULTS.allowRestart = false; }, TypeError);
  assert.deepEqual([...ENTRY_KEYS], ['entryPanel', 'entryFooter', 'entryHeader', 'entrySettingsRow']);
  assert.ok(Object.isFrozen(ENTRY_KEYS), 'ENTRY_KEYS 也应冻结');
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

test('U12c clampConfig 只收 8 个合法键并收紧类型（v1.2.2）', () => {
  assert.deepEqual(clampConfig({ allowRestart: false, confirm: true, delayMs: 123.7, exePath: '  x.exe  ' }),
    { allowRestart: false, confirm: true, exePath: 'x.exe' }, 'v1.1 起 delayMs 属未知键，被丢弃');
  assert.deepEqual(clampConfig({ platformAuth: false }), { platformAuth: false }, 'v1.2.1 逃生门键');
  assert.deepEqual(clampConfig({ platformAuth: 'no' }), {}, '非布尔值的逃生门丢弃（默认保持强制）');
  assert.deepEqual(clampConfig({ entryPanel: false, entryFooter: false, entryHeader: false, entrySettingsRow: false }),
    { entryPanel: false, entryFooter: false, entryHeader: false, entrySettingsRow: false }, 'v1.2.2 四个入口键');
  assert.deepEqual(clampConfig({ entryPanel: 'off' }), {}, '入口键非布尔值丢弃');
  assert.deepEqual(clampConfig({ delayMs: 999999 }), {}, 'delayMs 已是未知键');
  assert.deepEqual(clampConfig({ evil: 1, delayMs: '100', entryHeader: 0 }), {}, '未知键与非布尔值丢弃');
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

test('U12f effectiveConfig 三层合并：默认 < patch < 文件（八键）', () => {
  const f = join(dir, 'restart-now.config.json');
  saveFileConfig(f, { confirm: false, entryHeader: false });
  const eff = effectiveConfig({ allowRestart: false, exePath: 'patch.exe' }, f);
  assert.deepEqual(eff, EIGHT({
    allowRestart: false,   // patch 层
    confirm: false,        // 文件层压过默认
    exePath: 'patch.exe',  // patch 层
    entryHeader: false,    // 文件层压过默认（v1.2.2）
  }));
  // patch 层也接受入口键
  assert.deepEqual(effectiveConfig({ entrySettingsRow: false }, join(dir, 'none.json')),
    EIGHT({ entrySettingsRow: false }), '无文件时 patch 层的 entry 键直接生效');
});

test('U12g 旧键兼容映射：hideSidebarButton:true 且无 entryFooter → entryFooter:false', () => {
  assert.deepEqual(clampConfig({ hideSidebarButton: true }), { entryFooter: false },
    'v1.2 及之前的配置读进来应仍能关掉底部入口');
  assert.deepEqual(clampConfig({ hideSidebarButton: false }), { entryFooter: true },
    'false 映射成「显示」——显式写 false 也该等价于 entryFooter:true');
});

test('U12h 两键并存时新键 entryFooter 优先（旧键不覆盖）', () => {
  assert.deepEqual(clampConfig({ hideSidebarButton: true, entryFooter: true }), { entryFooter: true },
    '新键赢——用户已经明确设过 entryFooter');
  assert.deepEqual(clampConfig({ hideSidebarButton: false, entryFooter: false }), { entryFooter: false });
  // 文件层与 patch 层的冲突走三层合并，仍然是「新键在各自层内已定」，旧键不会复活
  const f = join(dir, 'restart-now.config.json');
  saveFileConfig(f, { hideSidebarButton: true });
  assert.equal(effectiveConfig({}, f).entryFooter, false, '旧键经 clamp 后以 entryFooter 参与合并');
});

test('U12i saveFileConfig 永不写回旧键 hideSidebarButton（保存一次即淘汰）', () => {
  const f = join(dir, 'restart-now.config.json');
  saveFileConfig(f, { hideSidebarButton: true, allowRestart: false });
  const raw = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal('hideSidebarButton' in raw, false, '旧键不得出现在磁盘上');
  assert.equal(raw.entryFooter, false, '映射后的新键写进去');
  assert.equal(raw.allowRestart, false);
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
