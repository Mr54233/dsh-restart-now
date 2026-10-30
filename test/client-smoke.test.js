// test/client-smoke.test.js —— 客户端半边的装载冒烟（v1.1）
//
// 为什么需要它：lib/client.js 跑在浏览器里，宿主侧的 83 个单测覆盖不到它；
// 而它最容易犯的错（顶层语法、STRINGS 键缺失、apply 时机抛异常）会让整个插件包
// 在 __ModuleLoader__ 里静默失败——界面直接消失，日志里只有一行 loaded without registering。
// 这里用一个最小 DOM/React 桩把它真正跑起来：捕获 module factory、调用 apply，
// 断言「web 环境零挂载」「desktop 环境挂两个槽位」「中英文字典键集合一致」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

const REACT_KEYS = ['createElement', 'useState', 'useEffect'];

function makeElement(tag) {
  const handlers = {};
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    textContent: '',
    parentNode: null,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) { const list = handlers[type]; if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } },
    // 测试用：手动派发事件（真实浏览器里由用户点击/按键触发）。keydown 携带 Escape。
    __dispatch(type) { for (const fn of [...(handlers[type] || [])]) fn({ key: type === 'keydown' ? 'Escape' : '', stopPropagation() {} }); },
    focus() {},
  };
}

/** 把 client.js 装进最小浏览器沙箱，返回捕获到的模块导出与记录对象 */
function load({ probeBody, lang = 'zh-CN', locale = null, entries = null, configPostFail = false, configGetBody = null }) {
  const captured = { id: null, exports: null };
  const injected = [];
  const appendedStyles = [];
  const localeInjections = [];
  const effects = [];
  const store = new Map();
  const configPosts = [];
  if (entries) store.set('dsh-restart-now:entries', JSON.stringify(entries));
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children });

  // —— 迷你 hooks：让 useState/useEffect 真的能跑、能触发重渲染 ——
  // 只支持「一个组件实例」的场景（本文件每次渲染一个组件），足够覆盖设置页的异步加载路径。
  const hookState = [];
  let hookIdx = 0;
  let pendingEffects = [];
  const react = {
    createElement,
    useState(initial) {
      const i = hookIdx++;
      if (!(i in hookState)) hookState[i] = initial;
      return [hookState[i], (value) => { hookState[i] = typeof value === 'function' ? value(hookState[i]) : value; }];
    },
    useEffect(fn) { pendingEffects.push(fn); },
  };

  const document = {
    documentElement: { getAttribute: (name) => (name === 'lang' ? (lang.startsWith('zh') ? 'zh-CN' : 'en') : null) },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const element = makeElement(tag);
      element.dataset = {};
      return element;
    },
    // svgEl 用 createElementNS 建 svg/path；桩给一个与 makeElement 等价的工厂
    createElementNS: (ns, tag) => makeElement(tag),
    head: { appendChild: (tag) => appendedStyles.push(tag) },
    body: makeElement('body'),
    // openModal 把 Escape 监听挂在 document 上（capture）；真实浏览器由按键触发。
    addEventListener: (type, fn) => { (docHandlers[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { const list = docHandlers[type]; if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } },
    activeElement: null,
  };
  const docHandlers = {};

  const fetchCalls = [];
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    document,
    navigator: { language: lang },
    fetch: (url, init) => {
      fetchCalls.push({ url, init });
      const method = (init && init.method) || 'GET';
      // POST /config：v1.2.2 入口开关的落盘通道（configPostFail=true 模拟配置文件只读）
      if (method === 'POST' && String(url).endsWith('/config')) {
        configPosts.push({ url, init, body: JSON.parse((init && init.body) || '{}') });
        if (configPostFail) {
          return Promise.resolve({
            ok: false, status: 500,
            json: () => Promise.resolve({ ok: false, reason: 'config-write-failed' }),
          });
        }
        const posted = JSON.parse((init && init.body) || '{}');
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ ok: true, config: { ...DESKTOP_PROBE.config, ...posted } }),
        });
      }
      if (method === 'GET' && String(url).endsWith('/config') && configGetBody) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(configGetBody) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(probeBody),
      });
    },
    window: {
      // v1.2.2：localStorage 只是首帧缓存（真相在配置文件）
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(key, String(value)); },
        removeItem: (key) => { store.delete(key); },
      },
      __ModuleLoader__: {
        load(descriptor) {
          captured.id = descriptor.id;
          captured.exports = descriptor.factory((name) => {
            if (name !== 'react') throw new Error('unexpected require: ' + name);
            return react;
          });
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });

  const ctx = {
    get: (name) => {
      if (name === 'slots') {
        return {
          // 真 cordis 里 inject(...) 返回 disposer（客户端用它做「关掉入口就撤注册」，v1.2）；
          // 桩必须同样返回能撤掉记录的 disposer，否则重复 applyEntries 会累积出重复注册。
          inject: (slotName, factory) => {
            const entry = { slotName, factory };
            injected.push(entry);
            return () => {
              const i = injected.indexOf(entry);
              if (i >= 0) injected.splice(i, 1);
            };
          },
          register: (descriptor, render) => ({ ...descriptor, render }),
        };
      }
      if (name === 'locale') return locale;
      return undefined;
    },
    // v1.1.1：等 locale 服务出现的那条路（真 shell 里 locale 由官方 locale-client 异步 provide）
    inject: (deps, callback) => {
      localeInjections.push(deps);
      if (locale && deps.includes('locale')) callback({ locale, get: (n) => (n === 'locale' ? locale : undefined) });
      return () => {};
    },
    // v1.2：入口注销用 ctx.effect（真 cordis 里插件卸载时会跑 teardown）
    effect: (fn) => { const dispose = fn(); effects.push(dispose); return dispose; },
  };
  // 每次渲染一个组件前把 hook 游标归零（迷你 hooks 是单实例语义）
  const resetHooks = () => { hookIdx = 0; pendingEffects = []; };
  const takeEffects = () => { const list = pendingEffects; pendingEffects = []; return list; };
  // 测试用：在 document 上派发按键（openModal 的 Escape 监听在 document 上，capture）
  const pressEscape = () => { for (const fn of [...(docHandlers.keydown || [])]) fn({ key: 'Escape', stopPropagation() {} }); };
  // 当前挂着的模态根节点（openModal appendChild 到 body；关闭后应被移除）
  const modalRoots = () => document.body.children.filter((n) => String(n.className || '').includes('dsrn-modal-root'));
  return {
    captured, injected, appendedStyles, fetchCalls, ctx, createElement,
    localeInjections, effects, store, configPosts, resetHooks, takeEffects, react,
    document, pressEscape, modalRoots,
  };
}

