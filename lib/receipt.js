// dsh-restart-now —— 重启回执（上一次重启的结果，供下次挂载时展示）
//
// 为什么需要：重启会把界面连同会话一起打断，用户回来后无法判断「刚才是重启成功了，
// 还是我自己误触/崩溃了」。官方结构里重启由主进程完成、宿主无法留话，因此落一个文件：
//   <profile>/restart-now.last.json
//   { at, atMs, hostPid, mainPid, helperPid, stamp, respawnedAt?, newPid?, downtimeMs?, failed? }
// 宿主在派发前写「开始」段，助手在拉起成功后补「完成」段（或写 failed 段）。
// 新宿主挂载时读到 hostPid !== 当前 pid → 说明这是重启后的新实例，展示耗时/失败提示。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RECEIPT_FILE = 'restart-now.last.json';

/** 回执文件路径。 */
export function receiptPath(profileDir) {
  return profileDir ? join(profileDir, RECEIPT_FILE) : '';
}

/** 读回执；文件缺失或损坏一律返回 null（损坏不阻塞任何流程）。 */
export function readReceipt(profileDir, deps = {}) {
  const readFile = deps.readFile || ((path) => readFileSync(path, 'utf8'));
  const file = receiptPath(profileDir);
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFile(file));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

/** 写回执（合并写入）；失败静默——回执只是体验增强，绝不影响重启本身。 */
export function writeReceipt(profileDir, data, deps = {}) {
  const writeFile = deps.writeFile || ((path, text) => writeFileSync(path, text));
  const file = receiptPath(profileDir);
  if (!file) return false;
  try {
    writeFile(file, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    return false;
  }
}

/** 派发前写「开始」段（覆盖上一次结果）。 */
export function beginReceipt(profileDir, info, deps = {}) {
  const now = Number(info && info.now) || Date.now();
  const at = new Date(now).toISOString();
  const data = {
    at,
    atMs: now,
    stamp: info && info.stamp ? info.stamp : '',
    hostPid: info && Number(info.hostPid) ? Number(info.hostPid) : 0,
    mainPid: info && Number(info.mainPid) ? Number(info.mainPid) : 0,
    helperPid: info && Number(info.helperPid) ? Number(info.helperPid) : 0,
  };
  writeReceipt(profileDir, data, deps);
  return data;
}

/** 助手拉起失败时补失败段（宿主已死，只能由派发前写好的文件承接）。 */
export function failReceipt(profileDir, failed, deps = {}) {
  const current = readReceipt(profileDir, deps) || {};
  const data = Object.assign({}, current, { failed });
  writeReceipt(profileDir, data, deps);
  return data;
}

/**
 * 归一化回执给前端：区分 成功 / 失败 / 未确认 / 无记录。
 * @param receipt 回执对象或 null
 * @param now 当前时间戳（便于测试）
 */
export function summarizeReceipt(receipt, now = Date.now()) {
  if (!receipt || typeof receipt !== 'object') return { status: 'none' };
  const atMs = Number(receipt.atMs) || (receipt.at ? Date.parse(receipt.at) : 0) || 0;
  const base = {
    at: receipt.at || '',
    ageMs: atMs ? Math.max(0, now - atMs) : null,
    hostPid: Number(receipt.hostPid) || 0,
  };
  const failed = receipt.failed && typeof receipt.failed === 'object' ? receipt.failed : null;

  if (receipt.respawnedAt) {
    return Object.assign(base, {
      status: 'ok',
      downtimeMs: Number.isFinite(Number(receipt.downtimeMs)) ? Math.max(0, Number(receipt.downtimeMs)) : null,
      newPid: Number(receipt.newPid) || 0,
    });
  }
  if (failed) {
    return Object.assign(base, {
      status: 'failed',
      reason: typeof failed.reason === 'string' ? failed.reason : '',
      detail: typeof failed.detail === 'string' ? failed.detail : '',
      failedAt: typeof failed.at === 'string' ? failed.at : '',
    });
  }
  return Object.assign(base, { status: 'unconfirmed' });
}
