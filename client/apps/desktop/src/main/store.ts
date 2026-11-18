// 桌面端自己要记住的几样东西：窗口的位置、界面的语言。存在应用数据目录下的一个小文件里。
// 登录状态不在这里，那是浏览器内核自己保存的 Cookie。

import { readFileSync, writeFileSync } from 'node:fs'
import { type Language, parseLanguage } from './messages.js'
import { type Bounds, parseBounds } from './window-state.js'

export interface Saved {
  window: Bounds | null
  language: Language | null
}

/** 读保存的内容。文件不存在、内容坏了都当作没有保存过。 */
export function load(path: string): Saved {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return { window: parseBounds(raw.window), language: parseLanguage(raw.language) }
  } catch {
    return { window: null, language: null }
  }
}

/** 写不下来就算了：下次用默认的位置和语言。 */
export function save(path: string, saved: Saved): void {
  try {
    writeFileSync(path, JSON.stringify(saved))
  } catch {
    // 忽略
  }
}
