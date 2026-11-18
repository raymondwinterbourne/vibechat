import { describe, expect, it } from 'vitest'
import { badgeText, parseCallAlert, parseLanguage, parseUnread } from './messages.js'

describe('messages from the page', () => {
  it('takes an incoming-call alert only as on or off', () => {
    expect(parseCallAlert(true)).toBe(true)
    expect(parseCallAlert(false)).toBe(false)
    for (const odd of [1, 'true', null, undefined, {}]) expect(parseCallAlert(odd)).toBeNull()
  })

  it('takes an unread count only when it is a sane whole number', () => {
    expect(parseUnread(0)).toBe(0)
    expect(parseUnread(7)).toBe(7)
    expect(parseUnread(1_000_000)).toBe(1_000_000)
    for (const odd of [
      -1,
      1.5,
      1_000_001,
      Number.NaN,
      Infinity,
      '7',
      null,
      undefined,
      {},
      [7],
      true,
    ]) {
      expect(parseUnread(odd), String(odd)).toBeNull()
    }
  })

  it('takes a language only when it is one the app has', () => {
    expect(parseLanguage('zh-CN')).toBe('zh-CN')
    expect(parseLanguage('en')).toBe('en')
    for (const odd of ['zh', 'EN', 'fr', '', 1, null, undefined, { toString: () => 'en' }]) {
      expect(parseLanguage(odd), String(odd)).toBeNull()
    }
  })
})

describe('the number on the Dock icon', () => {
  it('is hidden at zero, exact up to 99, then 99+', () => {
    expect(badgeText(0)).toBe('')
    expect(badgeText(-3)).toBe('')
    expect(badgeText(1)).toBe('1')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
    expect(badgeText(12345)).toBe('99+')
  })
})
