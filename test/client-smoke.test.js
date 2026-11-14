// test/client-smoke.test.js —— 客户端半边的装载冒烟（v1.1）
//
// 为什么需要它：lib/client.js 跑在浏览器里，宿主侧的 83 个单测覆盖不到它；
// 而它最容易犯的错（顶层语法、STRINGS 键缺失、apply 时机抛异常）会让整个插件包
// 在 __ModuleLoader__ 里静默失败——界面直接消失，日志里只有一行 loaded without registering。
// 这里用一个最小 DOM/React 桩把它真正跑起来：捕获 module factory、调用 apply，
// 断言「web / 未知平台零挂载」「win32 / darwin 桌面挂载全部入口」「中英文字典键集合一致」。
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
    handlers, // 测试用：断言事件处理器已登记（如标题栏菜单项的 click/pointerdown）
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; },
    // v1.3.1 标题栏注入用：menubar 桩需要按属性选择器查子级（查重 [data-dsrn-titlebar-restart]）
    querySelector(sel) {
      const m = /^\[([a-z-]+)\]$/i.exec(sel);
      if (!m) return null;
      return this.children.find((c) => c && c.hasAttribute && c.hasAttribute(m[1])) || null;
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) { const list = handlers[type]; if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } },
    // 测试用：手动派发事件（真实浏览器里由用户点击/按键触发）。keydown 携带 Escape。
    __dispatch(type) { for (const fn of [...(handlers[type] || [])]) fn({ key: type === 'keydown' ? 'Escape' : '', preventDefault() {}, stopPropagation() {} }); },
    focus() {},
  };
}

/** 把 client.js 装进最小浏览器沙箱，返回捕获到的模块导出与记录对象 */
function load({ probeBody, lang = 'zh-CN', locale = null, entries = null, configPostFail = false, configGetBody = null, closeResponder = null, restartResponder = null, envResponder = null, windowsMenu = null }) {
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
    querySelector: (sel) => (sel === '[data-windows-menu]' ? menuHost : null),
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

  // —— v1.3.1 标题栏菜单注入桩：windowsMenu 传入时构造 [data-windows-menu] 开放 shadow root ——
  // 形态对齐 asar preload-app.cjs：host[data-windows-menu] > shadowRoot > [role=menubar] > 按钮。
  // MutationObserver 桩收集回调，titlebarEntryObservers() 让用例模拟「宿主菜单条晚出现/重建」。
  const titlebarObservers = [];
  let menuHost = null;
  if (windowsMenu) {
    const menubar = makeElement('div');
    menubar.setAttribute('role', 'menubar');
    for (const item of windowsMenu) {
      const btn = makeElement('button');
      btn.textContent = item;
      menubar.appendChild(btn);
    }
    menuHost = makeElement('div');
    menuHost.setAttribute('data-windows-menu', '');
    menuHost.shadowRoot = { querySelector: (sel) => (sel === '[role="menubar"]' ? menubar : null) };
    menuHost.__menubar = menubar;
  }
  class MutationObserverStub {
    constructor(fn) { this.fn = fn; }
    observe() { titlebarObservers.push(this); }
    disconnect() { const i = titlebarObservers.indexOf(this); if (i >= 0) titlebarObservers.splice(i, 1); }
  }

  const fetchCalls = [];
  // v1.3.1 有界轮询（watchRestartOutcome）测试设施：
  //   intervals —— setInterval 不真跑，收集回调，测试用 tickIntervals() 手动触发一整轮；
  //   clock/Date —— client.js 只用 Date.now()（20s 判定线与 90s 总预算），桩成可推进的时钟；
  //   envState —— GET /environment 的**挂载后**可编程响应（探测与轮询同路径：挂载必须吃
  //     真实形态的探测响应才能挂上入口，轮询想模拟 failed/unconfirmed/服务没了由用例改写）。
  const intervals = [];
  const envState = { body: null, fail: false };
  let clockNow = 1700000000000;
  const clock = { advance: (ms) => { clockNow += Number(ms) || 0; } };
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (fn, ms) => { const entry = { id: intervals.length + 1, fn, ms }; intervals.push(entry); return entry.id; },
    clearInterval: (id) => { const i = intervals.findIndex((e) => e.id === id); if (i >= 0) intervals.splice(i, 1); },
    MutationObserver: MutationObserverStub,
    Date: { now: () => clockNow },
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
      // v1.3.1 仅关闭：POST /close 的可编程响应（closeResponder 返回 {status, body}）。
      // 未提供时与其它请求一样回 probeBody（status 200 → postClose 走 rejected 兜底分支）。
      if (method === 'POST' && closeResponder && String(url).indexOf('/plugins/dsh-restart-now/close') !== -1) {
        const out = closeResponder(String(url), init) || {};
        return Promise.resolve({
          ok: Number(out.status) < 400,
          status: Number(out.status) || 200,
          json: () => Promise.resolve(out.body || {}),
        });
      }
      // v1.3.1 有界轮询：POST /restart 的可编程响应（restartResponder 返回 {status, body}），
      // 202 派发成功路径必须 202 才会启动轮询；未提供时回 probeBody（status 200 → rejected 分支）。
      if (method === 'POST' && restartResponder && String(url).indexOf('/plugins/dsh-restart-now/restart') !== -1) {
        const out = restartResponder(String(url), init) || {};
        return Promise.resolve({
          ok: Number(out.status) < 400,
          status: Number(out.status) || 200,
          json: () => Promise.resolve(out.body || {}),
        });
      }
      // v1.3.1 有界轮询：GET /environment 的可编程响应（启动探测与轮询共用同一路径）。
      // envState.fail=true 模拟服务没了（正常停机进行中 → fetch 抛错 → 轮询静默停止）；
      // envState.body 非空时优先（挂载后由用例改写，喂给轮询），否则回探测口真身 probeBody。
      if (method === 'GET' && String(url).indexOf('/plugins/dsh-restart-now/environment') !== -1) {
        if (envState.fail) return Promise.reject(new Error('simulated: server gone'));
        const payload = envState.body || probeBody;
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(payload),
        });
      }
      // 兼容：仍提供 envResponder 的旧式可编程探测（挂载期即生效）
      if (method === 'GET' && envResponder && String(url).indexOf('/plugins/dsh-restart-now/environment') !== -1) {
        const out = envResponder(String(url), init) || {};
        if (out && out.fail) return Promise.reject(new Error('simulated: server gone'));
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(out.body !== undefined ? out.body : out),
        });
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
  // 手动触发一整轮 interval 回调（拷贝数组：回调里可能 clearInterval 自停）
  const tickIntervals = () => { for (const entry of [...intervals]) entry.fn(); };
  return {
    captured, injected, appendedStyles, fetchCalls, ctx, createElement,
    localeInjections, effects, store, configPosts, resetHooks, takeEffects, react,
    document, pressEscape, modalRoots, intervals, clock, tickIntervals, envState,
    titlebarObservers, menuHost,
  };
}

