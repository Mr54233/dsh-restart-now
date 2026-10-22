/* eslint-disable */
// lib/client.js —— 客户端半边（v0.19：官方图标套件 + 隐藏按钮开关 + 配置表单；
// exePath 输入框直接预填自动推导路径；导航图标认领机制定案，排查遥测已移除）。
// 依据官方插件样式规范（asar:292610）：第三方插件不得 require Harness client 包，
// 应把官方控件 markup/CSS 抄进插件、类名改自前缀、颜色只引用 --dsw-* token。
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
window.__ModuleLoader__.load({
  id: 'dsh-restart-now',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var name = 'dsh-restart-now';
    var PROBE = '/plugins/dsh-restart-now/environment';
    var ACTION = '/plugins/dsh-restart-now/restart';
    var STATUS = '/plugins/dsh-restart-now/status';
    var CONFIG = '/plugins/dsh-restart-now/config';

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
        hideSidebarButton: '隐藏左下角按钮',
        hideSidebarButtonHint: '开启后侧栏底部不再显示重启入口（保存后立即生效）。',
        exePath: '可执行文件路径',
        exePathPlaceholder: '留空自动推导',
        exePathHint: '重启时拉起的目标程序，默认即当前 DeepSeek Harness.exe（自动跟随安装目录，更新/换目录无需修改）。'
          + '手动改成其他路径时必须是已存在的文件，否则保存会被拒绝。',
        save: '保存配置',
        saved: '已保存 ✓',
        saveFailed: '保存失败',
        version: '运行版本',
        versionUnsupported: '当前 DSH 版本不在支持范围，重启可能失败',
        versionUnknown: '未能读取版本',
        lastRestart: '上次重启',
        lastOk: '已完成，停机约 {s} 秒',
        lastFailed: '失败：{r}（详见 %TEMP% 日志）',
        lastUnconfirmed: '已发起，但未确认成功',
        confirmBody: '重启会中断当前正在进行的输出和任务（包括本条回复）。窗口先关闭后自动回来，通常十几秒；'
          + '插件较多或网络慢时可能要几分钟，请耐心等待。',
        disabled: '重启已被总开关禁用（设置 → 重启应用 → 允许重启）。',
        busyTitle: '还有任务在运行',
        busyBody: '当前有 {t} 个会话在运行、{j} 个任务在跑。重启会把它们一起中断。',
        waitingBody: '已进入等待：任务结束后会自动重启（最多等 30 分钟）。',
        rejected: '重启被拒绝：{r}',
        installing: '插件正在安装/卸载，等它结束后再重启。',
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
        hideSidebarButton: 'Hide the sidebar button',
        hideSidebarButtonHint: 'Hide the restart entry at the sidebar foot (takes effect on save).',
        exePath: 'Executable path',
        exePathPlaceholder: 'Blank = auto-detect',
        exePathHint: 'Program to relaunch; defaults to the running DeepSeek Harness.exe and follows the install'
          + ' directory automatically. If you set another path it must be an existing file, otherwise the save is rejected.',
        save: 'Save',
        saved: 'Saved ✓',
        saveFailed: 'Save failed',
        version: 'Running version',
        versionUnsupported: 'This DSH version is outside the supported range; restart may fail',
        versionUnknown: 'Version could not be read',
        lastRestart: 'Last restart',
        lastOk: 'done, about {s}s of downtime',
        lastFailed: 'failed: {r} (see the %TEMP% log)',
        lastUnconfirmed: 'requested, but not confirmed',
        confirmBody: 'Restarting interrupts running output and tasks, including this reply. The window closes and'
          + ' comes back by itself, usually within seconds; with many plugins or a slow network it can take minutes.',
        disabled: 'Restart is disabled by the master switch (Settings → Restart app → Allow restart).',
        busyTitle: 'Tasks are still running',
        busyBody: '{t} conversation(s) running, {j} job(s) in flight. Restarting will interrupt them.',
        waitingBody: 'Waiting: the app will restart when tasks finish (up to 30 minutes).',
        rejected: 'Restart rejected: {r}',
        installing: 'A plugin install/uninstall is in progress; try again when it finishes.',
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

    // openModal({title, body?, description?, footer?, autofocus?}) → {close}
    // 结构与官方 Modal 一致：root(role=presentation) > mask(aria-hidden, 点击关闭) + dialog(role=dialog aria-modal) > content(header(title+close)+body|description) + footer
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

      function close() {
        if (root.parentNode) root.parentNode.removeChild(root);
        document.removeEventListener('keydown', onKey, true);
        if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
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
    var confirmOpen = false;
    function openConfirm(o) {
      if (confirmOpen) return;
      confirmOpen = true;
      var m;
      var body = el('div', 'dsrn-warning');
      body.appendChild(svgEl(ICON_WARN, 18, 'dsrn-warning-icon'));
      body.appendChild(el('p', null, o.body));
      var bodyWrap = el('div', null);
      bodyWrap.appendChild(body);
      var footer = el('div', 'dsrn-modal-footer');
      footer.appendChild(domButton('dsrn-button dsrn-md dsrn-outline dsrn-modal-action', o.cancelLabel || t('cancel'), function () { m.close(); }));
      footer.appendChild(domButton('dsrn-button dsrn-md dsrn-primary dsrn-confirm-action', o.okLabel || t('ok'), function () { m.close(); if (o.onOk) o.onOk(); }));
      m = openModal({ title: o.title || navLabel(), body: bodyWrap, footer: footer, autofocus: footer.lastChild });
      var origClose = m.close;
      m.close = function () { confirmOpen = false; origClose(); };
    }

    // 官方 Modal 单键提示形态：description 文本 + primary 确定
    function openNotice(o) {
      var footer = el('div', 'dsrn-modal-footer');
      footer.appendChild(domButton('dsrn-button dsrn-md dsrn-primary dsrn-modal-action', o.okLabel || t('ok'), function () { m.close(); }));
      var m = openModal({ title: o.title || navLabel(), description: o.body, footer: footer, autofocus: footer.firstChild });
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
      // 侧栏 nav 项无同名行，footer 行不在 nav 下，无碰撞。
      try {
        var buttons = document.querySelectorAll('nav button');
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          var text = (btn.textContent || '').trim();
          if (NAV_LABELS.indexOf(text) !== -1) {
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
    var busy = { v: false };
    var liveCfg = null; // 探测口挂载时/设置表单加载保存后更新；重启与 footer 可见性优先用最新值
    var saveReason = ''; // v0.17：最近一次保存失败的服务端原因（如 exe-path-invalid）
    var derivedExe = ''; // v0.18：GET /config 回传的自动推导路径（服务端 resolveExe）
    // v1.1：探测口回传的运行快照（版本判定 / 上次重启回执 / 等待状态），只读展示用
    var liveMeta = { version: null, supportedRange: '', supported: null, lastRestart: null };
    var waitSubs = [];  // 等待状态订阅（设置页与 footer 共享）
    var waitState = { state: 'idle', since: 0, remainingMs: 0, tasks: 0, jobs: 0 };
    function setWaitState(next) {
      waitState = next || { state: 'idle', since: 0, remainingMs: 0, tasks: 0, jobs: 0 };
      waitSubs.forEach(function (fn) { try { fn(); } catch (e) { void e; } });
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
        fetch(STATUS, { credentials: 'omit' })
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

    // 重启请求：query 决定宿主走哪条路（?force=1 越过任务守卫 / ?wait=1 等空闲 / ?cancel=1 撤销等待）
    function postRestart(query) {
      if (busy.v) return;
      busy.v = true;
      // 同源 POST：Origin 由浏览器自补（v0.6 勘误：origin 是 forbidden header）
      fetch(ACTION + (query || ''), { method: 'POST', credentials: 'omit' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); })
        .then(function (res) {
          busy.v = false;
          var body = res.body || {};
          if (res.status === 202 && body.ok) {
            if (body.mode === 'waiting') {
              // 等待模式：宿主在后台盯着任务，界面只显示「等待中」+ 撤销
              refreshWait({ state: 'waiting', since: body.since || Date.now(), remainingMs: body.remainingMs || 0, tasks: body.tasks || 0, jobs: body.jobs || 0 });
              openNotice({ title: navLabel(), body: t('waitingBody') });
            } else {
              window.__dsh_restart_now__ = 'restarting';
            }
            return;
          }
          if (res.status === 409 && body.reason === 'busy') {
            // v1.1：有任务在跑时不再直接拒绝，而是给出三条路（官方口径：让用户自己判断）
            askBusy(body.tasks || 0, body.jobs || 0);
            return;
          }
          if (res.status === 409 && body.reason === 'installing') {
            openNotice({ title: navLabel(), body: t('installing') });
            return;
          }
          var reason = body.reason || ('HTTP ' + res.status);
          openNotice({ title: navLabel(), body: t('rejected', { r: reason }) });
        })
        .catch(function (e) {
          busy.v = false;
          // fetch 因进程被杀而中断属预期（Q5：前端自动重连）
          window.__dsh_restart_now__ = 'restarting';
          void e;
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
      fetch(ACTION + '?cancel=1', { method: 'POST', credentials: 'omit' })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) { refreshWait({ state: 'idle' }); if (!(j && j.cancelled)) void j; })
        .catch(function () { refreshWait({ state: 'idle' }); });
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
      props = props || {};
      var wide = !!props.wide;
      // v0.12：「隐藏左下角按钮」开关（保存后立即生效；初始值来自探测口 liveCfg）
      var st = React.useState(effectiveCfg().hideSidebarButton === true);
      var hidden = st[0];
      var setHidden = st[1];
      React.useEffect(function () {
        var fn = function () { setHidden(effectiveCfg().hideSidebarButton === true); };
        cfgSubs.push(fn);
        fn();
        return function () { var i = cfgSubs.indexOf(fn); if (i >= 0) cfgSubs.splice(i, 1); };
      }, []);
      // 语言晚到/切换 → 重渲染（标题与 aria-label 都取 navLabel()）
      var langTick = React.useState(0);
      var bumpLang = langTick[1];
      React.useEffect(function () {
        var fn = function () { bumpLang(function (n) { return n + 1; }); };
        langSubs.push(fn);
        return function () { var i = langSubs.indexOf(fn); if (i >= 0) langSubs.splice(i, 1); };
      }, []);
      if (hidden) return null;
      return React.createElement('button', {
        type: 'button',
        className: 'dsrn-row' + (wide ? '' : ' dsrn-collapsed'),
        title: navLabel(),
        'aria-label': navLabel(),
        onClick: doRestart,
      },
        React.createElement('span', { className: 'dsrn-glyph', 'aria-hidden': 'true' },
          React.createElement(RestartIcon, { size: wide ? 16 : 18, medium: true })),
        wide ? React.createElement('span', { className: 'dsrn-title' }, navLabel()) : null
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
      return React.createElement('div', { className: 'dsrn-field' },
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
      React.useEffect(function () {
        var done = false;
        fetch(CONFIG, { credentials: 'omit' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (done) return;
            var c = (j && j.config) || null;
            liveCfg = c; // liveCfg 保持原始值；预填只影响表单显示
            derivedExe = (j && j.derivedExe) || ''; // v0.18：自动推导结果（服务端 resolveExe）
            if (j && j.version !== undefined) {
              liveMeta = {
                version: j.version === undefined ? null : j.version,
                supportedRange: j.supportedRange || '',
                supported: j.supported,
                lastRestart: j.lastRestart || null,
              };
            }
            setS({ loading: false, cfg: withDerived(c), saveState: 0 });
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
                type: 'button', className: 'dsrn-button dsrn-sm dsrn-primary', onClick: doRestart,
              }, React.createElement('span', { className: 'dsrn-icon' },
                React.createElement(RestartIcon, { size: 16, medium: true })),
              isWaiting() ? t('waitCancel') : t('restartNow'))),
            React.createElement('div', { className: 'dsrn-hint' }, t('sectionHint'))));
      }

      function upd(key, value) {
        var n = Object.assign({}, s.cfg);
        n[key] = value;
        setS({ loading: false, cfg: n, saveState: s.saveState });
      }

      var disabled = s.cfg.allowRestart === false && !isWaiting();
      var waiting = isWaiting();
      var rows = [];

      // ① 重启行：label + 官方 sm primary 按钮（等待中变成「撤销等待」，同一按钮两种语义）
      rows.push(React.createElement('div', { className: 'dsrn-field', key: 'restart' },
        React.createElement('div', { className: 'dsrn-head' },
          React.createElement('span', { className: 'dsrn-label' }, t('restart')),
          React.createElement('button', {
            type: 'button',
            className: 'dsrn-button dsrn-sm ' + (waiting ? 'dsrn-outline' : 'dsrn-primary'),
            disabled: disabled,
            title: (s.cfg.allowRestart === false && !waiting) ? t('allowRestart') : undefined,
            onClick: doRestart,
          }, React.createElement('span', { className: 'dsrn-icon' },
            React.createElement(RestartIcon, { size: 16, medium: true })),
          waiting ? t('waitCancel') : t('restartNow'))),
        React.createElement('div', { className: 'dsrn-hint' },
          waiting ? t('waitingBody') : t('sectionHint'))));

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
        if (last.status === 'ok') lastText = t('lastOk', { s: Math.max(1, Math.round((last.downtimeMs || 0) / 1000)) });
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
        onChange: function (v) { upd('allowRestart', v); },
      }));
      rows.push(SwitchField({
        key: 'confirm',
        label: t('confirm'), checked: s.cfg.confirm !== false,
        hint: t('confirmHint'),
        onChange: function (v) { upd('confirm', v); },
      }));
      // v0.12：隐藏左下角按钮（保存后立即生效）
      rows.push(SwitchField({
        key: 'hideSidebarButton',
        label: t('hideSidebarButton'), checked: s.cfg.hideSidebarButton === true,
        hint: t('hideSidebarButtonHint'),
        onChange: function (v) { upd('hideSidebarButton', v); },
      }));

      // exe 路径（v0.18：保留手填逃生舱，但展示自动推导结果，避免盲填；
      // 原生文件选择框属于 Electron 主进程能力，插件两层（utility 宿主/web 前端）够不着，
      // 且 Electron 32+ 的 <input type=file> 已不返回真实路径——见 02 文档 errata v0.18）
      rows.push(React.createElement('div', { className: 'dsrn-field', key: 'exePath' },
        React.createElement('div', { className: 'dsrn-head' },
          React.createElement('span', { className: 'dsrn-label' }, t('exePath')),
          React.createElement('input', {
            type: 'text', className: 'dsrn-input', placeholder: t('exePathPlaceholder'),
            style: { flex: 1 },
            value: s.cfg.exePath || '',
            onChange: function (e) { upd('exePath', e.target.value); },
          })),
        React.createElement('div', { className: 'dsrn-hint' }, t('exePathHint'))));

      // SettingsForm .footer + .save（v0.12：右对齐；提示在前、保存键压右）
      rows.push(React.createElement('div', { className: 'dsrn-footer', key: 'footer' },
        s.saveState === 1 ? React.createElement('span', { className: 'dsrn-ok' }, t('saved')) : null,
        s.saveState === -1
          ? React.createElement('span', { className: 'dsrn-failed' }, t('saveFailed') + (saveReason ? ': ' + saveReason : ''))
          : null,
        React.createElement('button', {
          type: 'button', className: 'dsrn-save',
          onClick: function () {
            fetch(CONFIG, {
              method: 'POST',
              credentials: 'omit',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                allowRestart: s.cfg.allowRestart !== false,
                confirm: s.cfg.confirm !== false,
                // v0.19：输入框预填了推导路径；保存时若值仍等于推导值则落盘 ''，
                // 保留「留空 = 自动跟随当前安装」语义（DSH 换目录/更新后依然正确）；
                // 只有手动改成其他路径才真正固定到文件（保存时校验该文件存在）。
                exePath: String(s.cfg.exePath || '') === derivedExe ? '' : String(s.cfg.exePath || ''),
                hideSidebarButton: s.cfg.hideSidebarButton === true,
              }),
            })
              .then(function (r) { return r.json(); })
              .then(function (j) {
                if (j && j.ok) {
                  liveCfg = j.config;
                  notifyCfg(); // footer 响应式隐藏（v0.12）
                  setS({ loading: false, cfg: withDerived(j.config), saveState: 1 }); // 预填保持（v0.19）
                } else {
                  // v0.17：带原因（如 exe-path-invalid——exePath 不是已存在的文件）
                  saveReason = (j && j.reason) ? String(j.reason) : '';
                  setS({ loading: false, cfg: s.cfg, saveState: -1 });
                }
              })
              .catch(function () { saveReason = ''; setS({ loading: false, cfg: s.cfg, saveState: -1 }); });
          },
        }, t('save'))));

      return React.createElement('div', { className: 'dsrn-section' }, rows);
    }

    // —— 挂载（仅 desktop）——
    function mount(ctx) {
      var slots = ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function') return;

      slots.inject('sidebar.footer.action', function () {
        return slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-restart-now', order: 100, label: navLabel }, 
          function (props) { return React.createElement(RestartFooterAction, props); }
        );
      });

      slots.inject('settings.section', function () {
        return slots.register(
          // 导航行 = {id, order, label}（asar:478663-478668）；label 缺失 → 无名字（v0.6 教训）
          // 图标由宿主 navIcon(id) 硬编码（回退齿轮）→ startNavEnhance 做 DOM 增强（v0.12）
          { name: 'settings.section', id: 'dsh-restart-now', order: 900, label: navLabel }, 
          function () { return React.createElement(RestartSection, null); }
        );
      });

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
      fetch(PROBE, { credentials: 'omit' })
        .then(function (r) { return (r.ok ? r.json() : null); })
        .then(function (j) {
          if (j && j.ok && j.environment === 'desktop') {
            // v1.0.2：platform !== 'win32' 时不挂载（重启链路是纯 Windows 机制）；
            // platform 缺失视为 win32，兼容未升级的旧宿主探测口。
            var supported = !j.platform || j.platform === 'win32';
            if (supported) {
              // v0.21：探测口直接回传生效配置——挂载即得 liveCfg，不必等用户打开设置页
              // （此前重启后 liveCfg 为 null，footer 用 patch 默认值，已关的二次确认会复活）。
              if (j.config) { liveCfg = j.config; notifyCfg(); }
              if (j.derivedExe) derivedExe = j.derivedExe;
              // v1.1：版本判定与上次重启回执一并带走（设置页不必再发一次探测）
              liveMeta = {
                version: j.version === undefined ? null : j.version,
                supportedRange: j.supportedRange || '',
                supported: j.supported,
                lastRestart: j.lastRestart || null,
              };
              // 上次的重启还处在等待模式（例如用户重启前点了「等空闲」）→ 继续轮询显示
              if (j.wait && j.wait.state === 'waiting') refreshWait(j.wait);
              mount(ctx);
            }
          }
        })
        .catch(function () { /* 探测失败 = 不挂载（web 环境或宿主旧版），零副作用 */ });
    };

    return module.exports;
  },
});
