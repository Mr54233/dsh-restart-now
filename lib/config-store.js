// lib/config-store.js —— 配置持久层（v0.8 自绘表单的底层）。
// 背景（真机勘误）：宿主设置页不读取插件的 schemastery Config 导出（plugins.bundle.config
// 只渲染 patch 条目里已声明的 config），所以配置项由插件自绘表单 + 本模块持久化。
// 优先级：代码默认 < patch 条目 config（apply 第二参） < 配置文件（本模块读写）。
//
// v1.1：删除 delayMs。用户裁定（原话）：「防止重复就够了，delay删掉，不给用户反悔的机会，
// 并且尽可能快的重启」。派发时延改为固定的「等助手 ack（≤800ms）」——有 ack 才动手，
// 没 ack 直接报错不杀任何进程，比让用户调一个毫秒数更安全也更快。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

export const DEFAULTS = Object.freeze({
  allowRestart: true, confirm: true, exePath: '', platformAuth: true,
  entryPanel: true, entryFooter: true, entryHeader: true, entrySettingsRow: true,
});

/** 配置文件位置：随 profile 走（与 cordis.patch.yml 同目录语义）。
 *  宿主进程注入 DSH_PROFILE_DIR/DSH_HOME（实测会话环境存在）；逐级兜底到 %USERPROFILE%\.dsh。 */
export function resolveConfigFile(env = process.env) {
  const dir = env.DSH_PROFILE_DIR
    || (env.DSH_HOME ? join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop') : '')
    || (env.USERPROFILE ? join(env.USERPROFILE, '.dsh') : '');
  return dir ? join(dir, 'restart-now.config.json') : null;
}

/** v1.2.2：四个入口开关的键名（issue #1 修复后，开关值存配置层而不再存 localStorage）。 */
export const ENTRY_KEYS = Object.freeze(['entryPanel', 'entryFooter', 'entryHeader', 'entrySettingsRow']);

/** 只保留 8 个合法键并做类型收紧；非法值丢弃（绝不抛异常，绝不写入未知键）。
 *  v1.1：delayMs 已删除——旧配置文件里残留的该键会被静默忽略（clamp 不收未知键）。
 *  v1.2.2：hideSidebarButton 废弃，只做单向兼容映射（true → entryFooter:false）；
 *          两键并存时新键 entryFooter 优先；输出里永不出现旧键（保存一次即自然淘汰）。 */
export function clampConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.allowRestart === 'boolean') out.allowRestart = raw.allowRestart;
  if (typeof raw.confirm === 'boolean') out.confirm = raw.confirm;
  if (typeof raw.exePath === 'string') out.exePath = raw.exePath.trim();
  // v1.2.1 逃生门：鉴权默认强制；关掉后退回「只做围栏」（v1.2.0 及之前的行为）
  if (typeof raw.platformAuth === 'boolean') out.platformAuth = raw.platformAuth;
  for (const key of ENTRY_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  // 旧键兼容：仅在新键缺席时生效（不覆盖用户已经写下的 entryFooter）
  if (typeof raw.hideSidebarButton === 'boolean' && out.entryFooter === undefined) {
    out.entryFooter = !raw.hideSidebarButton;
  }
  return out;
}

/** v1.2.2：**配置文件本身**是否已经写过任何入口键——这是「要不要做一次性迁移」的唯一判据。
 *  不能拿 effectiveConfig() 判：它必然叠加 DEFAULTS 的四个 entry 键，永远为真，
 *  用它当判据会让迁移逻辑在生产里永不触发（本地单测却因为夹具直接喂裸文件而看不出问题）。
 *  旧键 hideSidebarButton 也算「用户已经表过态」，否则老配置会被迁移逻辑翻盘。 */
export function fileHasEntries(file) {
  if (!file || !existsSync(file)) return false;
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.hideSidebarButton === 'boolean') return true;
  return ENTRY_KEYS.some((key) => typeof raw[key] === 'boolean');
}

export function loadFileConfig(file) {
  if (!file || !existsSync(file)) return {};
  try { return clampConfig(JSON.parse(readFileSync(file, 'utf8'))); } catch { return {}; }
}

export function saveFileConfig(file, patch) {
  const clamped = clampConfig(patch);
  writeFileSync(file, JSON.stringify(clamped, null, 2) + '\n');
  return clamped;
}

/** 三层合并：DEFAULTS < patch 条目 config < 文件。clamp 保证每层只含合法键。 */
export function effectiveConfig(patchConfig, file) {
  return { ...DEFAULTS, ...clampConfig(patchConfig), ...loadFileConfig(file) };
}

/** v0.17 exePath 有效性：必须是「已存在的普通文件」。
 *  背景（真机勘误）：用户在表单随手填 'c/' 也能保存成功——existsSync('c/') 为 false
 *  （Windows 下被当相对路径），但 'C:\Windows' 这类已存在的目录会骗过 existsSync，
 *  助手 spawn 一个目录必然失败且发生在杀树之后（窗口关了不回来）。isFile 双闸堵死：
 *  保存时 400 exe-path-invalid（入口一），重启前 fail-fast 500 exe-not-found（入口二，
 *  且 fail-fast 在派发助手之前，应用绝不会被误杀）。留空返回 false——空值语义是自动推导，
 *  由 resolveExe 兜底，不算「不可用」。 */
export function isUsableExePath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  try { return statSync(resolvePath(p.trim())).isFile(); } catch { return false; }
}
