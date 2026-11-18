import type { FriendRequestView, FriendView } from '@vibechat/protocol'
import { describe, expect, it } from 'vitest'
import {
  acceptFriendRequest,
  applyFriendProfile,
  countPendingReceived,
  dropFriend,
  filterFriends,
  friendName,
  groupFriends,
  initialOf,
  listFriendRequests,
  listFriends,
  lookupUser,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  setFriendRemark,
  sortFriends,
  upsertFriend,
  upsertFriendRequest,
} from './contacts'

interface Call {
  path: string
  init: RequestInit
}

function server(status: number, body?: unknown) {
  const calls: Call[] = []
  const fetchImpl = async (path: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ path: String(path), init })
    return new Response(body === undefined ? null : JSON.stringify(body), { status })
  }
  return { calls, fetchImpl: fetchImpl as typeof fetch }
}

function friend(id: string, nickname: string, remark: string | null = null): FriendView {
  return {
    user: { id, handle: `id_${id}`, nickname, avatar_file_id: null },
    signature: '',
    remark,
    since: 1,
  }
}

function request(
  id: string,
  direction: FriendRequestView['direction'],
  status: FriendRequestView['status'],
  sentAt: number,
): FriendRequestView {
  return {
    id,
    direction,
    user: { id: `u-${id}`, handle: `id_${id}`, nickname: id, avatar_file_id: null },
    message: '',
    status,
    sent_at: sentAt,
    handled_at: null,
  }
}

describe('contact api', () => {
  it('looks a user up by handle, escaping it for the address', async () => {
    const { calls, fetchImpl } = server(200, {})
    await lookupUser('xiao ming&x=1', { fetchImpl })
    expect(calls[0]?.path).toBe('/api/users/lookup?handle=xiao+ming%26x%3D1')
  })

  it('sends, accepts and rejects friend requests', async () => {
    const { calls, fetchImpl } = server(200, {})
    await sendFriendRequest('u1', '我是小明', { fetchImpl })
    await acceptFriendRequest('r1', { fetchImpl })
    await rejectFriendRequest('r2', { fetchImpl })

    expect(calls[0]?.path).toBe('/api/friend-requests')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ to: 'u1', message: '我是小明' })
    expect([calls[1]?.path, calls[1]?.init.method]).toEqual([
      '/api/friend-requests/r1/accept',
      'POST',
    ])
    expect(calls[2]?.path).toBe('/api/friend-requests/r2/reject')
  })

  it('lists return just the items', async () => {
    const items = [friend('1', '小红')]
    const { fetchImpl } = server(200, { items })
    expect(await listFriends({ fetchImpl })).toEqual(items)
    expect(await listFriendRequests({ fetchImpl })).toEqual(items)
  })

  it('sets a remark and removes a friend', async () => {
    const { calls, fetchImpl } = server(200, {})
    await setFriendRemark('u1', '红姐', { fetchImpl })
    expect([calls[0]?.path, calls[0]?.init.method]).toEqual(['/api/friends/u1', 'PATCH'])
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ remark: '红姐' })

    const removal = server(204)
    await removeFriend('u1', { fetchImpl: removal.fetchImpl })
    expect([removal.calls[0]?.path, removal.calls[0]?.init.method]).toEqual([
      '/api/friends/u1',
      'DELETE',
    ])
  })
})

