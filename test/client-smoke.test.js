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
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    textContent: '',
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  };
}

/** 把 client.js 装进最小浏览器沙箱，返回捕获到的模块导出与记录对象 */
function load({ probeBody, lang = 'zh-CN', locale = null, entries = null }) {
  const captured = { id: null, exports: null };
  const injected = [];
  const appendedStyles = [];
  const localeInjections = [];
  const effects = [];
  const store = new Map();
  if (entries) store.set('dsh-restart-now:entries', JSON.stringify(entries));
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children });

  const document = {
    documentElement: { getAttribute: (name) => (name === 'lang' ? (lang.startsWith('zh') ? 'zh-CN' : 'en') : null) },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const element = makeElement(tag);
      element.dataset = {};
      return element;
    },
    head: { appendChild: (tag) => appendedStyles.push(tag) },
    body: makeElement('body'),
  };

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
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(probeBody),
      });
    },
    window: {
      // v1.2：入口开关存本机 localStorage
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
            return {
              createElement,
              useState: (initial) => [initial, () => {}],
              useEffect: () => {},
            };
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
          inject: (slotName, factory) => { injected.push({ slotName, factory }); },
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
  return { captured, injected, appendedStyles, fetchCalls, ctx, createElement, localeInjections, effects, store };
}

const DESKTOP_PROBE = {
  ok: true,
  environment: 'desktop',
  platform: 'win32',
  config: { allowRestart: true, confirm: true, exePath: '', hideSidebarButton: false, platformAuth: true },
  derivedExe: 'D:\\dsh\\DeepSeek Harness.exe',
  version: '0.2.1-rc.2',
  supportedRange: '>=0.2.0-0',
  supported: true,
  lastRestart: { status: 'ok', downtimeMs: 9400, newPid: 4242 },
  wait: { state: 'idle' },
};

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
  // 用户上次在设置页关掉了 底部按钮 与 顶栏按钮 → localStorage 记着
  const { captured, injected, ctx } = load({
    probeBody: DESKTOP_PROBE,
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
    probeBody: DESKTOP_PROBE,
    entries: { panel: false, footer: false, header: false, settingsRow: false },
  });
  captured.exports.apply(ctx, {});
  await flush();

  assert.deepEqual(injected.map((i) => i.slotName), ['settings.section']);
  // ctx.effect 的 teardown 会被注册（真 cordis 卸载插件时会跑）
  assert.equal(typeof effects[0], 'function', '应通过 ctx.effect 注册清理回调');
});

test('U21c4 panellist 与 main 必须成对：只开 panel 时两个都在，关 panel 时两个都不在', async () => {
  const on = load({ probeBody: DESKTOP_PROBE, entries: { panel: true } });
  on.captured.exports.apply(on.ctx, {});
  await flush();
  const onSlots = on.injected.map((i) => i.slotName);
  assert.ok(onSlots.includes('sidebar.panellist') && onSlots.includes('main'));

  const off = load({ probeBody: DESKTOP_PROBE, entries: { panel: false } });
  off.captured.exports.apply(off.ctx, {});
  await flush();
  const offSlots = off.injected.map((i) => i.slotName);
  assert.ok(!offSlots.includes('sidebar.panellist'), 'panel 关掉后不该留 panellist');
  assert.ok(!offSlots.includes('main'), 'panel 关掉后必须同时撤 main，否则 selectPanel 指向空面板');
});

test('U21c5 旧配置键 hideSidebarButton 仍能硬关底部按钮（默认值来源）', async () => {
  const { captured, injected, ctx } = load({
    probeBody: {
      ...DESKTOP_PROBE,
      config: { allowRestart: true, confirm: true, exePath: '', hideSidebarButton: true, platformAuth: true },
    },
  });
  captured.exports.apply(ctx, {});
  await flush();
  assert.ok(!injected.map((i) => i.slotName).includes('sidebar.footer.action'),
    'hideSidebarButton:true 时底部按钮不应注册（向后兼容 v1.1 的配置）');
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
    '底部按钮同步时也须保留平台鉴权键（否则写丢后自动关闭鉴权）');
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
