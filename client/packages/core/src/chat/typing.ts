// "正在输入"（F8）：谁在哪个会话里打字，以及我打字时多久告诉一次服务端。不存下来，过几秒就没用了。

import type { ServerEvent } from '@vibechat/protocol'

/** 我在打字时最多多久告诉一次服务端。服务端那边 0.5 秒之内的只转一次。 */
export const TYPING_SEND_EVERY_MS = 3000
/** 别人说了一次"正在输入"之后显示多久。比上面的间隔长一些，连续打字时提示不会一闪一闪。 */
export const TYPING_SHOW_MS = 6000

export interface TypingTrackerOptions {
  me: string
  /** 告诉服务端"我在这个会话里输入"。 */
  send: (conversationId: string) => void
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** 每个会话里正在输入的人，按开始输入的先后。没有人在输入的会话不在里面。 */
export type TypingState = Readonly<Record<string, readonly string[]>>

const NOBODY: readonly string[] = []

export class TypingTracker {
  private state: TypingState = {}
  private readonly listeners = new Set<() => void>()
  private readonly me: string
  private readonly sendTyping: (conversationId: string) => void
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  /** 每个人的提示什么时候消失：键是"会话 人"。 */
  private readonly timers = new Map<string, unknown>()
  /** 每个会话里我最近一次告诉服务端的时间。 */
  private readonly sent = new Map<string, number>()

  constructor(options: TypingTrackerOptions) {
    this.me = options.me
    this.sendTyping = options.send
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number))
  }

  getState = (): TypingState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 这个会话里正在输入的人。 */
  typingIn(conversationId: string): readonly string[] {
    return this.state[conversationId] ?? NOBODY
  }

  /** 我在这个会话的输入框里打了字：隔一会儿才再告诉服务端一次。 */
  typed(conversationId: string): void {
    const now = this.now()
    const last = this.sent.get(conversationId)
    if (last !== undefined && now - last < TYPING_SEND_EVERY_MS) return
    this.sent.set(conversationId, now)
    this.sendTyping(conversationId)
  }

  /** 我把消息发出去了：下一次打字马上告诉对方。 */
  stopped(conversationId: string): void {
    this.sent.delete(conversationId)
  }

  handleEvent(event: ServerEvent): void {
    if (event.type === 'conv.typing') {
      const { conversation_id: id, user_id: user } = event.data
      if (user === this.me) return
      this.show(id, user)
    } else if (event.type === 'msg.new') {
      // 他的消息到了：不再是"正在输入"
      const sender = event.data.sender_id
      if (sender) this.hide(event.data.conversation_id, sender)
    }
  }

  /** 退出登录时：停掉全部计时。 */
  dispose(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer)
    this.timers.clear()
    this.listeners.clear()
  }

  private show(id: string, user: string): void {
    const key = `${id} ${user}`
    const timer = this.timers.get(key)
    if (timer !== undefined) this.clearTimer(timer)
    this.timers.set(
      key,
      this.setTimer(() => this.hide(id, user), TYPING_SHOW_MS),
    )
    const current = this.typingIn(id)
    if (!current.includes(user)) this.set(id, [...current, user])
  }

  private hide(id: string, user: string): void {
    const key = `${id} ${user}`
    const timer = this.timers.get(key)
    if (timer !== undefined) this.clearTimer(timer)
    this.timers.delete(key)
    const current = this.typingIn(id)
    if (current.includes(user))
      this.set(
        id,
        current.filter((item) => item !== user),
      )
  }

  private set(id: string, users: readonly string[]): void {
    const next = { ...this.state }
    if (users.length === 0) delete next[id]
    else next[id] = users
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
