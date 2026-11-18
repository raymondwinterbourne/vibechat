// 会话列表在本地的整理：新消息来了更新摘要和未读数，已读位置变了更新"已读"。

import type { ConversationRead, ConversationView, MessageView } from '@vibechat/protocol'

/**
 * 一个会话显示成什么名字。单聊是对方：有备注用备注，没有用昵称。
 * 群是群名；没有起名的群用最早加入的几个成员的昵称，用 `separator` 连起来。
 */
export function conversationName(conversation: ConversationView, separator = '、'): string {
  const { peer, group } = conversation
  if (group) return group.name || group.name_hint.join(separator)
  return peer ? peer.remark || peer.user.nickname : ''
}

/** 这条消息有没有 @ `myId`：点了他的名，或者 @ 了所有人。自己发的不算。 */
export function mentionsMe(message: MessageView, myId: string): boolean {
  if (message.sender_id === myId) return false
  return message.mention_all || message.mentions.includes(myId)
}

/** 别人发布或修改了群公告（不是清空）。它和 @ 所有人一样提醒每个人。 */
export function isNewNotice(message: MessageView, myId: string): boolean {
  return message.kind === 'notice_changed' && message.text !== null && message.actor?.id !== myId
}

/**
 * 我在这个群里的身份：群主、管理员，还是普通成员。已经离开、或者群已经解散的，什么都管不了，
 * 算作普通成员。
 */
export function groupRole(
  conversation: ConversationView,
  myId: string,
): 'owner' | 'admin' | 'member' {
  const group = conversation.group
  if (!group || group.left || group.dissolved) return 'member'
  if (group.owner_id === myId) return 'owner'
  return group.admin_ids.includes(myId) ? 'admin' : 'member'
}

/** 我能不能管理这个群：改群资料和公告、@ 所有人、移出普通成员。群主和管理员可以。 */
export function canManage(conversation: ConversationView, myId: string): boolean {
  return groupRole(conversation, myId) !== 'member'
}

/** 禁言"直到解除"记成的时间：公元 9999 年底。不小于它的都是直到解除。 */
export const MUTED_FOREVER = 253_402_300_799_999

/** 禁言可以选的时长，分钟。 */
export const MUTE_MINUTES = [10, 60, 720, 1440] as const

/**
 * 我现在为什么不能在这个群里说话：被禁言了（到 `until` 为止），或者全员禁言而我不是群主或管理员。
 * 能说话时为空。`now` 是现在的时间。
 */
export function silenced(
  conversation: ConversationView,
  myId: string,
  now: number,
): { kind: 'muted'; until: number } | { kind: 'all' } | null {
  const group = conversation.group
  if (!group || group.left || group.dissolved) return null
  if (group.muted_until !== null && group.muted_until > now) {
    return { kind: 'muted', until: group.muted_until }
  }
  if (group.all_muted && !canManage(conversation, myId)) return { kind: 'all' }
  return null
}

/** 我看过了这个群现在的公告。 */
export function seenNotice(conversation: ConversationView): ConversationView {
  const group = conversation.group
  return group?.notice_unseen
    ? { ...conversation, group: { ...group, notice_unseen: false } }
    : conversation
}

const GROUP_EVENTS: ReadonlySet<MessageView['kind']> = new Set([
  'group_created',
  'member_joined',
  'member_left',
  'member_removed',
  'owner_changed',
  'admin_added',
  'admin_removed',
  'member_muted',
  'member_unmuted',
  'all_muted',
  'all_unmuted',
  'renamed',
  'avatar_changed',
  'dissolved',
  'notice_changed',
])

/** 群里会改变群本身的事件：成员进出、换群主、管理员变动、禁言、改名、换头像、解散、群公告。 */
export function changesGroup(message: MessageView): boolean {
  return GROUP_EVENTS.has(message.kind)
}

