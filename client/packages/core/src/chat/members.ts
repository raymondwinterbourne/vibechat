// 群成员在本地的整理：谁读了一条消息，事件里的人显示成什么名字。

import type { ConversationRead, EventParty, MemberView, MessageView } from '@vibechat/protocol'

/** 一个成员显示成什么名字：我给他起了备注就用备注，其次是他的群内昵称，最后是昵称。 */
export function memberName(member: MemberView): string {
  return member.remark || member.group_nickname || member.user.nickname
}

/** 一个成员在群里人人都看得到的名字：群内昵称，没有就是昵称。@ 他时写进文字里的是它。 */
export function publicName(member: MemberView): string {
  return member.group_nickname || member.user.nickname
}

export interface Readers {
  read: MemberView[]
  unread: MemberView[]
}

/**
 * 我发的一条消息，群里其他人谁读了、谁还没读。
 * 只算现在还在群里、并且入群早于这条消息的人：之后才进来的人本来就看不到它。
 */
export function readersOf(
  members: readonly MemberView[],
  message: MessageView,
  myId: string,
): Readers {
  const audience = members.filter(
    (member) => member.active && member.user.id !== myId && member.joined_seq < message.seq,
  )
  return {
    read: audience.filter((member) => member.read_seq >= message.seq),
    unread: audience.filter((member) => member.read_seq < message.seq),
  }
}

/** 一个成员的已读位置前进了。 */
export function applyMemberRead(
  members: readonly MemberView[],
  read: ConversationRead,
): MemberView[] {
  return members.map((member) =>
    member.user.id === read.user_id && read.read_seq > member.read_seq
      ? { ...member, read_seq: read.read_seq }
      : member,
  )
}

/**
 * 事件里提到的一个人显示成什么名字。成员名单里有他就用名单里的（含我给他起的备注）；
 * 没有（名单还没取回来，或者这个人已经查不到了）就用事件里存下的、当时的昵称。
 * 是我自己时返回 null，由界面换成"你"。
 */
export function partyName(
  party: EventParty,
  members: readonly MemberView[] | undefined,
  myId: string,
): string | null {
  if (party.id === myId) return null
  const member = members?.find((candidate) => candidate.user.id === party.id)
  return member ? memberName(member) : party.nickname
}
