import type { MessageView, ServerEvent } from '@vibechat/protocol'
import { describe, expect, it } from 'vitest'
import { TYPING_SEND_EVERY_MS, TYPING_SHOW_MS, TypingTracker } from './typing'

function setup() {
  let now = 1000
  const sent: string[] = []
  const timers: { run: () => void; ms: number; at: number }[] = []
  const tracker = new TypingTracker({
    me: 'me',
    send: (id) => sent.push(id),
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { run, ms, at: now + ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const at = timers.indexOf(timer as (typeof timers)[number])
      if (at >= 0) timers.splice(at, 1)
    },
  })
  return {
    tracker,
    sent,
    advance: (ms: number) => {
      now += ms
      for (const timer of timers.filter((item) => item.at <= now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.run()
      }
    },
  }
}

const typing = (conversation: string, user: string): ServerEvent => ({
  type: 'conv.typing',
  data: { conversation_id: conversation, user_id: user },
})

const message = (conversation: string, sender: string) =>
  ({
    type: 'msg.new',
    data: { conversation_id: conversation, sender_id: sender } as MessageView,
  }) as ServerEvent

describe('who is typing', () => {
  it('shows someone for a few seconds after they last said so', () => {
    const t = setup()
    t.tracker.handleEvent(typing('c1', 'bea'))
    expect(t.tracker.typingIn('c1')).toEqual(['bea'])
    t.advance(TYPING_SHOW_MS - 1000)
    // 又说了一次：重新计时
    t.tracker.handleEvent(typing('c1', 'bea'))
    t.advance(TYPING_SHOW_MS - 1000)
    expect(t.tracker.typingIn('c1')).toEqual(['bea'])
    t.advance(1000)
    expect(t.tracker.typingIn('c1')).toEqual([])
    expect(t.tracker.getState()).toEqual({})
  })

  it('keeps the order people started in, and drops someone once their message arrives', () => {
    const t = setup()
    t.tracker.handleEvent(typing('g1', 'bea'))
    t.tracker.handleEvent(typing('g1', 'cy'))
    t.tracker.handleEvent(typing('g1', 'bea'))
    expect(t.tracker.typingIn('g1')).toEqual(['bea', 'cy'])
    t.tracker.handleEvent(message('g1', 'bea'))
    expect(t.tracker.typingIn('g1')).toEqual(['cy'])
    // 我自己的不算
    t.tracker.handleEvent(typing('g1', 'me'))
    expect(t.tracker.typingIn('g1')).toEqual(['cy'])
  })
})

describe('telling others I am typing', () => {
  it('says so at most every few seconds, and at once again after a message goes out', () => {
    const t = setup()
    t.tracker.typed('c1')
    t.tracker.typed('c1')
    t.advance(TYPING_SEND_EVERY_MS - 1)
    t.tracker.typed('c1')
    expect(t.sent).toEqual(['c1'])
    t.advance(1)
    t.tracker.typed('c1')
    expect(t.sent).toEqual(['c1', 'c1'])
    // 另一个会话分开算
    t.tracker.typed('c2')
    expect(t.sent).toEqual(['c1', 'c1', 'c2'])
    // 发出去了一条：再打字马上说
    t.tracker.stopped('c1')
    t.tracker.typed('c1')
    expect(t.sent).toEqual(['c1', 'c1', 'c2', 'c1'])
  })
})