const DESKTOP_PROBE = {
  ok: true,
  environment: 'desktop',
  platform: 'win32',
  // v1.2.2：入口开关进了配置层（八键），旧键 hideSidebarButton 已废弃
  config: {
    allowRestart: true, confirm: true, exePath: '', platformAuth: true,
    entryPanel: true, entryFooter: true, entryHeader: true, entrySettingsRow: true,
  },
  derivedExe: 'D:\\dsh\\DeepSeek Harness.exe',
  // v1.2.2 勘误：迁移判据来自服务端 entriesDeclared（不能看 config——eff 必然含 DEFAULTS 四键）
  entriesDeclared: true,
  version: '0.2.1-rc.2',
  supportedRange: '>=0.2.0-0',
  supported: true,
  lastRestart: { status: 'ok', downtimeMs: 9400, newPid: 4242 },
  wait: { state: 'idle' },
};

/** 配置层还没有任何 entry 键的形态（v1.1 及更早的配置文件）——用于测「缓存兜底 / 一次性迁移」 */
const NO_ENTRY_CONFIG = { allowRestart: true, confirm: true, exePath: '', platformAuth: true };

/** 老用户的探测口响应：配置文件从没写过 entry 键（服务端 entriesDeclared:false）。
 *  注意 config 仍然是**生效配置**（宿主合并了 DEFAULTS，四个 entry 键必然为 true）——
 *  真实形态就是这样，所以客户端不能拿 config 判迁移，只能看 entriesDeclared。 */
const LEGACY_PROBE = { ...DESKTOP_PROBE, config: DESKTOP_PROBE.config, entriesDeclared: false };

/** 递归收集元素树里的可见文本（我们的 React 桩把 children 存在数组里） */
function textOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out; }
  if (typeof node === 'object') {
    if (node.props) {
      if (typeof node.props.children !== 'undefined') textOf(node.props.children, out);
      // 直接传入的文本型 prop（我们的组件用 children 为主，但兜一层）
      for (const [key, value] of Object.entries(node.props)) {
        if (key !== 'children' && typeof value === 'string' && value.length < 40 && /[\u4e00-\u9fa5]|^[A-Z]/.test(value)) out.push(value);
      }
    }
    if (Array.isArray(node.children)) textOf(node.children, out);
    return out;
  }
  return out;
}

