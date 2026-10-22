// dsh-restart-now —— 重启冷却（v1.2.1 第 22 项）
//
// 为什么需要（来自 dsh-hot-restart 的实践）：连点两次会在「主进程还活着的那一两秒」里
// 派发**两个助手**——两个都杀主进程、两个都去拉起，最后可能留下两个实例，或者
// 一个助手把另一个刚拉起的实例当成旧进程再杀一遍。窗口在那段时间里通常还没消失，
// 用户完全可能再点一下（以为没反应）。
//
// 判据用两处时间戳，取较晚的那个：
//   ① 内存 lastAt —— 本宿主进程刚派发过（同一次运行里连点）；
//   ② 回执 atMs   —— 落盘的「上次重启开始时间」（重启后新宿主也能看见，跨实例有效）。
// 时钟回拨（now < lastAt）一律不拦：宁可放过一次，也不要把功能锁死。
//
// 冷却被拒不等于故障：客户端按 reason='cooldown' 走轻提示，不弹失败框。

/** 冷却窗口：够挡住连点，又不至于让人等。 */
export const COOLDOWN_MS = 5000;

/**
 * 还能再等多少毫秒才允许下一次重启。
 * @param {number} lastAt 上次派发/开始重启的时间戳（毫秒）。
 * @param {number} now 当前时间戳（毫秒）。
 * @param {number} [window] 冷却窗口毫秒，默认 {@link COOLDOWN_MS}。
 * @returns {number} 剩余毫秒；0 表示可以立刻重启。
 */
export function cooldownRemaining(lastAt, now, window = COOLDOWN_MS) {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return 0;
  if (!Number.isFinite(now) || !Number.isFinite(window) || window <= 0) return 0;
  const elapsed = now - lastAt;
  if (elapsed < 0) return 0; // 时钟回拨：不拦
  return elapsed >= window ? 0 : window - elapsed;
}

/**
 * 从回执里取「上次重启开始时间」。
 * @param {object|null} receipt 回执对象（可能为 null）。
 * @returns {number} 毫秒时间戳；取不到返回 0。
 */
export function receiptStartAt(receipt) {
  const at = receipt && typeof receipt === 'object' ? Number(receipt.atMs) : 0;
  return Number.isFinite(at) && at > 0 ? at : 0;
}
