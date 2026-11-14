/* eslint-disable */
// lib/client.js —— 客户端半边（v1.3.1：六个重启入口 + 逐入口开关 + 停机后有界轮询）。
// 入口（都走同一条受守卫的 POST /restart）：
//   ① sidebar.panellist（侧栏左上角，整行由侧栏自己画）+ main（点它切到主区重启面板）
//   ② sidebar.footer.action（侧栏底部动作位，官方给第三方插件的座位）
//   ③ conversation.session.header.actions（会话标题栏按钮，order 15：官方 jobs 条目是 20，排在它前面才不被挤右）
//   ④ 设置 → 通用 行（settings.general.item，order 91）
//   ⑤ 斜杠命令 /restart（宿主半边注册，不受前端开关影响）
//   ⑥ Windows 标题栏菜单「重启」项（v1.3.1：shadow DOM 注入，落在「应用 编辑」后面，
//      形态=issue #5 用户指定的文字菜单项；两击式确认；官方出正式槽位后迁移）
// 另有 settings.section 配置页——它本身不可关（否则关掉就回不来了）。
// 入口开关存**配置文件**（entryPanel/entryFooter/entryHeader/entrySettingsRow/entryTitlebar，经宿主 /config 路由落盘）；
// localStorage 只当首帧缓存（dsh-restart-now:entries），永不覆盖配置层。
// v1.2.2 勘误（issue #1）：v1.2 把开关存在 localStorage，用户点完开关 1 秒内点重启 →
// 强杀（taskkill /F）时 Chromium 未提交的写入丢失 → 开关「回弹」。配置层是同步落盘的，没有这个窗口。
// 官方控件：@deepseek-ai/dsh-client-ui-primitives 在客户端 require 表里，能 require 到就直接用官方 Button，
// 拿不到（未来改名/挪包）就退回本文件里逐字照抄官方数值的 .dsrn-* 样式——界面不会崩。
// 依据官方插件样式规范（asar:292610）：类名改自前缀、颜色只引用 --dsw-* token。
// 蓝本（均提取自 app.asar 内官方包，见 .m4/primitives/）：
//   - dsh-client-ui-sidebar：panelRow/panelGlyph/panelTitle（任务导航行全宽行样式）
//   - dsh-client-ui-primitives：Button/Switch/fields/SettingsForm/Modal/RiskConfirmation
//   - 图标 = primitives 官方 16 网格 artwork 原样拷贝（viewBox 0 0 16 16、fill:none、
//     stroke:currentColor、strokeWidth 1=Regular / 1.3=ICON_MEDIUM_STROKE，无 linecap/linejoin）：
//       Refresh（重启语义）= IconRefreshOutlineArtwork（primitives-index.js L713-729）
//       Warning 圆圈 = IconWarningOutlineArtwork（L1185-1207）；Close = IconCloseOutlineArtwork（L602-618）
// window.confirm/alert 是 Chromium 原生对话框（标题 = Electron app.name，不可定制），
// 官方一律自绘 Modal（Modal.module.css + RiskConfirmation），故 v0.11 起弹窗全部自绘。
// v0.12：设置导航行图标由宿主 navIcon(id) 硬编码（asar L477884，未知 id 回退齿轮，
// descriptor 无 icon 字段）→ 守卫式 MutationObserver 只精确匹配我们那一行换成官方 Refresh；
// 匹配不到就保持齿轮，增强失败不影响任何功能。
// v1.3.1：新增「仅关闭」（close-only，POST /plugins/dsh-restart-now/close）：停机后不拉起，
// 窗口由用户手动打开。入口只放主面板与设置页（footer/header 等快速入口仍是重启）；
// 确认文案必须明确「不会自动重启」。忙碌时只有「仍然关闭/取消」二选一——没有「等空闲」，
// 等待模式的终局是一次重启，与仅关闭语义冲突，刻意不复用。宿主探测口 closeSupported:false
// （助手尚未实现 action:'close'）时全部关闭入口不渲染，双保险防「点关闭变成重启」。
// v1.3.1 停机后有界轮询（watchRestartOutcome）：202 派发后正常路径是进程被杀、窗口关闭、
// 新实例拉起（页面会死，fetch 中断 = 服务没了 = 正常停机，静默收场）；失败路径（助手身份
// 核验拒绝 identity-verification-failed、main-not-stopped 等）进程还活着、页面还在——此前只打
// __dsh_restart_now__ 标记，用户毫无反馈。现在每 2s 拉一次探测口，页面活过 20s（正常停机
// 主进程 <1s 就死）即视为失败，读回执给一句人话（failed → 「重启已中止：原因」；一直没标记
// → 「重启似乎没有生效：应用仍在运行」，话术参考竞品 dsh-restart-app），90s 总预算到点放弃。
// restart 与 close 同款，busy.v 在发现失败时复位（按钮恢复可用）。
window.__ModuleLoader__.load({
  id: 'dsh-restart-now',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var name = 'dsh-restart-now';
    var PROBE = '/plugins/dsh-restart-now/environment';
    var ACTION = '/plugins/dsh-restart-now/restart';
    // v1.3.1 仅关闭口：宿主半边 POST /close（门禁与 /restart 同序，无 wait/cancel）
    var CLOSE = '/plugins/dsh-restart-now/close';
    var STATUS = '/plugins/dsh-restart-now/status';
    var PREFLIGHT = '/plugins/dsh-restart-now/preflight';
    var CONFIG = '/plugins/dsh-restart-now/config';
    // v1.2：面板 id 同时是 sidebar.panellist 的 id 与 main 槽位的 key（selectPanel 按 key 找面板，缺 key 会抛错）
    var PANEL_ID = 'dsh-restart-now';
    // 短键（UI 内部用）↔ 配置键（entryPanel/entryFooter/entryHeader/entrySettingsRow/entryTitlebar）
    // v1.3.1：+titlebar（标题栏 overlay 按钮，宿主 config-store 的 ENTRY_KEYS/DEFAULTS 同步加键；
    // 保存是全量写回——POST /config 落盘是整文件替换，漏键会把用户的关闭偏好抹掉）
    var ENTRY_KEYS = ['panel', 'footer', 'header', 'settingsRow', 'titlebar'];
    var ENTRY_CONF = { panel: 'entryPanel', footer: 'entryFooter', header: 'entryHeader', settingsRow: 'entrySettingsRow', titlebar: 'entryTitlebar' };
    // v1.2.2：localStorage 降级为首帧缓存（不再是真相来源）
    var ENTRY_STORE = 'dsh-restart-now:entries';
    // v1.3.0 跨平台挂载白名单：与宿主 environment.supportedPlatform 同一口径（win32 + darwin）。
    // platform 缺失 = 未升级的旧宿主探测口，调用方仍按支持处理（保持旧兼容路径）。
    const SUPPORTED_PLATFORMS = ['win32', 'darwin'];

    // 官方共享组件库（可选）：客户端 require 表里有它，能拿到就用官方本体，拿不到就用手抄版。
    var UI = null;
    try { UI = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (e) { UI = null; }
    var OfficialButton = UI && typeof UI.Button === 'function' ? UI.Button : null;
    // 官方 Toast 原语（asar 实锤：sidebar「版本已复制」/ chat quota-notice / message-feedback
    // 都用它）：props = { text, tone?:'success', icon?:ReactNode, onDone }。不可用时显示行内反馈。
    var OfficialToast = UI && typeof UI.Toast === 'function' ? UI.Toast : null;

    // —— 文案（v1.1：中文 + 英文；v0.1 起一直是 zh-only，Q7 预留的 i18n 位在此落地）——
    // 语言判定（v1.1.1 修正）：旧实现只读 <html lang> / navigator.language，实测在桌面端会判成英文——
    //   DSH 的 <html lang> 是 locale 服务在插件激活**之后**才写上去的（locale-client.js:1175 syncDocumentLanguage），
    //   而 Electron 里 navigator.language 通常是 en-US。
    // 现行顺序：DSH locale 服务 locale.getSnapshot().active → <html lang> → navigator.languages/language；
    // 服务晚到或用户切换语言时，通过 langSubs 通知已挂载组件重渲染（label 是函数，宿主重渲染也会跟着变）。
    // 所有面向用户的字符串都必须经 t()，不许再出现裸中文字面量。
    function normalizeLang(tag) {
      var s = String(tag || '').toLowerCase();
      if (!s) return null;
      if (s.indexOf('zh') === 0) return 'zh';
      if (s.indexOf('en') === 0) return 'en';
      return null;
    }
    function pickLang(doc, nav, localeId) {
      var fromService = normalizeLang(localeId);
      if (fromService) return fromService;
      var declared = '';
      try { declared = (doc && doc.documentElement && (doc.documentElement.getAttribute('lang') || '')) || ''; } catch (e) { void e; }
      var declaredLang = normalizeLang(declared);
      if (declaredLang) return declaredLang;
      var tags = [];
      try {
        if (nav && nav.languages && nav.languages.length) tags = [].slice.call(nav.languages);
        else if (nav && nav.language) tags = [nav.language];
      } catch (e) { void e; }
      for (var i = 0; i < tags.length; i += 1) {
        var hit = normalizeLang(tags[i]);
        if (hit) return hit;
      }
      return 'en';
    }
    var LANG = pickLang(typeof document === 'undefined' ? null : document,
      typeof navigator === 'undefined' ? null : navigator, null);
    var langSubs = [];
    function notifyLang() { langSubs.forEach(function (fn) { try { fn(); } catch (e) { void e; } }); }
    function setLang(id) {
      var next = normalizeLang(id);
      if (!next || next === LANG) return false;
      LANG = next;
      notifyLang();
      return true;
    }
    // locale 服务就绪后接进来：先取值，再订阅切换（服务 API 见 asar locale-client.js:1526 provide("locale"),
    // getSnapshot() → {active, locales, revision}，subscribe(fn)）
    function attachLocale(locale) {
      if (!locale) return;
      var read = function () {
        try {
          var snap = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
          return snap && snap.active ? snap.active : null;
        } catch (e) { void e; return null; }
      };
      setLang(read());
      try { if (typeof locale.subscribe === 'function') locale.subscribe(function () { setLang(read()); }); } catch (e) { void e; }
    }

    var STRINGS = {
      zh: {
        nav: '重启应用',
        ok: '确定',
        restart: '重启',
        restartNow: '立即重启',
        cancel: '取消',
        waiting: '等待中…',
        waitCancel: '撤销等待',
        waitStart: '等空闲后重启',
        forceStart: '仍然重启',
        configLoading: '配置加载中…',
        sectionHint: '退出并重新启动 DeepSeek Harness 桌面应用。',
        allowRestart: '允许重启',
        allowRestartHint: '总开关；关闭后所有重启入口立即失效。',
        confirm: '二次确认',
        confirmHint: '点击重启后先弹出确认框。',
        entryWriteFailed: '未能保存到配置文件，重启后可能回弹；请检查配置文件是否只读。',
        platformAuth: '平台会话鉴权',
        platformAuthHint: '只允许通过本应用的界面操作重启；本机其他程序直接调用接口会被拒绝。'
          + '若界面本身提示未授权，可临时关闭本项自救，然后反馈问题。',
        exePath: '可执行文件路径',
        exePathPlaceholder: '留空自动推导',
        exePathHint: '重启时拉起的目标程序，默认即当前 DeepSeek Harness 程序（Windows 为安装目录下的 exe，'
          + 'macOS 为 .app 内的可执行文件；自动跟随安装位置，更新/换目录无需修改）。'
          + '手动改成其他路径时必须是已存在的文件，否则保存会被拒绝。',
        save: '保存配置',
        saved: '已保存 ✓',
        saveFailed: '保存失败',
        retrySave: '重试保存',
        savingConfig: '正在保存配置…',
        savingConfigUnknown: '保存耗时较长，结果尚未确认；后续更改正在排队，请勿关闭页面。',
        savingConfigUncertain: '保存结果未知，后续写入已暂停。请先确认服务端已处理完该请求，再核对配置文件并重新加载页面；未保存的更改可能丢失。',
        version: '运行版本',
        versionUnsupported: '当前 DSH 版本不在支持范围，重启可能失败',
        versionUnknown: '未能读取版本',
        lastRestart: '上次重启/关闭',
        lastClosed: '已关闭（未自动重启）',
        lastOk: '已完成，停机约 {s} 秒',
        lastServing: 'HTTP 已响应（未验证应用就绪）',
        preflight: '重启前预检',
        preflightFailed: '预检不可用：{r}',
        preflightResult: '这是只读的即时快照，不保证之后重启安全。\n环境：{env}；支持的平台：{platform}\n重启开关：{enabled}；安装锁：{lock}\n任务：{tasks}；后台作业：{jobs}；冷却剩余：{cooldown} 毫秒\n目标程序：{exe}\n程序路径可用：{usable}；主进程 PID：{pid}\n主进程身份及启动参数未在预检中核验。',
        lastFailed: '失败：{r}（详见临时目录日志）',
        lastUnconfirmed: '已发起，但未确认成功',
        confirmBody: '重启会中断当前正在进行的输出和任务（包括本条回复）。窗口先关闭后自动回来，通常十几秒；'
          + '插件较多或网络慢时可能要几分钟，请耐心等待。',
        disabled: '重启已被总开关禁用（设置 → 重启应用 → 允许重启）。',
        busyTitle: '还有任务在运行',
        busyBody: '当前有 {t} 个会话在运行、{j} 个任务在跑。重启会把它们一起中断。',
        waitingBody: '已进入等待：任务结束后会自动重启（最多等 30 分钟）。',
        rejected: '重启被拒绝：{r}',
        unauthorized: '平台未授权本页操作（401）。请确认是在本应用界面内点击；'
          + '若持续出现，可在 设置 → 重启应用 中临时关闭「平台会话鉴权」后重试，并反馈此问题。',
        forbidden: '请求来源不被信任（403），已拒绝。',
        installing: '插件正在安装/卸载，等它结束后再重启。',
        cooldown: '刚刚已经发起过一次重启，请等 {s} 秒后再试。',
        entryGroup: '重启入口',
        entryHint: '关掉的入口立即消失；本页不在开关范围内，随时可以回来重新打开。',
        entryPanel: '左上角面板',
        entryFooter: '侧栏底部按钮',
        entryHeader: '会话标题栏按钮',
        entrySettingsRow: '设置 → 通用 行',
        entryTitlebar: '标题栏按钮（编辑旁）',
        entryCommandHint: '斜杠命令 /restart 始终可用（不受这些开关影响）。',
        panelTitle: '重启桌面应用',
        panelDesc: '关闭并重新启动 DeepSeek Harness。进行中的输出与任务会被中断，窗口通常十几秒后自行回来。',
        headerLabel: '重启',
        settingsRowLabel: '重启桌面应用',
        settingsRowHint: '关闭并重新启动 DeepSeek Harness 桌面应用；更多选项见 设置 → 重启应用。',
        restarting: '正在重启…',
        closing: '正在关闭…',
        resultUnknown: '请求结果未确认（{r}）；请检查应用状态后再试。',
        confirmRestart2: '确认重启',
        confirmRestart2Hint: '再次点击确认重启 DSH',
        restartFailedShort: '重启失败',
        // v1.3.1 仅关闭（close-only）
        closeNow: '仅关闭',
        closeConfirmBody: '仅关闭会退出应用，且不会自动重启，需要手动重新打开。'
          + '进行中的输出与任务会被中断（包括本条回复）。',
        closeAnyway: '仍然关闭',
        closeBusyBody: '当前有 {t} 个会话在运行、{j} 个任务在跑。关闭会把它们中断，应用不会自动重启。',
        closeCooldown: '刚刚已经发起过一次重启/关闭，请等 {s} 秒后再试。',
        closeDisabled: '重启/关闭已被总开关禁用（设置 → 重启应用 → 允许重启）。',
        closeUnsupported: '仅关闭暂不可用（当前版本助手尚未支持），请更新插件后再试。',
        closeRejected: '关闭被拒绝：{r}',
        // v1.3.1 停机后有界轮询：失败路径要给用户一句人话（进程活着但重启/关闭没发生）
        restartAborted: '重启已中止：{r}。可在设置→重启应用 查看详情。',
        restartNotEffective: '重启似乎没有生效：应用仍在运行。',
        closeAborted: '关闭已中止：{r}。可在设置→重启应用 查看详情。',
        closeNotEffective: '关闭似乎没有生效：应用仍在运行。',
      },
      en: {
        nav: 'Restart app',
        ok: 'OK',
        restart: 'Restart',
        restartNow: 'Restart now',
        cancel: 'Cancel',
        waiting: 'Waiting…',
        waitCancel: 'Cancel wait',
        waitStart: 'Restart when idle',
        forceStart: 'Restart anyway',
        configLoading: 'Loading settings…',
        sectionHint: 'Quit and relaunch the DeepSeek Harness desktop app.',
        allowRestart: 'Allow restart',
        allowRestartHint: 'Master switch; turning it off disables every restart entry point.',
        confirm: 'Ask for confirmation',
        confirmHint: 'Show a confirmation dialog before restarting.',
        entryWriteFailed: 'Could not save to the config file — the switch may revert after a restart.',
        platformAuth: 'Require platform session',
        platformAuthHint: 'Only this app\'s UI may trigger a restart; other local processes calling the endpoint'
          + ' directly are rejected. If the UI itself reports unauthorized, turn this off to recover,'
          + ' then report the problem.',
        exePath: 'Executable path',
        exePathPlaceholder: 'Blank = auto-detect',
        exePathHint: 'Program to relaunch; defaults to the running DeepSeek Harness app (the .exe on Windows,'
          + ' the binary inside the .app on macOS) and follows the install directory automatically.'
          + ' If you set another path it must be an existing file, otherwise the save is rejected.',
        save: 'Save',
        saved: 'Saved ✓',
        saveFailed: 'Save failed',
        retrySave: 'Retry save',
        savingConfig: 'Saving settings…',
        savingConfigUnknown: 'Saving is taking longer than expected; the outcome is unconfirmed. Later changes are queued; keep this page open.',
        savingConfigUncertain: 'The save outcome is unknown and later writes are paused. Confirm the server has finished processing the request, then check the config file and reload; unsaved changes may be lost.',
        version: 'Running version',
        versionUnsupported: 'This DSH version is outside the supported range; restart may fail',
        versionUnknown: 'Version could not be read',
        lastRestart: 'Last restart/close',
        lastClosed: 'closed (not relaunched)',
        lastOk: 'done, about {s}s of downtime',
        lastServing: 'HTTP responded (app readiness not verified)',
        preflight: 'Restart preflight',
        preflightFailed: 'Preflight unavailable: {r}',
        preflightResult: 'Read-only snapshot; it does not guarantee a future restart is safe.\nEnvironment: {env}; supported platform: {platform}\nRestart enabled: {enabled}; install lock: {lock}\nTasks: {tasks}; jobs: {jobs}; cooldown: {cooldown} ms\nTarget: {exe}\nExecutable usable: {usable}; main PID: {pid}\nProcess identity and launch arguments are not verified by this preflight.',
        lastFailed: 'failed: {r} (see the temp-directory log)',
        lastUnconfirmed: 'requested, but not confirmed',
        confirmBody: 'Restarting interrupts running output and tasks, including this reply. The window closes and'
          + ' comes back by itself, usually within seconds; with many plugins or a slow network it can take minutes.',
        disabled: 'Restart is disabled by the master switch (Settings → Restart app → Allow restart).',
        busyTitle: 'Tasks are still running',
        busyBody: '{t} conversation(s) running, {j} job(s) in flight. Restarting will interrupt them.',
        waitingBody: 'Waiting: the app will restart when tasks finish (up to 30 minutes).',
        rejected: 'Restart rejected: {r}',
        unauthorized: 'The platform did not authorize this page (401). Make sure you clicked inside this app;'
          + ' if it keeps happening, temporarily turn off "Require platform session" in'
          + ' Settings → Restart app, then report the problem.',
        forbidden: 'The request origin is not trusted (403) and was rejected.',
        installing: 'A plugin install/uninstall is in progress; try again when it finishes.',
        cooldown: 'A restart was just started; wait {s}s and try again.',
        entryGroup: 'Restart entry points',
        entryHint: 'Disabled entries disappear immediately; this page is never toggled off, so you can always come back and re-enable them.',
        entryPanel: 'Top-left panel',
        entryFooter: 'Sidebar footer button',
        entryHeader: 'Session header button',
        entrySettingsRow: 'Settings → General row',
        entryTitlebar: 'Titlebar button (next to Edit)',
        entryCommandHint: 'The /restart slash command is always available (not affected by these switches).',
        panelTitle: 'Restart the desktop app',
        panelDesc: 'Quits and relaunches DeepSeek Harness. Running output and tasks are interrupted; the window usually comes back within seconds.',
        headerLabel: 'Restart',
        settingsRowLabel: 'Restart the desktop app',
        settingsRowHint: 'Quit and relaunch the DeepSeek Harness desktop app; more options under Settings → Restart app.',
        restarting: 'Restarting…',
        closing: 'Closing…',
        resultUnknown: 'Request outcome unconfirmed ({r}); check the application status before retrying.',
        confirmRestart2: 'Confirm restart',
        confirmRestart2Hint: 'Click again to confirm restarting DSH',
        restartFailedShort: 'Restart failed',
        // v1.3.1 close-only
        closeNow: 'Close only',
        closeConfirmBody: 'Closing quits the app and does not relaunch it — you must reopen DeepSeek Harness'
          + ' manually. Running output and tasks are interrupted, including this reply.',
        closeAnyway: 'Close anyway',
        closeBusyBody: '{t} conversation(s) running, {j} job(s) in flight. Closing interrupts them and does not relaunch the app.',
        closeCooldown: 'A restart/close was just started; wait {s}s and try again.',
        closeDisabled: 'Restart/close is disabled by the master switch (Settings → Restart app → Allow restart).',
        closeUnsupported: 'Close-only is not available in this build yet; update the plugin and try again.',
        closeRejected: 'Close was rejected: {r}',
        // v1.3.1 bounded poll after the 202: a failed stop must be visible to the user
        restartAborted: 'Restart aborted: {r}. See Settings → Restart app for details.',
        restartNotEffective: 'The restart did not take effect: the app is still running.',
        closeAborted: 'Close aborted: {r}. See Settings → Restart app for details.',
        closeNotEffective: 'The close did not take effect: the app is still running.',
      },
    };
    function t(key, params) {
      var table = STRINGS[LANG] || STRINGS.zh;
      var text = table[key];
      if (text === undefined) text = STRINGS.zh[key] || key;
      if (!params) return text;
      return String(text).replace(/\{(\w+)\}/g, function (all, key2) {
        return params[key2] === undefined ? all : String(params[key2]);
      });
    }

    // 导航行文本随语言变化：声明用 t('nav')，认领时两种语言都接受（宿主 lang 可能后改）
    var NAV_LABELS = [STRINGS.zh.nav, STRINGS.en.nav];
    function navLabel() { return t('nav'); }

    // —— 官方控件 CSS（抄自 primitives / sidebar，改 .dsrn- 前缀；只用 --dsw-* token）——
    var CSS = [
      // Button.module.css
      '.dsrn-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px}',
      '.dsrn-button:disabled{cursor:not-allowed;opacity:.4}',
      '.dsrn-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dsrn-md{height:36px}',
      '.dsrn-sm{height:28px;font-size:12px;line-height:18px;padding:0 10px;border-radius:var(--dsw-radius-sm)}',
      '.dsrn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsrn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dsrn-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}',
      '.dsrn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '@keyframes dsrn-spin{to{transform:rotate(360deg)}}',
      '.dsrn-spinner{display:inline-block;box-sizing:border-box;width:14px;height:14px;flex:none;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dsrn-spin .8s linear infinite}',
      '@media (prefers-reduced-motion:reduce){.dsrn-spinner{animation:none}}',
      '.dsrn-head,.dsrn-panel-actions{flex-wrap:wrap}',
      '.dsrn-icon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center}',
      // fields.module.css
      '.dsrn-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.dsrn-field+.dsrn-field{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dsrn-head{display:flex;gap:8px;align-items:center}',
      '.dsrn-label{flex:1;font-size:13px;line-height:1.5;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsrn-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dsrn-input{height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box}',
      '.dsrn-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsrn-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
      // Switch.module.css
      '.dsrn-switch{width:36px;height:20px;padding:2px;border-radius:999px;border:none;background:var(--dsw-alias-border-l3);cursor:pointer;display:inline-flex;align-items:center;flex-shrink:0}',
      '.dsrn-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dsrn-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dsrn-switch:disabled{opacity:.4;cursor:not-allowed}',
      '.dsrn-thumb{width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform 120ms ease;display:block}',
      '.dsrn-switch[aria-checked="true"] .dsrn-thumb{background:var(--dsw-alias-label-primary-foreground);transform:translateX(16px)}',
      // SettingsForm.module.css（v0.12：保存键右对齐，与官方表单一致）
      '.dsrn-footer{display:flex;gap:8px;align-items:center;justify-content:flex-end;padding-top:16px}',
      '.dsrn-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);padding:5px 14px;font-size:13px;line-height:1.5;border:none;border-radius:var(--dsw-radius-md);cursor:pointer}',
      '.dsrn-save:hover{opacity:.9}',
      '.dsrn-failed{color:var(--dsw-alias-label-error);font-size:12px}',
      '.dsrn-ok{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      // section 壳（GeneralSection.module.css）
      '.dsrn-section{display:flex;flex-direction:column;width:100%}',
      // sidebar panelRow（任务导航行全宽行样式，sidebar-client.js css blob）
      // v0.13：width:100% —— codex-ui 的 .dcu-footer-actions 无任何 CSS 规则（普通块级 div，
      // 无 flex 上下文），panelRow 原版 flex:1 在那里失效导致按钮缩成文字宽（用户截图实证）；
      // 官方 sidebar footerActions 是 flex 容器，width:100% 同样成立，两种宿主都全宽。
      '.dsrn-row{box-sizing:border-box;width:100%;border-radius:var(--dsw-radius-md);min-height:36px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:none;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex;flex:1 1 auto}',
      '.dsrn-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsrn-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.dsrn-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex}',
      '.dsrn-title{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      // 收窄态（官方 collapsed panelRow：36x36 居中、margin/padding 归零；根 collapsed 类不可用，按 wide 自行模拟）
      '.dsrn-row.dsrn-collapsed{width:36px;height:36px;min-height:36px;justify-content:center;margin:0;padding:0;flex:none;align-self:center}',
      // Modal.module.css（自绘弹窗，官方 Modal 结构 root>mask+dialog>content(header/body)+footer）
      '.dsrn-modal-root{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}',
      '.dsrn-modal-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0 0;backdrop-filter:var(--dsw-mask-blur)}',
      '.dsrn-modal-mask::after{content:\'\';position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}',
      '.dsrn-modal-dialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}',
      '.dsrn-modal-dialog:focus{outline:none}',
      '@keyframes dsrn-modal-enter{from{opacity:0}to{opacity:1}}',
      '.dsrn-modal-mask::after,.dsrn-modal-dialog{animation:dsrn-modal-enter var(--ds-transition-duration,150ms) var(--ds-ease-in-out,ease)}',
      '@media (prefers-reduced-motion:reduce){.dsrn-modal-mask::after,.dsrn-modal-dialog{animation:none}}',
      '.dsrn-modal-content{display:flex;flex-direction:column;width:100%}',
      '.dsrn-modal-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}',
      '.dsrn-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsrn-modal-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.dsrn-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsrn-modal-close:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dsrn-modal-desc{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}',
      '.dsrn-modal-body{display:flex;flex-direction:column;min-width:0;margin-top:20px;padding:0 24px}',
      '.dsrn-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}',
      // RiskConfirmation.module.css（警告行 + 弹窗按钮最小宽）
      '.dsrn-warning{display:flex;align-items:flex-start;gap:10px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}',
      '.dsrn-warning p{margin:0}',
      '.dsrn-warning-icon{flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary)}',
      '.dsrn-modal-action{min-width:72px}',
      '.dsrn-confirm-action{min-width:136px}',
      // v1.2 入口样式
      // 会话标题栏按钮：照抄同座位官方 ui-jobs 的 JobListAction（28px 高、radius sm、无底色、
      // hover 只把字色从 tertiary 提到 secondary——maker 了官方「安静」的观感）
      '.dsrn-hdr{display:inline-flex;align-items:center;gap:3px;min-height:28px;padding:3px 2px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsrn-hdr:hover:not(:disabled){color:var(--dsw-alias-label-secondary)}',
      '.dsrn-hdr:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dsrn-hdr:disabled{opacity:.4;cursor:not-allowed}',
      '.dsrn-hdr-label{white-space:nowrap}',
      // 设置 → 通用 行（官方 GeneralRow 形态：左文右钮、行间细分割线）
      '.dsrn-gen{display:flex;align-items:center;gap:12px;padding:12px 0}',
      '.dsrn-gen+.dsrn-gen{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dsrn-gen-text{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
      '.dsrn-gen-label{font-size:13px;line-height:1.5;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsrn-gen-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      // 主区面板（点侧栏左上角那一条切过来）
      '.dsrn-panel{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;width:100%;max-width:640px;margin:0 auto;padding:32px 24px}',
      '.dsrn-panel-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsrn-panel-desc{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}',
      '.dsrn-panel-meta{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dsrn-panel-actions{display:flex;gap:8px;align-items:center}',
    ].join('\n');
    // 注入方式与官方/生态插件一致（thinking-effort 同款）：style 标签 + data-plugin-css 防重
    if (typeof document !== 'undefined' &&
        document.querySelector('style[data-plugin-css="dsh-restart-now/client.css"]') === null) {
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-restart-now';
      tag.dataset.pluginCss = 'dsh-restart-now/client.css';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // —— 官方 16 网格图标（primitives artwork 原样拷贝，见文件头注释）——
    // IconRefreshOutlineArtwork：strokeWidth 1=Regular，1.3=Medium（ICON_MEDIUM_STROKE）
    var REFRESH_PATHS = [
      'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
      'M14.4999 1.5V5.1H10.8999',
    ];
    function RestartIcon(props) {
      var size = (props && props.size) || 16;
      var sw = (props && props.medium) ? 1.3 : 1;
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: sw, 'aria-hidden': true,
      },
        React.createElement('path', { d: REFRESH_PATHS[0] }),
        React.createElement('path', { d: REFRESH_PATHS[1] }));
    }

    // 官方 Close artwork（16 网格，与弹窗 x 同一份 path 数据）：仅关闭按钮的图标
    function CloseIcon(props) {
      var size = (props && props.size) || 16;
      var sw = (props && props.medium) ? 1.3 : 1;
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: sw, 'aria-hidden': true,
      },
        React.createElement('path', { d: ICON_CLOSE[0][1].d }),
        React.createElement('path', { d: ICON_CLOSE[1][1].d }));
    }

    // —— 自绘 Modal（官方 Modal 形态；window.confirm/alert 不可定制标题，v0.11 弃用）——
    function el(tagName, className, text) {
      var n = document.createElement(tagName);
      if (className) n.className = className;
      if (text !== undefined) n.textContent = text;
      return n;
    }
    // 官方 16 网格 DOM svg（Regular sw1；弹窗 Warning/Close 用）
    function svgEl(paths, size, className) {
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', size); svg.setAttribute('height', size);
      svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1');
      if (className) svg.setAttribute('class', className);
      svg.setAttribute('aria-hidden', 'true');
      paths.forEach(function (d) {
        var p = document.createElementNS(ns, d[0]);
        for (var k in d[1]) p.setAttribute(k, d[1][k]);
        svg.appendChild(p);
      });
      return svg;
    }
    // 官方 IconCloseOutlineArtwork（L602-618）/ IconWarningOutlineArtwork（L1185-1207）
    var ICON_CLOSE = [['path', { d: 'M2.5 2.5L13.5 13.5' }], ['path', { d: 'M13.5 2.5L2.5 13.5' }]];
    var ICON_WARN = [
      ['path', { d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z' }],
      ['path', { d: 'M8 4.29199V9.79199' }],
      ['path', { d: 'M8 10.708V11.708' }],
    ];

    // openModal({title, body?, description?, footer?, autofocus?, onClose?}) → {close}
    // 结构与官方 Modal 一致：root(role=presentation) > mask(aria-hidden, 点击关闭) + dialog(role=dialog aria-modal) > content(header(title+close)+body|description) + footer
    // onClose：无论从哪条路关掉（遮罩点击 / x / Escape / 外部 close()）都会回调一次。
    //   issue #2：确认框此前靠「包装 m.close」复位 confirmOpen，但遮罩/x/Escape 走的是
    //   内部 close()，绕过了包装 → confirmOpen 永久为 true，确认框再也弹不出来、也无法重启。
    function openModal(opts) {
      var prevFocus = document.activeElement;
      var root = el('div', 'dsrn-modal-root');
      root.setAttribute('role', 'presentation');
      var mask = el('div', 'dsrn-modal-mask');
      mask.setAttribute('aria-hidden', 'true');
      var dialog = el('div', 'dsrn-modal-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', opts.title);
      dialog.tabIndex = -1;
      var content = el('div', 'dsrn-modal-content');
      var header = el('div', 'dsrn-modal-header');
      header.appendChild(el('h2', 'dsrn-modal-title', opts.title));
      var closeBtn = el('button', 'dsrn-modal-close');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.appendChild(svgEl(ICON_CLOSE, 14));
      header.appendChild(closeBtn);
      content.appendChild(header);
      if (opts.body) {
        var body = el('div', 'dsrn-modal-body');
        body.appendChild(opts.body);
        content.appendChild(body);
      } else if (opts.description) {
        content.appendChild(el('p', 'dsrn-modal-desc', opts.description));
      }
      dialog.appendChild(content);
      if (opts.footer) dialog.appendChild(opts.footer);
      root.appendChild(mask);
      root.appendChild(dialog);

      var closed = false;
      function close() {
        if (closed) return; // onClose 只回一次：按钮 close() 之后浏览器再派发 Escape/mask 的残余事件
        closed = true;
        if (root.parentNode) root.parentNode.removeChild(root);
        document.removeEventListener('keydown', onKey, true);
        if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
        if (opts.onClose) { try { opts.onClose(); } catch (e) { /* 关闭回调失败不影响主流程 */ } }
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
      }
      mask.addEventListener('click', close);
      closeBtn.addEventListener('click', close);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(root);
      var target = opts.autofocus || dialog;
      if (typeof target.focus === 'function') target.focus();
      return { close: close, root: root, dialog: dialog };
    }

    function domButton(cls, label, onClick) {
      var b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    }

    // 官方 RiskConfirmation 形态：warning(图标+描述) + footer(outline 取消 + primary 确认)
    // confirmOpen 只防「重复弹窗」，不复位就是 issue #2：x/遮罩关闭后 openConfirm 永久失效。
    // 复位挂在 openModal 的 onClose 上——四条关闭路径（取消/重启按钮、x、遮罩、Escape）都经过它。
    var confirmOpen = false;
    function openConfirm(o) {
      if (confirmOpen) return;
      confirmOpen = true;
      var body = el('div', 'dsrn-warning');
      body.appendChild(svgEl(ICON_WARN, 18, 'dsrn-warning-icon'));
      body.appendChild(el('p', null, o.body));
      var bodyWrap = el('div', null);
      bodyWrap.appendChild(body);
      var footer = el('div', 'dsrn-modal-footer');
      footer.appendChild(domButton('dsrn-button dsrn-md dsrn-outline dsrn-modal-action', o.cancelLabel || t('cancel'), function () { m.close(); }));
      footer.appendChild(domButton('dsrn-button dsrn-md dsrn-primary dsrn-confirm-action', o.okLabel || t('ok'), function () { m.close(); if (o.onOk) o.onOk(); }));
      var m = openModal({ title: o.title || navLabel(), body: bodyWrap, footer: footer, autofocus: footer.lastChild, onClose: function () { confirmOpen = false; } });
    }

    // 官方 Modal 单键提示形态：description 文本 + primary 确定
    function openNotice(o) {
      var footer = el('div', 'dsrn-modal-footer');
      footer.appendChild(domButton('dsrn-button dsrn-md dsrn-primary dsrn-modal-action', o.okLabel || t('ok'), function () { m.close(); }));
      var m = openModal({ title: o.title || navLabel(), description: o.body, footer: footer, autofocus: footer.firstChild });
    }

    // —— v1.4.0 保存反馈 toast（设置页实时保存的提示形态）——
    // 用官方 Toast 原语（@deepseek-ai/dsh-client-ui-primitives.Toast，v0.10 起已 require 的同一个包；
    // asar 实锤：sidebar「版本已复制」= tone:"success"+text+onDone，plugin-manager 的警告 = icon+IconWarningOutlineRegular）。
    // 官方组件管理自身动画；行内兜底的失败保留至下一次反馈。
    // 不写任何自绘 toast CSS——样式/动画/时长全由官方组件管理。
    // 落点：官方包没有独立 render 导出、本插件无 react-dom 依赖，但 Toast 在官方代码里
    // 都是「随所属 React 树渲染」的（sidebar 根组件、plugin-manager 面板内）——我们把它挂进
    // 设置页组件树（RestartSection 的 React 元素），而不是命令式插 DOM。见 saveToast 元素。
    var saveToast = null;          // null | { ok: boolean, reason: string, seq: number }
    var saveToastSeq = 0;
    function showSaveToast(ok, reason) {
      saveToastSeq += 1;
      saveToast = { ok: ok, reason: reason || '', seq: saveToastSeq };
      notifyCfg(); // 复用 cfg 订阅通道：设置页重渲染并消费 saveToast
      if ((OfficialToast || ok) && typeof setTimeout === 'function') {
        var seq = saveToastSeq;
        setTimeout(function () {
          if (saveToast && saveToast.seq === seq) { saveToast = null; notifyCfg(); }
        }, ok ? 2500 : 8000);
      }
    }

    // —— 设置导航行图标增强（v0.16 定案机制；v0.19 移除排查遥测）——
    // 宿主 navIcon(id) 按 section id 硬编码图标，未知 id 回退齿轮（asar L477884）；
    // descriptor 无 icon 字段，契约内改不了 → 每个第三方 section 都戴齿轮（dshmarket 也是）。
    // dshmarket settings-nav-icon.ts 的做法：认领自己的导航行（marker 属性 + 注入样式），
    // [marker]>svg{display:none} 藏宿主图标，[marker]::before 用 mask-image 画自己的图标
    // （mask 只读 SVG 的 alpha 通道，颜色随 currentColor，选中/hover 状态自动跟随）。
    // v0.16 遥测定案：真机设置面板没有 role=dialog / data-shortcut-modal 属性，但导航行
    // （含「重启应用」）就在 light DOM 的 nav button 里 → 认领选择器 = 全文档 'nav button'
    // 按文本精确匹配（v0.13/v0.14 的面板圈定选择器因此永不命中）。v0.19：排查用
    // census / 1.5s 巡检 / navdiag 回传已移除（使命完成）；若图标回归，按 02/03 文档
    // v0.15–v0.16 勘误记录的机制与数据恢复诊断。
    var NAV_ROW_MARKER = 'data-dsh-restart-now-nav-icon';
    var MASK_SVG =
      "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='#000' stroke-width='1.3'>" +
      "<path d='" + REFRESH_PATHS[0] + "'/><path d='" + REFRESH_PATHS[1] + "'/></svg>";
    var NAV_CSS = [
      '[' + NAV_ROW_MARKER + ']{-webkit-mask-image:none;mask-image:none}',
      '[' + NAV_ROW_MARKER + ']>svg{display:none}',
      '[' + NAV_ROW_MARKER + ']::before{content:"";flex:none;width:16px;height:16px;' +
        'background-color:currentColor;' +
        '-webkit-mask-image:url("data:image/svg+xml,' + encodeURIComponent(MASK_SVG) + '");' +
        'mask-image:url("data:image/svg+xml,' + encodeURIComponent(MASK_SVG) + '");' +
        '-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;' +
        '-webkit-mask-position:center;mask-position:center;' +
        '-webkit-mask-size:16px 16px;mask-size:16px 16px}',
    ].join('\n');
    if (typeof document !== 'undefined' &&
        document.querySelector('style[data-plugin-css="dsh-restart-now/nav-icon.css"]') === null) {
      var navTag = document.createElement('style');
      navTag.dataset.plugin = 'dsh-restart-now';
      navTag.dataset.pluginCss = 'dsh-restart-now/nav-icon.css';
      navTag.textContent = NAV_CSS;
      document.head.appendChild(navTag);
    }
    function sweepNavIcon() {
      if (typeof document === 'undefined' || !document.body) return;
      // 认领动作（v0.16，遥测定案）：全文档 nav button 按文本精确匹配「重启应用 / Restart app」，
      // 打 marker 藏宿主齿轮、::before mask 画官方 Refresh；失配清除（locale 切换后重认领）。
      // v1.2.1 碰撞修复：1.2.0 起侧栏左上面板行也是 nav button 且同文本，会被误认领——
      // ::before 多画一个图标，而 `[marker]>svg{display:none}` 只藏直接子级 svg，面板行的
      // 图标包在 span.panelGlyph 里藏不掉 → 按钮双图标。两类行的结构差异：设置导航行的
      // 宿主图标是**直接子级 svg**（`>svg` 藏齿轮规则即证），面板行不是 → 用
      // `:scope > svg` 存在性把面板行排除，只认领设置行。
      try {
        var buttons = document.querySelectorAll('nav button');
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          var text = (btn.textContent || '').trim();
          var isSettingsRow = NAV_LABELS.indexOf(text) !== -1 &&
            (typeof btn.querySelector === 'function' ? btn.querySelector(':scope > svg') !== null : true);
          if (isSettingsRow) {
            if (!btn.hasAttribute(NAV_ROW_MARKER)) btn.setAttribute(NAV_ROW_MARKER, '');
          } else if (btn.hasAttribute(NAV_ROW_MARKER)) {
            btn.removeAttribute(NAV_ROW_MARKER);
          }
        }
      } catch (e) { void e; /* 增强失败不影响任何功能 */ }
    }
    var navObs = null;
    function startNavEnhance() {
      sweepNavIcon();
      if (typeof MutationObserver !== 'undefined' && !navObs) {
        var timer = null;
        navObs = new MutationObserver(function () {
          if (timer) return;
          timer = setTimeout(function () {
            timer = null;
            try { sweepNavIcon(); } catch (e) { void e; }
          }, 150);
        });
        navObs.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
    }

    // —— 状态与动作 ——
    var busy = { v: false, kind: 'restart' };
    function setBusy(v, kind) { busy.v = v; if (kind) busy.kind = kind; waitSubs.forEach(function (f) { try { f(); } catch(e) { void e; } }); syncTitlebar(); }
    function actionLabel() { return busy.kind === 'close' ? t('closing') : t('restarting'); }
    function actionIcon(icon) { return (busy.v || isWaiting()) ? React.createElement('span', { className: 'dsrn-spinner', 'aria-hidden': 'true' }) : icon; }
    function useActionState() { var tick = React.useState(0), bump = tick[1]; React.useEffect(function () { var f = function () { bump(function (n) { return n + 1; }); }; waitSubs.push(f); return function () { var i = waitSubs.indexOf(f); if (i >= 0) waitSubs.splice(i, 1); }; }, []); }
    function timedFetch(url, options) { var timer; return Promise.race([fetch(url, options), new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('timeout')); }, 30000); })]).finally(function () { clearTimeout(timer); }); }
    // 最近一次发起的停机动作：fetch 因进程退出而中断属预期，界面/调试标记据此区分重启与仅关闭
    var lastAction = 'restart';
    var liveCfg = null; // 探测口挂载时/设置表单加载保存后更新；重启与 footer 可见性优先用最新值
    var saveReason = ''; // v0.17：最近一次保存失败的服务端原因（如 exe-path-invalid）
    var derivedExe = ''; // v0.18：GET /config 回传的自动推导路径（服务端 resolveExe）
    // v1.1：探测口回传的运行快照（版本判定 / 上次重启回执 / 等待状态），只读展示用
    // v1.3.1：closeSupported = 助手是否支持 action:'close'（false 时关闭入口一律不渲染）
    var liveMeta = { version: null, supportedRange: '', supported: null, lastRestart: null, closeSupported: false };
    var waitSubs = [];  // 等待状态订阅（设置页与 footer 共享）
    var waitState = { state: 'idle', since: 0, remainingMs: 0, tasks: 0, jobs: 0 };
    function setWaitState(next) {
      waitState = next || { state: 'idle', since: 0, remainingMs: 0, tasks: 0, jobs: 0 };
      waitSubs.forEach(function (fn) { try { fn(); } catch (e) { void e; } });
      syncTitlebar();
    }
    function isWaiting() { return waitState.state === 'waiting'; }
    // 等待期间每 2s 拉一次 /status（宿主自己 5s 复检；这里只负责把倒计时/结束同步到界面）。
    var waitPoll = null;
    function stopWaitPoll() {
      if (waitPoll) { clearInterval(waitPoll); waitPoll = null; }
    }
    function startWaitPoll() {
      if (waitPoll || typeof setInterval === 'undefined') return;
      waitPoll = setInterval(function () {
        fetch(STATUS, { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.ok) setWaitState(j); })
          .catch(function () { /* 宿主正在重启：轮询失败属预期 */ });
      }, 2000);
    }
    function refreshWait(snapshot) {
      setWaitState(snapshot);
      if (snapshot && snapshot.state === 'waiting') startWaitPoll();
      else stopWaitPoll();
    }
    // v0.19：exePath 预填（用户要求）——文件层为空时把自动推导路径直接填进输入框。
    // 仅影响表单显示；保存时若值仍等于推导值则落盘 ''（保持「自动跟随当前安装目录」
    // 语义，见 save 处注释），手动改成其他路径才真正固定到文件。
    function withDerived(c) {
      if (c && !c.exePath && derivedExe) {
        var n = Object.assign({}, c);
        n.exePath = derivedExe;
        return n;
      }
      return c;
    }
    var cfgSubs = [];   // v0.12：配置变化订阅（footer 响应式隐藏）
    function notifyCfg() { cfgSubs.forEach(function (fn) { try { fn(); } catch (e) { void e; } }); }
    function effectiveCfg() {
      return liveCfg || exports.__restartCfg || {};
    }

    // —— v1.2.2：入口开关（真相在配置文件；localStorage 只做首帧缓存）——
    // 读：内存 → 配置层（探测口/GET /config 回传，含旧键映射）→ 首帧缓存 → 默认全开
    // 写：setEntry 立即改内存并撤/加注册（界面即时响应），同时把**全量 8 键**写回 /config；
    //     写失败不吞（issue #1 的次生原因就是静默失败）：pendingEntriesWrite 记待重试值，
    //     设置页渲染红字提示，下次打开设置页自动重试一次。
    var entries = null;
    var entrySubs = [];
    var pendingEntriesWrite = null;   // { 短键: bool } 尚未成功落盘的值（null = 无待写）
    var entryWriteFailed = false;     // 最近一次写回是否失败（设置页据此显示红字）
    function notifyEntries() { entrySubs.forEach(function (fn) { try { fn(); } catch (e) { void e; } }); }
    function subscribeEntries(fn) {
      entrySubs.push(fn);
      return function () { var i = entrySubs.indexOf(fn); if (i >= 0) entrySubs.splice(i, 1); };
    }
    function readEntryCache() {
      try {
        var raw = window.localStorage.getItem(ENTRY_STORE);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        var out = {};
        for (var i = 0; i < ENTRY_KEYS.length; i += 1) {
          var k = ENTRY_KEYS[i];
          if (typeof parsed[k] === 'boolean') out[k] = parsed[k];
        }
        return out;
      } catch (e) { return null; }
    }
    /** 配置层是否已经「明确表过态」——迁移的唯一判据（表过态 → 永不迁移）。
     *  v1.2.2 勘误：判据必须来自服务端的 `entriesDeclared`，**不能看 config 对象**——
     *  effectiveConfig() 必然叠加 DEFAULTS 的四个 entry 键，用它判会恒为真，迁移在生产里永不触发
     *  （单测当时直接喂裸配置，绕过了服务端合并，所以没抓到）。
     *  entriesDeclaredFlag 三态：null = 宿主旧版没这个字段（保守按「已表态」处理，宁可不迁移）；
     *  true = 用户/patch 写过 entry 键；false = 从没写过 → 该迁移。 */
    var entriesDeclaredFlag = null;
    function configHasEntries() {
      return entriesDeclaredFlag !== false;
    }
    function adoptDeclared(v) {
      if (typeof v === 'boolean') entriesDeclaredFlag = v;
    }
    function entriesFromConfig(cfg) {
      // 服务端说「配置文件没表过态」时，cfg 里的 entry 值只是 DEFAULTS 回声，不能当真相用
      if (!cfg || typeof cfg !== 'object' || !configHasEntries()) return null;
      var out = {};
      var seen = false;
      for (var i = 0; i < ENTRY_KEYS.length; i += 1) {
        var k = ENTRY_KEYS[i];
        var v = cfg[ENTRY_CONF[k]];
        if (typeof v === 'boolean') { out[k] = v; seen = true; }
      }
      return seen ? out : null;
    }
    function defaultEntries() {
      // 默认全开（旧键 hideSidebarButton 的映射在宿主的 clampConfig 里做过，客户端不再处理）
      var out = {};
      for (var i = 0; i < ENTRY_KEYS.length; i += 1) out[ENTRY_KEYS[i]] = true;
      return out;
    }
    function getEntries() {
      if (!entries) {
        entries = Object.assign(defaultEntries(), readEntryCache() || {}, entriesFromConfig(effectiveCfg()) || {});
      }
      return entries;
    }
    /** 首帧缓存：只写 localStorage，纯加速，失败无所谓。 */
    function cacheEntries(next) {
      try { window.localStorage.setItem(ENTRY_STORE, JSON.stringify(next)); } catch (e) { void e; }
    }
    /** 配置层已到达 → 以配置为准重建开关状态（迁移后的第一次、以及每次 GET /config 之后都走这里）。 */
    function adoptConfigEntries(cfg) {
      if (pendingEntriesWrite) return false;
      var fromCfg = entriesFromConfig(cfg);
      if (!fromCfg) return false;
      entries = Object.assign(defaultEntries(), fromCfg);
      cacheEntries(entries);
      return true;
    }
    // 所有整文件 POST 共用单一队列。每个操作只覆盖自己修改的字段，基于上一次成功的配置组包。
    // 失败字段独立保留，其他字段成功不能把失败伪装成成功。
    var configQueue = Promise.resolve();
    var configRevision = 0;
    var configPending = 0;
    var failedConfig = {};
    var fieldRevision = {};
    var pendingFields = {};
    var pendingIntent = {}; // 最新排队意图；设置页重挂载时不能显示旧的 liveCfg
    var exeDraft = null; // null 表示无未提交的路径草稿（空字符串也是有效草稿）
    var configSlow = false;
    var configUnknown = false; // 无法证明是否落盘时，不再发出后续整文件写入
    function queueConfigPatch(patch) {
      var revisions = {};
      Object.keys(patch).forEach(function (key) {
        fieldRevision[key] = (fieldRevision[key] || 0) + 1;
        revisions[key] = fieldRevision[key];
        pendingIntent[key] = { revision: revisions[key], value: patch[key] };
        pendingFields[key] = (pendingFields[key] || 0) + 1;
      });
      configRevision += 1;
      configPending += 1;
      if (saveToast && saveToast.ok) saveToast = null;
      notifyCfg();
      var operation = configQueue.then(function () {
        // 仅提示耗时，不中止请求或放行队列：超时不证明服务端不会迟到写盘。
        var slowTimer = setTimeout(function () { configSlow = true; notifyCfg(); }, 30000);
        var base = effectiveCfg() || {};
        var body = {
          allowRestart: base.allowRestart !== false, confirm: base.confirm !== false,
          exePath: base.exePath || '', platformAuth: base.platformAuth !== false,
        };
        ENTRY_KEYS.forEach(function (key) { body[ENTRY_CONF[key]] = base[ENTRY_CONF[key]] !== false; });
        Object.assign(body, patch);
        return Promise.resolve().then(function () {
          return fetch(CONFIG, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok || !j || !j.ok || !j.config) {
              var error = new Error(j && j.reason || '');
              // 只有明确的 4xx 拒绝才可确定尚未写盘；网络/5xx/无效响应均视为未知。
              error.definiteRejection = r.status >= 400 && r.status < 500 && j && j.ok === false;
              throw error;
            }
            return j;
          });
        }).then(function (j) {
          liveCfg = j.config;
          adoptDeclared(j.entriesDeclared === undefined ? true : j.entriesDeclared);
          Object.keys(patch).forEach(function (key) {
            if (fieldRevision[key] === revisions[key]) delete failedConfig[key];
          });
          if (Object.prototype.hasOwnProperty.call(patch, 'exePath') &&
              fieldRevision.exePath === revisions.exePath && exeDraft !== null &&
              (exeDraft === derivedExe ? '' : exeDraft) === patch.exePath) exeDraft = null;
          if (pendingEntriesWrite && ENTRY_KEYS.every(function (key) {
            var conf = ENTRY_CONF[key];
            return !failedConfig[conf] && (j.config[conf] !== false) === (pendingEntriesWrite[key] !== false);
          })) {
            pendingEntriesWrite = null;
            entryWriteFailed = false;
            adoptConfigEntries(j.config);
          }
          notifyEntries(); notifyCfg();
          if (configPending === 1 && Object.keys(failedConfig).length === 0) showSaveToast(true, '');
          return true;
        }).catch(function (error) {
          Object.keys(patch).forEach(function (key) {
            if (fieldRevision[key] === revisions[key]) failedConfig[key] = { value: patch[key], reason: error.message || '' };
          });
          entryWriteFailed = ENTRY_KEYS.some(function (key) { return !!failedConfig[ENTRY_CONF[key]]; });
          notifyEntries(); notifyCfg();
          showSaveToast(false, error.message || '');
          if (!error.definiteRejection) {
            // 响应断开或服务端错误可能发生在写盘之后；绝不能用旧快照放行后续写。
            clearTimeout(slowTimer);
            configUnknown = true;
            notifyCfg();
            return new Promise(function () {});
          }
          return false;
        }).finally(function () {
          clearTimeout(slowTimer);
          configSlow = false;
        });
      });
      operation = operation.finally(function () {
        configPending -= 1;
        Object.keys(patch).forEach(function (key) {
          pendingFields[key] -= 1;
          if (!pendingFields[key]) delete pendingFields[key];
          if (pendingIntent[key] && pendingIntent[key].revision === revisions[key]) delete pendingIntent[key];
        });
        notifyCfg();
      });
      configQueue = operation.catch(function () { return false; });
      return operation;
    }
    function saveEntries(pending) {
      var next = Object.assign({}, getEntries(), pending || {});
      pendingEntriesWrite = next;
      var patch = {};
      ENTRY_KEYS.forEach(function (key) { patch[ENTRY_CONF[key]] = next[key] !== false; });
      return queueConfigPatch(patch);
    }
    /** 开关被拨动：立即生效（撤销/恢复注册），并写回配置层。 */
    function setEntry(key, on) {
      var next = Object.assign({}, getEntries());
      next[key] = !!on;
      entries = next;
      cacheEntries(next);
      notifyEntries();
      saveEntries(next);
    }
    /** 打开设置页时的自动重试：上次没写成功，就把待写值再试一次。 */
    function retryPendingEntries() {
      if (!pendingEntriesWrite || ENTRY_KEYS.some(function (key) { return pendingFields[ENTRY_CONF[key]]; })) return;
      var pending = pendingEntriesWrite;
      saveEntries(pending);
    }
    /** 一次性迁移（issue #1 修法③）：配置层从来没有 entry 键（服务端 entriesDeclared:false）、
     *  而首帧缓存里有旧值时，把缓存里的值整体写进配置层一次。判据是「服务端说没表过态」，
     *  所以用户以后手动改配置（哪怕只是其中一两个键）都不会被迁移逻辑覆盖回去。 */
    function migrateEntries() {
      if (pendingEntriesWrite || configHasEntries()) return false; // 待写值优先，配置层已有则永不迁移
      var cached = readEntryCache();
      if (!cached) return false;                      // 没有旧值 → 没什么可迁
      entries = Object.assign(defaultEntries(), getEntries(), cached);
      cacheEntries(entries);
      notifyEntries();
      saveEntries(entries);
      return true;
    }

    // —— v1.3.1 停机后有界轮询（watchRestartOutcome）——
    // 202 派发后正常路径是进程被杀（fetch 中断 = 服务没了 = 静默，窗口马上要关，绝不弹窗）；
    // 失败路径（助手身份核验拒绝 / 主进程没停等）进程活着、页面还在，得把失败说给人听。
    // 每 2s 拉一次探测口：页面活过 20s（正常停机主进程 <1s 就死）才有资格下结论——
    //   回执 failed → 「重启已中止：原因」（close 用「关闭已中止」），busy.v 复位可重试；
    //   ok/closed 且 ageMs 小（回执是本次派发的，新实例已起来但旧页面还活着，罕见）→ 静默停；
    //   一直没有 failed 标记（unconfirmed）→ 「重启似乎没有生效：应用仍在运行」，busy.v 复位。
    // 90s 总预算到点放弃并停止（放弃不弹窗：能确定失败的分支 20s 时就已经说完了）。
    var RESTART_WATCH_INTERVAL = 2000;
    var RESTART_WATCH_FAIL_AFTER = 20000;
    var RESTART_WATCH_BUDGET = 90000;
    var restartWatch = null;
    function stopRestartWatch() {
      if (restartWatch) { clearInterval(restartWatch); restartWatch = null; }
    }
    /** startedAt：派发起始（20s 判定线与 90s 预算都从这里起算）；kind：'restart' | 'close'（文案分叉）。 */
    function watchRestartOutcome(startedAt, kind) {
      stopRestartWatch(); // 连发时以最后一次派发为准：旧轮询作废、重新计时
      if (typeof setInterval === 'undefined' || typeof clearInterval === 'undefined') return;
      var mine = setInterval(function () {
        if (restartWatch !== mine) return;               // 已被新一轮派发接管：本轮回调全部作废
        if (Date.now() - startedAt > RESTART_WATCH_BUDGET) {
          stopRestartWatch();
          setBusy(false);
          openNotice({ title: navLabel(), body: t('resultUnknown', { r: 'timeout' }) });
          return;
        }
        fetch(PROBE, { credentials: 'same-origin' })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (body) {
            if (restartWatch !== mine) return;           // 在途响应回来时轮询已被停掉/换掉：丢弃
            if (!body || typeof body !== 'object') return;   // JSON 不成形：按仍在停机对待，继续等
            if (Date.now() - startedAt <= RESTART_WATCH_FAIL_AFTER) return; // 20s 内不下结论
            var last = body.lastRestart || null;
            if (last && last.status === 'failed') {
              // 助手把失败写进了回执（identity-verification-failed / main-not-stopped …）
              stopRestartWatch();
              setBusy(false);
              openNotice({
                title: kind === 'close' ? t('closeNow') : navLabel(),
                body: kind === 'close' ? t('closeAborted', { r: last.reason || 'unknown' })
                  : t('restartAborted', { r: last.reason || 'unknown' }),
              });
              return;
            }
            if (last && (last.status === 'ok' || last.status === 'closed')
                && Number(last.ageMs) <= RESTART_WATCH_BUDGET) {
              // 收到回执后恢复
              stopRestartWatch();
              setBusy(false);
              return;
            }
            // 回执没有 failed 标记（unconfirmed）：进程一直活着，宿主也没写失败 → 重启没生效
            stopRestartWatch();
            setBusy(false);
            openNotice({
              title: kind === 'close' ? t('closeNow') : navLabel(),
              body: kind === 'close' ? t('closeNotEffective') : t('restartNotEffective'),
            });
          })
          .catch(function () {
            // 服务没了 = 正常停机进行中：窗口马上要关，静默停止（绝不能在这时弹窗）
            void mine; // 网络中断不能证明成功，继续到总预算
          });
      }, RESTART_WATCH_INTERVAL);
      restartWatch = mine;
    }

    // 重启请求：query 决定宿主走哪条路（?force=1 越过任务守卫 / ?wait=1 等空闲 / ?cancel=1 撤销等待）
    function postRestart(query) {
      if (busy.v) return;
      setBusy(true, 'restart');
      lastAction = 'restart';
      var startedAt = Date.now(); // 有界轮询的计时起点
      // 同源 POST：Origin 由浏览器自补（v0.6 勘误：origin 是 forbidden header）
      timedFetch(ACTION + (query || ''), { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (res) {
          var body = res.body || {};
          if (res.status === 202 && body.ok) {
            if (body.mode === 'waiting') {
              // 等待模式：宿主在后台盯着任务，界面只显示「等待中」+ 撤销
              setBusy(false);
              refreshWait({ state: 'waiting', since: body.since || Date.now(), remainingMs: body.remainingMs || 0, tasks: body.tasks || 0, jobs: body.jobs || 0 });
              openNotice({ title: navLabel(), body: t('waitingBody') });
            } else {
              window.__dsh_restart_now__ = 'restarting';
              // v1.3.1：202 已派发。正常路径进程 <1s 就死（页面随后消失）；若页面还活着，
              // 有界轮询负责在 20s 后把失败说给人听（见 watchRestartOutcome）。
              watchRestartOutcome(startedAt, 'restart');
            }
            return;
          }
          setBusy(false);
          if (res.status === 409 && body.reason === 'busy') {
            // v1.1：有任务在跑时不再直接拒绝，而是给出三条路（官方口径：让用户自己判断）
            askBusy(body.tasks || 0, body.jobs || 0);
            return;
          }
          if (res.status === 409 && body.reason === 'installing') {
            openNotice({ title: navLabel(), body: t('installing') });
            return;
          }
          if (res.status === 409 && body.reason === 'cooldown') {
            // v1.2.1 第 22 项：刚派发过重启（连点）。轻提示，不当故障。
            var waitSeconds = Math.max(1, Math.ceil((body.retryAfterMs || 0) / 1000));
            openNotice({ title: navLabel(), body: t('cooldown', { s: waitSeconds }) });
            return;
          }
          if (res.status === 401) {
            // v1.2.1：平台会话鉴权拦下本页（未带/已过期凭据）。
            // 单独给文案：这里不是「没权限重启」，而是壳层没认这个页面，用户需要知道逃生门在哪。
            openNotice({ title: navLabel(), body: t('unauthorized') });
            return;
          }
          if (res.status === 403) {
            openNotice({ title: navLabel(), body: t('forbidden') });
            return;
          }
          var reason = body.reason || ('HTTP ' + res.status);
          openNotice({ title: navLabel(), body: t('rejected', { r: reason }) });
        })
        .catch(function (e) {
          setBusy(false); openNotice({ title: navLabel(), body: t('resultUnknown', { r: e.message || 'network error' }) });
        });
    }

    // —— v1.3.1 仅关闭（close-only）：POST /close，停机后不拉起，窗口由用户手动打开 ——
    // 入口只在主面板与设置页（footer/header 等快速入口仍是重启）；确认文案必须明确「不会自动重启」
    // ——这是与重启确认（“窗口会自动回来”）最大的语义差别。忙碌时只有「仍然关闭/取消」，
    // 没有「等空闲」：等待模式的终局是一次重启，与仅关闭冲突，刻意不复用。
    function postClose(query) {
      if (busy.v) return;
      setBusy(true, 'close');
      lastAction = 'close';
      var startedAt = Date.now(); // 同 restart：有界轮询的计时起点
      // 同源 POST：Origin 由浏览器自补；门禁在宿主侧与 /restart 完全同序
      timedFetch(CLOSE + (query || ''), { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (res) {
          var body = res.body || {};
          if (res.status === 202 && body.ok) {
            window.__dsh_restart_now__ = 'closing';
            // v1.3.1：close 同样有界轮询——关成功 = 页面死掉（同静默逻辑）；关失败要可见
            watchRestartOutcome(startedAt, 'close');
            return;
          }
          setBusy(false);
          if (res.status === 501 && body.reason === 'close-helper-missing') {
            // 能力位缺位的兜底话术：正常情况下 closeSupported:false 时入口根本不渲染
            openNotice({ title: t('closeNow'), body: t('closeUnsupported') });
            return;
          }
          if (res.status === 409 && body.reason === 'busy') {
            // 有任务在跑：与重启同口径给出计数，但只有「仍然关闭」一条强制路（没有等待）
            askCloseBusy(body.tasks || 0, body.jobs || 0);
            return;
          }
          if (res.status === 409 && body.reason === 'installing') {
            openNotice({ title: navLabel(), body: t('installing') });
            return;
          }
          if (res.status === 409 && body.reason === 'cooldown') {
            // 冷却窗口与重启共用（同一次停机派发计数）；轻提示，不当故障
            var waitSeconds = Math.max(1, Math.ceil((body.retryAfterMs || 0) / 1000));
            openNotice({ title: navLabel(), body: t('closeCooldown', { s: waitSeconds }) });
            return;
          }
          if (res.status === 401) {
            openNotice({ title: navLabel(), body: t('unauthorized') });
            return;
          }
          if (res.status === 403) {
            openNotice({ title: navLabel(), body: t('forbidden') });
            return;
          }
          var reason = body.reason || ('HTTP ' + res.status);
          openNotice({ title: navLabel(), body: t('closeRejected', { r: reason }) });
        })
        .catch(function (e) {
          setBusy(false); openNotice({ title: t('closeNow'), body: t('resultUnknown', { r: e.message || 'network error' }) });
        });
    }

    // 关闭的忙碌二选一：仍然关闭 / 取消。刻意没有「等空闲后重启」——等待终局是重启。
    function askCloseBusy(tasks, jobs) {
      var m;
      var footer = el('div', 'dsrn-modal-footer');
      var cancel = domButton('dsrn-button dsrn-md dsrn-outline dsrn-modal-action', t('cancel'), function () { m.close(); });
      var force = domButton('dsrn-button dsrn-md dsrn-primary dsrn-confirm-action', t('closeAnyway'), function () { m.close(); postClose('?force=1'); });
      footer.appendChild(cancel);
      footer.appendChild(force);
      m = openModal({
        title: t('busyTitle'),
        description: t('closeBusyBody', { t: tasks, j: jobs }),
        footer: footer,
        autofocus: force,
      });
    }

    function doClose() {
      if (busy.v || isWaiting()) return;
      var effective = effectiveCfg();
      if (effective.allowRestart === false) {
        openNotice({ title: t('closeNow'), body: t('closeDisabled') });
        return;
      }
      // 仅关闭始终要求明确确认，即使重启的二次确认开关已关闭。
      openConfirm({
        title: t('closeNow'),
        body: t('closeConfirmBody'),
        okLabel: t('closeNow'), cancelLabel: t('cancel'),
        onOk: function () { postClose(''); },
      });
    }

    // 忙碌三选一：仍然重启 / 等空闲后重启 / 取消（对齐竞品 1 的守卫，但文案说清代价）
    function askBusy(tasks, jobs) {
      var m;
      var footer = el('div', 'dsrn-modal-footer');
      var cancel = domButton('dsrn-button dsrn-md dsrn-outline dsrn-modal-action', t('cancel'), function () { m.close(); });
      var wait = domButton('dsrn-button dsrn-md dsrn-outline dsrn-modal-action', t('waitStart'), function () { m.close(); postRestart('?wait=1'); });
      var force = domButton('dsrn-button dsrn-md dsrn-primary dsrn-confirm-action', t('forceStart'), function () { m.close(); postRestart('?force=1'); });
      footer.appendChild(cancel);
      footer.appendChild(wait);
      footer.appendChild(force);
      m = openModal({
        title: t('busyTitle'),
        description: t('busyBody', { t: tasks, j: jobs }),
        footer: footer,
        autofocus: force,
      });
    }

    function cancelWait() {
      if (busy.v) return;
      setBusy(true, 'restart');
      timedFetch(ACTION + '?cancel=1', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) { setBusy(false); if (res.ok && res.body.cancelled) refreshWait({ state: 'idle' }); else openNotice({ title: navLabel(), body: t('rejected', { r: res.body.reason || 'cancel failed' }) }); })
        .catch(function (e) { setBusy(false); openNotice({ title: navLabel(), body: t('rejected', { r: e.message || 'network error' }) }); });
    }

    function doPreflight() {
      fetch(PREFLIGHT, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
        .then(function (res) {
          var b = res.body || {};
          if (!res.ok || !b.ok || !b.checks) { openNotice({ title: t('preflight'), body: t('preflightFailed', { r: b.reason || 'unknown' }) }); return; }
          var c = b.checks, lock = c.lock || {}, busyInfo = c.busy || {}, exe = c.executable || {}, main = c.mainProcess || {};
          openNotice({ title: t('preflight'), body: t('preflightResult', {
            env: c.environment || 'unknown', platform: String(c.platformSupported), enabled: String(c.enabled),
            lock: lock.state || 'unknown', tasks: busyInfo.tasks == null ? 'unknown' : busyInfo.tasks,
            jobs: busyInfo.jobs == null ? 'unknown' : busyInfo.jobs, cooldown: c.cooldownMs || 0,
            exe: exe.path || 'unknown', usable: String(exe.usable), pid: main.pid || 'unknown',
          }) });
        }).catch(function () { openNotice({ title: t('preflight'), body: t('preflightFailed', { r: 'network error' }) }); });
    }

    function doRestart() {
      if (busy.v) return;
      if (isWaiting()) { cancelWait(); return; }
      var effective = effectiveCfg();
      if (effective.allowRestart === false) {
        openNotice({ title: navLabel(), body: t('disabled') });
        return;
      }
      if (effective.confirm !== false) {
        openConfirm({
          title: navLabel(),
          body: t('confirmBody'),
          okLabel: t('restart'), cancelLabel: t('cancel'),
          onOk: function () { postRestart(''); },
        });
        return;
      }
      postRestart('');
    }

    // —— sidebar.footer.action 入口：官方 panelRow 全宽行形态（同「任务」导航行）——
    // PanelRow DOM（sidebar-client.js L173-200）：button[panelRow] > span[panelGlyph](图标 wide?16:18) + wide&&span[panelTitle](文字)
    function RestartFooterAction(props) {
      useActionState();
      props = props || {};
      var wide = !!props.wide;
      // v1.2.2：显示与否看配置层的 entryFooter（getEntries 已合并默认/缓存/配置三层）
      var st = React.useState(getEntries().footer !== false);
      var visible = st[0];
      var setVisible = st[1];
      React.useEffect(function () {
        var fn = function () { setVisible(getEntries().footer !== false); };
        var off = subscribeEntries(fn);
        fn();
        return off;
      }, []);
      // 语言晚到/切换 → 重渲染（标题与 aria-label 都取 navLabel()）
      var langTick = React.useState(0);
      var bumpLang = langTick[1];
      React.useEffect(function () {
        var fn = function () { bumpLang(function (n) { return n + 1; }); };
        langSubs.push(fn);
        return function () { var i = langSubs.indexOf(fn); if (i >= 0) langSubs.splice(i, 1); };
      }, []);
      if (!visible) return null;
      return React.createElement('button', {
        type: 'button',
        className: 'dsrn-row' + (wide ? '' : ' dsrn-collapsed'),
        title: busy.v ? actionLabel() : (isWaiting() ? t('waitCancel') : navLabel()),
        'aria-label': busy.v ? actionLabel() : (isWaiting() ? t('waitCancel') : navLabel()),
        'aria-busy': busy.v, disabled: busy.v,
        onClick: doRestart,
      },
        React.createElement('span', { className: 'dsrn-glyph', 'aria-hidden': 'true' },
          actionIcon(React.createElement(RestartIcon, { size: wide ? 16 : 18, medium: true }))),
        wide ? React.createElement('span', { className: 'dsrn-title' }, busy.v ? actionLabel() : (isWaiting() ? t('waitCancel') : navLabel())) : null
      );
    }

    // —— v1.2 入口②：侧栏左上角面板（sidebar.panellist + main）——
    // 座位只把 { size, active } 传给图标：整行（按钮/tooltip/文字/选中态）都是侧栏自己画的，
    // 我们只提供图标，所以这一条看起来一定是官方的。
    function RestartPanelGlyph(props) {
      props = props || {};
      var size = typeof props.size === 'number' ? props.size : 16;
      return React.createElement(RestartIcon, { size: size, medium: true });
    }

    // 主区面板：点左上角那一条，侧栏调 ctx.layout.selectPanel(PANEL_ID) 切过来。
    // 面板不是「动作位」，所以给一个正经说明 + 主按钮（有官方 Button 就用官方本体）。
    function RestartPanel() {
      var langTick = React.useState(0);
      var bumpLang = langTick[1];
      React.useEffect(function () {
        var fn = function () { bumpLang(function (n) { return n + 1; }); };
        langSubs.push(fn);
        return function () { var i = langSubs.indexOf(fn); if (i >= 0) langSubs.splice(i, 1); };
      }, []);
      var waitTick = React.useState(0);
      var bumpWait = waitTick[1];
      React.useEffect(function () {
        var fn = function () { bumpWait(function (n) { return n + 1; }); };
        waitSubs.push(fn);
        return function () { var i = waitSubs.indexOf(fn); if (i >= 0) waitSubs.splice(i, 1); };
      }, []);

      var waiting = isWaiting();
      var disabled = (effectiveCfg().allowRestart === false && !waiting) || busy.v;
      var label = busy.v ? actionLabel() : (waiting ? t('waitCancel') : t('restartNow'));
      var onClick = waiting ? cancelWait : doRestart;

      var metaRows = [];
      if (liveMeta.version) {
        metaRows.push(t('version') + '：DSH ' + liveMeta.version
          + (liveMeta.supportedRange ? ' · ' + liveMeta.supportedRange.replace(/-0$/, '') : ''));
      }
      var last = liveMeta.lastRestart;
      if (last && last.status && last.status !== 'none') {
        var lastText = last.status === 'ok'
          ? t('lastOk', { s: Math.max(1, Math.round((last.downtimeMs || 0) / 1000)) })
            + (last.webListen && last.webListen.verdict === 'serving' ? ' · ' + t('lastServing') : '')
          : (last.status === 'closed' ? t('lastClosed') : (last.status === 'failed' ? t('lastFailed', { r: last.reason || 'unknown' }) : t('lastUnconfirmed')));
        metaRows.push(t('lastRestart') + '：' + lastText);
      }

      var button = OfficialButton
        ? React.createElement(OfficialButton, {
          variant: waiting ? 'outline' : 'primary',
          icon: actionIcon(React.createElement(RestartIcon, { size: 16 })),
          disabled: disabled,
          title: navLabel(),
          onClick: onClick,
        }, label)
        : React.createElement('button', {
          type: 'button',
          className: 'dsrn-button dsrn-md ' + (waiting ? 'dsrn-outline' : 'dsrn-primary'),
          disabled: disabled,
          title: navLabel(),
          onClick: onClick,
        },
          React.createElement('span', { className: 'dsrn-icon', 'aria-hidden': 'true' },
            actionIcon(React.createElement(RestartIcon, { size: 16 }))), label);

      // v1.3.1 仅关闭：主面板的第二个入口（outline 弱形态，与主按钮并列）。
      // 只在宿主回报 closeSupported（助手已实现 action:'close'）时渲染——
      // 否则一个「点关闭却重启了」的按钮比没有按钮糟糕得多。
      var closeButton = null;
      if (liveMeta.closeSupported) {
        closeButton = OfficialButton
          ? React.createElement(OfficialButton, {
            variant: 'outline',
            icon: actionIcon(React.createElement(CloseIcon, { size: 16 })),
            disabled: disabled || waiting,
            title: t('closeNow'),
            onClick: doClose,
          }, busy.v ? actionLabel() : t('closeNow'))
          : React.createElement('button', {
            type: 'button',
            className: 'dsrn-button dsrn-md dsrn-outline',
            disabled: disabled || waiting,
            title: t('closeNow'),
            onClick: doClose,
          },
            React.createElement('span', { className: 'dsrn-icon', 'aria-hidden': 'true' },
              actionIcon(React.createElement(CloseIcon, { size: 16 }))), busy.v ? actionLabel() : t('closeNow'));
      }

      var children = [
        React.createElement('h2', { className: 'dsrn-panel-title', key: 'title' }, t('panelTitle')),
        React.createElement('p', { className: 'dsrn-panel-desc', key: 'desc' }, t('panelDesc')),
      ];
      if (metaRows.length > 0) {
        children.push(React.createElement('div', { className: 'dsrn-panel-meta', key: 'meta' },
          metaRows.map(function (line, index) {
            return React.createElement('div', { key: 'meta-' + index }, line);
          })));
      }
      if (waiting) {
        children.push(React.createElement('div', { className: 'dsrn-gen-hint', key: 'wait' }, t('waitingBody')));
      }
      children.push(React.createElement('div', { className: 'dsrn-panel-actions', key: 'actions' }, button, closeButton));
      return React.createElement('div', { className: 'dsrn-panel' }, children);
    }

    // —— v1.2 入口③：会话标题栏按钮（conversation.session.header.actions）——
    // 同座位官方 ui-jobs 条目是 order 20，标题栏动作组左紧排：排在 20 之前，任务条目出现在我们右侧，按钮不动。
    function HeaderRestartButton() {
      useActionState();
      var langTick = React.useState(0);
      var bumpLang = langTick[1];
      React.useEffect(function () {
        var fn = function () { bumpLang(function (n) { return n + 1; }); };
        langSubs.push(fn);
        return function () { var i = langSubs.indexOf(fn); if (i >= 0) langSubs.splice(i, 1); };
      }, []);
      var waiting = isWaiting();
      var disabled = (effectiveCfg().allowRestart === false && !waiting) || busy.v;
      return React.createElement('button', {
        type: 'button',
        className: 'dsrn-hdr',
        title: navLabel(),
        'aria-label': busy.v ? actionLabel() : (waiting ? t('waitCancel') : navLabel()),
        'aria-busy': busy.v,
        disabled: disabled,
        onClick: waiting ? cancelWait : doRestart,
      },
        React.createElement('span', { className: 'dsrn-icon', 'aria-hidden': 'true' },
          actionIcon(React.createElement(RestartIcon, { size: 14, medium: true }))),
        React.createElement('span', { className: 'dsrn-hdr-label' }, busy.v ? actionLabel() : (waiting ? t('waitCancel') : t('headerLabel')))
      );
    }

    // —— v1.3.1 入口⑥：Windows 标题栏菜单「重启」项（shadow DOM 注入）——
    // 形态取自 _research/dsh-titlebar-restart（issue #5 用户指定的形态）：「应用 编辑 重启」，
    // 文字按钮直接 append 进 preload 画的 menubar（[data-windows-menu] 开放 shadow root），
    // 样式自动继承 preload 的 button{} 规则——与「编辑」同款 28px 高/10px 内边距/14px 字号。
    // 该 DOM 契约已对本机 0.2.2-rc.1 逐点验证（见 _research/asar 抽取）；上游改版时按钮
    // 静默不出现（无危险副作用）。非 Windows / dsh web 下宿主节点不存在 → 同样静默。
    // 确认交互：菜单场景弹不了 Modal → 两击式（第一次点变「确认重启」，4s 内再点才执行，
    // 超时自动弹回）。遵循「二次确认」总开关（confirm:false 时直接执行，与其它入口同语义）——
    // 用户裁定：开关关了点击就不问，直接重启。
    // 点击最终走 postRestart（受守卫 POST + 停机轮询），非竞品的裸直发。
    var TITLEBAR_BTN = 'data-dsrn-titlebar-restart';
    var titlebarState = { button: null, phase: 'idle', revertTimer: 0, mounted: false };
    function titlebarLabel() { return t('restart'); } // 「重启」/「Restart」，与菜单项等宽
    function titlebarSet(text, ariaHint) {
      var b = titlebarState.button;
      if (!b) return;
      b.textContent = text;
      if (ariaHint) b.setAttribute('aria-label', ariaHint);
      else b.removeAttribute('aria-label');
    }
    function titlebarReset() {
      titlebarState.phase = 'idle';
      if (titlebarState.revertTimer) { clearTimeout(titlebarState.revertTimer); titlebarState.revertTimer = 0; }
      var b = titlebarState.button;
      if (!b) return;
      b.disabled = false;
      titlebarSet(titlebarLabel());
    }
    function titlebarArm() {
      titlebarState.phase = 'confirm';
      titlebarSet(t('confirmRestart2'), t('confirmRestart2Hint'));
      if (titlebarState.revertTimer) clearTimeout(titlebarState.revertTimer);
      titlebarState.revertTimer = setTimeout(titlebarReset, 4000);
    }
    function titlebarFailed() {
      titlebarState.phase = 'failed';
      var b = titlebarState.button;
      if (b) b.disabled = false;
      titlebarSet(t('restartFailedShort'));
      if (titlebarState.revertTimer) clearTimeout(titlebarState.revertTimer);
      titlebarState.revertTimer = setTimeout(titlebarReset, 2500);
    }
    function titlebarSend() {
      if (titlebarState.revertTimer) { clearTimeout(titlebarState.revertTimer); titlebarState.revertTimer = 0; }
      titlebarState.phase = 'busy';
      var b = titlebarState.button;
      if (b) b.disabled = true;
      titlebarSet(t('restarting'));
      postRestart('');
    }
    function titlebarOnClick(event) {
      event.preventDefault();
      event.stopPropagation();
      if (busy.v || titlebarState.phase === 'busy') return;
      if (isWaiting()) { cancelWait(); return; }
      if (titlebarState.phase === 'confirm') { titlebarSend(); return; }
      if (effectiveCfg().allowRestart === false) { openNotice({ title: navLabel(), body: t('disabled') }); return; }
      // 「二次确认」开关关闭 → 与其它入口同语义：直接执行，不进两击式
      if (effectiveCfg().confirm === false) { titlebarSend(); return; }
      titlebarArm();
    }
    function syncTitlebar() {
      if (!titlebarState || !titlebarState.button) return;
      var b = titlebarState.button;
      if (busy.v) { if (titlebarState.revertTimer) { clearTimeout(titlebarState.revertTimer); titlebarState.revertTimer = 0; } titlebarState.phase = 'busy'; b.disabled = true; b.setAttribute('aria-busy', 'true'); titlebarSet(actionLabel()); }
      else { b.disabled = false; b.removeAttribute('aria-busy'); if (titlebarState.phase === 'busy') titlebarState.phase = 'idle'; if (titlebarState.phase === 'idle') titlebarSet(isWaiting() ? t('waitCancel') : titlebarLabel()); }
    }
    function titlebarMount() {
      if (typeof document === 'undefined' || !titlebarState.mounted) return;
      var host = document.querySelector('[data-windows-menu]');
      var root = host && host.shadowRoot ? host.shadowRoot : null;
      var bar = root ? root.querySelector('[role="menubar"]') : null;
      if (!bar) { // 宿主节点消失（上游改版/非 Windows）：清引用，等下次 DOM 变化再试
        if (titlebarState.button && titlebarState.button.parentNode === null) titlebarState.button = null;
        return;
      }
      var current = bar.querySelector('[' + TITLEBAR_BTN + ']');
      if (current) { titlebarState.button = current; syncTitlebar(); return; }
      var node = document.createElement('button');
      node.type = 'button';
      node.setAttribute('role', 'menuitem');
      node.setAttribute(TITLEBAR_BTN, '');
      node.textContent = titlebarLabel();
      // 与 preload 自家 caption 按钮一致：按下不抢编辑器焦点（竞品同款处理）
      node.addEventListener('pointerdown', function (e) { e.preventDefault(); });
      node.addEventListener('mousedown', function (e) { e.preventDefault(); });
      node.addEventListener('click', titlebarOnClick);
      bar.appendChild(node);
      titlebarState.button = node;
      syncTitlebar();
    }
    var titlebarObs = null;
    function startTitlebarEntry() {
      titlebarState.mounted = true;
      titlebarMount();
      if (typeof MutationObserver === 'undefined' || titlebarObs) return;
      // 宿主的菜单条可能晚于插件挂载（preload 时序）或被宿主重建：盯整个文档子树补挂
      titlebarObs = new MutationObserver(function () {
        if (!titlebarState.mounted) return;
        titlebarMount();
      });
      try {
        titlebarObs.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { void e; }
    }
    function stopTitlebarEntry() {
      titlebarState.mounted = false;
      if (titlebarState.revertTimer) { clearTimeout(titlebarState.revertTimer); titlebarState.revertTimer = 0; }
      var b = titlebarState.button;
      if (b && b.parentNode) { try { b.parentNode.removeChild(b); } catch (e) { void e; } }
      titlebarState.button = null;
      titlebarState.phase = 'idle';
    }
    // 语言切换 → 菜单项文字跟随（idle 态才改字；confirm/busy 态有自己的短窗口文案）
    langSubs.push(function () {
      if (titlebarState.phase === 'idle') titlebarSet(titlebarLabel());
    });

    // —— v1.2 入口④：设置 → 通用 行（settings.general.item）——
    function SettingsGeneralRow() {
      useActionState();
      var langTick = React.useState(0);
      var bumpLang = langTick[1];
      React.useEffect(function () {
        var fn = function () { bumpLang(function (n) { return n + 1; }); };
        langSubs.push(fn);
        return function () { var i = langSubs.indexOf(fn); if (i >= 0) langSubs.splice(i, 1); };
      }, []);
      var waiting = isWaiting();
      var disabled = (effectiveCfg().allowRestart === false && !waiting) || busy.v;
      return React.createElement('div', { className: 'dsrn-gen' },
        React.createElement('div', { className: 'dsrn-gen-text' },
          React.createElement('div', { className: 'dsrn-gen-label' }, t('settingsRowLabel')),
          React.createElement('div', { className: 'dsrn-gen-hint' }, waiting ? t('waitingBody') : t('settingsRowHint'))),
        React.createElement('button', {
          type: 'button',
          className: 'dsrn-button dsrn-sm dsrn-outline',
          disabled: disabled,
          title: busy.v ? actionLabel() : navLabel(),
          'aria-busy': busy.v,
          onClick: waiting ? cancelWait : doRestart,
        },
          React.createElement('span', { className: 'dsrn-icon', 'aria-hidden': 'true' },
            actionIcon(React.createElement(RestartIcon, { size: 14, medium: true }))),
          busy.v ? actionLabel() : (waiting ? t('waitCancel') : t('restartNow')))
      );
    }

    // —— Switch（官方 Switch 原语 DOM：button[role=switch][aria-checked] + span.thumb）——
    function DsrnSwitch(props) {
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': !!props.checked,
        'aria-label': props.label,
        className: 'dsrn-switch',
        onClick: function () { props.onChange(!props.checked); },
      }, React.createElement('span', { className: 'dsrn-thumb' }));
    }

    function SwitchField(props) {
      // key 转发给最外层元素：这些字段是作为数组子项塞进 rows 的，不带 key 会刷 React 警告
      return React.createElement('div', { className: 'dsrn-field', key: props.key },
        React.createElement('div', { className: 'dsrn-head' },
          React.createElement('span', { className: 'dsrn-label' }, props.label),
          DsrnSwitch({ label: props.label, checked: props.checked, onChange: props.onChange })),
        props.hint ? React.createElement('div', { className: 'dsrn-hint' }, props.hint) : null);
    }

    // —— 设置页区块（v0.8 自绘配置；v0.10 官方 fields/Switch/SettingsForm 形态；v0.12 五项+保存键右对齐）——
    function RestartSection() {
      var st = React.useState({ loading: true, cfg: null, saveState: 0 }); // saveState 0=无 1=已存 -1=失败
      var s = st[0];
      var setS = st[1];
      // v1.1：等待状态参与渲染（等待中按钮变「撤销等待」，并显示倒计时行）
      var waitTick = React.useState(0);
      var setWaitTick = waitTick[1];
      React.useEffect(function () {
        var fn = function () { setWaitTick(function (n) { return n + 1; }); };
        waitSubs.push(fn);
        return function () { var i = waitSubs.indexOf(fn); if (i >= 0) waitSubs.splice(i, 1); };
      }, []);
      // 语言晚到/切换 → 整块重渲染（v1.1.1：locale 服务比插件晚就绪是常态）
      var langTick = React.useState(0);
      var bumpLang = langTick[1];
      React.useEffect(function () {
        var fn = function () { bumpLang(function (n) { return n + 1; }); };
        langSubs.push(fn);
        return function () { var i = langSubs.indexOf(fn); if (i >= 0) langSubs.splice(i, 1); };
      }, []);
      // v1.2：入口开关变化 → 本页开关状态跟着重渲染
      var entryTick = React.useState(0);
      var bumpEntry = entryTick[1];
      React.useEffect(function () {
        return subscribeEntries(function () { bumpEntry(function (n) { return n + 1; }); });
      }, []);
      // v1.4.0：保存反馈 toast 经 cfgSubs 广播（showSaveToast 调 notifyCfg）→ 本页重渲染消费
      var cfgTick = React.useState(0);
      var bumpCfg = cfgTick[1];
      React.useEffect(function () {
        var fn = function () { bumpCfg(function (n) { return n + 1; }); };
        cfgSubs.push(fn);
        return function () { var i = cfgSubs.indexOf(fn); if (i >= 0) cfgSubs.splice(i, 1); };
      }, []);
      React.useEffect(function () {
        var done = false;
        var loadRevision = configRevision;
        var loadHadPending = configPending > 0;
        fetch(CONFIG, { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (done) return;
            var c = (j && j.config) || null;
            if (loadHadPending || loadRevision !== configRevision || configPending) c = effectiveCfg();
            else liveCfg = c; // 旧 GET 不得覆盖已经排队或完成的写入
            derivedExe = (j && j.derivedExe) || ''; // v0.18：自动推导结果（服务端 resolveExe）
            // v1.2.2：配置层是入口开关的真相来源（判据是服务端的 entriesDeclared，不是 config 本身）
            if (j && loadRevision === configRevision) adoptDeclared(j.entriesDeclared);
            adoptConfigEntries(c);
            // 上一次没写成功的待写值：服务端说没表过态时先迁移，否则才重试（谁先谁后不能颠倒）
            if (!migrateEntries()) retryPendingEntries();
            if (j && j.version !== undefined) {
              liveMeta = {
                version: j.version === undefined ? null : j.version,
                supportedRange: j.supportedRange || '',
                supported: j.supported,
                lastRestart: j.lastRestart || null,
                // 配置口不回报 closeSupported（那是探测口的字段）：保留探测时的判定，不因刷新丢失
                closeSupported: liveMeta.closeSupported === true,
              };
            }
            var draft = c ? Object.assign({}, withDerived(c)) : null;
            if (draft) {
              Object.keys(failedConfig).forEach(function (key) {
                if (key.indexOf('entry') !== 0) draft[key] = failedConfig[key].value;
              });
              Object.keys(pendingIntent).forEach(function (key) {
                if (key.indexOf('entry') !== 0) draft[key] = pendingIntent[key].value;
              });
              if (exeDraft !== null) draft.exePath = exeDraft;
              else if (!draft.exePath && derivedExe) draft.exePath = derivedExe;
            }
            setS({ loading: false, cfg: draft, saveState: 0 });
          })
          .catch(function () { if (!done) setS({ loading: false, cfg: null, saveState: 0 }); });
        return function () { done = true; };
      }, []);

      if (s.loading) {
        return React.createElement('div', { className: 'dsrn-section' },
          React.createElement('div', { className: 'dsrn-field' },
            React.createElement('div', { className: 'dsrn-hint' }, t('configLoading'))));
      }
      if (!s.cfg) {
        // 配置口不可用：退化为官方字段行的纯按钮形态（功能不受影响）
        return React.createElement('div', { className: 'dsrn-section' },
          React.createElement('div', { className: 'dsrn-field' },
            React.createElement('div', { className: 'dsrn-head' },
              React.createElement('span', { className: 'dsrn-label' }, t('restart')),
              React.createElement('button', {
                type: 'button', className: 'dsrn-button dsrn-sm dsrn-primary', onClick: doRestart, disabled: busy.v, 'aria-busy': busy.v,
              }, React.createElement('span', { className: 'dsrn-icon', 'aria-hidden': 'true' },
                actionIcon(React.createElement(RestartIcon, { size: 16, medium: true }))),
              busy.v ? actionLabel() : (isWaiting() ? t('waitCancel') : t('restartNow')))),
            React.createElement('div', { className: 'dsrn-hint' }, t('sectionHint'))));
      }

      // v1.4.0 实时保存：改动即写回配置层（开关拨动立即 POST；exePath 失焦校验后写回），
      // 每次仅提交修改字段，队列在发出时与上次成功配置合并成全量 body；失败可显式重试。
      function persistNow(next, key) {
        var patch = {};
        patch[key] = key === 'exePath'
          ? (String(next.exePath || '') === derivedExe ? '' : String(next.exePath || ''))
          : next[key] !== false;
        queueConfigPatch(patch);
      }
      function updAndSave(key, value) {
        setS(function (current) {
          var n = Object.assign({}, current.cfg); n[key] = value;
          return Object.assign({}, current, { cfg: n });
        });
        var next = Object.assign({}, s.cfg); next[key] = value;
        persistNow(next, key);
      }
      function upd(key, value) {
        if (key === 'exePath') exeDraft = value;
        setS(function (current) {
          var n = Object.assign({}, current.cfg); n[key] = value;
          return Object.assign({}, current, { cfg: n });
        });
      }

      var disabled = (s.cfg.allowRestart === false && !isWaiting()) || busy.v;
      var waiting = isWaiting();
      var rows = [];

      // ① 重启行：label + 官方 sm primary 按钮（等待中变成「撤销等待」，同一按钮两种语义）
      // v1.3.1：助手支持 action:'close' 时同行并列一个 outline 的「仅关闭」（closeSupported 门控）
      rows.push(React.createElement('div', { className: 'dsrn-field', key: 'restart' },
        React.createElement('div', { className: 'dsrn-head' },
          React.createElement('span', { className: 'dsrn-label' }, t('restart')),
          React.createElement('button', {
            type: 'button',
            className: 'dsrn-button dsrn-sm ' + (waiting ? 'dsrn-outline' : 'dsrn-primary'),
            disabled: disabled,
            'aria-busy': busy.v,
            title: (s.cfg.allowRestart === false && !waiting) ? t('allowRestart') : undefined,
            onClick: doRestart,
          }, React.createElement('span', { className: 'dsrn-icon' },
            actionIcon(React.createElement(RestartIcon, { size: 16, medium: true }))),
          busy.v ? actionLabel() : (waiting ? t('waitCancel') : t('restartNow'))),
          liveMeta.closeSupported ? React.createElement('button', {
            type: 'button',
            className: 'dsrn-button dsrn-sm dsrn-outline',
            disabled: disabled || waiting,
            title: t('closeNow'),
            onClick: doClose,
          }, React.createElement('span', { className: 'dsrn-icon', 'aria-hidden': 'true' },
            actionIcon(React.createElement(CloseIcon, { size: 14, medium: true }))),
          busy.v ? actionLabel() : t('closeNow')) : null),
        React.createElement('div', { className: 'dsrn-hint' },
          waiting ? t('waitingBody') : t('sectionHint'))));

      rows.push(React.createElement('div', { className: 'dsrn-field', key: 'preflight' },
        React.createElement('button', { type: 'button', className: 'dsrn-button dsrn-sm dsrn-outline', onClick: doPreflight }, t('preflight'))));

      // ② 等待中：剩余时间（宿主 5s 复检，最长 30 分钟）
      if (waiting) {
        var minutes = Math.max(0, Math.ceil((waitState.remainingMs || 0) / 60000));
        rows.push(React.createElement('div', { className: 'dsrn-field', key: 'waiting' },
          React.createElement('div', { className: 'dsrn-hint' },
            t('waiting') + ' ' + minutes + ' min' + (waitState.tasks ? ' · tasks ' + waitState.tasks : ''))));
      }

      // ③ 上次重启回执（v1.1）：确认「刚才是重启成功了还是崩了」
      var last = liveMeta.lastRestart;
      if (last && last.status && last.status !== 'none') {
        var lastText;
        if (last.status === 'ok') lastText = t('lastOk', { s: Math.max(1, Math.round((last.downtimeMs || 0) / 1000)) })
          + (last.webListen && last.webListen.verdict === 'serving' ? ' · ' + t('lastServing') : '');
        else if (last.status === 'closed') lastText = t('lastClosed');
        else if (last.status === 'failed') lastText = t('lastFailed', { r: last.reason || 'unknown' });
        else lastText = t('lastUnconfirmed');
        rows.push(React.createElement('div', { className: 'dsrn-field', key: 'last' },
          React.createElement('div', { className: 'dsrn-head' },
            React.createElement('span', { className: 'dsrn-label' }, t('lastRestart')),
            React.createElement('span', { className: 'dsrn-hint', style: { margin: 0 } }, lastText))));
      }

      // ④ 运行版本（选择题 9：用户「更新了一下都不知道要支持什么版本了」）
      // 支持范围内部写着 >=0.2.0-0（-0 是为了让 0.2.0 的预发布版也算满足），
      // 展示时去掉这个 semver 内部写法，避免用户看到 -0 一头雾水；红/灰由 supported 决定。
      var rangeText = (liveMeta.supportedRange || '').replace(/-0$/, '');
      var verText = liveMeta.version
        ? 'DSH ' + liveMeta.version + (rangeText ? ' · ' + rangeText : '')
        : t('versionUnknown');
      rows.push(React.createElement('div', { className: 'dsrn-field', key: 'version' },
        React.createElement('div', { className: 'dsrn-head' },
          React.createElement('span', { className: 'dsrn-label' }, t('version')),
          React.createElement('span', { className: 'dsrn-hint', style: { margin: 0 } }, verText)),
        liveMeta.supported === false
          ? React.createElement('div', { className: 'dsrn-failed' }, t('versionUnsupported'))
          : null));

      rows.push(SwitchField({
        key: 'allowRestart',
        label: t('allowRestart'), checked: s.cfg.allowRestart !== false,
        hint: t('allowRestartHint'),
        onChange: function (v) { updAndSave('allowRestart', v); },
      }));
      rows.push(SwitchField({
        key: 'confirm',
        label: t('confirm'), checked: s.cfg.confirm !== false,
        hint: t('confirmHint'),
        onChange: function (v) { updAndSave('confirm', v); },
      }));
      // v1.2.1：平台会话鉴权（P0）。默认开启；界面自己失效时它是逃生门。
      rows.push(SwitchField({
        key: 'platformAuth',
        label: t('platformAuth'), checked: s.cfg.platformAuth !== false,
        hint: t('platformAuthHint'),
        onChange: function (v) { updAndSave('platformAuth', v); },
      }));
      // v1.2：底部按钮的开关并进「重启入口」组（同一件事只留一个开关）

      // exe 路径（v0.18：保留手填逃生舱，但展示自动推导结果，避免盲填；
      // 原生文件选择框属于 Electron 主进程能力，插件两层（utility 宿主/web 前端）够不着，
      // 且 Electron 32+ 的 <input type=file> 已不返回真实路径——见 02 文档 errata v0.18）
      // v1.4.0 实时保存：输入只改本地状态（不打字就发请求）；失焦时校验并写回，
      // 非空且不是已存在文件会被服务端 400 拒掉（红字显原因），清空 = 回到自动推导。
      rows.push(React.createElement('div', { className: 'dsrn-field', key: 'exePath' },
        React.createElement('div', { className: 'dsrn-head' },
          React.createElement('span', { className: 'dsrn-label' }, t('exePath')),
          React.createElement('input', {
            type: 'text', className: 'dsrn-input', placeholder: t('exePathPlaceholder'),
            style: { flex: 1 },
            value: s.cfg.exePath || '',
            onChange: function (e) { upd('exePath', e.target.value); },
            onBlur: function (e) { persistNow({ exePath: e.target.value }, 'exePath'); },
          })),
        React.createElement('div', { className: 'dsrn-hint' }, t('exePathHint'))));

      // —— v1.2.2：入口开关组（真相在配置文件；拨动即撤注册 + 全量写回 /config）——
      // 与 v1.2 的差别：v1.2 只写 localStorage（强杀会丢未提交写入 → issue #1 回弹），
      // 现在 localStorage 只是首帧缓存，写回失败会在这里显红字，并在下次打开设置页自动重试。
      var entryOn = getEntries();
      rows.push(React.createElement('div', { className: 'dsrn-field', key: 'entries' },
        React.createElement('div', { className: 'dsrn-head' },
          React.createElement('span', { className: 'dsrn-label' }, t('entryGroup'))),
        React.createElement('div', { className: 'dsrn-hint' }, t('entryHint'))));
      var entryDefs = [
        ['panel', t('entryPanel')],
        ['footer', t('entryFooter')],
        ['header', t('entryHeader')],
        ['settingsRow', t('entrySettingsRow')],
        ['titlebar', t('entryTitlebar')],
      ];
      entryDefs.forEach(function (def) {
        var key2 = def[0];
        rows.push(SwitchField({
          key: 'entry-' + key2,
          label: def[1],
          checked: entryOn[key2] !== false,
          hint: '',
          onChange: function (v) { setEntry(key2, v); }, // setEntry 内部已写回配置文件
        }));
      });
      if (entryWriteFailed) {
        rows.push(React.createElement('div', { className: 'dsrn-field', key: 'entryWriteFailed' },
          React.createElement('div', { className: 'dsrn-failed' }, t('entryWriteFailed'))));
      }
      rows.push(React.createElement('div', { className: 'dsrn-field', key: 'entryCommand' },
        React.createElement('div', { className: 'dsrn-hint' }, t('entryCommandHint'))));

      if (configPending) {
        rows.push(React.createElement('div', { className: 'dsrn-footer', key: 'saving-config', role: 'status' },
          React.createElement('span', { className: (configSlow || configUnknown) ? 'dsrn-failed' : 'dsrn-hint' },
            t(configUnknown ? 'savingConfigUncertain' : (configSlow ? 'savingConfigUnknown' : 'savingConfig')))));
      }
      // Toast 会自动消失；未解决的失败另以持久行显示并提供明确重试。
      var failedKeys = Object.keys(failedConfig);
      if (failedKeys.length) {
        rows.push(React.createElement('div', { className: 'dsrn-footer', key: 'persistent-save-error', role: 'alert' },
          React.createElement('span', { className: 'dsrn-failed' }, t('saveFailed') + ': ' + failedKeys.map(function (key) {
            return key + (failedConfig[key].reason ? ' (' + failedConfig[key].reason + ')' : '');
          }).join(', ')),
          React.createElement('button', { type: 'button', className: 'dsrn-button dsrn-sm dsrn-outline', onClick: function () {
            var patch = {};
            failedKeys.forEach(function (key) {
              // 有更新意图排队或在途时，绝不能把旧失败值排到它后面。
              if (!failedConfig[key] || pendingFields[key]) return;
              patch[key] = key === 'exePath'
                ? (String(s.cfg.exePath || '') === derivedExe ? '' : String(s.cfg.exePath || ''))
                : failedConfig[key].value;
            });
            if (Object.keys(patch).length) queueConfigPatch(patch);
          } }, t('retrySave'))));
      }

      // 旧 Toast 的延迟 onDone 只能清除其自身，不能清除更新的反馈。
      if (saveToast) {
        var toast = saveToast;
        var toastText = toast.ok ? t('saved') : t('saveFailed') + (toast.reason ? ': ' + toast.reason : '');
        if (OfficialToast) {
          rows.push(React.createElement(OfficialToast, {
            key: 'save-toast-' + toast.seq,
            tone: toast.ok ? 'success' : undefined,
            text: toastText,
            icon: toast.ok ? undefined : (UI && UI.IconWarningOutlineRegular ? React.createElement(UI.IconWarningOutlineRegular, { size: 18 }) : undefined),
            onDone: function () {
              if (saveToast && saveToast.seq === toast.seq) { saveToast = null; notifyCfg(); }
            },
          }));
        } else {
          rows.push(React.createElement('div', { className: 'dsrn-footer', key: 'save-feedback' },
            React.createElement('span', { className: toast.ok ? 'dsrn-ok' : 'dsrn-failed', role: toast.ok ? 'status' : 'alert' }, toastText)));
        }
      }

      return React.createElement('div', { className: 'dsrn-section' }, rows);
    }

    // —— 挂载（仅 desktop）——
    // v1.2：四个可关入口按开关动态注入/撤销（关闭即撤注册，界面上真的消失），
    // settings.section 配置页始终注册（否则关掉就回不来了）。
    var entryDisposers = [];
    function clearEntries() {
      var list = entryDisposers.splice(0, entryDisposers.length);
      for (var i = 0; i < list.length; i += 1) {
        try { if (typeof list[i] === 'function') list[i](); } catch (e) { void e; }
      }
    }
    function applyEntries(slots) {
      clearEntries();
      var on = getEntries();
      if (on.panel !== false) {
        // 左上角那一条（整行侧栏自己画，我们只给图标）…
        entryDisposers.push(slots.inject('sidebar.panellist', function () {
          return slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: navLabel,
          }, RestartPanelGlyph);
        }));
        // …以及它切过去的主区面板。两者必须成对：selectPanel(id) 找不到 key 会抛错。
        entryDisposers.push(slots.inject('main', function () {
          return slots.register({ name: 'main', key: PANEL_ID }, RestartPanel);
        }));
      }
      if (on.footer !== false) {
        entryDisposers.push(slots.inject('sidebar.footer.action', function () {
          return slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-restart-now', order: 100, label: navLabel },
            function (props) { return React.createElement(RestartFooterAction, props); }
          );
        }));
      }
      if (on.header !== false) {
        // order 15：官方 ui-jobs 条目是 20，动作组左紧排，排在它前面才不会被顶右（竞品实测 134px）
        entryDisposers.push(slots.inject('conversation.session.header.actions', function () {
          return slots.register({ name: 'conversation.session.header.actions', id: 'dsh-restart-now', order: 15 }, HeaderRestartButton);
        }));
      }
      if (on.settingsRow !== false) {
        entryDisposers.push(slots.inject('settings.general.item', function () {
          return slots.register({ name: 'settings.general.item', id: 'dsh-restart-now', order: 91 }, SettingsGeneralRow);
        }));
      }
      if (on.titlebar !== false) {
        // 标题栏菜单「重启」项：shadow DOM 注入（非槽位体系，见 startTitlebarEntry 注释）。
        // 开关拨动即挂/摘（摘除 = 从 menubar 移除按钮 + 停 MutationObserver 回调）。
        startTitlebarEntry();
        entryDisposers.push(function () { stopTitlebarEntry(); });
      }
    }

    function mount(ctx) {
      var slots = ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function') return;

      // 配置页：始终在（关掉入口也能回来打开）
      slots.inject('settings.section', function () {
        return slots.register(
          // 导航行 = {id, order, label}（asar:478663-478668）；label 缺失 → 无名字（v0.6 教训）
          // 图标由宿主 navIcon(id) 硬编码（回退齿轮）→ startNavEnhance 做 DOM 增强（v0.12）
          { name: 'settings.section', id: 'dsh-restart-now', order: 900, label: navLabel },
          function () { return React.createElement(RestartSection, null); }
        );
      });

      applyEntries(slots);
      // 开关一变就重新注入（关掉的入口连注册一起撤掉）
      subscribeEntries(function () { applyEntries(slots); });
      // 插件被停用/卸载时，把自己注册的入口一起撤掉
      try {
        if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { clearEntries(); }; });
      } catch (e) { void e; }

      startNavEnhance();

      // 语言兜底（v1.1.1）：哪怕所有服务路径都没拿到，DSH 的 locale 服务写 <html lang> 这一步是保证发生的，
      // 盯住它的属性变化就能补上——这是真机「中文界面显示英文」的最小可靠修复。
      try {
        var doc = typeof document === 'undefined' ? null : document;
        if (doc && doc.documentElement && typeof MutationObserver === 'function') {
          new MutationObserver(function () {
            try { setLang(doc.documentElement.getAttribute('lang')); } catch (e) { void e; }
          }).observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
        }
      } catch (e) { void e; }
    }

    exports.name = name;
    exports.inject = ['slots'];
    exports.apply = function (ctx, config) {
      // config 由 cordis.patch.yml 条目 config 传入（§7）
      exports.__restartCfg = config || {};
      // 语言（v1.1.1）：locale 服务可能已经就绪，也可能晚一些（官方 locale-client 用 async apply 提供它），
      // 两条路都接：先同步试一次，再用 ctx.inject 等服务出现；切换语言时 subscribe 会回推。
      try {
        if (ctx && typeof ctx.get === 'function') attachLocale(ctx.get('locale'));
      } catch (e) { void e; }
      try {
        if (ctx && typeof ctx.inject === 'function') {
          ctx.inject(['locale'], function (sub) {
            var svc = null;
            try { svc = (sub && sub.locale) || (sub && typeof sub.get === 'function' ? sub.get('locale') : null); } catch (e) { void e; }
            attachLocale(svc);
          });
        }
      } catch (e) { void e; }
      // 客户端 cordis 里服务晚到也会广播 internal/service（官方客户端插件的既有写法），再兜一层
      try {
        if (ctx && typeof ctx.on === 'function') {
          ctx.on('internal/service', function (serviceName) {
            if (serviceName !== 'locale') return;
            try { attachLocale(ctx.get('locale')); } catch (e) { void e; }
          });
        }
      } catch (e) { void e; }
      fetch(PROBE, { credentials: 'same-origin' })
        .then(function (r) { return (r.ok ? r.json() : null); })
        .then(function (j) {
          if (j && j.ok && j.environment === 'desktop') {
            // v1.3.0：从「仅 win32」放宽到两平台白名单（重启链路已在 macOS 打通）；
            // 判据只认 SUPPORTED_PLATFORMS，platform 缺失视为受支持，兼容未升级的旧宿主探测口。
            // v1.0.2 起这里的历史语义：平台不符 = 零挂载、零副作用（web/未知平台不能挂桌面入口）。
            var supported = !j.platform || SUPPORTED_PLATFORMS.indexOf(j.platform) !== -1;
            if (supported) {
              // v0.21：探测口直接回传生效配置——挂载即得 liveCfg，不必等用户打开设置页
              // （此前重启后 liveCfg 为 null，footer 用 patch 默认值，已关的二次确认会复活）。
              if (j.config) { liveCfg = j.config; notifyCfg(); }
              adoptDeclared(j.entriesDeclared);
              adoptConfigEntries(j.config);
              if (j.derivedExe) derivedExe = j.derivedExe;
              // v1.1：版本判定与上次重启回执一并带走（设置页不必再发一次探测）
              // v1.3.1：closeSupported = 助手是否支持 action:'close'，false 时关闭入口一律不渲染
              liveMeta = {
                version: j.version === undefined ? null : j.version,
                supportedRange: j.supportedRange || '',
                supported: j.supported,
                lastRestart: j.lastRestart || null,
                closeSupported: j.closeSupported === true,
              };
              // 上次的重启还处在等待模式（例如用户重启前点了「等空闲」）→ 继续轮询显示
              if (j.wait && j.wait.state === 'waiting') refreshWait(j.wait);
              // v1.2.2：配置层还没有 entry 键而本机缓存里有旧值 → 迁移一次（issue #1 修法③）
              migrateEntries();
              mount(ctx);
            }
          }
        })
        .catch(function () { /* 探测失败 = 不挂载（web 环境或宿主旧版），零副作用 */ });
    };

    return module.exports;
  },
});
