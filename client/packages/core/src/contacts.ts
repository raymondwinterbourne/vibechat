// 通讯录：接口调用，以及好友列表、申请列表在本地的整理（排序、筛选、按推送更新）。

import type {
  FriendList,
  FriendProfile,
  FriendRequestList,
  FriendRequestResult,
  FriendRequestView,
  FriendView,
  UserLookup,
} from '@vibechat/protocol'
import { apiRequest } from './api'

interface Options {
  signal?: AbortSignal
  /** 测试时替换掉全局的 fetch。 */
  fetchImpl?: typeof fetch
}

function json(method: string, body: unknown, options: Options = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  }
}

/** 按 ID 精确查找一个用户。找不到时抛出错误码为 `user_not_found` 的错误。 */
export function lookupUser(handle: string, options: Options = {}): Promise<UserLookup> {
  const query = new URLSearchParams({ handle })
  return apiRequest(`/api/users/lookup?${query}`, options)
}

/** 我收到的和发出的全部好友申请，最近的在前。 */
export async function listFriendRequests(options: Options = {}): Promise<FriendRequestView[]> {
  const list = await apiRequest<FriendRequestList>('/api/friend-requests', options)
  return list.items
}

/**
 * 向一个用户发好友申请。`to` 是对方的内部编号，来自查找的结果。
 * 对方已经向我申请过时，两人直接成为好友，结果里带着这位新好友。
 */
export function sendFriendRequest(
  to: string,
  message: string,
  options?: Options,
): Promise<FriendRequestResult> {
  return apiRequest('/api/friend-requests', json('POST', { to, message }, options))
}

export function acceptFriendRequest(
  id: string,
  options: Options = {},
): Promise<FriendRequestResult> {
  return apiRequest(`/api/friend-requests/${id}/accept`, { method: 'POST', ...options })
}

export function rejectFriendRequest(
  id: string,
  options: Options = {},
): Promise<FriendRequestResult> {
  return apiRequest(`/api/friend-requests/${id}/reject`, { method: 'POST', ...options })
}

/** 我的全部好友。顺序不保证，显示前用 `sortFriends` 排序。 */
export async function listFriends(options: Options = {}): Promise<FriendView[]> {
  const list = await apiRequest<FriendList>('/api/friends', options)
  return list.items
}

/** 给好友设置备注名；留空即清除。 */
export function setFriendRemark(
  userId: string,
  remark: string,
  options?: Options,
): Promise<FriendView> {
  return apiRequest(`/api/friends/${userId}`, json('PATCH', { remark }, options))
}

export function removeFriend(userId: string, options: Options = {}): Promise<void> {
  return apiRequest(`/api/friends/${userId}`, { method: 'DELETE', ...options })
}

// ---------- 本地的整理 ----------

/** 一个好友显示成什么名字：有备注用备注，没有用昵称。 */
export function friendName(friend: FriendView): string {
  return friend.remark || friend.user.nickname
}

/** 按显示的名字排序。`locale` 是界面语言：中文按拼音，英文按字母。 */
export function sortFriends(friends: readonly FriendView[], locale: string): FriendView[] {
  const collator = new Intl.Collator(locale)
  return [...friends].sort(
    (a, b) =>
      collator.compare(friendName(a), friendName(b)) ||
      // 名字相同时顺序也要固定，不能每次刷新都变
      a.user.id.localeCompare(b.user.id),
  )
}

/** 筛选：备注名、昵称、ID 里包含输入的文字就算匹配，不区分大小写。 */
export function filterFriends(friends: readonly FriendView[], query: string): FriendView[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...friends]
  return friends.filter((friend) =>
    [friend.remark ?? '', friend.user.nickname, friend.user.handle].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  )
}

/** 列表里已经有这个好友就换成新的，没有就加上。 */
export function upsertFriend(friends: readonly FriendView[], friend: FriendView): FriendView[] {
  const others = friends.filter((existing) => existing.user.id !== friend.user.id)
  return [...others, friend]
}

