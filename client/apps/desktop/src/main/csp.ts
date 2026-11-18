// 内容安全策略：页面只能运行本站的脚本。
//
// 这个策略本来由提供页面的服务器随页面一起发来。这里再守一道：
// 服务器没有发的时候桌面端自己补上，这样桌面端的安全不取决于服务器那边有没有配好。

/** 桌面端补上的策略。内容和 Web 应用自己带的那一份（`apps/web/csp.ts`）一样，有测试盯着。 */
export function fallbackPolicy(server: URL): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src 'self' ws://${server.host} wss://${server.host}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

type Headers = Record<string, string[]>

/**
 * 页面的响应头里已经有内容安全策略就原样返回；没有就补上。
 * 响应头的名字不分大小写。
 */
export function ensurePolicy(headers: Headers, server: URL): Headers {
  const present = Object.keys(headers).some(
    (name) => name.toLowerCase() === 'content-security-policy',
  )
  if (present) return headers
  return { ...headers, 'Content-Security-Policy': [fallbackPolicy(server)] }
}
