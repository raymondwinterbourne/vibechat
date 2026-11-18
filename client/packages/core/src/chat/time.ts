// 聊天里的时间怎么显示。

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(time: number): number {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** `time` 在 `now` 的几天之前：0 是今天，1 是昨天。按本地的日历日算，不是按 24 小时算。 */
function daysAgo(time: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS)
}

function clock(time: number, locale: string): string {
  // h23：午夜是 00:05，而不是 24:05
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(time)
}

/** "昨天"这个词，首字母大写。 */
function yesterday(locale: string): string {
  const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day')
  return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1)
}

function day(time: number, now: number, locale: string): string {
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(
    locale,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  ).format(time)
}

/** 会话列表里的时间，尽量短：今天的只显示几点几分，昨天的显示"昨天"，更早的显示日期。 */
export function formatListTime(time: number, now: number, locale: string): string {
  const ago = daysAgo(time, now)
  if (ago <= 0) return clock(time, locale)
  if (ago === 1) return yesterday(locale)
  return day(time, now, locale)
}

/** 会话里两段消息之间的时间：总是带上几点几分。 */
export function formatMessageTime(time: number, now: number, locale: string): string {
  const ago = daysAgo(time, now)
  if (ago <= 0) return clock(time, locale)
  const date = ago === 1 ? yesterday(locale) : day(time, now, locale)
  return `${date} ${clock(time, locale)}`
}

/** 相邻两条消息隔了这么久，中间就插入一行时间。 */
export const TIME_GAP_MS = 5 * 60 * 1000
