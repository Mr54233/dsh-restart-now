// lib/environment.js —— 环境判定 v0.5（真机勘误：v44.0.0 官方桌面宿主不发布 desktopProfiles 服务，
// asar 全文零命中；dshmarket index.ts:183-204 同款事实：desktopProfiles 是第三方壳的自我声明，
// 官方桌面判定 = profileContext（启动器发布 {name,dir}）name==='desktop'，且 dsh CLI 按名字拒绝
// 管理 desktop profile（#702 实测教训）。三者依次：
//   ① desktopProfiles 存在        → 第三方桌面壳 → 'desktop'
//   ② profileContext.name=desktop → 官方桌面（launcher 发布）→ 'desktop'
//   ③ process.argv 含 --profile   → dsh CLI 启动（含 `dsh --profile desktop`，其 ppid 是终端，
//                                   杀之属误伤）→ 永远 'web'
// 其余（CLI 默认/其他 profile）→ 'web'。同步判定，无进程查询。
export function detectEnvironment(ctx) {
  try {
    const marker = ctx && typeof ctx.get === 'function' ? ctx.get('desktopProfiles') : undefined;
    if (marker !== undefined && marker !== null) {
      return 'desktop';
    }
  } catch { /* 服务未就绪按缺失处理 */ }
  try {
    const pc = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
    const launchedByCli = Array.isArray(process.argv) && process.argv.includes('--profile');
    if (
      !launchedByCli &&
      pc !== undefined && pc !== null && typeof pc === 'object' &&
      String(pc.name ?? '').toLowerCase() === 'desktop'
    ) {
      return 'desktop';
    }
  } catch { /* 同上 */ }
  return 'web';
}

// v1.0.2 适用范围：重启链路（WMI Win32_Process.Create、wscript VBS、taskkill /T、
// 'DeepSeek Harness.exe' 路径推导）全部是 Windows 机制；其他平台上动作口拒绝、客户端零挂载。
export function supportedPlatform(platform = process.platform) {
  return platform === 'win32';
}
