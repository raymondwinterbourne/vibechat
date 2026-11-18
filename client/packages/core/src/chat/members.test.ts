import type { MemberView, MessageView } from '@vibechat/protocol'
import { describe, expect, it } from 'vitest'
import { applyMemberRead, memberName, partyName, publicName, readersOf } from './members'

const ME = 'me'

function member(id: string, overrides: Partial<MemberView> = {}): MemberView {
  return {
    user: { id, handle: `${id}_id`, nickname: id, avatar_file_id: null },
    remark: null,
    is_friend: true,
    is_owner: false,
    is_admin: false,
    group_nickname: null,
    muted_until: null,
    active: true,
    joined_seq: 0,
    read_seq: 0,
    ...overrides,
  }
}

function message(seq: number): MessageView {
  return {
    id: `m${seq}`,
    conversation_id: 'g1',
    seq,
    sender_id: ME,
    client_id: `k${seq}`,
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
    created_at: seq,
  }
}

describe('group members', () => {
  it('shows my remark for a member when I gave one', () => {
    expect(memberName(member('a'))).toBe('a')
    expect(memberName(member('a', { remark: '老王' }))).toBe('老王')
  })

  it('splits the others into who read my message and who did not', () => {
    const members = [
      member(ME, { read_seq: 9 }),
      member('read', { read_seq: 5 }),
      member('beyond', { read_seq: 8 }),
      member('behind', { read_seq: 4 }),
    ]

    const readers = readersOf(members, message(5), ME)

    expect(readers.read.map((item) => item.user.id)).toEqual(['read', 'beyond'])
    expect(readers.unread.map((item) => item.user.id)).toEqual(['behind'])
  })

  it('leaves out people who left and people who joined after the message', () => {
    const members = [
      member('gone', { active: false, read_seq: 9 }),
      member('late', { joined_seq: 5, read_seq: 9 }),
      member('early', { joined_seq: 4, read_seq: 9 }),
    ]

    const readers = readersOf(members, message(5), ME)

    expect(readers.read.map((item) => item.user.id)).toEqual(['early'])
    expect(readers.unread).toEqual([])
  })

  it('only moves a read position forward', () => {
    const members = [member('a', { read_seq: 5 }), member('b', { read_seq: 5 })]

    const forward = applyMemberRead(members, { conversation_id: 'g1', user_id: 'a', read_seq: 7 })
    expect(forward.map((item) => item.read_seq)).toEqual([7, 5])
    const backward = applyMemberRead(members, { conversation_id: 'g1', user_id: 'a', read_seq: 3 })
    expect(backward.map((item) => item.read_seq)).toEqual([5, 5])
  })

  it('names the people in an event', () => {
    const members = [member('a', { remark: '老王' }), member('b')]

    // 名单里有：用名单里的，备注优先
    expect(partyName({ id: 'a', nickname: '当时的昵称' }, members, ME)).toBe('老王')
    expect(partyName({ id: 'b', nickname: '当时的昵称' }, members, ME)).toBe('b')
    // 名单里没有，或者名单还没取回来：用事件里存下的
    expect(partyName({ id: 'x', nickname: '当时的昵称' }, members, ME)).toBe('当时的昵称')
    expect(partyName({ id: 'a', nickname: '当时的昵称' }, undefined, ME)).toBe('当时的昵称')
    // 是我自己：交给界面显示成"你"
    expect(partyName({ id: ME, nickname: '我' }, members, ME)).toBeNull()
  })
})

describe('names in a group', () => {
  it('prefer my remark, then the group nickname, then the nickname', () => {
    const named = member('bea', { group_nickname: '队长' })
    expect(memberName(named)).toBe('队长')
    expect(memberName({ ...named, remark: '小贝' })).toBe('小贝')
    expect(memberName(member('bea'))).toBe('bea')
  })

  it('show everyone the group nickname, never my private remark', () => {
    expect(publicName(member('bea', { group_nickname: '队长', remark: '小贝' }))).toBe('队长')
    expect(publicName(member('bea', { remark: '小贝' }))).toBe('bea')
  })
})