export function dropFriend(friends: readonly FriendView[], userId: string): FriendView[] {
  return friends.filter((friend) => friend.user.id !== userId)
}

/** 一个好友改了自己的资料：换上新的，我给他起的备注不变。 */
export function applyFriendProfile(
  friends: readonly FriendView[],
  profile: FriendProfile,
): FriendView[] {
  return friends.map((friend) =>
    friend.user.id === profile.user.id
      ? { ...friend, user: profile.user, signature: profile.signature }
      : friend,
  )
}

/** 列表里已经有这条申请就换成新的，并按发出的时间重新排好：最近的在前。 */
export function upsertFriendRequest(
  requests: readonly FriendRequestView[],
  request: FriendRequestView,
): FriendRequestView[] {
  const others = requests.filter((existing) => existing.id !== request.id)
  return [...others, request].sort((a, b) => b.sent_at - a.sent_at || b.id.localeCompare(a.id))
}

/** 我还没有处理的申请有几个。通讯录图标上的数字。 */
export function countPendingReceived(requests: readonly FriendRequestView[]): number {
  return requests.filter(
    (request) => request.direction === 'received' && request.status === 'pending',
  ).length
}

// ---------- 按首字母分组 ----------

/**
 * 每个拼音首字母在中文排序里打头的那个字：一个汉字排在某个字之后（含）、下一个字之前，
 * 它的拼音就以这个字母开头。没有 I、U、V 开头的拼音。用浏览器自带的中文排序规则，不需要拼音库；
 * 个别多音字的姓（例如"曾"）会归到另一组。
 */
const PINYIN_STARTS: readonly [string, string][] = [
  ['A', '阿'],
  ['B', '八'],
  ['C', '嚓'],
  ['D', '哒'],
  ['E', '妸'],
  ['F', '发'],
  ['G', '旮'],
  ['H', '哈'],
  ['J', '讥'],
  ['K', '咔'],
  ['L', '垃'],
  ['M', '妈'],
  ['N', '拏'],
  ['O', '噢'],
  ['P', '妑'],
  ['Q', '七'],
  ['R', '呥'],
  ['S', '仨'],
  ['T', '他'],
  ['W', '穵'],
  ['X', '夕'],
  ['Y', '丫'],
  ['Z', '帀'],
]

/** 不是字母开头、也推算不出拼音的，归到这一组，排在最后。 */
export const OTHER_INITIAL = '#'

const pinyinCollator = new Intl.Collator('zh')
const HAN = /\p{Script=Han}/u

/** 一个名字归到哪一组：英文字母开头的取那个字母，汉字开头的取拼音首字母，其余是"#"。 */
export function initialOf(name: string): string {
  const first = [...name.trim()][0]
  if (!first) return OTHER_INITIAL
  // 去掉附加符号：é 算 E
  const latin = first.normalize('NFD').charAt(0).toUpperCase()
  if (latin >= 'A' && latin <= 'Z') return latin
  if (!HAN.test(first)) return OTHER_INITIAL
  let found = OTHER_INITIAL
  for (const [letter, start] of PINYIN_STARTS) {
    if (pinyinCollator.compare(first, start) < 0) break
    found = letter
  }
  return found
}

export interface FriendSection {
  initial: string
  friends: FriendView[]
}

/**
 * 把好友按名称的首字母分组：A 到 Z，最后是"#"。组内按浏览器自带的中文排序：中文名按拼音在前，
 * 同一组里的英文名按字母排在后面。没有好友的字母不出现。
 */
export function groupFriends(friends: readonly FriendView[]): FriendSection[] {
  const sections = new Map<string, FriendView[]>()
  for (const friend of sortFriends(friends, 'zh')) {
    const initial = initialOf(friendName(friend))
    const section = sections.get(initial)
    if (section) section.push(friend)
    else sections.set(initial, [friend])
  }
  return [...sections.entries()]
    .sort(([a], [b]) => (a === OTHER_INITIAL ? 1 : b === OTHER_INITIAL ? -1 : a.localeCompare(b)))
    .map(([initial, list]) => ({ initial, friends: list }))
}
