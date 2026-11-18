// 桌面端连哪一个服务器。
//
// 代码里不写死任何地址：打包时把服务器的地址写进应用（`built-in-server.json`，见 scripts/package.mjs）；
// 开发和测试时用启动参数或环境变量。

import { readFileSync } from 'node:fs'

/** 打包时写进应用的服务器地址。没有（开发时）、文件坏了都为空。`file` 只在测试里换。 */
export function builtInServer(
  file: URL = new URL('./built-in-server.json', import.meta.url),
): string | null {
  try {
    const { server } = JSON.parse(readFileSync(file, 'utf8')) as { server?: unknown }
    return typeof server === 'string' && server ? server : null
  } catch {
    return null
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface ServerSource {
  /** 启动参数，例如 `--server=http://127.0.0.1:8780`。 */
  argv: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  /** 打包时写进应用的地址。 */
  builtIn: string | null
}

export type Resolved =
  | { ok: true; url: URL }
  /** 给的地址不能用：格式不对，或者不是加密的连接。 */
  | { ok: false; given: string }

/**
 * 决定用哪个地址：启动参数优先，其次是环境变量，都没有就用打包时写进去的。都没有算地址不能用。
 * 只接受 `https`；本机的地址（开发和测试用）可以是 `http`。
 */
export function resolveServer(source: ServerSource): Resolved {
  const flag = source.argv.find((arg) => arg.startsWith('--server='))
  const given = flag?.slice('--server='.length) || source.env.VC_SERVER_URL || source.builtIn || ''
  let url: URL
  try {
    url = new URL(given)
  } catch {
    return { ok: false, given }
  }
  const secure = url.protocol === 'https:'
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
  if (!secure && !local) return { ok: false, given }
  // 只要来源那一段：路径、参数都不要
  return { ok: true, url: new URL(url.origin) }
}

/** 这是不是本机上的开发服务器。开发模式的页面要用内嵌脚本，不能给它加内容安全策略。 */
export function isLocalServer(server: URL): boolean {
  return server.protocol === 'http:' && LOOPBACK.has(server.hostname)
}
