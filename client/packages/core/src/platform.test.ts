import { describe, expect, it, vi } from 'vitest'
import { type DesktopBridge, detectPlatform, type PlatformCommand } from './platform'

function bridge() {
  const listeners: ((command: string) => void)[] = []
  const calls: unknown[][] = []
  const fake: DesktopBridge = {
    version: '0.1.0',
    setUnreadCount: (count) => calls.push(['unread', count]),
    showWindow: () => calls.push(['show']),
    setLanguage: (language) => calls.push(['language', language]),
    onCommand: (listener) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
  }
  return {
    fake,
    calls,
    emit: (command: string) => {
      for (const listener of [...listeners]) listener(command)
    },
  }
}

const LINUX = { platform: 'Linux x86_64', maxTouchPoints: 0 }
const MAC = { platform: 'MacIntel', maxTouchPoints: 0 }

describe('in a browser', () => {
  it('is the web platform when nothing is attached to the window', () => {
    const focus = vi.fn()
    const platform = detectPlatform({ focus, navigator: LINUX })
    expect(platform.name).toBe('web')
    expect(platform.version).toBeNull()
    expect(platform.noticesOnByDefault).toBe(false)
    // 这些在浏览器里什么也不用做，但调用它们不出错
    platform.setUnreadCount(3)
    platform.setLanguage('en')
    platform.onCommand(() => {})()
    platform.showWindow()
    expect(focus).toHaveBeenCalledOnce()
  })

  it('ignores something on the window that only looks like the desktop bridge', () => {
    for (const fake of [null, 'yes', {}, { version: 1 }, { version: '1', setUnreadCount() {} }]) {
      expect(detectPlatform({ focus() {}, navigator: MAC, vibeDesktop: fake }).name).toBe('web')
    }
  })

  it('offers the desktop client on a Mac only', () => {
    const offered = (navigator: { platform: string; maxTouchPoints: number }) =>
      detectPlatform({ focus() {}, navigator }).desktopInstallable
    expect(offered(MAC)).toBe(true)
    expect(offered({ platform: 'MacARM', maxTouchPoints: 0 })).toBe(true)
    expect(offered(LINUX)).toBe(false)
    expect(offered({ platform: 'Win32', maxTouchPoints: 0 })).toBe(false)
    expect(offered({ platform: 'iPhone', maxTouchPoints: 5 })).toBe(false)
    // iPad 在"桌面版网站"模式下自称 Mac，但它有触摸屏
    expect(offered({ platform: 'MacIntel', maxTouchPoints: 5 })).toBe(false)
  })
})

describe('in the desktop app', () => {
  it('hands unread counts, focus and language over to the desktop side', () => {
    const { fake, calls } = bridge()
    const focus = vi.fn()
    const platform = detectPlatform({ focus, navigator: MAC, vibeDesktop: fake })
    expect(platform.name).toBe('desktop')
    expect(platform.version).toBe('0.1.0')
    expect(platform.desktopInstallable).toBe(true)
    expect(platform.noticesOnByDefault).toBe(true)
    platform.setUnreadCount(12)
    platform.showWindow()
    platform.setLanguage('zh-CN')
    expect(calls).toEqual([['unread', 12], ['show'], ['language', 'zh-CN']])
    // 假接口的这几个函数是有返回值的；不能漏出去，否则会被界面当成别的东西用
    expect(platform.setUnreadCount(1)).toBeUndefined()
    expect(platform.showWindow()).toBeUndefined()
    expect(platform.setLanguage('en')).toBeUndefined()
    // 把窗口带到前台是桌面端的事，不是页面自己 focus
    expect(focus).not.toHaveBeenCalled()
  })

  it('asks the desktop side to bring the window up when a call comes in', () => {
    const { fake, calls } = bridge()
    const alerts: boolean[] = []
    const platform = detectPlatform({
      focus() {},
      navigator: MAC,
      vibeDesktop: { ...fake, version: '0.2.0', callAlert: (on: boolean) => alerts.push(on) },
    })
    platform.callAlert(true)
    platform.callAlert(false)
    expect(alerts).toEqual([true, false])
    expect(calls).toEqual([])

    // 0.1.0 的桌面端没有这一项：什么也不做，不出错
    const old = detectPlatform({ focus() {}, navigator: MAC, vibeDesktop: fake })
    expect(() => old.callAlert(true)).not.toThrow()
    // 浏览器里也不做什么
    expect(() => detectPlatform({ focus() {}, navigator: MAC }).callAlert(true)).not.toThrow()
  })

  it('asks the desktop side whether the system lets it record the screen', async () => {
    const { fake } = bridge()
    const asks = (answer: string) =>
      detectPlatform({
        focus() {},
        navigator: MAC,
        vibeDesktop: { ...fake, version: '0.4.0', screenAccess: async () => answer },
      }).screenAccess()
    expect(await asks('denied')).toBe('denied')
    expect(await asks('granted')).toBe('granted')
    expect(await asks('not-determined')).toBe('unknown')
    // 旧版本的桌面端、浏览器里：不知道
    expect(
      await detectPlatform({ focus() {}, navigator: MAC, vibeDesktop: fake }).screenAccess(),
    ).toBe('unknown')
    expect(await detectPlatform({ focus() {}, navigator: MAC }).screenAccess()).toBe('unknown')
  })

  it('passes on the commands it knows and drops the rest', () => {
    const { fake, emit } = bridge()
    const platform = detectPlatform({ focus() {}, navigator: MAC, vibeDesktop: fake })
    const seen: PlatformCommand[] = []
    const stop = platform.onCommand((command) => seen.push(command))
    emit('open-settings')
    emit('something-from-a-newer-desktop')
    emit('reconnect')
    expect(seen).toEqual(['open-settings', 'reconnect'])
    stop()
    emit('reconnect')
    expect(seen).toHaveLength(2)
  })
})