/** 把 render() 出来的元素真正执行一遍（组件是普通函数，直接调即可） */
function renderDeep(element) {
  if (!element || typeof element !== 'object') return element;
  if (typeof element.type !== 'function') return element;
  return element.type(element.props || {});
}

const flush = () => new Promise((resolve) => setImmediate(resolve));


test('U21a client.js 注册到 __ModuleLoader__，导出名/inject/apply 合规', () => {
  const { captured } = load({ probeBody: { ok: true, environment: 'web' } });
  assert.equal(captured.id, 'dsh-restart-now');
  assert.equal(captured.exports.name, 'dsh-restart-now');
  assert.deepEqual(Array.from(captured.exports.inject), ['slots']);
  assert.equal(typeof captured.exports.apply, 'function');
});

test('U21b web 环境（含平台不符）→ 零挂载，不碰任何槽位', async () => {
  for (const probeBody of [
    { ok: true, environment: 'web', platform: 'win32' },
    { ok: true, environment: 'desktop', platform: 'linux' },
    { ok: false },
  ]) {
    const { captured, injected, ctx } = load({ probeBody });
    captured.exports.apply(ctx, {});
    await flush();
    assert.equal(injected.length, 0, `${JSON.stringify(probeBody)} 下不应挂载任何入口`);
  }
});

test('U21c desktop 环境 → 挂载配置页 + 四个入口（panellist/main 成对）', async () => {
  const { captured, injected, ctx, createElement } = load({ probeBody: DESKTOP_PROBE });
  captured.exports.apply(ctx, {});
  await flush();

  assert.deepEqual(injected.map((i) => i.slotName).sort(), [
    'conversation.session.header.actions',
    'main',
    'settings.general.item',
    'settings.section',
    'sidebar.footer.action',
    'sidebar.panellist',
  ]);

  // 槽位注册描述符必须带 name；除 main（keyed 槽位，只有 key）外还要 id/label
  const descriptors = injected.map((i) => ({ slotName: i.slotName, descriptor: i.factory() }));
  for (const { slotName, descriptor } of descriptors) {
    assert.ok(descriptor, `${slotName} 注册回调须返回描述符`);
    assert.ok(descriptor.name, `${slotName} 描述符缺 name`);
  }
  for (const { slotName, descriptor } of descriptors) {
    if (slotName === 'main') {
      assert.equal(descriptor.key, 'dsh-restart-now', 'main 槽位必须用 panel 的 key');
      continue;
    }
    assert.ok(descriptor.id, `${slotName} 描述符缺 id`);
    // label 只有「导航行/整行」类槽位需要（官方 settings.general.item 与 header.actions 的
    // 示例都只传 id/order/locale：名字由组件自己画）
    if (slotName === 'settings.section' || slotName === 'sidebar.panellist' || slotName === 'sidebar.footer.action') {
      assert.ok(descriptor.label, `${slotName} 描述符缺 label（v0.6 踩过空名字）`);
    }
  }
  assert.equal(typeof createElement, 'function');
});

test('U21c2 关掉的入口连注册一起撤掉（不是渲染成空，而是压根不注册）', async () => {
  // v1.2.2：配置层还没有 entry 键（老配置）→ 首帧缓存里的旧值是唯一已知值
  const { captured, injected, ctx } = load({
    probeBody: LEGACY_PROBE,
    entries: { panel: true, footer: false, header: false, settingsRow: true },
  });
  captured.exports.apply(ctx, {});
  await flush();

  const slots = injected.map((i) => i.slotName).sort();
  assert.deepEqual(slots, ['main', 'settings.general.item', 'settings.section', 'sidebar.panellist']);
  assert.ok(!slots.includes('sidebar.footer.action'), 'footer 已关，不该注册');
  assert.ok(!slots.includes('conversation.session.header.actions'), 'header 已关，不该注册');
  // 配置页必须始终在，否则关完入口就再也回不来了
  assert.ok(slots.includes('settings.section'));
});

test('U21c3 全部入口关掉后仍保留配置页 + 插件卸载时撤销自己注册的入口', async () => {
  const { captured, injected, ctx, effects } = load({
    probeBody: LEGACY_PROBE,
    entries: { panel: false, footer: false, header: false, settingsRow: false },
  });
  captured.exports.apply(ctx, {});
  await flush();

  assert.deepEqual(injected.map((i) => i.slotName), ['settings.section']);
  // ctx.effect 的 teardown 会被注册（真 cordis 卸载插件时会跑）
  assert.equal(typeof effects[0], 'function', '应通过 ctx.effect 注册清理回调');
});

