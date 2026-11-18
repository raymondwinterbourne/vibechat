import type { ConversationView, FriendRequestView, MessageView } from '@vibechat/protocol'
import { describe, expect, it } from 'vitest'
import { alerts, titleWithUnread, totalUnread } from './chat/conversations'
import { noticesOn, noticeTag, shouldNotifyMessage, shouldNotifyRequest } from './notify'

const ME = 'me'

function message(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: 'm1',
    conversation_id: 'c1',
    seq: 5,
    sender_id: 'peer',
    client_id: null,
    kind: 'text',
    text: 'hello',
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
    created_at: 1,
    ...overrides,
  }
}

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: 'c1',
    kind: 'group',
    peer: null,
    group: {
      name: '项目组',
      name_hint: [],
      avatar_file_id: null,
      owner_id: 'peer',
      dissolved: false,
      member_count: 3,
      max_members: 10,
      left: false,
      mentioned: false,
      notice: null,
      notice_unseen: false,
      admin_ids: [],
      all_muted: false,
      muted_until: null,
      join_approval: false,
      pending_requests: 0,
    },
    last_seq: 4,
    read_seq: 4,
    last_message: null,
    unread: 0,
    muted: false,
    pinned_at: null,
    ...overrides,
  }
}

describe('whether a message should raise a notification', () => {
  it('for a call record only when I missed the call', () => {
    const call = (call_outcome: MessageView['call_outcome'], sender_id = 'peer') =>
      shouldNotifyMessage(
        message({ kind: 'call', text: null, call_outcome, sender_id }),
        conversation({ kind: 'direct', group: null }),
        ME,
        false,
      )
    for (const outcome of ['cancelled', 'missed', 'busy', 'offline'] as const) {
      expect(call(outcome)).toBe(true)
    }
    for (const outcome of ['completed', 'rejected', 'interrupted'] as const) {
      expect(call(outcome)).toBe(false)
    }
    // 我打出去的
    expect(call('missed', ME)).toBe(false)
  })

  it('only when the page is in the background', () => {
    expect(shouldNotifyMessage(message(), conversation(), ME, false)).toBe(true)
    expect(shouldNotifyMessage(message(), conversation(), ME, true)).toBe(false)
  })

  it('only for messages other people sent', () => {
    const notify = (overrides: Partial<MessageView>) =>
      shouldNotifyMessage(message(overrides), conversation(), ME, false)
    for (const kind of ['text', 'image', 'file', 'voice'] as const) {
      expect(notify({ kind })).toBe(true)
    }
    // 我自己在别处发的
    expect(notify({ sender_id: ME })).toBe(false)
    // 系统提示和撤回
    expect(notify({ kind: 'member_joined', sender_id: null })).toBe(false)
    expect(notify({ kind: 'recalled', sender_id: null, target_seq: 3 })).toBe(false)
    expect(notify({ recalled: true, text: null })).toBe(false)
  })

  it('not for a muted conversation, unless the message mentions me', () => {
    const muted = conversation({ muted: true })
    expect(shouldNotifyMessage(message(), muted, ME, false)).toBe(false)
    expect(shouldNotifyMessage(message({ mentions: [ME] }), muted, ME, false)).toBe(true)
    expect(shouldNotifyMessage(message({ mention_all: true }), muted, ME, false)).toBe(true)
    // @ 的是别人
    expect(shouldNotifyMessage(message({ mentions: ['someone'] }), muted, ME, false)).toBe(false)
  })

  it('for a new group notice from someone else, even in a muted group', () => {
    const muted = conversation({ muted: true })
    const notice = message({
      kind: 'notice_changed',
      sender_id: null,
      text: 'meeting on Friday',
      actor: { id: 'peer', nickname: 'Bea' },
    })
    expect(shouldNotifyMessage(notice, muted, ME, false)).toBe(true)
    // 自己发布的、清空公告的都不弹
    const mine = { ...notice, actor: { id: ME, nickname: 'me' } }
    expect(shouldNotifyMessage(mine, muted, ME, false)).toBe(false)
    expect(shouldNotifyMessage({ ...notice, text: null }, conversation(), ME, false)).toBe(false)
    // 页面在前台时照样不弹
    expect(shouldNotifyMessage(notice, muted, ME, true)).toBe(false)
  })

  it('treats a conversation it has not heard of as not muted', () => {
    expect(shouldNotifyMessage(message(), undefined, ME, false)).toBe(true)
  })

  it('uses one tag per conversation', () => {
    expect(noticeTag('c1')).toBe(noticeTag('c1'))
    expect(noticeTag('c1')).not.toBe(noticeTag('c2'))
  })
})

describe('whether a friend request should raise a notification', () => {
  const request = (overrides: Partial<FriendRequestView>): FriendRequestView => ({
    id: 'r1',
    direction: 'received',
    user: { id: 'u1', handle: 'someone', nickname: '小红', avatar_file_id: null },
    message: '',
    status: 'pending',
    sent_at: 1,
    handled_at: null,
    ...overrides,
  })

  it('only for a new request to me, while in the background', () => {
    expect(shouldNotifyRequest(request({}), false)).toBe(true)
    expect(shouldNotifyRequest(request({}), true)).toBe(false)
    // 我发出去的、已经处理过的
    expect(shouldNotifyRequest(request({ direction: 'sent' }), false)).toBe(false)
    expect(shouldNotifyRequest(request({ status: 'accepted' }), false)).toBe(false)
  })
})

describe('whether notices are on', () => {
  it('follows what the user chose', () => {
    for (const byDefault of [true, false]) {
      expect(noticesOn('on', true, byDefault)).toBe(true)
      expect(noticesOn('off', true, byDefault)).toBe(false)
    }
  })

  it('falls back to the platform default when the user never chose', () => {
    // 浏览器里默认关，桌面端里默认开
    expect(noticesOn(null, true, false)).toBe(false)
    expect(noticesOn(null, true, true)).toBe(true)
  })

  it('is off without permission, whatever else says', () => {
    expect(noticesOn('on', false, true)).toBe(false)
    expect(noticesOn(null, false, true)).toBe(false)
  })
})

describe('the unread total', () => {
  it('leaves out muted conversations unless they mention me', () => {
    const list = [
      conversation({ id: 'a', unread: 2 }),
      conversation({ id: 'b', unread: 5, muted: true }),
      conversation({ id: 'c', unread: 0 }),
    ]
    expect(totalUnread(list)).toBe(2)
    expect(alerts(list[1] as ConversationView)).toBe(false)

    const mentioned = conversation({ id: 'd', unread: 3, muted: true })
    if (mentioned.group) mentioned.group.mentioned = true
    expect(alerts(mentioned)).toBe(true)
    expect(totalUnread([...list, mentioned])).toBe(5)
  })

  it('goes at the front of the page title', () => {
    expect(titleWithUnread(0, 'VibeChat')).toBe('VibeChat')
    expect(titleWithUnread(3, 'VibeChat')).toBe('(3) VibeChat')
    expect(titleWithUnread(99, 'VibeChat')).toBe('(99) VibeChat')
    expect(titleWithUnread(100, 'VibeChat')).toBe('(99+) VibeChat')
  })
})