describe('friend list', () => {
  it('shows the remark when there is one, otherwise the nickname', () => {
    expect(friendName(friend('1', '小红'))).toBe('小红')
    expect(friendName(friend('1', '小红', '红姐'))).toBe('红姐')
  })

  it('sorts by the shown name: Chinese by pinyin, English by letter', () => {
    const friends = [
      friend('1', '张三'),
      friend('2', '李四'),
      friend('3', '阿明'),
      // 备注是"王总"：按 W 排，而不是按昵称的 B
      friend('4', '白板', '王总'),
    ]
    const names = (locale: string, list: FriendView[]) => sortFriends(list, locale).map(friendName)

    expect(names('zh-CN', friends)).toEqual(['阿明', '李四', '王总', '张三'])
    expect(names('en', [friend('1', 'bob'), friend('2', 'Alice'), friend('3', 'carol')])).toEqual([
      'Alice',
      'bob',
      'carol',
    ])
  })

  it('keeps a stable order for equal names and leaves the input untouched', () => {
    const friends = [friend('b', '小红'), friend('a', '小红')]
    expect(sortFriends(friends, 'zh-CN').map((f) => f.user.id)).toEqual(['a', 'b'])
    expect(friends.map((f) => f.user.id)).toEqual(['b', 'a'])
  })

  it('filters by remark, nickname or id, ignoring case', () => {
    const friends = [friend('1', '小红', 'Boss'), friend('2', 'Alice'), friend('3', '小刚')]
    const ids = (query: string) => filterFriends(friends, query).map((f) => f.user.id)

    expect(ids('')).toEqual(['1', '2', '3'])
    expect(ids('  ')).toEqual(['1', '2', '3'])
    expect(ids('boss')).toEqual(['1'])
    expect(ids('红')).toEqual(['1'])
    expect(ids('ALI')).toEqual(['2'])
    expect(ids('id_3')).toEqual(['3'])
    expect(ids('nobody')).toEqual([])
  })

  it('adds, replaces and drops friends by user id', () => {
    const friends = [friend('1', '小红'), friend('2', '小刚')]

    const added = upsertFriend(friends, friend('3', '小明'))
    expect(added.map((f) => f.user.id).sort()).toEqual(['1', '2', '3'])

    const replaced = upsertFriend(friends, friend('1', '小红', '红姐'))
    expect(replaced).toHaveLength(2)
    expect(replaced.find((f) => f.user.id === '1')?.remark).toBe('红姐')

    expect(dropFriend(friends, '1').map((f) => f.user.id)).toEqual(['2'])
    expect(dropFriend(friends, 'nobody')).toEqual(friends)
  })

  it('a profile change replaces the profile but keeps my remark', () => {
    const friends = [friend('1', '小红', '红姐'), friend('2', '小刚')]
    const updated = applyFriendProfile(friends, {
      user: { id: '1', handle: 'new_id', nickname: '大红', avatar_file_id: 'f1' },
      signature: '新的签名',
    })

    expect(updated[0]).toEqual({
      user: { id: '1', handle: 'new_id', nickname: '大红', avatar_file_id: 'f1' },
      signature: '新的签名',
      remark: '红姐',
      since: 1,
    })
    expect(updated[1]).toBe(friends[1])
  })
})

describe('friend requests', () => {
  it('a pushed request replaces the old one and the newest comes first', () => {
    const requests = [request('b', 'received', 'pending', 20), request('a', 'sent', 'pending', 10)]

    const added = upsertFriendRequest(requests, request('c', 'received', 'pending', 30))
    expect(added.map((r) => r.id)).toEqual(['c', 'b', 'a'])

    // 同一条申请被再次发出：换成新的，并回到最前面
    const resent = upsertFriendRequest(requests, request('a', 'sent', 'pending', 40))
    expect(resent.map((r) => r.id)).toEqual(['a', 'b'])

    const handled = upsertFriendRequest(requests, request('b', 'received', 'accepted', 20))
    expect(handled.map((r) => [r.id, r.status])).toEqual([
      ['b', 'accepted'],
      ['a', 'pending'],
    ])
  })

  it('counts only the requests I have not handled yet', () => {
    expect(
      countPendingReceived([
        request('a', 'received', 'pending', 1),
        request('b', 'received', 'accepted', 2),
        request('c', 'received', 'rejected', 3),
        request('d', 'sent', 'pending', 4),
        request('e', 'received', 'pending', 5),
      ]),
    ).toBe(2)
    expect(countPendingReceived([])).toBe(0)
  })
})

describe('grouping friends by initial', () => {
  it('takes the pinyin initial of a Chinese name and the first letter of a Latin one', () => {
    const cases: [string, string][] = [
      ['张三', 'Z'],
      ['李四', 'L'],
      ['王五', 'W'],
      ['欧阳', 'O'],
      ['艾米', 'A'],
      ['Bob', 'B'],
      ['alice', 'A'],
      ['Émile', 'E'],
      ['  陈晨', 'C'],
      ['7号', '#'],
      ['😀', '#'],
      ['', '#'],
    ]
    for (const [name, initial] of cases) expect(initialOf(name), name).toBe(initial)
  })

  it('makes A to Z sections with # last, Chinese and Latin names mixed by pinyin', () => {
    const named = (id: string, nickname: string) => friend(id, nickname)
    const sections = groupFriends([
      named('1', '张伟'),
      named('2', 'Zoe'),
      named('3', '9号'),
      named('4', '安琪'),
      named('5', 'Amy'),
      named('6', '赵敏'),
    ])
    expect(sections.map((section) => section.initial)).toEqual(['A', 'Z', '#'])
    const names = (initial: string) =>
      sections
        .find((section) => section.initial === initial)
        ?.friends.map((item) => item.user.nickname)
    expect(names('A')).toEqual(['安琪', 'Amy'])
    expect(names('Z')).toEqual(['张伟', '赵敏', 'Zoe'])
    expect(names('#')).toEqual(['9号'])
  })
})
