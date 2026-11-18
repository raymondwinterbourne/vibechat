import type { ConversationView, GroupView, MessageView } from '@vibechat/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyMessage,
  applyRead,
  canManage,
  changesGroup,
  conversationName,
  groupRole,
  MUTED_FOREVER,
  mentionsMe,
  seenNotice,
  silenced,
  sortConversations,
  totalUnread,
} from './conversations'

const ME = 'me'

function message(seq: number, sender: string | null, createdAt = seq): MessageView {
  return {
    id: `m${seq}`,
    conversation_id: 'c1',
    seq,
    sender_id: sender,
    client_id: null,
    kind: sender === null ? 'friends' : 'text',
    text: sender === null ? null : `text ${seq}`,
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
    created_at: createdAt,
  }
}

function conversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    id: 'c1',
    kind: 'direct',
    peer: {
      user: { id: 'peer', handle: 'peer_id', nickname: '小红', avatar_file_id: null },
      is_self: false,
      remark: null,
      is_friend: true,
      read_seq: 0,
    },
    group: null,
    last_seq: 3,
    read_seq: 3,
    last_message: message(3, 'peer'),
    unread: 0,
    muted: false,
    pinned_at: null,
    ...overrides,
  }
}

function group(overrides: Partial<GroupView> = {}): ConversationView {
  return conversation({
    kind: 'group',
    peer: null,
    group: {
      name: '',
      name_hint: ['小明', '小红', '小刚'],
      avatar_file_id: null,
      owner_id: ME,
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
      ...overrides,
    },
  })
}

describe('my role in a group', () => {
  it('is the owner, an admin, or an ordinary member', () => {
    expect(groupRole(group(), ME)).toBe('owner')
    expect(groupRole(group({ owner_id: 'x', admin_ids: [ME] }), ME)).toBe('admin')
    expect(groupRole(group({ owner_id: 'x', admin_ids: ['y'] }), ME)).toBe('member')
    expect(canManage(group({ owner_id: 'x', admin_ids: [ME] }), ME)).toBe(true)
    expect(canManage(group({ owner_id: 'x' }), ME)).toBe(false)
  })

  it('manages nothing in a group that is gone, or in a direct chat', () => {
    expect(canManage(group({ left: true }), ME)).toBe(false)
    expect(canManage(group({ dissolved: true, admin_ids: [ME] }), ME)).toBe(false)
    expect(canManage(conversation(), ME)).toBe(false)
  })

  it('is refreshed by admin changes like any other change to the group', () => {
    expect(changesGroup({ ...message(4, null), kind: 'admin_added' })).toBe(true)
    expect(changesGroup({ ...message(4, null), kind: 'admin_removed' })).toBe(true)
  })
})

describe('being muted', () => {
  it('silences me until the time is up', () => {
    const muted = group({ owner_id: 'x', muted_until: 1000 })
    expect(silenced(muted, ME, 999)).toEqual({ kind: 'muted', until: 1000 })
    expect(silenced(muted, ME, 1000)).toBeNull()
    expect(silenced(group({ owner_id: 'x', muted_until: MUTED_FOREVER }), ME, 1)).toEqual({
      kind: 'muted',
      until: MUTED_FOREVER,
    })
  })

  it('silences ordinary members when everyone is muted, but not the owner or admins', () => {
    expect(silenced(group({ owner_id: 'x', all_muted: true }), ME, 0)).toEqual({ kind: 'all' })
    expect(silenced(group({ all_muted: true }), ME, 0)).toBeNull()
    expect(silenced(group({ owner_id: 'x', admin_ids: [ME], all_muted: true }), ME, 0)).toBeNull()
    expect(silenced(conversation(), ME, 0)).toBeNull()
  })
})

describe('groups in the conversation list', () => {
  it('names a group by its name, or by its first members when it has none', () => {
    expect(conversationName(group({ name: '项目组' }))).toBe('项目组')
    expect(conversationName(group())).toBe('小明、小红、小刚')
    expect(conversationName(group(), ', ')).toBe('小明, 小红, 小刚')
  })

  it('knows when a message mentions me', () => {
    expect(mentionsMe({ ...message(4, 'peer'), mentions: [ME] }, ME)).toBe(true)
    expect(mentionsMe({ ...message(4, 'peer'), mention_all: true }, ME)).toBe(true)
    expect(mentionsMe({ ...message(4, 'peer'), mentions: ['someone'] }, ME)).toBe(false)
    // 自己 @ 所有人，不算 @ 了自己
    expect(mentionsMe({ ...message(4, ME), mention_all: true }, ME)).toBe(false)
  })

  it('flags the group when a new message mentions me, and clears it once I caught up', () => {
    const mentioned = applyMessage(group(), { ...message(4, 'peer'), mentions: [ME] }, ME)
    expect(mentioned.group?.mentioned).toBe(true)
    expect(mentioned.unread).toBe(1)

    // 后面又来了一条普通的：标记还在
    const more = applyMessage(mentioned, message(5, 'peer'), ME)
    expect(more.group?.mentioned).toBe(true)

    // 只读到一半：标记还在
    const half = applyRead(more, { conversation_id: 'c1', user_id: ME, read_seq: 4 }, ME)
    expect(half.conversation.group?.mentioned).toBe(true)
    const all = applyRead(more, { conversation_id: 'c1', user_id: ME, read_seq: 5 }, ME)
    expect(all.conversation.group?.mentioned).toBe(false)
    expect(all.conversation.unread).toBe(0)
  })

  it('tells group events from ordinary messages', () => {
    expect(changesGroup(message(4, 'peer'))).toBe(false)
    expect(changesGroup(message(4, null))).toBe(false)
    expect(changesGroup({ ...message(4, null), kind: 'member_joined' })).toBe(true)
    expect(changesGroup({ ...message(4, null), kind: 'renamed' })).toBe(true)
    expect(changesGroup({ ...message(4, null), kind: 'notice_changed' })).toBe(true)
  })

  it('a new notice from someone else flags the group like a mention, but is not unread', () => {
    const notice: MessageView = {
      ...message(4, null),
      kind: 'notice_changed',
      text: 'meeting on Friday',
      actor: { id: 'peer', nickname: 'Bea' },
    }
    const flagged = applyMessage(group(), notice, ME)
    expect(flagged.group?.mentioned).toBe(true)
    expect(flagged.unread).toBe(0)
    // 我自己发布的、清空的：不标
    const mine = { ...notice, actor: { id: ME, nickname: 'me' } }
    expect(applyMessage(group(), mine, ME).group?.mentioned).toBe(false)
    expect(applyMessage(group(), { ...notice, text: null }, ME).group?.mentioned).toBe(false)
  })

  it('seeing the notice takes the banner away', () => {
    const notice = { text: 'rules', by_id: 'peer', by_name: 'Bea', at: 1, seq: 3 }
    const unseen = group({ notice, notice_unseen: true })
    expect(seenNotice(unseen).group?.notice_unseen).toBe(false)
    const seen = seenNotice(unseen)
    expect(seenNotice(seen)).toBe(seen)
  })
})