test('U21c4 panellist 与 main 必须成对：只开 panel 时两个都在，关 panel 时两个都不在', async () => {
  const offProbe = LEGACY_PROBE;
  const on = load({ probeBody: offProbe, entries: { panel: true } });
  on.captured.exports.apply(on.ctx, {});
  await flush();
  const onSlots = on.injected.map((i) => i.slotName);
  assert.ok(onSlots.includes('sidebar.panellist') && onSlots.includes('main'));

  const off = load({ probeBody: offProbe, entries: { panel: false } });
  off.captured.exports.apply(off.ctx, {});
  await flush();
  const offSlots = off.injected.map((i) => i.slotName);
  assert.ok(!offSlots.includes('sidebar.panellist'), 'panel 关掉后不该留 panellist');
  assert.ok(!offSlots.includes('main'), 'panel 关掉后必须同时撤 main，否则 selectPanel 指向空面板');
});

test('U21c5 配置层关掉的入口生效（v1.2.2：开关的真相来源是配置文件）', async () => {
  const { captured, injected, ctx } = load({
    probeBody: { ...DESKTOP_PROBE, config: { ...DESKTOP_PROBE.config, entryFooter: false } },
  });
  captured.exports.apply(ctx, {});
  await flush();
  assert.ok(!injected.map((i) => i.slotName).includes('sidebar.footer.action'),
    'entryFooter:false 时底部按钮不应注册');
  assert.ok(injected.map((i) => i.slotName).includes('settings.section'), '配置页始终在');
});

test('U21c6 v1.2.1 平台鉴权：请求必须带 cookie，且配置页有逃生门开关', () => {
  // credentials:'omit' 会让壳层鉴权拿不到 cookie → 界面上每个操作都 401。
  // 这条断言是「鉴权上线后界面仍能用」的唯一保护。
  assert.ok(!/credentials:\s*'omit'/.test(source),
    '不得省略凭据：启用平台鉴权后界面操作会全部 401');
  assert.match(source, /credentials:\s*'same-origin'/, '同源请求须携带平台会话 cookie');
  assert.ok(source.includes("key: 'platformAuth'"), '配置页须有平台鉴权开关（逃生门）');
  assert.ok(source.includes('platformAuth: s.cfg.platformAuth !== false'), '保存时须写回平台鉴权键');
  assert.ok(source.includes('platformAuth: base.platformAuth !== false'),
    '入口开关写回时也须保留平台鉴权键（否则写丢后自动关闭鉴权）');
  assert.ok(source.includes('res.status === 401'), '界面须单独识别 401（与 403 文案分开）');
});

test('U21d 中英字典键集合一致（漏翻会退化成中文/键名，用户能看出来）', () => {
  // 用括号配平截出 STRINGS 对象本体，避免把后面 React 组件的属性名（hint/role/type…）也抓进来
  const start = source.indexOf('var STRINGS = {');
  assert.ok(start > 0, '未找到 STRINGS 定义');
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > start, '未找到 STRINGS 的收尾括号');
  const block = source.slice(start, end);
  const keysOf = (text) => {
    const keys = [];
    const re = /^\s{8}([a-zA-Z][a-zA-Z0-9]*):/gm;
    let match;
    while ((match = re.exec(text)) !== null) keys.push(match[1]);
    return keys.sort();
  };
  const zhStart = block.indexOf('zh: {');
  const enStart = block.indexOf('en: {');
  assert.ok(zhStart > 0 && enStart > zhStart, 'STRINGS 里应同时有 zh 与 en');
  const zhKeys = keysOf(block.slice(zhStart, enStart));
  const enKeys = keysOf(block.slice(enStart));
  assert.deepEqual(enKeys, zhKeys, 'STRINGS.zh 与 STRINGS.en 的键必须一一对应');
  assert.ok(zhKeys.length >= 25, '文案表异常过小，正则可能失配');
});

test('U21e 深色/等待相关文案没有残留 delayMs 概念', () => {
  assert.equal(source.includes('delayMs'), false, 'v1.1 删掉了 delayMs，客户端不该再提');
  assert.equal(source.includes('延时'), false, '文案里也不该再出现「延时」');
});

