// lib/platform-auth.js —— 平台会话鉴权（v1.2.1）
//
// 为什么需要（对手能利用的唯一个缺口）：
// guard.js 的围栏只证明「请求来自本机回环」，而本机任意进程本来就满足这条。于是
//     curl -X POST "http://127.0.0.1:<端口>/plugins/dsh-restart-now/restart?force=1"
// 就能把桌面应用重启掉——打断正在跑的回合，反复打就是一次 DoS。guard.js 头注释自己
// 也写着「非浏览器本地进程本来就是 loopback 信任域的根」，即它从设计上不做鉴权。
//
// 平台自己是怎么做的（app.asar 的 webServer 鉴权层）：
//     requestRejection(request) {
//       const admission = this.admit(request);
//       return "rejection" in admission ? admission.rejection : void 0;
//     }
//     admit(request) {
//       if (!this.isTrusted(request)) return { rejection: 403 };        // 围栏（我们已实现）
//       if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer };
//       const id = this.browserAuth.authenticateApi(request, secure);   // API 凭据（v2）
//       const record = id === undefined ? void 0 : this.peers.get(id);
//       return record === void 0 ? { rejection: 401 } : { peer: record };
//     }
// 即：本机回环只过了第一道，第二道要「authority 绑定 + 启动密钥签名 + 未过期的会话 cookie」
// 或版本 2 的 API 凭据。401 = 缺/过期凭据，403 = 来源不可信，两者语义必须分开。
//
// 本模块只做归一化，不实现鉴权本身：平台服务缺失、方法缺失、平台自己抛异常时一律
// 判「不拦截」（available:false），否则一次平台 API 变动就会把插件整体弄挂。

/** 平台连接服务（cordis 服务名）。只读获取，服务未就绪按缺失处理。 */
export function resolveConnection(ctx) {
  try {
    const connection = ctx && typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    return connection && typeof connection === 'object' ? connection : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 归一化平台鉴权结论（纯逻辑 + 一次平台调用，便于单测）。
 * @param ctx cordis 上下文
 * @param req http.IncomingMessage
 * @param options.enforced=false 时整体跳过（逃生门：配置 platformAuth:false）
 * @returns { enforced, available, verdict, status?, error? }
 *   verdict: 'ok' | 'unauthorized' | 'forbidden' | 'rejected' | 'skipped' | 'bypassed' | 'error'
 *   - skipped  逃生门关闭了鉴权
 *   - bypassed 平台没有可用的 requestRejection（放行）
 *   - error    平台调用抛异常（放行，但留 error 供诊断）
 */
export async function inspectPlatformAuth(ctx, req, options = {}) {
  const enforced = options.enforced !== false;
  const connection = resolveConnection(ctx);
  const available = Boolean(connection && typeof connection.requestRejection === 'function');
  if (!enforced) return { enforced: false, available, verdict: 'skipped' };
  if (!available) return { enforced: true, available: false, verdict: 'bypassed' };

  let rejection;
  try {
    rejection = await connection.requestRejection(req);
  } catch (error) {
    return {
      enforced: true, available: false, verdict: 'error',
      error: String(error?.message ?? error),
    };
  }
  if (rejection === undefined || rejection === null) {
    return { enforced: true, available: true, verdict: 'ok' };
  }
  // 平台约定返回数字状态码；容忍对象形态（{ status } / { rejection }），其余归 0。
  const raw = typeof rejection === 'object'
    ? (rejection.status ?? rejection.rejection)
    : rejection;
  const status = Number(raw);
  const code = Number.isFinite(status) && status > 0 ? status : 0;
  if (code === 401) return { enforced: true, available: true, verdict: 'unauthorized', status: 401 };
  if (code === 403) return { enforced: true, available: true, verdict: 'forbidden', status: 403 };
  return { enforced: true, available: true, verdict: 'rejected', status: code };
}

/** 环境口回报的精简形态（不含 req 细节，客户端可直接展示）。 */
export function summarizeAuth(auth) {
  return {
    enforced: auth?.enforced !== false,
    available: auth?.available === true,
    verdict: auth?.verdict || 'bypassed',
    error: auth?.error ? String(auth.error) : '',
  };
}
