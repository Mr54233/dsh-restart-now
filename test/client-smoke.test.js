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
function load({ probeBody, lang = 'zh-CN' }) {
  const captured = { id: null, exports: null };
  const injected = [];
  const appendedStyles = [];
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
    get: (name) => (name === 'slots' ? {
      inject: (slotName, factory) => { injected.push({ slotName, factory }); },
      register: (descriptor, render) => ({ ...descriptor, render }),
    } : undefined),
  };
  return { captured, injected, appendedStyles, fetchCalls, ctx, createElement };
}

const DESKTOP_PROBE = {
  ok: true,
  environment: 'desktop',
  platform: 'win32',
  config: { allowRestart: true, confirm: true, exePath: '', hideSidebarButton: false },
  derivedExe: 'D:\\dsh\\DeepSeek Harness.exe',
  version: '0.2.1-rc.2',
  supportedRange: '>=0.2.0',
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

test('U21c desktop 环境 → 挂载 sidebar.footer.action 与 settings.section 两个槽位', async () => {
  const { captured, injected, ctx, createElement } = load({
    probeBody: {
      ok: true,
      environment: 'desktop',
      platform: 'win32',
      config: { allowRestart: true, confirm: true, exePath: '', hideSidebarButton: false },
      derivedExe: 'D:\\dsh\\DeepSeek Harness.exe',
      version: '0.2.1-rc.2',
      supportedRange: '>=0.2.0',
      supported: true,
      lastRestart: { status: 'none' },
      wait: { state: 'idle' },
    },
  });
  captured.exports.apply(ctx, {});
  await flush();

  assert.deepEqual(injected.map((i) => i.slotName).sort(), ['settings.section', 'sidebar.footer.action']);

  // 槽位注册描述符必须带 name/id/label（label 缺失 → 设置导航空名字，v0.6 踩过）
  const descriptors = injected.map((i) => i.factory());
  for (const descriptor of descriptors) {
    assert.ok(descriptor, '注册回调须返回描述符');
    assert.ok(descriptor.name);
    assert.ok(descriptor.id);
    assert.ok(descriptor.label, 'label 不可缺失');
  }
  assert.ok(descriptors.every((d) => d !== undefined));
  // 渲染函数返回 React 元素（不抛异常、有 type）
  assert.equal(typeof createElement, 'function');
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