// —— U21f/U21g：把两个组件真正渲染一遍（React 桩里组件是普通函数，直接调）——
// 目的不是像素，而是「渲染路径不抛异常」「关键状态文案真的接上了 i18n」。
// vm 冒烟只能证明模块装载与 apply；这里补上 useState/useEffect 之外的真渲染。

test('U21f 设置页区块渲染成功，加载态/版本行文案来自字典（中文）', async () => {
  const { captured, injected, ctx } = load({ probeBody: DESKTOP_PROBE, lang: 'zh-CN' });
  captured.exports.apply(ctx, {});
  await flush();

  const section = injected.find((i) => i.slotName === 'settings.section');
  assert.ok(section, '设置页槽位未注册');
  const descriptor = section.factory();
  const tree = renderDeep(descriptor.render({}));
  assert.ok(tree && typeof tree === 'object', '设置页组件未返回元素');

  const text = textOf(tree).join(' ');
  assert.ok(text.length > 0, '渲染结果没有任何文本');
  // 初始加载态来自 t('configLoading')；版本行来自 liveMeta（探测口已回传 0.2.1-rc.2）
  assert.ok(/配置加载中|Loading settings/.test(text), `加载态文案缺失：${text.slice(0, 120)}`);
  assert.ok(!/undefined|NaN/.test(text), `渲染出未定义值：${text.slice(0, 200)}`);
});

test('U21g 侧栏行渲染成功且宽态显示本地化标题，窄态只有图标', async () => {
  for (const [lang, expected] of [['zh-CN', '重启应用'], ['en-US', 'Restart app']]) {
    const { captured, injected, ctx } = load({ probeBody: DESKTOP_PROBE, lang });
    captured.exports.apply(ctx, {});
    await flush();

    const footer = injected.find((i) => i.slotName === 'sidebar.footer.action');
    assert.ok(footer, '侧栏槽位未注册');
    const descriptor = footer.factory();

    const wideTree = renderDeep(descriptor.render({ wide: true }));
    const wideText = textOf(wideTree).join(' ');
    assert.ok(wideText.includes(expected), `${lang} 宽态标题应为「${expected}」，实际：${wideText.slice(0, 120)}`);

    // 窄态（56px 轨）只出图标：不该有可见标题节点（aria-label 仍应保留，方便读屏/悬浮提示）
    const narrowTree = renderDeep(descriptor.render({ wide: false }));
    const hasTitle = (function walk(node) {
      if (!node || typeof node !== 'object') return false;
      if (Array.isArray(node)) return node.some(walk);
      if (node.props && typeof node.props.className === 'string' && node.props.className.includes('dsrn-title')) return true;
      if (Array.isArray(node.children)) return node.children.some(walk);
      return false;
    })(narrowTree);
    assert.equal(hasTitle, false, '窄态不应渲染 dsrn-title 文字节点');
  }
});

// v1.1.1：语言判定必须以 DSH 的 locale 服务为准
// 真机 bug 现场：桌面端界面是中文，但 <html lang> 由 locale 服务稍后才写、Electron 的
// navigator.language 是 en-US → 旧实现（只读这两处）把中文界面判成英文。
test('U21h locale 服务优先：html lang/navigator 都说 en 时也按服务的中文渲染', async () => {
  const locale = { active: 'zh-CN', getSnapshot: () => ({ active: locale.active }), subscribe() {} };
  const { captured, injected, ctx } = load({ probeBody: DESKTOP_PROBE, lang: 'en-US', locale });
  captured.exports.apply(ctx, {});
  await flush();

  const footer = injected.find((i) => i.slotName === 'sidebar.footer.action');
  assert.ok(footer, '侧栏槽位未注册');
  const wideText = textOf(renderDeep(footer.factory().render({ wide: true }))).join(' ');
  assert.ok(wideText.includes('重启应用'), `应显示中文标题，实际：${wideText.slice(0, 120)}`);

  const section = injected.find((i) => i.slotName === 'settings.section');
  const sectionText = textOf(renderDeep(section.factory().render({}))).join(' ');
  assert.ok(/配置加载中/.test(sectionText), `设置页应为中文，实际：${sectionText.slice(0, 120)}`);
});