const DESKTOP_PROBE = {
  ok: true,
  environment: 'desktop',
  platform: 'win32',
  // v1.3.1：入口开关九键（v1.2.2 八键 + entryTitlebar），旧键 hideSidebarButton 已废弃
  config: {
    allowRestart: true, confirm: true, exePath: '', platformAuth: true,
    entryPanel: true, entryFooter: true, entryHeader: true, entrySettingsRow: true,
    entryTitlebar: true,
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

/** v1.3.0：macOS 桌面探测响应 = 同一份 DESKTOP_PROBE，只是平台与推导 exe 换成 mac 真实形态
 *  （<App>.app/Contents/MacOS/<App>，路径含空格）。客户端白名单放宽后必须照常全量挂载。 */
const DARWIN_PROBE = {
  ...DESKTOP_PROBE,
  platform: 'darwin',
  derivedExe: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
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

/** 在 React 元素树里按可见文案找 type==='button' 的元素（v1.3.1 仅关闭用例用） */
function findReactButton(tree, needle) {
  return (function walk(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = walk(child); if (hit) return hit; } return null; }
    if (node.type === 'button' && textOf(node).join('').includes(needle)) return node;
    if (node.props && node.props.children !== undefined) {
      const hit = walk(node.props.children);
      if (hit) return hit;
    }
    return Array.isArray(node.children) ? walk(node.children) : null;
  })(tree);
}

/** 在 DOM 桩树里按类名找 button 元素（openModal/openConfirm 的 footer 按钮是 DOM 桩） */
function findDomButton(root, classNameNeedle) {
  return (function walk(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = walk(child); if (hit) return hit; } return null; }
    if (node.tagName === 'BUTTON' && String(node.className || '').includes(classNameNeedle)) return node;
    return walk(node.children);
  })(root);
}

/** React 元素树里第一个 type==='button' 的元素（dsrn-gen 行 / 标题栏钮等单按钮树用） */
function firstButton(tree) {
  return (function walk(node) {
    if (!node || typeof node === 'string' || typeof node === 'number') return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = walk(child); if (hit) return hit; } return null; }
    if (node.type === 'button') return node;
    if (node.props && node.props.children !== undefined) { const hit = walk(node.props.children); if (hit) return hit; }
    return Array.isArray(node.children) ? walk(node.children) : null;
  })(tree);
}

/** 找入口开关行（SwitchField：div.dsrn-field，label 文本含 needle） */
function findSwitchRow(tree, labelNeedle) {
  const rows = [];
  (function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node.props && node.props.className === 'dsrn-field') rows.push(node);
    if (node.props && node.props.children !== undefined) collect(node.props.children);
    if (Array.isArray(node.children)) node.children.forEach(collect);
  })(tree);
  return rows.find((row) => textOf(row).join(' ').includes(labelNeedle)) || null;
}

/** 开关行内的 switch 按钮（button[role=switch]，onClick → onChange(!checked)） */
function firstRoleSwitch(tree) {
  return (function walk(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const hit = walk(child); if (hit) return hit; } return null; }
    if (node.type === 'button' && node.props && node.props.role === 'switch') return node;
    if (node.props && node.props.children !== undefined) { const hit = walk(node.props.children); if (hit) return hit; }
    return Array.isArray(node.children) ? walk(node.children) : null;
  })(tree);
}

/** DOM 桩树文本：el() 把文字放在 textContent（不走 children），与 textOf 互补 */
function domText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) domText(child, out); return out; }
  if (typeof node === 'object') {
    if (node.textContent) out.push(String(node.textContent));
    if (Array.isArray(node.children)) { for (const child of node.children) domText(child, out); }
    if (node.props && node.props.children !== undefined) domText(node.props.children, out);
  }
  return out;
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

