// 会话和消息显示成的文字：会话的名称、事件的一句话、会话列表里的摘要。

import { conversationName, MUTED_FOREVER, memberName, partyName } from '@vibechat/core'
import type { ConversationView, EventParty, MemberView, MessageView } from '@vibechat/protocol'
import type { TFunction } from 'i18next'

type T = TFunction<'chats'>

/** 群名称最多多少个字。 */
export const GROUP_NAME_MAX_CHARS = 30

/** 会话的名称。没有起名的群用成员的名称，按当前语言的习惯连起来。 */
export function displayName(conversation: ConversationView, t: T): string {
  // 和自己的对话：名字后面带着"（我）"
  if (conversation.peer?.is_self) return t('selfName', { name: conversation.peer.user.nickname })
  return conversationName(conversation, t('listSeparator'))
}

/** 群里一条消息的发送人显示成什么名字。成员名单还没取回来时用消息里带的昵称。 */
export function senderName(
  message: MessageView,
  members: readonly MemberView[] | undefined,
): string | null {
  const sender = members?.find((member) => member.user.id === message.sender_id)
  return sender ? memberName(sender) : message.sender_name
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 一段时间写成"1 天 3 小时""2 小时 5 分钟""9 分钟"：最多两级，不足一分钟的算一分钟。
 * 用在禁言的时长和还剩多久。
 */
export function formatSpan(ms: number, t: T): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS))
  const days = Math.floor(minutes / (DAY_MS / MINUTE_MS))
  const hours = Math.floor((minutes % (DAY_MS / MINUTE_MS)) / 60)
  const rest = minutes % 60
  const parts =
    days > 0
      ? [t('duration.days', { count: days }), hours > 0 && t('duration.hours', { count: hours })]
      : hours > 0
        ? [
            t('duration.hours', { count: hours }),
            rest > 0 && t('duration.minutes', { count: rest }),
          ]
        : [t('duration.minutes', { count: rest })]
  return parts.filter(Boolean).join(' ')
}

/** 通话时长写成"3:12""1:02:05"。 */
export function callDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}

/**
 * 通话记录在消息流里写成什么，从我的角度看：接通过的写时长，没接通的写原因；
 * 我是被叫、没接到的是"未接来电"（`missed` 为真，用危险色）。
 */
export function callRecordText(
  message: MessageView,
  myId: string,
  t: T,
): { text: string; missed: boolean } {
  const caller = message.sender_id === myId
  const duration = callDuration(message.duration_ms ?? 0)
  // 群通话的记录（F10）：多久、几个人参加过。没有"未接来电"的说法
  if (message.call_joined != null) {
    // 是语音还是视频看发起时选的类型（F11）
    const video = message.call_video
    const text =
      message.call_joined > 1
        ? t(video ? 'groupCall.record.videoCompleted' : 'groupCall.record.completed', {
            duration,
            count: message.call_joined,
          })
        : t(video ? 'groupCall.record.videoNobody' : 'groupCall.record.nobody')
    return { text, missed: false }
  }
  switch (message.call_outcome) {
    case 'completed':
      return {
        text: message.call_video
          ? t('call.record.videoCompleted', { duration })
          : t('call.record.completed', { duration }),
        missed: false,
      }
    case 'interrupted':
      return { text: t('call.record.interrupted', { duration }), missed: false }
    case 'rejected':
      return {
        text: caller ? t('call.record.rejectedByPeer') : t('call.record.rejected'),
        missed: false,
      }
    case 'no_microphone':
      return {
        text: caller ? t('call.record.noMicrophoneByPeer') : t('call.record.noMicrophone'),
        missed: false,
      }
    case 'cancelled':
      return caller
        ? { text: t('call.record.cancelled'), missed: false }
        : { text: t('call.record.missed'), missed: true }
    case 'missed':
    case 'busy':
    case 'offline':
      return caller
        ? { text: t(`call.record.${message.call_outcome}ByPeer`), missed: false }
        : { text: t('call.record.missed'), missed: true }
    default:
      return { text: t('content.call'), missed: false }
  }
}

