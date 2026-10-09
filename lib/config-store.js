// lib/config-store.js —— 配置持久层（v0.8 自绘表单的底层）。
// 背景（真机勘误）：宿主设置页不读取插件的 schemastery Config 导出（plugins.bundle.config
// 只渲染 patch 条目里已声明的 config），所以四个配置项由插件自绘表单 + 本模块持久化。
// 优先级：代码默认 < patch 条目 config（apply 第二参） < 配置文件（本模块读写）。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

export const DEFAULTS = Object.freeze({
  allowRestart: true, confirm: true, delayMs: 50, exePath: '', hideSidebarButton: false,
});

/** 配置文件位置：随 profile 走（与 cordis.patch.yml 同目录语义）。
 *  宿主进程注入 DSH_PROFILE_DIR/DSH_HOME（实测会话环境存在）；逐级兜底到 %USERPROFILE%\.dsh。 */
export function resolveConfigFile(env = process.env) {
  const dir = env.DSH_PROFILE_DIR
    || (env.DSH_HOME ? join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop') : '')
    || (env.USERPROFILE ? join(env.USERPROFILE, '.dsh') : '');
  return dir ? join(dir, 'restart-now.config.json') : null;
}

/** 只保留 5 个合法键并做类型收紧；非法值丢弃（绝不抛异常，绝不写入未知键） */
export function clampConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.allowRestart === 'boolean') out.allowRestart = raw.allowRestart;
  if (typeof raw.confirm === 'boolean') out.confirm = raw.confirm;
  if (typeof raw.delayMs === 'number' && Number.isFinite(raw.delayMs)) {
    out.delayMs = Math.min(60000, Math.max(0, Math.round(raw.delayMs)));
  }
  if (typeof raw.exePath === 'string') out.exePath = raw.exePath.trim();
  if (typeof raw.hideSidebarButton === 'boolean') out.hideSidebarButton = raw.hideSidebarButton;
  return out;
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
