import type { MessageView } from '@vibechat/protocol'
import { describe, expect, it } from 'vitest'
import {
  addPending,
  EMPTY_THREAD,
  firstSeq,
  lastSeq,
  mergeMessages,
  type PendingMessage,
  prependOlder,
  type Thread,
  updatePending,
} from './thread'

const ME = 'me'

function message(seq: number, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: `m${seq}`,
    conversation_id: 'c1',
    seq,
    sender_id: 'other',
    client_id: `k${seq}`,
    kind: 'text',
    text: `text ${seq}`,
    sender_name: null,
    actor: null,
    targets: [],
    name: null,
    mentions: [],
    mention_all: false,
    file: null,
    duration_ms: null,
    record: null,
    call_outcome: null,
    call_video: false,
    call_joined: null,
    approver: null,
    until: null,
    reply: null,
    recalled: false,
    target_seq: null,
    played: false,
    edited_at: null,
    previous_text: null,
    created_at: 1000 + seq,
    ...overrides,
  }
}

function ready(seqs: number[], pending: PendingMessage[] = []): Thread {
  return { ...EMPTY_THREAD, status: 'ready', messages: seqs.map((seq) => message(seq)), pending }
}

function sending(clientId: string): PendingMessage {
  return { clientId, text: clientId, createdAt: 1, status: 'sending' }
}

const seqs = (thread: Thread) => thread.messages.map((item) => item.seq)

describe('merging confirmed messages', () => {
  it('appends the next message', () => {
    const merged = mergeMessages(ready([1, 2]), [message(3)], ME)
    expect(seqs(merged.thread)).toEqual([1, 2, 3])
    expect(merged.gap).toBe(false)
  })

  it('starts an empty conversation at the first message', () => {
    const merged = mergeMessages(ready([]), [message(1)], ME)
    expect(seqs(merged.thread)).toEqual([1])
    expect(merged.gap).toBe(false)
  })

  it('ignores what it already has, and returns the same thread untouched', () => {
    const thread = ready([3, 4, 5])
    for (const duplicate of [4, 5, 2]) {
      const merged = mergeMessages(thread, [message(duplicate)], ME)
      expect(merged.thread).toBe(thread)
      expect(merged.gap).toBe(false)
    }
  })

  it('does not jump over a gap', () => {
    const thread = ready([1, 2])
    const merged = mergeMessages(thread, [message(5)], ME)
    expect(merged.thread).toBe(thread)
    expect(merged.gap).toBe(true)

    // 空的会话里来的第一条不是第 1 条，也是缺了
    expect(mergeMessages(ready([]), [message(2)], ME).gap).toBe(true)
  })

  it('takes a batch in any order and stops at the first gap', () => {
    const merged = mergeMessages(ready([1]), [message(3), message(2), message(6)], ME)
    expect(seqs(merged.thread)).toEqual([1, 2, 3])
    expect(merged.gap).toBe(true)
  })

  it('the result is the same whichever way the same messages arrive', () => {
    const arrivals = [[[2], [3], [4]], [[2, 3, 4]], [[2], [2], [3], [2, 3, 4], [4]], [[4, 3, 2]]]
    for (const batches of arrivals) {
      let thread = ready([1])
      for (const batch of batches) {
        thread = mergeMessages(
          thread,
          batch.map((seq) => message(seq)),
          ME,
        ).thread
      }
      expect(seqs(thread)).toEqual([1, 2, 3, 4])
    }
  })

  it('drops the pending copy once my own message is confirmed', () => {
    const thread = ready([1], [sending('a'), sending('b')])
    const mine = message(2, { sender_id: ME, client_id: 'a' })
    const merged = mergeMessages(thread, [mine], ME)

    expect(seqs(merged.thread)).toEqual([1, 2])
    expect(merged.thread.pending.map((item) => item.clientId)).toEqual(['b'])
  })

  it('confirms a pending message even when the confirmation is a duplicate', () => {
    // 推送先到，消息已经在列表里；之后重发的应答又把同一条带回来
    const mine = message(2, { sender_id: ME, client_id: 'a' })
    const thread: Thread = { ...ready([1]), messages: [message(1), mine], pending: [sending('a')] }
    const merged = mergeMessages(thread, [mine], ME)

    expect(seqs(merged.thread)).toEqual([1, 2])
    expect(merged.thread.pending).toEqual([])
  })

  it("someone else's message with the same client id confirms nothing", () => {
    const thread = ready([1], [sending('a')])
    const theirs = message(2, { sender_id: 'other', client_id: 'a' })
    expect(mergeMessages(thread, [theirs], ME).thread.pending).toHaveLength(1)
  })
})

describe('older messages', () => {
  it('go in front, and only those earlier than what is loaded', () => {
    const thread = { ...ready([5, 6]), hasOlder: true, loadingOlder: true }
    const older = prependOlder(thread, [message(4), message(3), message(5)], true)

    expect(seqs(older)).toEqual([3, 4, 5, 6])
    expect(older.loadingOlder).toBe(false)
    expect(older.hasOlder).toBe(true)
    expect([firstSeq(older), lastSeq(older)]).toEqual([3, 6])

    expect(prependOlder(older, [message(1), message(2)], false).hasOlder).toBe(false)
  })

  it('an empty thread has no first or last', () => {
    expect([firstSeq(EMPTY_THREAD), lastSeq(EMPTY_THREAD)]).toEqual([0, 0])
  })
})

describe('pending messages', () => {
  it('are kept in the order they were sent, and change state by client id', () => {
    let thread = addPending(addPending(ready([1]), sending('a')), sending('b'))
    expect(thread.pending.map((item) => item.clientId)).toEqual(['a', 'b'])

    thread = updatePending(thread, 'a', { status: 'failed', error: 'network_error' })
    expect(thread.pending[0]).toMatchObject({ status: 'failed', error: 'network_error' })
    expect(thread.pending[1]?.status).toBe('sending')

    // 重发时清掉上一次的失败原因
    thread = updatePending(thread, 'a', { status: 'sending' })
    expect(thread.pending[0]).toMatchObject({ status: 'sending', error: undefined })
  })
})