/** 一条事件显示成的一句话，例如"小明邀请小红加入了群聊"。 */
export function eventText(
  message: MessageView,
  members: readonly MemberView[] | undefined,
  myId: string,
  t: T,
): string {
  const name = (party: EventParty, me: string) => partyName(party, members, myId) ?? me
  const actor = message.actor ? name(message.actor, t('event.you')) : t('event.someone')
  const targets = message.targets
    .map((party) => name(party, t('event.youObject')))
    .join(t('listSeparator'))
  switch (message.kind) {
    case 'friends':
      return t('event.friends')
    case 'group_created':
      return t('event.group_created', { actor, targets })
    case 'member_joined':
      // 经过审批入群的：写明谁同意的
      return message.approver
        ? t('event.member_joined_approved', {
            actor,
            targets,
            approver: name(message.approver, t('event.youObject')),
          })
        : t('event.member_joined', { actor, targets })
    case 'member_left':
      return t('event.member_left', { actor })
    case 'member_removed':
      return message.targets.some((party) => party.id === myId)
        ? t('event.removed_you', { actor })
        : t('event.member_removed', { actor, targets })
    case 'owner_changed':
      return t('event.owner_changed', { actor, targets })
    case 'admin_added':
      return t('event.admin_added', { actor, targets })
    case 'admin_removed':
      return t('event.admin_removed', { actor, targets })
    case 'member_muted':
      return message.until === null || message.until >= MUTED_FOREVER
        ? t('event.member_muted_forever', { actor, targets })
        : t('event.member_muted', {
            actor,
            targets,
            duration: formatSpan(message.until - message.created_at, t),
          })
    case 'member_unmuted':
      return t('event.member_unmuted', { actor, targets })
    case 'all_muted':
      return t('event.all_muted', { actor })
    case 'all_unmuted':
      return t('event.all_unmuted', { actor })
    case 'renamed':
      return message.name
        ? t('event.renamed', { actor, name: message.name })
        : t('event.name_cleared', { actor })
    case 'avatar_changed':
      return t('event.avatar_changed', { actor })
    case 'dissolved':
      // 事件里没有写是谁解散的：是管理员
      return message.actor ? t('event.dissolved', { actor }) : t('event.dissolved_by_admin')
    case 'recalled':
      return t('event.recalled', { actor })
    case 'edited':
      return t('event.edited', { actor })
    case 'notice_changed':
      return message.text
        ? t('event.notice_changed', { actor })
        : t('event.notice_cleared', { actor })
    case 'text':
    case 'image':
    case 'file':
    case 'voice':
    case 'chat_record':
    case 'call':
      return contentLabel(message, t)
  }
}

/**
 * 一条消息的内容写成一行字：文字本身，或者"[图片]"（带说明的是"[图片] 说明"）"[文件] 名字""[语音]"
 * "[聊天记录] 标题"。引用里的聊天记录没有 `record`，标题在 `text` 里。
 */
export function contentLabel(
  message: Pick<MessageView, 'kind' | 'text'> & {
    call_video?: boolean
    file?: { name: string } | null
    record?: { title: string } | null
  },
  t: T,
): string {
  switch (message.kind) {
    case 'image':
      // 带说明的图片：[图片] 说明
      return message.text
        ? `${t('content.image')} ${message.text.replace(/\s+/g, ' ').trim()}`
        : t('content.image')
    case 'file':
      return t('content.file', { name: message.file?.name ?? '' }).trim()
    case 'voice':
      return t('content.voice')
    case 'chat_record':
      return `${t('content.chatRecord')} ${message.record?.title ?? message.text ?? ''}`.trim()
    case 'call':
      return message.call_video ? t('content.videoCall') : t('content.call')
    default:
      // 多行的消息并成一行
      return (message.text ?? '').replace(/\s+/g, ' ')
  }
}

/** 一条已撤回的消息显示成的一句话。`name` 是发送人显示的名字；是我自己时不用给。 */
export function recalledText(
  message: MessageView,
  name: string | null,
  myId: string,
  t: T,
): string {
  const actor = message.sender_id === myId ? t('event.you') : (name ?? t('event.someone'))
  return t('event.recalled', { actor })
}

/** 会话列表里一条消息显示成的一行字。群里别人发的，前面带上他的名称。 */
export function summarize(
  message: MessageView,
  conversation: ConversationView,
  members: readonly MemberView[] | undefined,
  myId: string,
  t: T,
): string {
  const group = conversation.group !== null
  // 单聊里对方的名字就是会话的名字
  const name = group ? senderName(message, members) : displayName(conversation, t)
  if (message.recalled) return recalledText(message, name, myId, t)
  // 新的群公告：摘要和系统通知里直接是公告的开头
  if (message.kind === 'notice_changed' && message.text) {
    return `${t('content.notice')} ${message.text.replace(/\s+/g, ' ').trim()}`
  }
  if (
    message.kind !== 'text' &&
    message.kind !== 'image' &&
    message.kind !== 'file' &&
    message.kind !== 'voice' &&
    message.kind !== 'chat_record' &&
    message.kind !== 'call'
  ) {
    return eventText(message, members, myId, t)
  }
  // 没接到的电话：摘要和通知里写"[未接来电]"
  if (message.kind === 'call' && callRecordText(message, myId, t).missed) {
    return t('content.missedCall')
  }
  const text = contentLabel(message, t)
  if (!group || message.sender_id === myId) return text
  return name ? `${name}: ${text}` : text
}