test('U21i locale 服务切到英文 → 已挂载入口跟着换语言', async () => {
  let subscriber = null;
  const locale = {
    active: 'zh-CN',
    getSnapshot: () => ({ active: locale.active }),
    subscribe: (fn) => { subscriber = fn; return () => { subscriber = null; }; },
  };
  const { captured, injected, ctx } = load({ probeBody: DESKTOP_PROBE, lang: 'zh-CN', locale });
  captured.exports.apply(ctx, {});
  await flush();

  const footer = injected.find((i) => i.slotName === 'sidebar.footer.action');
  const descriptor = footer.factory();
  assert.ok(textOf(renderDeep(descriptor.render({ wide: true }))).join(' ').includes('重启应用'));

  // 用户在 设置 → 通用 里把语言切成 English
  locale.active = 'en';
  assert.equal(typeof subscriber, 'function', '应当订阅 locale 变化');
  subscriber();

  const after = textOf(renderDeep(descriptor.render({ wide: true }))).join(' ');
  assert.ok(after.includes('Restart app'), `切换后应显示英文，实际：${after.slice(0, 120)}`);
});

// —— v1.2 三个新入口的渲染 ——
// 竞品1 有五个入口，我们此前只有两个（侧栏底部 + 配置页）。新增：侧栏面板、会话标题栏、
// 设置→通用 行。这里逐个渲染，确保它们真的产出可交互元素且文案接了字典。
test('U21j 会话标题栏按钮：渲染出图标 + 本地化文字，宽窄无关', async () => {
  for (const [lang, expected] of [['zh-CN', '重启'], ['en-US', 'Restart']]) {
    const { captured, injected, ctx } = load({ probeBody: DESKTOP_PROBE, lang });
    captured.exports.apply(ctx, {});
    await flush();

    const header = injected.find((i) => i.slotName === 'conversation.session.header.actions');
    assert.ok(header, '标题栏槽位未注册');
    const tree = renderDeep(header.factory().render({}));
    assert.ok(tree && typeof tree === 'object', '标题栏组件未返回元素');
    assert.equal(tree.props.className, 'dsrn-hdr');
    const text = textOf(tree).join(' ');
    assert.ok(text.includes(expected), `${lang} 标题栏文案应为「${expected}」，实际：${text.slice(0, 80)}`);
  }
});

test('U21k 设置→通用 行：左文右钮，点击即重启（不经确认框时直接 POST）', async () => {
  const { captured, injected, ctx, fetchCalls } = load({
    probeBody: { ...DESKTOP_PROBE, config: { allowRestart: true, confirm: false, exePath: '', hideSidebarButton: false, platformAuth: true } },
    lang: 'zh-CN',
  });
  captured.exports.apply(ctx, {});
  await flush();

  const row = injected.find((i) => i.slotName === 'settings.general.item');
  assert.ok(row, '设置通用行槽位未注册');
  const tree = renderDeep(row.factory().render({}));
  assert.ok(tree && typeof tree === 'object');
  assert.equal(tree.props.className, 'dsrn-gen');

  const text = textOf(tree).join(' ');
  assert.ok(text.includes('重启'), `应有本地化文案，实际：${text.slice(0, 80)}`);

  // 找到按钮并点它（confirm:false → 直接 POST，不弹确认框）
  const button = (function walk(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = walk(child); if (hit) return hit; } return null; }
    if (node.type === 'button') return node;
    if (Array.isArray(node.children)) return walk(node.children);
    return null;
  })(tree);
  assert.ok(button, '行内应有按钮');
  fetchCalls.length = 0;
  await button.props.onClick();
  await flush();
  assert.ok(fetchCalls.some((c) => String(c.url).endsWith('/plugins/dsh-restart-now/restart')
    && c.init && c.init.method === 'POST'), '点击后应发出重启请求');
});

test('U21l 侧栏面板页：标题/说明/版本行/上次重启都在，且主按钮可点', async () => {
  const { captured, injected, ctx } = load({ probeBody: DESKTOP_PROBE, lang: 'zh-CN' });
  captured.exports.apply(ctx, {});
  await flush();

  // 面板页注册在 keyed 的 main 槽位（restart 是它的 render）
  const main = injected.find((i) => i.slotName === 'main');
  assert.ok(main, 'main 槽位未注册');
  const descriptor = main.factory();
  const tree = renderDeep(descriptor.render({}));
  assert.ok(tree && typeof tree === 'object', '面板组件未返回元素');
  assert.equal(tree.props.className, 'dsrn-panel');

  const text = textOf(tree).join(' ');
  assert.ok(text.includes('DSH 0.2.1-rc.2'), `版本行缺失：${text.slice(0, 160)}`);
  assert.ok(!/undefined|NaN/.test(text), `渲染出未定义值：${text.slice(0, 200)}`);

  // panellist 的图标组件只吃 {size, active}，返回图标元素（整行由侧栏自己画）
  const panellist = injected.find((i) => i.slotName === 'sidebar.panellist');
  const glyph = panellist.factory().render({ size: 16, active: true });
  assert.ok(glyph && typeof glyph === 'object', 'panellist 图标未返回元素');
});

