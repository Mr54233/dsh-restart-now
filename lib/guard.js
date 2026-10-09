// lib/guard.js —— Q6 安全围栏 v0.6（桌面构建感知版）。
// 参照 dshmarket restart.ts:207 directLoopbackRequest / :237 trustedRestartRequest、
// http.ts:134 loopbackAuthority、:142 sameOrigin。
//
// 真机勘误（v0.6）：桌面构建有一条会剥请求头的内部代理（dshmarket http.ts:147-152
// 原注释 "a stripping proxy (the Desktop build's, #648) may remove it and must not
// be refused for it"）。首版「必须 Origin === http://$Host」在真机上把合法请求全拒成
// untrusted。本版语义改为「存在即校验、缺失可容忍、全部留痕」：
//   ① 对端必须是 loopback（硬条件，不可容忍）；
//   ② Host 存在时必须是 loopback authority（防 DNS rebinding，#678）；
//   ③ Origin 存在时必须解析为 http/https 且与 Host 同 authority
//      （Host 缺失时退化为 Origin 自身须为 loopback authority）；
//   ④ 转发头存在不再一票否决（桌面代理会加），记入 notes；
//   ⑤ Host/Origin 缺失记入 notes（剥头代理形态）。
// 安全性论证：浏览器承载的攻击（CSRF / DNS rebinding）必然携带 Host/Origin，
// 在 ②③ 被拦截；能造出 ⑤ 形态的只有机器内的剥头代理，而该代理只存在于官方
// 桌面壳内；非浏览器本地进程本来就是 loopback 信任域的根。所有容忍形态由
// index.js 写入 %TEMP%\dsh-restart-now-debug.log 留痕，便于事后收紧。

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FORWARDED_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip'];

/** Host 头是否指向 loopback（127.0.0.1 / localhost / [::1]，端口忽略）——dshmarket http.ts:134 同款 */
export function loopbackAuthority(host) {
  if (typeof host !== 'string') return false;
  const lower = host.toLowerCase();
  // IPv6 字面量保留方括号：'[::1]:3080' → '[::1]'
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * 纯函数可单测：返回 { trusted, notes, detail }。
 * notes = 容忍/异常形态标记（'forwarded-headers' | 'host-absent' | 'origin-absent'），
 * detail = { peer, host, origin, forwarded[] } 供 debug 日志。
 */
export function inspectRequest(req) {
  const headers = req.headers ?? {};
  const detail = {
    peer: req.socket?.remoteAddress ?? '',
    host: headers.host,
    origin: headers.origin,
    forwarded: [],
  };
  const notes = [];
  if (!LOOPBACK.has(detail.peer)) {
    return { trusted: false, notes: ['peer-not-loopback'], detail };
  }
  for (const k of FORWARDED_HEADERS) {
    if (headers[k] !== undefined) detail.forwarded.push(k);
  }
  if (detail.forwarded.length > 0) notes.push('forwarded-headers');
  if (detail.host === undefined) {
    notes.push('host-absent'); // 剥头代理形态；缺失时无从校验 authority，靠 ③ 兜底
  } else if (!loopbackAuthority(detail.host)) {
    return { trusted: false, notes: ['host-not-loopback'], detail };
  }
  if (detail.origin === undefined) {
    notes.push('origin-absent'); // 剥头代理形态；浏览器 POST 本应携带
  } else {
    let ok = false;
    try {
      const u = new URL(detail.origin);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        ok = detail.host !== undefined ? u.host === detail.host : loopbackAuthority(u.host);
      }
    } catch {
      ok = false; // 'null' 或畸形 Origin
    }
    if (!ok) return { trusted: false, notes: ['origin-mismatch'], detail };
  }
  return { trusted: true, notes, detail };
}

export function isTrustedRequest(req) {
  return inspectRequest(req).trusted;
}
