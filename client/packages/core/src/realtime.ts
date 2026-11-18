// WebSocket 客户端：连接、心跳、断线后自动重连。
//
// 它只负责"连着"和"把服务端的事件交出去"。断线期间错过的内容不在这里补，
// 由上层在重新连上之后通过 HTTP 补齐。

import type { ClientMessage, ServerEvent } from '@vibechat/protocol'

export type ConnectionState =
  /** 第一次连接，还没有结果。 */
  | 'connecting'
  | 'open'
  /** 连接断了或没连上，正在重试。 */
  | 'reconnecting'
  /** 已经停止，不会再连。 */
  | 'closed'

export interface RealtimeOptions {
  /** WebSocket 地址，或每次连接前调用的取地址函数。 */
  url: string | (() => string)
  /** 测试时替换掉全局的 WebSocket。 */
  WebSocketImpl?: typeof WebSocket
  /** 第一次重连前等多久，之后每次翻倍。 */
  baseDelayMs?: number
  /** 重连间隔的上限。 */
  maxDelayMs?: number
  /** 0 到 1 之间的随机数，用来错开大量客户端同时重连。测试时固定下来。 */
  random?: () => number
}

const DEFAULT_BASE_DELAY_MS = 1000
// 上限不宜太长：服务端恢复之后，用户最多再等这么久就能重新连上
const DEFAULT_MAX_DELAY_MS = 10_000

/**
 * 第 attempt 次重连（从 0 开始）之前等多久：每次翻倍，直到上限，
 * 再乘以 0.5 到 1 之间的随机系数。
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  return Math.round(exponential * (0.5 + random() / 2))
}

export class RealtimeClient {
  private readonly options: Required<Omit<RealtimeOptions, 'url'>> & Pick<RealtimeOptions, 'url'>
  private socket: WebSocket | null = null
  private currentState: ConnectionState = 'closed'
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastHeardAt = 0
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private readonly eventListeners = new Set<(event: ServerEvent) => void>()

  constructor(options: RealtimeOptions) {
    this.options = {
      WebSocketImpl: options.WebSocketImpl ?? WebSocket,
      baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      random: options.random ?? Math.random,
      url: options.url,
    }
  }

  get state(): ConnectionState {
    return this.currentState
  }

  /** 开始连接。已经在运行时没有效果。 */
  start(): void {
    if (this.currentState !== 'closed') return
    this.attempt = 0
    this.setState('connecting')
    this.open()
  }

  /**
   * 现在就重新连接，不等心跳超时、不等重连的间隔。
   * 电脑刚从休眠里醒来时用：连接多半已经断了，只是这边还不知道。
   */
  reconnectNow(): void {
    if (this.currentState === 'closed') return
    this.clearTimers()
    this.dropSocket()
    this.attempt = 0
    this.setState('reconnecting')
    this.open()
  }

  /** 停止并断开，不再重连。 */
  stop(): void {
    this.setState('closed')
    this.clearTimers()
    this.dropSocket()
  }

  /** 连接状态变化时调用。返回取消订阅的函数。 */
  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  /** 收到服务端事件时调用（不含心跳的应答）。返回取消订阅的函数。 */
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  private open(): void {
    const { url, WebSocketImpl } = this.options
    const socket = new WebSocketImpl(typeof url === 'function' ? url() : url)
    this.socket = socket
    socket.onmessage = (message) => {
      if (socket === this.socket) this.handleMessage(message.data)
    }
    socket.onclose = () => {
      if (socket === this.socket) this.handleDisconnect()
    }
    // 出错之后浏览器总会再触发 close，重连统一在那里处理
    socket.onerror = () => {}
  }

  private handleMessage(data: unknown): void {
    this.lastHeardAt = Date.now()
    if (typeof data !== 'string') return
    let event: ServerEvent
    try {
      event = JSON.parse(data) as ServerEvent
    } catch {
      return
    }
    if (event.type === 'sys.pong') return
    if (event.type === 'sys.hello') {
      this.attempt = 0
      this.startHeartbeat(event.data.heartbeat_interval_ms)
      this.setState('open')
    }
    for (const listener of this.eventListeners) listener(event)
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      // 连续两个间隔没有收到服务端的任何消息：连接已经不通，主动断开并重连
      if (Date.now() - this.lastHeardAt > intervalMs * 2) {
        this.handleDisconnect()
        return
      }
      this.send({ type: 'sys.ping' })
    }, intervalMs)
  }

  /** 告诉服务端：我在这个会话里输入（F8）。没连着时什么也不做，过几秒本来就没用了。 */
  typing(conversationId: string): void {
    this.send({ type: 'conv.typing', data: { conversation_id: conversationId } })
  }

  private send(message: ClientMessage): void {
    const socket = this.socket
    if (socket && socket.readyState === this.options.WebSocketImpl.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  private handleDisconnect(): void {
    this.stopHeartbeat()
    this.dropSocket()
    if (this.currentState === 'closed' || this.reconnectTimer !== null) return
    this.setState('reconnecting')
    const { baseDelayMs, maxDelayMs, random } = this.options
    const delay = backoffDelay(this.attempt, baseDelayMs, maxDelayMs, random)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    socket.close()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private setState(state: ConnectionState): void {
    if (state === this.currentState) return
    this.currentState = state
    for (const listener of this.stateListeners) listener(state)
  }
}
