// 把浏览器报的设备信息（User-Agent）写成人看得懂的样子（F9 登录设备）：哪个浏览器、哪个系统，
// 是不是桌面客户端。只认常见的几种；认不出来的为空，界面上写"未知"。

export interface DeviceInfo {
  /** 例如 Chrome、Safari、Firefox、Edge。桌面客户端里为空。 */
  browser: string | null
  /** 例如 macOS、Windows、iPhone、iPad、Android、Linux。 */
  os: string | null
  /** 是桌面客户端时它的版本号。 */
  desktop: string | null
}

export function describeDevice(userAgent: string): DeviceInfo {
  // 桌面客户端（Electron）默认的设备信息里带着应用的名字和版本
  const desktop = /VibeChat\/(\d+\.\d+\.\d+)/.exec(userAgent)?.[1] ?? null
  const electron = desktop !== null || /Electron\//.test(userAgent)
  return {
    browser: electron ? null : browserOf(userAgent),
    os: osOf(userAgent),
    desktop: desktop ?? (electron ? '' : null),
  }
}

function browserOf(ua: string): string | null {
  // 顺序要紧：Edge、Opera 都自称 Chrome，Chrome 又自称 Safari
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/OPR\/|Opera/.test(ua)) return 'Opera'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox'
  if (/MicroMessenger\//.test(ua)) return 'WeChat'
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari'
  return null
}

function osOf(ua: string): string | null {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  return null
}