/** 置顶的在前，各自按最新有动静的先后（F6 Q2）。 */
export function sortConversations(list: readonly ConversationView[]): ConversationView[] {
  const latest = (conversation: ConversationView) => conversation.last_message?.created_at ?? 0
  const pinned = (conversation: ConversationView) => (conversation.pinned_at === null ? 0 : 1)
  return [...list].sort(
    (a, b) => pinned(b) - pinned(a) || latest(b) - latest(a) || b.last_seq - a.last_seq,
  )
}

/** 一条消息是否算作 `myId` 的未读：是别人发的。事件没有发送人，不算。 */
function countsAsUnread(message: MessageView, myId: string): boolean {
  return message.sender_id !== null && message.sender_id !== myId
}

/** 会话里多了一条：更新它的摘要、最新序号和未读数。已经知道的（序号不更新）不改。 */
export function applyMessage(
  conversation: ConversationView,
  message: MessageView,
  myId: string,
): ConversationView {
  if (message.seq <= conversation.last_seq) return conversation
  const group = conversation.group
  // 编辑事件不是新的一条：摘要还是原来那条，它就是被编辑的那条时换上新的内容（F8）
  if (message.kind === 'edited') {
    const last = conversation.last_message
    const edited =
      last && last.seq === message.target_seq && !last.recalled
        ? { ...last, text: message.text, edited_at: message.created_at }
        : last
    return {
      ...conversation,
      last_seq: message.seq,
      last_message: edited,
      group: group && mentionsMe(message, myId) ? { ...group, mentioned: true } : group,
    }
  }
  // 别人撤回了一条我还没有读的消息：它不再算未读
  const recalledUnread =
    message.kind === 'recalled' &&
    message.actor?.id !== myId &&
    (message.target_seq ?? 0) > conversation.read_seq
  const unread =
    conversation.unread + (countsAsUnread(message, myId) ? 1 : 0) - (recalledUnread ? 1 : 0)
  return {
    ...conversation,
    last_seq: message.seq,
    last_message: message,
    unread: Math.max(0, unread),
    group:
      group && (mentionsMe(message, myId) || isNewNotice(message, myId))
        ? { ...group, mentioned: true }
        : group,
  }
}

export interface ReadApplied {
  conversation: ConversationView
  /** 我的已读位置前进了，但没有到最新一条：剩下几条未读在本地算不出来，要重新取。 */
  stale: boolean
}

/** 一个成员的已读位置前进了。是我自己（在别处看过了）就清未读数，是对方就更新"已读"。 */
export function applyRead(
  conversation: ConversationView,
  read: ConversationRead,
  myId: string,
): ReadApplied {
  if (read.user_id === myId) {
    if (read.read_seq <= conversation.read_seq) return { conversation, stale: false }
    const caughtUp = read.read_seq >= conversation.last_seq
    const group = conversation.group
    return {
      conversation: {
        ...conversation,
        read_seq: read.read_seq,
        unread: caughtUp ? 0 : conversation.unread,
        // 都看过了，@ 我的那条自然也看过了
        group: group && caughtUp ? { ...group, mentioned: false } : group,
      },
      stale: !caughtUp && conversation.unread > 0,
    }
  }
  const peer = conversation.peer
  if (!peer || peer.user.id !== read.user_id || read.read_seq <= peer.read_seq) {
    return { conversation, stale: false }
  }
  return {
    conversation: { ...conversation, peer: { ...peer, read_seq: read.read_seq } },
    stale: false,
  }
}

/**
 * 这个会话的未读算不算进总数、要不要提醒。
 * 免打扰的会话不算，除非里面有 @ 我的消息还没看。
 */
export function alerts(conversation: ConversationView): boolean {
  return !conversation.muted || conversation.group?.mentioned === true
}

/** 未读总数：聊天图标和页面标题上的数字。免打扰的会话不计入。 */
export function totalUnread(list: readonly ConversationView[]): number {
  return list.reduce(
    (sum, conversation) => sum + (alerts(conversation) ? conversation.unread : 0),
    0,
  )
}

/** 页面标题：有未读时把数字放在最前面，标签页很窄时也看得到。 */
export function titleWithUnread(unread: number, name: string): string {
  if (unread <= 0) return name
  return `(${unread > 99 ? '99+' : unread}) ${name}`
}
