import { describe, expect, it } from 'vitest'
import { formatListTime, formatMessageTime } from './time'

// 用本地时间构造，测试在任何时区结果都一样
const at = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime()

const NOW = at(2026, 10, 4, 15, 30)

describe('time in the conversation list', () => {
  it('shows only the clock for today', () => {
    expect(formatListTime(at(2026, 10, 4, 9, 5), NOW, 'zh-CN')).toBe('09:05')
    expect(formatListTime(at(2026, 10, 4, 0, 5), NOW, 'en')).toBe('00:05')
  })

  it('says yesterday by the calendar day, not by 24 hours', () => {
    // 昨天晚上 23:50，离现在不到 24 小时，也是"昨天"
    expect(formatListTime(at(2026, 10, 3, 23, 50), NOW, 'zh-CN')).toBe('昨天')
    expect(formatListTime(at(2026, 10, 3, 0, 1), NOW, 'en')).toBe('Yesterday')
  })

  it('shows the date for earlier days, with the year only when it differs', () => {
    expect(formatListTime(at(2026, 10, 2, 12), NOW, 'zh-CN')).toBe('10月2日')
    expect(formatListTime(at(2026, 10, 2, 12), NOW, 'en')).toBe('Oct 2')
    expect(formatListTime(at(2025, 12, 31, 12), NOW, 'zh-CN')).toBe('2025年12月31日')
    expect(formatListTime(at(2025, 12, 31, 12), NOW, 'en')).toBe('Dec 31, 2025')
  })
})

describe('time between messages', () => {
  it('always includes the clock', () => {
    expect(formatMessageTime(at(2026, 10, 4, 14, 5), NOW, 'zh-CN')).toBe('14:05')
    expect(formatMessageTime(at(2026, 10, 3, 14, 5), NOW, 'zh-CN')).toBe('昨天 14:05')
    expect(formatMessageTime(at(2026, 10, 3, 14, 5), NOW, 'en')).toBe('Yesterday 14:05')
    expect(formatMessageTime(at(2026, 9, 30, 8, 0), NOW, 'zh-CN')).toBe('9月30日 08:00')
    expect(formatMessageTime(at(2025, 9, 30, 8, 0), NOW, 'en')).toBe('Sep 30, 2025 08:00')
  })
})
