// 页面的更新：服务器上的页面换了，已经开着的页面提示刷新（U1）。
//
// 每次构建有一个编号，写在页面里，也写在和页面放在一起的 version.json 里。
// 已经开着的页面在重新连上服务器之后、回到前台时取一次 version.json，编号不一样就是有新页面了。
// 不自动刷新：用户可能正在打字或者在通话，由用户自己点。

/** 回到前台时，两次检查之间至少隔多久。重连之后的检查不受它限制。 */
export const FOREGROUND_CHECK_INTERVAL_MS = 5 * 60 * 1000

interface FetchOptions {
  /** 测试时替换掉全局的 fetch。 */
  fetchImpl?: typeof fetch
  now?: () => number
}

/** 服务器上现在的页面的构建编号。取不到（开发环境没有这个文件、网络出错）时为空。 */
export async function fetchBuildId(options: FetchOptions = {}): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  try {
    // 带上时间：中间不管哪一层缓存，都取到的是最新的
    const response = await fetchImpl(`/version.json?t=${now()}`, { cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { build?: unknown }
    return typeof body.build === 'string' ? body.build : null
  } catch {
    return null
  }
}

export interface UpdateCheckerOptions {
  /** 这个页面自己的构建编号。为空（开发环境）时不检查。 */
  current: string | null
  fetchBuild: () => Promise<string | null>
  now?: () => number
  foregroundIntervalMs?: number
}

/** 检查服务器上的页面有没有换，换了就记下新的编号，等用户刷新或者关掉提示。 */
export class UpdateChecker {
  private readonly current: string | null
  private readonly fetchBuild: () => Promise<string | null>
  private readonly now: () => number
  private readonly foregroundIntervalMs: number
  private lastCheckedAt = Number.NEGATIVE_INFINITY
  private dismissed: string | null = null
  private newer: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor(options: UpdateCheckerOptions) {
    this.current = options.current
    this.fetchBuild = options.fetchBuild
    this.now = options.now ?? Date.now
    this.foregroundIntervalMs = options.foregroundIntervalMs ?? FOREGROUND_CHECK_INTERVAL_MS
  }

  /** 有新页面、用户还没有关掉提示时，是新页面的编号；否则为空。 */
  get available(): string | null {
    return this.newer !== null && this.newer !== this.dismissed ? this.newer : null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 检查一次。`reconnected`：和服务器的连接刚刚重新连上（同步代码会重启服务端），总是检查；
   * `foreground`：窗口回到前台，离上次检查不够久就不查。
   */
  async check(reason: 'reconnected' | 'foreground'): Promise<void> {
    if (this.current === null) return
    const now = this.now()
    if (reason === 'foreground' && now - this.lastCheckedAt < this.foregroundIntervalMs) return
    this.lastCheckedAt = now
    const build = await this.fetchBuild()
    if (build === null || build === this.current || build === this.newer) return
    this.newer = build
    this.notify()
  }

  /** 用户关掉了提示：这一次的新页面不再提示，下一次更新再提示。 */
  dismiss(): void {
    if (this.newer === null || this.dismissed === this.newer) return
    this.dismissed = this.newer
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
