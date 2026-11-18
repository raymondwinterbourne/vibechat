// 各个平台不一样的那几样能力。界面只通过这个接口去用它们，不直接判断自己在哪里。
//
// 现在有两种：浏览器，和桌面端（Electron）。桌面端加载的是同一份页面，
// 区别只在于它的预加载脚本在 `window` 上挂了一组接口（`vibeDesktop`）。

/** 平台发给界面的指令：打开设置页；立即重新连接（电脑刚唤醒）。 */
export type PlatformCommand = 'open-settings' | 'reconnect'

export interface Platform {
  readonly name: 'web' | 'desktop'
  /** 桌面端的版本号。浏览器里没有。 */
  readonly version: string | null
  /** 这台设备装不装得了桌面客户端。只有 Mac 装得了。 */
  readonly desktopInstallable: boolean
  /** 系统通知的开关从来没有动过时，算开还是算关。 */
  readonly noticesOnByDefault: boolean
  /** 未读总数变了。页面标题由界面自己改，这里是平台另外要做的事。 */
  setUnreadCount(count: number): void
  /** 把窗口带到前台。用户点了一条系统通知时调用。 */
  showWindow(): void
  /** 来电开始响铃、不响了。桌面端把窗口带到前面，程序坞的图标跳动；浏览器里靠系统通知。 */
  callAlert(on: boolean): void
  /** 界面的语言变了。 */
  setLanguage(language: string): void
  /** 平台发来指令时调用 `listener`。返回取消订阅的函数。 */
  onCommand(listener: (command: PlatformCommand) => void): () => void
  /** 系统给没给录屏的权限（F7）。浏览器里问不到，是 unknown。 */
  screenAccess(): Promise<'granted' | 'denied' | 'unknown'>
}

/** 桌面端的预加载脚本挂在 `window.vibeDesktop` 上的接口。 */
export interface DesktopBridge {
  version: string
  setUnreadCount(count: number): void
  showWindow(): void
  /** 0.2.0 起才有。 */
  callAlert?(on: boolean): void
  setLanguage(language: string): void
  onCommand(listener: (command: string) => void): () => void
  /** 0.4.0 起才有。 */
  screenAccess?(): Promise<string>
}

/** 判断平台时要看的那部分 `window`。 */
export interface PlatformWindow {
  focus(): void
  navigator: { platform: string; maxTouchPoints: number }
  vibeDesktop?: unknown
}

/**
 * 是不是一台 Mac。iPad 在"桌面版网站"模式下也自称 Mac，区别是它有触摸屏。
 * 分不出是 Apple 芯片还是 Intel 芯片（浏览器不说），下载的地方用文字说明。
 */
function isMac({ platform, maxTouchPoints }: PlatformWindow['navigator']): boolean {
  return platform.startsWith('Mac') && maxTouchPoints <= 1
}

/** 浏览器里：未读数只显示在页面标题上，通知要用户自己开启，没有来自系统的指令。 */
export function createWebPlatform(win: PlatformWindow): Platform {
  return {
    name: 'web',
    version: null,
    desktopInstallable: isMac(win.navigator),
    noticesOnByDefault: false,
    setUnreadCount: () => {},
    showWindow: () => win.focus(),
    callAlert: () => {},
    setLanguage: () => {},
    onCommand: () => () => {},
    screenAccess: async () => 'unknown',
  }
}

/** 桌面端里：把这几件事转给桌面端去做。 */
export function createDesktopPlatform(bridge: DesktopBridge): Platform {
  return {
    name: 'desktop',
    version: bridge.version,
    desktopInstallable: true,
    // 装了桌面应用的人多半就是为了收通知
    noticesOnByDefault: true,
    // 桌面端那边返回什么都不往外传：调用的地方只当它们没有返回值
    setUnreadCount: (count) => {
      bridge.setUnreadCount(count)
    },
    showWindow: () => {
      bridge.showWindow()
    },
    // 旧版本的桌面端没有：来电时只有系统通知
    callAlert: (on) => {
      bridge.callAlert?.(on)
    },
    setLanguage: (language) => {
      bridge.setLanguage(language)
    },
    onCommand: (listener) =>
      bridge.onCommand((command) => {
        // 不认识的指令（比这份页面更新的桌面端发来的）不理会
        if (command === 'open-settings' || command === 'reconnect') listener(command)
      }),
    // 旧版本的桌面端没有：当作不知道
    screenAccess: async () => {
      const access = await bridge.screenAccess?.().catch(() => null)
      return access === 'granted' || access === 'denied' ? access : 'unknown'
    },
  }
}

function isBridge(value: unknown): value is DesktopBridge {
  if (typeof value !== 'object' || value === null) return false
  const bridge = value as Record<string, unknown>
  return (
    typeof bridge.version === 'string' &&
    ['setUnreadCount', 'showWindow', 'setLanguage', 'onCommand'].every(
      (name) => typeof bridge[name] === 'function',
    )
  )
}

/** 页面启动时看一眼自己在哪里：`window` 上有桌面端的接口就是桌面端，否则是浏览器。 */
export function detectPlatform(win: PlatformWindow): Platform {
  return isBridge(win.vibeDesktop) ? createDesktopPlatform(win.vibeDesktop) : createWebPlatform(win)
}
