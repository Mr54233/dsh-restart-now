// dsh-restart-now —— DSH 运行时版本探测与兼容判定
//
// 为什么需要它：DSH 升级后用户不知道自己是否还在支持范围内（用户原话：
// 「我更新了一下都不知道要支持什么版本了」）。因此：
//   1) package.json 用官方认的 engines.dsh 声明支持范围（安装期硬闸，官方管理器据此报
//      incompatible-version；竞品2 自创的 compatibility.dshReleases 在 asar 里 0 命中，DSH 不读）；
//   2) 运行时再探一次真实版本，在设置页显示「当前 X / 支持 Y」，超出范围时给出明确提示。
// DSH 不通过环境变量暴露版本，桌面端的权威来源是 app.asar 内的 package.json
// （{name:"@deepseek-ai/dsh-desktop", version:"0.2.1-rc.2"}）；Electron 的 fs 对 asar 透明。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 支持范围（必须与 package.json 的 engines.dsh 一致，单测强制校验）。 */
export const SUPPORTED_RANGE = '>=0.2.0';

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 解析版本号，非法返回 null。 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const matched = VERSION_RE.exec(input.trim());
  if (!matched) return null;
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    pre: matched[4] ? matched[4].split('.') : [],
  };
}

function comparePre(a, b) {
  // 无 prerelease 的一方更大（1.0.0 > 1.0.0-rc.1）
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** -1 / 0 / 1 比较两个已解析版本。 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

function bump(version, index) {
  const next = { major: version.major, minor: version.minor, patch: version.patch, pre: [] };
  if (index === 0) {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (index === 1) {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.patch += 1;
  }
  return next;
}

function testComparator(version, comparator) {
  if (comparator === '*' || comparator === '') return true;
  const matched = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(comparator);
  if (!matched) return false;
  const operator = matched[1] || '=';
  const target = parseVersion(matched[2]);
  if (!target) return false;
  const diff = compareVersions(version, target);
  if (operator === '=') return diff === 0;
  if (operator === '>') return diff > 0;
  if (operator === '>=') return diff >= 0;
  if (operator === '<') return diff < 0;
  if (operator === '<=') return diff <= 0;
  if (operator === '^') {
    if (diff < 0) return false;
    const ceiling = target.major > 0 ? bump(target, 0) : target.minor > 0 ? bump(target, 1) : bump(target, 2);
    return compareVersions(version, ceiling) < 0;
  }
  if (operator === '~') {
    if (diff < 0) return false;
    return compareVersions(version, bump(target, 1)) < 0;
  }
  return false;
}

/**
 * 判断版本是否落在声明范围内。
 * 只实现 engines 里实际会用到的子集（比较符 + ^ + ~ + 空格 AND + `||` OR），
 * 与 semver.satisfies(range, {includePrerelease:true}) 在常见写法上等价。
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const text = typeof range === 'string' ? range.trim() : '';
  if (text === '' || text === '*') return true;
  return text.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return true;
    return comparators.every((comparator) => testComparator(parsed, comparator));
  });
}

/** 探测 DSH 运行时版本（桌面端读 app.asar/package.json；失败返回 null，前端不显示版本行）。 */
export function detectDshVersion(deps = {}) {
  const resourcesPath = deps.resourcesPath !== undefined ? deps.resourcesPath : process.resourcesPath;
  const readFile = deps.readFile || ((path) => readFileSync(path, 'utf8'));
  const candidates =
    deps.candidates ||
    (resourcesPath
      ? [join(resourcesPath, 'app.asar', 'package.json'), join(resourcesPath, 'app', 'package.json')]
      : []);
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(readFile(file));
      if (pkg && typeof pkg.version === 'string' && parseVersion(pkg.version)) {
        return { version: pkg.version, source: file, name: typeof pkg.name === 'string' ? pkg.name : '' };
      }
    } catch (error) {
      /* 试下一个候选 */
    }
  }
  return { version: null, source: null, name: '' };
}

/** 组合：探测 + 判定（供探测口一次性回传）。 */
export function inspectVersion(deps = {}) {
  const detected = detectDshVersion(deps);
  const supported = detected.version ? satisfiesRange(detected.version, SUPPORTED_RANGE) : null;
  return { version: detected.version, supportedRange: SUPPORTED_RANGE, supported };
}