test('U21m v1.2 入口文案两语言齐备（含面板/标题栏/设置行/入口组）', () => {
  for (const key of ['entryGroup', 'entryPanel', 'entryFooter', 'entryHeader',
    'entrySettingsRow', 'entryCommandHint', 'panelTitle', 'panelDesc',
    'headerLabel', 'settingsRowLabel', 'settingsRowHint']) {
    const hits = source.split(key + ':').length - 1;
    assert.ok(hits >= 2, `文案键 ${key} 应同时出现在 zh 与 en 里`);
  }
});

// —— v1.2.2（issue #1）：入口开关的真相在配置文件，localStorage 只当首帧缓存 ——
// 真机缺陷：强杀（taskkill /PID /F）让 Chromium 丢掉未提交的 localStorage 写入 →
// 关掉的入口重启后回弹。修法是把开关写进 profile 配置文件（宿主落盘、强杀不丢），
// 并对老用户做一次性迁移。下面三条守住「迁移一次」「配置优先」「写失败可见」。

test('U21r 老配置（无 entry 键）+ 缓存有值 → 恰好迁移一次 POST /config', async () => {
  const { captured, ctx, configPosts } = load({
    probeBody: LEGACY_PROBE,
    entries: { panel: true, footer: false, header: false, settingsRow: true },
  });
  captured.exports.apply(ctx, {});
  await flush();

  assert.equal(configPosts.length, 1, `迁移应当恰好写回一次，实际 ${configPosts.length} 次`);
  const sent = configPosts[0].body;
  assert.equal(sent.entryFooter, false, '缓存里关掉的底部按钮要迁进配置层');
  assert.equal(sent.entryHeader, false, '缓存里关掉的标题栏按钮要迁进配置层');
  assert.equal(sent.entryPanel, true);
  assert.equal(sent.entrySettingsRow, true);
  // 迁移是「全量 8 键」写回：不能把别的键写丢
  for (const key of ['allowRestart', 'confirm', 'exePath', 'platformAuth']) {
    assert.ok(key in sent, `迁移写回漏了 ${key}（全量 8 键才会不丢配置）`);
  }
  assert.equal('hideSidebarButton' in sent, false, '废弃键不得再写回磁盘');
});

test('U21s 配置层已有 entry 键 → 永不迁移，且配置赢过缓存', async () => {
  const { captured, ctx, injected, configPosts } = load({
    probeBody: { ...DESKTOP_PROBE, config: { ...DESKTOP_PROBE.config, entryFooter: false } },
    entries: { panel: true, footer: true, header: true, settingsRow: true },
  });
  captured.exports.apply(ctx, {});
  await flush();

  assert.equal(configPosts.length, 0, '配置层已有 entry 键时不该再迁移写回');
  const slots = injected.map((i) => i.slotName);
  assert.ok(!slots.includes('sidebar.footer.action'),
    '配置说 entryFooter:false，缓存里的 true 不得翻盘（配置层是真相来源）');
});

test('U21t 写回失败 → 设置页显红字提示，且开关仍然即时生效（撤注册不依赖落盘）', async () => {
  const { captured, ctx, injected, configPosts, resetHooks, takeEffects } = load({
    probeBody: LEGACY_PROBE,
    entries: { panel: true, footer: false, header: true, settingsRow: true },
    configPostFail: true,
    configGetBody: { ok: true, config: DESKTOP_PROBE.config, derivedExe: DESKTOP_PROBE.derivedExe },
  });
  captured.exports.apply(ctx, {});
  await flush();

  // 迁移写回失败（配置文件只读）
  assert.equal(configPosts.length, 1);
  // 界面行为不依赖落盘：关掉的入口已经撤注册
  assert.ok(!injected.map((i) => i.slotName).includes('sidebar.footer.action'),
    '写失败也不能拦住界面上的即时生效');

  const section = injected.find((i) => i.slotName === 'settings.section');
  assert.ok(section, '配置页槽位未注册');
  const descriptor = section.factory();

  // 第一遍渲染：加载态；把 effect 跑起来让 GET /config 落地
  resetHooks();
  renderDeep(descriptor.render({}));
  for (const fn of takeEffects()) fn();
  await flush();
  await flush();

  // 第二遍渲染：此时加载完成，且 entryWriteFailed 为真 → 必须出现红字
  resetHooks();
  const tree = renderDeep(descriptor.render({}));
  const text = textOf(tree).join(' ');
  assert.match(text, /未能保存到配置文件|Could not save to the config file/,
    `写回失败必须在界面上明示（issue #1 的次生原因就是静默失败）：${text.slice(0, 300)}`);
});