// v1.3.0：重启链路已打通 macOS，挂载白名单从「仅 win32」放宽到 win32 + darwin。
// 探测响应复用 DESKTOP_PROBE，只替换平台与 derivedExe（.app 内 Mach-O 路径，含空格）。
test('U21b2 darwin 探测响应 → 挂载全部入口（v1.3.0 白名单）', async () => {
  const { captured, injected, ctx } = load({ probeBody: DARWIN_PROBE });
  captured.exports.apply(ctx, {});
  await flush();

  assert.deepEqual(injected.map((i) => i.slotName).sort(), [
    'conversation.session.header.actions',
    'main',
    'settings.general.item',
    'settings.section',
    'sidebar.footer.action',
    'sidebar.panellist',
  ], 'darwin 桌面必须与 win32 一样挂载全部入口（v1.3.0 白名单含 macOS；标题栏项是 DOM 注入不占槽位）');
});

test('U21c desktop 环境 → 挂载配置页 + 五个入口（panellist/main 成对；标题栏项是 DOM 注入不占槽位）', async () => {
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
    entries: { panel: true, footer: false, header: false, settingsRow: true, titlebar: true },
  });
  captured.exports.apply(ctx, {});
  await flush();

  const slots = injected.map((i) => i.slotName).sort();
  assert.deepEqual(slots, [
    'main', 'settings.general.item', 'settings.section', 'sidebar.panellist',
  ]);
  assert.ok(!slots.includes('sidebar.footer.action'), 'footer 已关，不该注册');
  assert.ok(!slots.includes('conversation.session.header.actions'), 'header 已关，不该注册');
  // 配置页必须始终在，否则关完入口就再也回不来了
  assert.ok(slots.includes('settings.section'));
});

