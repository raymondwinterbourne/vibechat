// 页面的内容安全策略：只能运行本站的脚本，内嵌的脚本不执行。
// 即使有人设法往页面里塞进了一段脚本，浏览器也不会运行它。

/**
 * `host` 是用户访问时用的主机名（带端口），实时连接要按它单独放行：
 * 有的浏览器不认为 `'self'` 包括同一个主机上的 WebSocket。
 */
export function contentSecurityPolicy(host: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // 界面库会在运行时写入样式，所以样式允许内嵌；脚本不允许
    "style-src 'self' 'unsafe-inline'",
    // 发图片之前的预览、截图粘贴用的是浏览器本地生成的地址
    "img-src 'self' blob: data:",
    // 语音录完之后的试听也是
    "media-src 'self' blob:",
    `connect-src 'self' ws://${host} wss://${host}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