// —— v1.2.3（issue #2）：确认框从 x / 遮罩 / Escape 关闭后必须能再次弹出 ——
// 真机缺陷：confirmOpen 只在包装的 m.close 里复位，而 x/遮罩/Escape 走 openModal 内部
// close()，绕过了包装 → confirmOpen 永久 true → 再点「立即重启」既不弹窗也不重启。
test('U21u 确认框被 x/遮罩/Escape 关闭后，再次点击仍能弹出（issue #2）', async () => {
  const { captured, injected, ctx, document, pressEscape, modalRoots, fetchCalls } = load({
    probeBody: DESKTOP_PROBE, // confirm: true（默认）→ 走确认框路径
    lang: 'zh-CN',
  });
  captured.exports.apply(ctx, {});
  await flush();

  const row = injected.find((i) => i.slotName === 'settings.general.item');
  assert.ok(row, '设置通用行槽位未注册');
  const button = (function walk(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = walk(child); if (hit) return hit; } return null; }
    if (node.type === 'button') return node;
    if (Array.isArray(node.children)) return walk(node.children);
    return null;
  })(renderDeep(row.factory().render({})));
  assert.ok(button, '行内应有按钮');
  fetchCalls.length = 0;

  // 第一轮：点「立即重启」→ 弹确认框（不发重启请求）
  await button.props.onClick();
  await flush();
  assert.equal(modalRoots().length, 1, '点击后应弹出确认框');
  assert.ok(!fetchCalls.some((c) => String(c.url).endsWith('/restart') && c.init && c.init.method === 'POST'),
    '确认框未点「重启」前不得发出请求');

  // x / 遮罩 / Escape 三条路轮一遍：关掉 → 再点 → 必须再次弹（issue #2 的失效路径）
  const closePaths = [
    { label: 'x', act: () => findCloseButton(modalRoots()[0]).__dispatch('click') },
    { label: 'mask', act: () => findMask(modalRoots()[0]).__dispatch('click') },
    { label: 'Escape', act: () => pressEscape() },
  ];
  for (const path of closePaths) {
    await button.props.onClick();
    await flush();
    assert.equal(modalRoots().length, 1, `(${path.label}) 关闭前应有一个确认框`);
    path.act();
    assert.equal(modalRoots().length, 0, `(${path.label}) 关闭后确认框应移除`);
    // 关掉之后 confirmOpen 必须已复位：再点能重新弹（旧实现在这里永久失效）
    await button.props.onClick();
    await flush();
    assert.equal(modalRoots().length, 1, `(${path.label}) 关闭后再次点击必须能再弹确认框`);
    // 收尾：用 Escape 关掉，进入下一轮
    pressEscape();
    assert.equal(modalRoots().length, 0, `(${path.label}) 收尾关闭失败`);
  }

  // U21k 已覆盖「点确认」→ POST；本用例只验证 issue #2 的三条关闭路径，
  // 避免把异步重启请求混进确认框状态机。上面的断言已证明每次关闭后 confirmOpen 都复位。

  function findCloseButton(root) {
    return (function walk(n) {
      if (!n || typeof n !== 'object') return null;
      if (Array.isArray(n)) { for (const c of n) { const hit = walk(c); if (hit) return hit; } return null; }
      if (n.tagName === 'BUTTON' && String(n.className || '').includes('dsrn-modal-close')) return n;
      return walk(n.children);
    })(root);
  }
  function findMask(root) {
    return root.children.find((c) => String(c.className || '').includes('dsrn-modal-mask'));
  }
  function findConfirmButton(root) {
    return (function walk(n) {
      if (!n || typeof n !== 'object') return null;
      if (Array.isArray(n)) { for (const c of n) { const hit = walk(c); if (hit) return hit; } return null; }
      if (n.tagName === 'BUTTON' && String(n.className || '').includes('dsrn-confirm-action')) return n;
      return walk(n.children);
    })(root);
  }
});