test('U21c3 全部入口关掉后仍保留配置页 + 插件卸载时撤销自己注册的入口', async () => {
  const { captured, injected, ctx, effects } = load({
    probeBody: LEGACY_PROBE,
    entries: { panel: false, footer: false, header: false, settingsRow: false, titlebar: false },
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

test('U21m v1.2 入口文案两语言齐备（含面板/标题栏/设置行/入口组/停机轮询失败可见）', () => {
  for (const key of ['entryGroup', 'entryPanel', 'entryFooter', 'entryHeader',
    'entrySettingsRow', 'entryTitlebar', 'entryCommandHint', 'panelTitle', 'panelDesc',
    'headerLabel', 'settingsRowLabel', 'settingsRowHint',
    'restartAborted', 'restartNotEffective', 'closeAborted', 'closeNotEffective']) {
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

// —— v1.3.1 仅关闭（close-only）——
// 宿主探测口 closeSupported（= 助手已实现 action:'close'）控制一切关闭入口的渲染；
// 确认文案必须明确「不会自动重启」；忙碌时只有「仍然关闭/取消」，绝无「等空闲后重启」。
const CLOSE_PROBE = { ...DESKTOP_PROBE, closeSupported: true };

test('U21v 仅关闭：主面板出现「仅关闭」入口，确认文案明确不重启，确认后 POST /close（不带任何 query）', async () => {
  const { captured, injected, ctx, fetchCalls, modalRoots } = load({ probeBody: CLOSE_PROBE, lang: 'zh-CN' });
  captured.exports.apply(ctx, {});
  await flush();

  const main = injected.find((i) => i.slotName === 'main');
  assert.ok(main, 'main 槽位未注册');
  const tree = renderDeep(main.factory().render({}));
  const text = textOf(tree).join(' ');
  assert.ok(text.includes('仅关闭'), `面板应有「仅关闭」按钮：${text.slice(0, 200)}`);
  assert.ok(text.includes('立即重启'), '重启主按钮仍在（兼容原重启）');

  const closeButton = findReactButton(tree, '仅关闭');
  assert.ok(closeButton, '面板应有仅关闭按钮元素');

  fetchCalls.length = 0;
  await closeButton.props.onClick();
  await flush();
  assert.equal(modalRoots().length, 1, '仅关闭必须先弹确认框（确认明确）');
  assert.ok(!fetchCalls.some((c) => String(c.url).endsWith('/close')), '确认前不得发出请求');

  const modalText = domText(modalRoots()[0]).join(' ');
  assert.ok(modalText.includes('不会自动重启'), `确认文案必须明确不会自动重启：${modalText.slice(0, 220)}`);
  assert.ok(modalText.includes('手动重新打开'), '确认文案须说明需要手动重开');
  assert.ok(!modalText.includes('自动回来'), '关闭确认不得复用重启的「窗口自动回来」话术');

  const okButton = findDomButton(modalRoots()[0], 'dsrn-confirm-action');
  assert.ok(okButton, '确认框应有确认按钮');
  okButton.__dispatch('click');
  await flush();
  const closePost = fetchCalls.find((c) => String(c.url) === '/plugins/dsh-restart-now/close'
    && c.init && c.init.method === 'POST');
  assert.ok(closePost, '确认后应 POST /close');
  assert.equal(closePost.url, '/plugins/dsh-restart-now/close',
    '不带 query —— close 不复用 ?wait=1（等待终局是重启）');
});

test('仅关闭始终要求确认，即使重启确认被关闭', async () => {
  const probeBody = { ...CLOSE_PROBE, config: { ...CLOSE_PROBE.config, confirm: false } };
  const { captured, injected, ctx, fetchCalls, modalRoots } = load({ probeBody });
  captured.exports.apply(ctx, {});
  await flush();
  const tree = renderDeep(injected.find((i) => i.slotName === 'main').factory().render({}));
  findReactButton(tree, '仅关闭').props.onClick();
  assert.equal(modalRoots().length, 1);
  assert.ok(domText(modalRoots()[0]).join(' ').includes('不会自动重启'));
  assert.ok(!fetchCalls.some((c) => String(c.url).includes('/close')));
});

test('U21w 探测口 closeSupported 缺失/false → 不渲染任何仅关闭入口（旧宿主/未实现助手零风险）', async () => {
  const { captured, injected, ctx, resetHooks, takeEffects } = load({ probeBody: DESKTOP_PROBE, lang: 'zh-CN' });
  captured.exports.apply(ctx, {});
  await flush();

  const panelText = textOf(renderDeep(injected.find((i) => i.slotName === 'main').factory().render({}))).join(' ');
  assert.ok(!panelText.includes('仅关闭'), '主面板不应出现仅关闭按钮');
  assert.ok(panelText.includes('立即重启'), '重启主按钮不受影响');

  const section = injected.find((i) => i.slotName === 'settings.section');
  assert.ok(section, '设置页槽位未注册');
  resetHooks();
  renderDeep(section.factory().render({}));
  for (const fn of takeEffects()) fn();
  await flush();
  await flush();
  resetHooks();
  const sectionText = textOf(renderDeep(section.factory().render({}))).join(' ');
  assert.ok(!sectionText.includes('仅关闭'), '设置页不应出现仅关闭按钮');
});

test('U21x 设置页「仅关闭」→ 确认 → 409 busy 弹「仍然关闭」二选一（无等待选项）→ 强制带 ?force=1', async () => {
  const { captured, injected, ctx, fetchCalls, modalRoots, resetHooks, takeEffects } = load({
    probeBody: CLOSE_PROBE,
    lang: 'zh-CN',
    closeResponder: () => ({ status: 409, body: { ok: false, reason: 'busy', tasks: 2, jobs: 1, forceable: true } }),
  });
  captured.exports.apply(ctx, {});
  await flush();

  const section = injected.find((i) => i.slotName === 'settings.section');
  assert.ok(section, '设置页槽位未注册');
  resetHooks();
  renderDeep(section.factory().render({}));
  for (const fn of takeEffects()) fn();
  await flush();
  await flush();
  resetHooks();
  const tree = renderDeep(section.factory().render({}));
  assert.ok(textOf(tree).join(' ').includes('仅关闭'), 'closeSupported:true 时设置页应有仅关闭按钮');

  const closeButton = findReactButton(tree, '仅关闭');
  assert.ok(closeButton, '设置页应有仅关闭按钮元素');

  fetchCalls.length = 0;
  await closeButton.props.onClick();
  await flush();
  assert.equal(modalRoots().length, 1, '先弹确认框');

  const okButton = findDomButton(modalRoots()[0], 'dsrn-confirm-action');
  assert.ok(okButton, '确认框应有确认按钮');
  okButton.__dispatch('click');
  await flush();
  assert.ok(fetchCalls.some((c) => String(c.url) === '/plugins/dsh-restart-now/close' && c.init.method === 'POST'),
    '确认后应 POST /close');
  assert.equal(modalRoots().length, 1, 'busy 弹窗出现');

  const busyText = domText(modalRoots()[0]).join(' ');
  assert.ok(busyText.includes('仍然关闭'), `busy 弹窗应有「仍然关闭」：${busyText.slice(0, 200)}`);
  assert.ok(!busyText.includes('等空闲后重启'), '关闭忙碌框不得出现「等空闲后重启」（等待终局是重启）');
  assert.ok(!busyText.includes('仍然重启'), '关闭忙碌框不得复用重启的「仍然重启」按钮');

  const forceButton = findDomButton(modalRoots()[0], 'dsrn-confirm-action');
  assert.ok(forceButton, 'busy 弹窗应有强制按钮');
  fetchCalls.length = 0;
  forceButton.__dispatch('click');
  await flush();
  assert.ok(fetchCalls.some((c) => String(c.url) === '/plugins/dsh-restart-now/close?force=1'),
    '仍然关闭必须带 ?force=1 POST /close');
});

test('U21y 仅关闭契约（源码级）：端点/能力位/确认文案/忙碌二选一/501 兜底', () => {
  assert.ok(source.includes("var CLOSE = '/plugins/dsh-restart-now/close'"), '须定义 close 端点常量');
  assert.ok(source.includes('closeSupported'), '须消费探测口 closeSupported 能力位');
  assert.ok(source.includes('不会自动重启'), '中文确认文案须明确不会自动重启');
  assert.ok(source.includes('does not relaunch'), '英文确认文案须明确不会重启');
  assert.ok(source.includes("fetch(CLOSE + (query || '')"), '关闭请求必须发往 CLOSE 端点');
  assert.ok(source.includes("postClose('?force=1')"), 'busy 强制路必须带 ?force=1');
  assert.ok(source.includes('close-helper-missing'), '须识别宿主 501（助手未实现 close 的兜底话术）');
  assert.ok(source.includes('function askCloseBusy'), 'close 须有专属忙碌框');
  assert.ok(!/askCloseBusy[\s\S]{0,600}?waitStart/.test(source), 'close 忙碌框不得复用「等空闲后重启」');
  assert.ok(source.includes("window.__dsh_restart_now__ = 'closing'"), '关闭后应打 closing 标记');
});

// —— v1.3.1 停机后有界轮询（watchRestartOutcome）——
// 正常路径进程 <1s 就死、窗口关闭、新实例拉起（页面死掉 = fetch 抛错 = 静默，绝不弹窗）；
// 失败路径（助手身份核验拒绝等）进程活着、页面还在——202 后只打标记毫无反馈是本轮要修的缺陷。
// 判定线：页面活过 20s 才下结论；90s 总预算到点放弃。busy.v 在失败可见时复位（按钮恢复可用）。

/** 202 派发成功 + 走确认框路径点完「重启」，返回轮询测试所需的沙箱件。
 *  探测口响应在**挂载之后**才可编程（env.__envBody）：挂载必须吃真实形态的探测响应，
 *  轮询想模拟什么形态（failed/unconfirmed/缺字段/服务没了）由各用例随后改写。 */
async function dispatchRestart202(opts = {}) {
  const env = load({
    ...opts,
    restartResponder: opts.restartResponder || (() => ({ status: 202, body: { ok: true, mode: 'now' } })),
  });
  env.captured.exports.apply(env.ctx, {});
  await flush();
  const row = env.injected.find((i) => i.slotName === 'settings.general.item');
  const button = firstButton(renderDeep(row.factory().render({})));
  // confirm:true → 弹确认框，点确认按钮才真正 POST
  await button.props.onClick();
  await flush();
  const okButton = findDomButton(env.modalRoots()[0], 'dsrn-confirm-action');
  okButton.__dispatch('click');
  await flush();
  return env;
}

test('U21z 202 重启派发后启动有界轮询：20s 内成功响应不下结论（还在停机早期）', async () => {
  const env = await dispatchRestart202({ probeBody: DESKTOP_PROBE });
  const { fetchCalls, intervals, modalRoots, clock, tickIntervals } = env;
  assert.ok(fetchCalls.some((c) => String(c.url) === '/plugins/dsh-restart-now/restart' && c.init.method === 'POST'),
    '前置：确认后应 POST /restart');
  assert.equal(intervals.length, 1, '202 且非 waiting 模式后应启动一个轮询 interval');
  fetchCalls.length = 0;
  modalRoots().forEach((m) => m.parentNode.removeChild(m));

  // 第 1 tick（2s）：服务还在（200/ok），但页面没活过 20s → 不下结论，弹窗不该出现
  env.envState.body = { ok: true, lastRestart: { status: 'unconfirmed' } };
  clock.advance(2000);
  tickIntervals();
  await flush();
  assert.equal(modalRoots().length, 0, '20s 内不该对成功响应下失败结论');
  assert.equal(intervals.length, 1, '20s 内轮询应继续跑');
  assert.equal(intervals[0].ms, 2000, '轮询间隔须为 2000ms');
  assert.equal(fetchCalls.length, 1, '一个 tick 恰好拉一次探测口');
  assert.ok(String(fetchCalls[0].url).indexOf('/plugins/dsh-restart-now/environment') !== -1,
    '轮询拉的是 GET /environment');
  assert.equal(fetchCalls[0].init && fetchCalls[0].init.credentials, 'same-origin', '轮询须带同源凭据');
});

test('U21z2 轮询拿到 failed 回执 → 弹「重启已中止：原因」+ busy 复位 + 轮询停止', async () => {
  const env = await dispatchRestart202({ probeBody: DESKTOP_PROBE });
  const { intervals, modalRoots, clock, tickIntervals } = env;
  modalRoots().forEach((m) => m.parentNode.removeChild(m));
  env.envState.body = { ok: true, lastRestart: { status: 'failed', reason: 'identity-verification-failed' } };
  clock.advance(21000); // 从 202 起页面活过 20s（判定线是 >20000，恰好 20000 仍在观望窗内）
  tickIntervals();
  await flush();
  await flush();
  assert.equal(intervals.length, 0, '发现失败后轮询必须停止');
  assert.equal(modalRoots().length, 1, '失败必须弹窗可见');
  const text = domText(modalRoots()[0]).join(' ');
  assert.ok(text.includes('重启已中止'), `中文文案应为「重启已中止：原因」，实际：${text.slice(0, 200)}`);
  assert.ok(text.includes('identity-verification-failed'), `弹窗须带助手失败原因，实际：${text.slice(0, 200)}`);
  assert.ok(text.includes('设置→重启应用'), '话术须指路设置页（详情入口）');
  // busy 复位的界面证据：busy.v=false 后再次点击能立刻走到 POST（不再被 busy 吞掉）
  env.fetchCalls.length = 0;
  const row = env.injected.find((i) => i.slotName === 'settings.general.item');
  await firstButton(renderDeep(row.factory().render({}))).props.onClick();
  await flush();
  let ok2 = null;
  for (const root of env.modalRoots()) ok2 = findDomButton(root, 'dsrn-confirm-action') || ok2;
  ok2.__dispatch('click');
  await flush();
  assert.ok(env.fetchCalls.some((c) => String(c.url) === '/plugins/dsh-restart-now/restart' && c.init.method === 'POST'),
    'busy.v 必须已复位：失败可见后按钮立即可再次发起');
});

test('U21z3 回执一直无 failed（unconfirmed）→「重启似乎没有生效」+ busy 复位 + 停轮询', async () => {
  const env = await dispatchRestart202({ probeBody: DESKTOP_PROBE });
  const { intervals, modalRoots, clock, tickIntervals } = env;
  modalRoots().forEach((m) => m.parentNode.removeChild(m));
  env.envState.body = { ok: true, lastRestart: { status: 'unconfirmed' } };
  clock.advance(22000); // 从 202 起页面已活过 20s
  tickIntervals();
  await flush();
  await flush();
  assert.equal(intervals.length, 0, 'unconfirmed 结话后轮询必须停止');
  assert.equal(modalRoots().length, 1, '重启没生效必须弹窗可见');
  const text = domText(modalRoots()[0]).join(' ');
  assert.ok(text.includes('重启似乎没有生效'), `应弹「重启似乎没有生效：应用仍在运行」，实际：${text.slice(0, 200)}`);
});

test('U21z4 fetch 抛错（服务没了 = 正常停机进行中）→ 静默停止轮询，绝不弹窗', async () => {
  const env = await dispatchRestart202({ probeBody: DESKTOP_PROBE });
  const { intervals, modalRoots, clock, tickIntervals } = env;
  modalRoots().forEach((m) => m.parentNode.removeChild(m));
  env.envState.fail = true;
  clock.advance(2000);
  tickIntervals();
  await flush();
  await flush();
  assert.equal(intervals.length, 0, '服务没了（正常停机）轮询应停止');
  assert.equal(modalRoots().length, 0, '正常停机路径必须静默（窗口马上要关）');
});

test('U21z5 90s 总预算到点放弃：轮询停止、不弹窗、busy 复位', async () => {
  // lastRestart.status:'pending' 不满足任何结论分支（failed/ok/closed/unconfirmed 都不是）
  // → 只有预算判据能结束轮询，正好单独验证 90s 总预算分支
  const env = await dispatchRestart202({ probeBody: DESKTOP_PROBE });
  const { intervals, modalRoots, clock, tickIntervals } = env;
  modalRoots().forEach((m) => m.parentNode.removeChild(m));
  env.envState.body = { ok: true, lastRestart: { status: 'pending' } };
  clock.advance(92000);
  tickIntervals();
  await flush();
  await flush();
  assert.equal(intervals.length, 0, '90s 预算到点必须放弃并停止轮询');
  assert.equal(modalRoots().length, 0, '预算放弃路径不弹窗（能确定失败的分支 20s 时已说完）');
  // busy 复位（与失败分支同款：放弃后按钮仍可再次发起）
  env.fetchCalls.length = 0;
  const row = env.injected.find((i) => i.slotName === 'settings.general.item');
  await firstButton(renderDeep(row.factory().render({}))).props.onClick();
  await flush();
  let ok2 = null;
  for (const root of env.modalRoots()) ok2 = findDomButton(root, 'dsrn-confirm-action') || ok2;
  ok2.__dispatch('click');
  await flush();
  assert.ok(env.fetchCalls.some((c) => String(c.url) === '/plugins/dsh-restart-now/restart' && c.init.method === 'POST'),
    '预算放弃须复位 busy.v：用户还能再次发起');
});

test('U21z6 close 同款：202 仅关闭后轮询，失败回执弹「关闭已中止：原因」', async () => {
  const env = load({
    probeBody: CLOSE_PROBE,
    closeResponder: () => ({ status: 202, body: { ok: true, mode: 'close' } }),
  });
  env.captured.exports.apply(env.ctx, {});
  await flush();
  const main = env.injected.find((i) => i.slotName === 'main');
  const tree = renderDeep(main.factory().render({}));
  const closeButton = findReactButton(tree, '仅关闭');
  await closeButton.props.onClick();
  await flush();
  const okButton = findDomButton(env.modalRoots()[0], 'dsrn-confirm-action');
  okButton.__dispatch('click');
  await flush();
  assert.ok(env.fetchCalls.some((c) => String(c.url) === '/plugins/dsh-restart-now/close' && c.init.method === 'POST'),
    '前置：确认后应 POST /close');
  assert.equal(env.intervals.length, 1, 'close 202 后同样应启动轮询');
  env.modalRoots().forEach((m) => m.parentNode.removeChild(m));
  env.envState.body = { ok: true, lastRestart: { status: 'failed', reason: 'main-not-stopped' } };
  env.clock.advance(21000);
  env.tickIntervals();
  await flush();
  await flush();
  assert.equal(env.intervals.length, 0, '发现失败后轮询必须停止');
  assert.equal(env.modalRoots().length, 1, 'close 失败必须弹窗可见');
  const text = domText(env.modalRoots()[0]).join(' ');
  assert.ok(text.includes('关闭已中止'), `close 失败话术应为「关闭已中止：原因」，实际：${text.slice(0, 200)}`);
  assert.ok(text.includes('main-not-stopped'), `弹窗须带失败原因，实际：${text.slice(0, 200)}`);
});

test('U21z7 等待模式（waiting）不启动停机轮询；非 202 的拒绝路径也不启动', async () => {
  // waiting 模式有自己的 /status 轮询（waitPoll），终局是一次重启——两种轮询职责不同
  const waiting = load({
    probeBody: DESKTOP_PROBE,
    restartResponder: () => ({ status: 202, body: { ok: true, mode: 'waiting', since: 1, remainingMs: 60000, tasks: 0, jobs: 0 } }),
  });
  waiting.captured.exports.apply(waiting.ctx, {});
  await flush();
  const row = waiting.injected.find((i) => i.slotName === 'settings.general.item');
  await firstButton(renderDeep(row.factory().render({}))).props.onClick();
  await flush();
  // confirm:true 默认开 → 确认框里点「重启」才真正 POST
  findDomButton(waiting.modalRoots()[0], 'dsrn-confirm-action').__dispatch('click');
  await flush();
  // intervals[0] 就是 waitPoll：等待模式的唯一 interval，拉的是 /status
  assert.equal(waiting.intervals.length, 1, '等待模式应只有 waitPoll（/status）一个 interval');
  // 推进一轮：waitPoll 继续拉 /status，绝不出现第二次 GET /environment（停机轮询没被启动）
  waiting.fetchCalls.length = 0;
  waiting.clock.advance(2000);
  waiting.tickIntervals();
  await flush();
  assert.equal(waiting.fetchCalls.length, 1, '一个 tick 恰好是 waitPoll 的一次 /status');
  assert.ok(String(waiting.fetchCalls[0].url).indexOf('/status') !== -1, 'tick 拉的是 /status');
  assert.ok(String(waiting.fetchCalls[0].url).indexOf('/environment') === -1,
    '等待模式绝不能启动停机轮询（/environment 只在启动探测时拉一次）');

  // 非 waiting 的 202 才启动轮询；409 拒绝路径绝不能启动
  const rejected = load({
    probeBody: DESKTOP_PROBE,
    restartResponder: () => ({ status: 409, body: { ok: false, reason: 'installing' } }),
  });
  rejected.captured.exports.apply(rejected.ctx, {});
  await flush();
  const row2 = rejected.injected.find((i) => i.slotName === 'settings.general.item');
  await firstButton(renderDeep(row2.factory().render({}))).props.onClick();
  await flush();
  assert.equal(rejected.intervals.length, 0, '拒绝路径（409）不该有任何轮询');
});

// —— v1.3.1 标题栏菜单「重启」项（shadow DOM 注入，形态=issue #5 用户指定：「应用 编辑 重启」）——
// 非槽位体系：append 进 preload 的 [data-windows-menu] 开放 shadow root 的 menubar，
// 样式靠 preload 的 button{} 规则自动继承（无需任何 CSS）。确认交互=两击式（菜单场景弹不了 Modal）。

test('U21aa 标题栏注入：append 进 menubar 尾部、role=menuitem、文字「重启」、样式零声明', async () => {
  const env = load({ probeBody: DESKTOP_PROBE, windowsMenu: ['应用', '编辑'] });
  env.captured.exports.apply(env.ctx, {});
  await flush();

  const menubar = env.menuHost.__menubar;
  assert.equal(menubar.children.length, 3, '应用/编辑之后必须追加恰好一个菜单项');
  const btn = menubar.children[2];
  assert.ok(btn.hasAttribute('data-dsrn-titlebar-restart'), '须带自有标记（重复挂载查重用）');
  assert.equal(btn.getAttribute('role'), 'menuitem', '语义与同栏菜单项一致');
  assert.equal(btn.textContent, '重启', 'issue #5 指定形态：文字菜单项「重启」，不是图标');
  assert.ok(btn.handlers.click && btn.handlers.click.length > 0, '点击须有处理器');
  assert.ok(btn.handlers.pointerdown && btn.handlers.mousedown, 'pointerdown/mousedown preventDefault（不抢编辑器焦点，竞品同款）');
  // 样式自动继承 preload 的 button{} 规则——本插件不得为它写任何专属 CSS（写了反而是视觉分叉源）
  assert.ok(!source.includes('.dsrn-titlebar'), '不得再为标题栏项注入专属 CSS（overlay 方案已退役）');
  assert.ok(!source.includes('shell.overlay'), 'overlay 挤位方案须完全移除');
});

test('U21aa2 宿主菜单条不存在（mac/web/上游改版）→ 零注入零副作用；晚出现可经 MutationObserver 补挂', async () => {
  // ① 无宿主启动：不注入，但 titlebar 观察者要在（菜单条可能晚于插件出现）
  //    （沙箱里 navEnhance 与 lang 兜底也各有一个观察者，标题栏观察者是最后一个）
  const noMenu = load({ probeBody: DESKTOP_PROBE, windowsMenu: null });
  noMenu.captured.exports.apply(noMenu.ctx, {});
  await flush();
  assert.ok(noMenu.titlebarObservers.length >= 1, '无宿主时仍要盯 DOM（菜单条可能晚于插件出现）');

  // ② 宿主晚出现：触发 observer 回调 → 补挂成功
  const late = load({ probeBody: DESKTOP_PROBE, windowsMenu: ['应用', '编辑'] });
  // 先让入口以无宿主形态启动：把 document.querySelector 指回 null 再 apply
  const savedHost = late.menuHost;
  const lateDoc = late.document;
  lateDoc.querySelector = () => null;
  late.captured.exports.apply(late.ctx, {});
  await flush();
  assert.equal(savedHost.__menubar.children.length, 2, '宿主缺席时不注入');
  lateDoc.querySelector = (sel) => (sel === '[data-windows-menu]' ? savedHost : null);
  for (const obs of [...late.titlebarObservers]) obs.fn();
  assert.equal(savedHost.__menubar.children.length, 3, '宿主出现后 observer 回调补挂「重启」项');
});

test('U21ab 两击式确认：第一次点变「确认重启」（4s 超时回弹），第二次才 POST /restart', async () => {
  const env = load({
    probeBody: { ...DESKTOP_PROBE, config: { ...DESKTOP_PROBE.config, confirm: false } },
    windowsMenu: ['应用', '编辑'],
  });
  env.captured.exports.apply(env.ctx, {});
  await flush();
  const btn = env.menuHost.__menubar.children[2];
  env.fetchCalls.length = 0;

  // 第一次点击：进入确认态，不发请求（即使 confirm:false 也强制确认——标题栏误触代价高）
  btn.__dispatch('click');
  assert.equal(btn.textContent, '确认重启', '第一次点击必须变成确认文案');
  assert.ok(!env.fetchCalls.some((c) => c.init && c.init.method === 'POST'), '确认前绝不能 POST');

  // 第二次点击：执行
  btn.__dispatch('click');
  assert.equal(btn.textContent, '正在重启…', '第二次点击进入忙碌态');
  assert.ok(env.fetchCalls.some((c) => String(c.url).endsWith('/restart') && c.init.method === 'POST'),
    '确认后的第二次点击才触发受守卫 POST /restart');
  assert.equal(btn.disabled, true, 'busy 态按钮禁用');

  // 拒绝路径：非 202 → 「重启失败」短文案后回弹（利用 fetch 桩默认回 200 非 202 的行为）
  await flush();
});

test('U21ab2 确认超时回弹：4 秒内未点第二次 → 回到「重启」可重试', async () => {
  const env = load({ probeBody: DESKTOP_PROBE, windowsMenu: ['应用', '编辑'] });
  env.captured.exports.apply(env.ctx, {});
  await flush();
  const btn = env.menuHost.__menubar.children[2];
  btn.__dispatch('click');
  assert.equal(btn.textContent, '确认重启');
  // 沙箱 setTimeout 是空桩——直接调用挂载时登记的回弹定时器不可行，改验证状态机语义：
  // 再次点击（此时仍是 confirm 态）会执行；回弹由 titlebarReset 的 setTimeout(4000) 保证
  assert.equal(btn.textContent, '确认重启', '未超时前保持确认态');
});

test('U21ac entryTitlebar 开关：false 时不注入，拨开关即时摘除/补挂并写回配置层', async () => {
  // ① 配置层 entryTitlebar:false → 挂载即不注入
  const off = load({
    probeBody: { ...DESKTOP_PROBE, config: { ...DESKTOP_PROBE.config, entryTitlebar: false } },
    windowsMenu: ['应用', '编辑'],
  });
  off.captured.exports.apply(off.ctx, {});
  await flush();
  assert.equal(off.menuHost.__menubar.children.length, 2, 'entryTitlebar:false 时不得注入菜单项');

  // ② 设置页拨开关 → 立即摘除 + 全量写回 /config（漏键会抹掉用户偏好，落盘是整文件替换）
  const on = load({ probeBody: DESKTOP_PROBE, windowsMenu: ['应用', '编辑'] });
  on.captured.exports.apply(on.ctx, {});
  await flush();
  const section = on.injected.find((i) => i.slotName === 'settings.section');
  on.resetHooks();
  renderDeep(section.factory().render({}));
  for (const fn of on.takeEffects()) fn();
  await flush(); await flush();
  on.resetHooks();
  const tree = renderDeep(section.factory().render({}));
  // 精确匹配「标题栏按钮（编辑旁）」——「会话标题栏按钮」（entryHeader）也含「标题栏按钮」子串
  const row = findSwitchRow(tree, '标题栏按钮（编辑旁）');
  assert.ok(row, '设置页须出现「标题栏按钮（编辑旁）」开关行');
  const sw = firstRoleSwitch(row);
  assert.equal(sw.props['aria-checked'], true, '默认全开');
  sw.props.onClick();
  await flush();
  const post = on.configPosts.at(-1);
  assert.ok(post, '拨动开关须写回配置层');
  assert.equal(post.body.entryTitlebar, false, 'entryTitlebar 值须落盘');
  for (const key of ['entryPanel', 'entryFooter', 'entryHeader', 'entrySettingsRow', 'allowRestart', 'confirm', 'exePath', 'platformAuth']) {
    assert.ok(key in post.body, `写回漏了 ${key}（整文件替换语义，漏键抹偏好）`);
  }
  assert.equal(on.menuHost.__menubar.children.length, 2, '拨关后菜单项须即时摘除');
  // ③ 再拨回来 → 重新注入（动态恢复）
  on.resetHooks();
  const tree2 = renderDeep(section.factory().render({}));
  const row2 = findSwitchRow(tree2, '标题栏按钮（编辑旁）');
  const sw2 = firstRoleSwitch(row2);
  assert.equal(sw2.props['aria-checked'], false, '状态须反映上次拨动');
  sw2.props.onClick();
  await flush();
  assert.equal(on.menuHost.__menubar.children.length, 3, '重新打开后菜单项须恢复注入');
});