describe('conversation list', () => {
  it('names a direct conversation after the peer, remark first', () => {
    expect(conversationName(conversation())).toBe('小红')
    const remarked = conversation()
    if (remarked.peer) remarked.peer.remark = '红姐'
    expect(conversationName(remarked)).toBe('红姐')
    expect(conversationName(conversation({ peer: null }))).toBe('')
  })

  it('sorts by the time of the latest message, newest first', () => {
    const list = [
      conversation({ id: 'old', last_message: message(1, 'peer', 100) }),
      conversation({ id: 'new', last_message: message(1, 'peer', 300) }),
      conversation({ id: 'empty', last_message: null, last_seq: 0 }),
      conversation({ id: 'mid', last_message: message(1, 'peer', 200) }),
    ]
    expect(sortConversations(list).map((item) => item.id)).toEqual(['new', 'mid', 'old', 'empty'])
    expect(list[0]?.id).toBe('old')
  })

  it('puts pinned conversations first, each group newest first', () => {
    const list = [
      conversation({ id: 'old', last_message: message(1, 'peer', 100), pinned_at: 5 }),
      conversation({ id: 'new', last_message: message(1, 'peer', 300) }),
      conversation({ id: 'mid', last_message: message(1, 'peer', 200), pinned_at: 1 }),
      conversation({ id: 'newest', last_message: message(1, 'peer', 400) }),
    ]
    // 置顶的时间不影响先后：置顶的之间照样按最新有动静的
    expect(sortConversations(list).map((item) => item.id)).toEqual(['mid', 'old', 'newest', 'new'])
  })

  it("someone else's new message becomes the summary and counts as unread", () => {
    const updated = applyMessage(conversation(), message(4, 'peer'), ME)
    expect(updated).toMatchObject({ last_seq: 4, unread: 1 })
    expect(updated.last_message?.seq).toBe(4)
  })

  it('my own message and events do not count as unread', () => {
    expect(applyMessage(conversation(), message(4, ME), ME)).toMatchObject({
      last_seq: 4,
      unread: 0,
    })
    expect(applyMessage(conversation(), message(4, null), ME)).toMatchObject({
      last_seq: 4,
      unread: 0,
    })
  })

  it('a message it already knows changes nothing', () => {
    const known = conversation({ unread: 2 })
    expect(applyMessage(known, message(3, 'peer'), ME)).toBe(known)
    expect(applyMessage(known, message(1, 'peer'), ME)).toBe(known)
  })

  it('adds up the unread counts', () => {
    expect(totalUnread([conversation({ unread: 2 }), conversation({ unread: 5 })])).toBe(7)
    expect(totalUnread([])).toBe(0)
  })
})

describe('read positions', () => {
  const read = (userId: string, seq: number) => ({
    conversation_id: 'c1',
    user_id: userId,
    read_seq: seq,
  })

  it('the peer reading moves their position forward, never back', () => {
    const applied = applyRead(conversation(), read('peer', 2), ME)
    expect(applied.conversation.peer?.read_seq).toBe(2)
    expect(applied.stale).toBe(false)

    const again = applyRead(applied.conversation, read('peer', 1), ME)
    expect(again.conversation).toBe(applied.conversation)
  })

  it('my reading everything elsewhere clears the unread count', () => {
    const unreadOnes = conversation({ read_seq: 1, unread: 2 })
    const applied = applyRead(unreadOnes, read(ME, 3), ME)
    expect(applied.conversation).toMatchObject({ read_seq: 3, unread: 0 })
    expect(applied.stale).toBe(false)
  })

  it('my reading only part of it leaves a count that must be fetched again', () => {
    const unreadOnes = conversation({ read_seq: 0, unread: 3 })
    const applied = applyRead(unreadOnes, read(ME, 2), ME)
    expect(applied.conversation.read_seq).toBe(2)
    expect(applied.stale).toBe(true)
  })

  it('an old report of my own position changes nothing', () => {
    const known = conversation({ read_seq: 3 })
    expect(applyRead(known, read(ME, 2), ME)).toEqual({ conversation: known, stale: false })
  })

  it('a stranger in the event changes nothing', () => {
    const known = conversation()
    expect(applyRead(known, read('someone else', 3), ME).conversation).toBe(known)
  })
})
