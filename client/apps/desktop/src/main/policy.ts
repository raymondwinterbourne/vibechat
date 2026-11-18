// 窗口可以去哪些地址。
//
// 窗口里只应当显示服务器上的页面，以及应用自带的那个"连不上服务器"页面。
// 其余的一律不去；其中普通的网页地址交给系统的浏览器。

export type Verdict =
  /** 在窗口里打开。 */
  | 'allow'
  /** 不在窗口里打开，交给系统默认的浏览器。 */
  | 'external'
  /** 什么也不做。 */
  | 'deny'

/** 一个地址该怎么处理。`offlinePage` 是应用自带页面的地址（`file:` 开头）。 */
export function judge(target: string, server: URL, offlinePage: string): Verdict {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return 'deny'
  }
  if (url.origin === server.origin) return 'allow'
  if (url.protocol === 'file:') return sameFile(url, offlinePage) ? 'allow' : 'deny'
  // 只把普通的网页地址交给系统：别的协议可能启动本机上的其他程序
  if (url.protocol === 'http:' || url.protocol === 'https:') return 'external'
  return 'deny'
}

function sameFile(url: URL, offlinePage: string): boolean {
  try {
    return url.pathname === new URL(offlinePage).pathname
  } catch {
    return false
  }
}

/** 一条来自页面的消息是不是服务器上的页面发的。预加载脚本的接口只对它生效。 */
export function fromServer(senderUrl: string | undefined, server: URL): boolean {
  if (!senderUrl) return false
  try {
    return new URL(senderUrl).origin === server.origin
  } catch {
    return false
  }
}

/** 页面要用的"媒体"：声音是麦克风，画面是摄像头。别的都不给。 */
export type MediaDevice = 'microphone' | 'camera'

/**
 * 页面请求"媒体"时要向 macOS 问哪几样。请求了别的类型的整个拒绝，返回空。
 * 0.3.0 起放行摄像头（视频通话），之前只放行麦克风。共享屏幕不在这里，见 `usesSystemPicker`。
 */
export function mediaToAsk(types: readonly string[]): MediaDevice[] | null {
  const asked: MediaDevice[] = []
  for (const type of types) {
    if (type === 'audio') asked.push('microphone')
    else if (type === 'video') asked.push('camera')
    else return null
  }
  return asked
}

/**
 * 共享屏幕时用不用 macOS 自带的选择框（F7 Q8）：macOS 15 起才有。
 * `version` 是系统的版本号，形如 `15.1.0`。
 */
export function usesSystemPicker(platform: string, version: string): boolean {
  return platform === 'darwin' && Number.parseInt(version, 10) >= 15
}

/** 告诉页面系统给没给录屏的权限。 */
export type ScreenAccess = 'granted' | 'denied' | 'unknown'

/**
 * 系统的录屏权限，换成告诉页面的话。用系统自带的选择框时，共享不靠这个权限，
 * 选择框里点了取消也是"拒绝"，分不出来：一律说不知道，页面就当是取消了。
 */
export function screenAccessOf(status: string, systemPicker: boolean): ScreenAccess {
  if (systemPicker) return 'unknown'
  return status === 'granted' ? 'granted' : 'denied'
}
