// lib/schema.js —— 设置页表单 schema（@deepseek-ai/schemastery 可选依赖）。
//
// 真机勘误（v0.6）：桌面 profile 对本插件是 link: 安装，import.meta.url 经 realpath
// 落在 D:\workspace\dsh-restart-now —— 从那里向上找不到 profile node_modules 里的
// @deepseek-ai/schemastery，首版的裸说明符解析静默失败 → Config=undefined →
// 设置页无配置表单（「四个配置项不见了」的根因）。
// 解析链：① DSH_HOME/DSH_PROFILE 指向的 profile package.json（link 形态）
//        ② USERPROFILE\.dsh\profiles\desktop（默认安装位置的兜底）
//        ③ 从本文件真实位置的裸说明符（real-dir 安装形态）
// 全部失败 → Config=undefined，不影响插件加载与功能（表单只是便利层，
// 配置值始终经 cordis.patch.yml 条目 config → apply(ctx, config) 生效）。
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function buildConfig(Schema) {
  return Schema.object({
    allowRestart: Schema.boolean().role('switch').default(true)
      .description('总开关：关闭后动作口一律 403 disabled'),
    confirm: Schema.boolean().role('switch').default(true)
      .description('点击重启后先弹二次确认'),
    exePath: Schema.string()
      .description('DeepSeek Harness.exe 绝对路径；留空自动推导（推荐）'),
    platformAuth: Schema.boolean().role('switch').default(true)
      .description('平台会话鉴权：拒绝本机其它进程直接调用动作口；仅在确证桌面壳不携带会话凭据时才关闭'),
    // v1.2.2：四个入口开关进配置层（原 hideSidebarButton 废弃，只做读时兼容映射）
    entryPanel: Schema.boolean().role('switch').default(true)
      .description('侧栏面板入口（侧栏「扩展」列表里的一项，点击切到重启面板页）'),
    entryFooter: Schema.boolean().role('switch').default(true)
      .description('侧栏底部按钮（取代已废弃的 hideSidebarButton）'),
    entryHeader: Schema.boolean().role('switch').default(true)
      .description('会话标题栏按钮（排在官方任务按钮左边）'),
    entrySettingsRow: Schema.boolean().role('switch').default(true)
      .description('设置 → 通用 里的一行'),
  });
}

function loadSchemastery() {
  const candidates = [];
  const home = process.env.DSH_HOME;
  const profile = process.env.DSH_PROFILE || 'desktop';
  if (home) candidates.push(join(home, 'profiles', profile, 'package.json'));
  const userHome = process.env.USERPROFILE || process.env.HOME;
  if (userHome) candidates.push(join(userHome, '.dsh', 'profiles', 'desktop', 'package.json'));
  for (const pkgPath of candidates) {
    if (!existsSync(pkgPath)) continue;
    try {
      return createRequire(pkgPath)('@deepseek-ai/schemastery');
    } catch { /* 尝试下一个 */ }
  }
  try {
    return createRequire(import.meta.url)('@deepseek-ai/schemastery');
  } catch {
    return null;
  }
}

const Schema = loadSchemastery();
export const Config = Schema ? buildConfig(Schema) : undefined;
