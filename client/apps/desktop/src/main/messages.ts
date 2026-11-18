// 页面发给主进程的消息：有哪几种，内容要符合什么。
//
// 页面是从网络上加载的，所以它发来的任何东西都先检查，不符合的直接丢掉。

export const CHANNELS = {
  setUnread: 'vc:set-unread',
  showWindow: 'vc:show-window',
  setLanguage: 'vc:set-language',
  /** 来电开始响铃（true）、不响了（false）。 */
  callAlert: 'vc:call-alert',
  /** 页面问：系统给没给录屏的权限（0.4.0 起）。 */
  screenAccess: 'vc:screen-access',
  /** 主进程发给页面的指令。 */
  command: 'vc:command',
  /** 只有"连不上服务器"的页面用：现在就重试。 */
  retry: 'vc:retry',
} as const

export type Language = 'zh-CN' | 'en'

/** 主进程发给页面的指令。 */
export type Command = 'open-settings' | 'reconnect'

/** 未读数再多也不会超过这个；超过的当作不合法。 */
const UNREAD_MAX = 1_000_000

/** 未读总数：非负的整数。 */
export function parseUnread(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= 0 && value <= UNREAD_MAX ? value : null
}

/** 来电提醒的开和关：只认 true 和 false。 */
export function parseCallAlert(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function parseLanguage(value: unknown): Language | null {
  return value === 'zh-CN' || value === 'en' ? value : null
}

/** 程序坞图标上显示成什么。没有未读时不显示。 */
export function badgeText(unread: number): string {
  if (unread <= 0) return ''
  return unread > 99 ? '99+' : String(unread)
}
