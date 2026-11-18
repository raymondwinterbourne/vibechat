// 什么时候该弹系统通知。这里只有规则，不碰浏览器：弹不弹得出来、怎么弹，由界面那一层去做。

import type { ConversationView, FriendRequestView, MessageView } from '@vibechat/protocol'
import { isNewNotice, mentionsMe } from './chat/conversations'

/**
 * 这条新到的消息要不要弹通知。
 *
 * - 页面在前台时不弹：用户正看着。
 * - 只有别人发的消息才弹；系统提示、撤回、自己在别处发的都不弹。
 * - 免打扰的会话不弹，除非这条消息 @ 了我。
 * - 例外：别人发布或修改了群公告，和 @ 所有人一样，照常弹，免打扰也弹。
 *
 * `conversation` 是它所在的会话；还不知道这个会话时（刚被拉进一个群）传空，按没有免打扰算。
 */
export function shouldNotifyMessage(
  message: MessageView,
  conversation: ConversationView | undefined,
  myId: string,
  foreground: boolean,
): boolean {
  if (foreground) return false
  if (message.recalled) return false
  if (isNewNotice(message, myId)) return true
  // 通话记录：只提醒被叫没接到的（未接来电）
  if (message.kind === 'call') {
    const missed =
      message.call_outcome === 'cancelled' ||
      message.call_outcome === 'missed' ||
      message.call_outcome === 'busy' ||
      message.call_outcome === 'offline'
    if (!missed || message.sender_id === myId) return false
    return !conversation?.muted
  }
  const isMessage =
    message.kind === 'text' ||
    message.kind === 'image' ||
    message.kind === 'file' ||
    message.kind === 'voice' ||
    message.kind === 'chat_record'
  if (!isMessage) return false
  if (message.sender_id === null || message.sender_id === myId) return false
  if (conversation?.muted) return mentionsMe(message, myId)
  return true
}

/** 这条好友申请要不要弹通知：别人刚发给我的、我还没有处理的。 */
export function shouldNotifyRequest(request: FriendRequestView, foreground: boolean): boolean {
  return !foreground && request.direction === 'received' && request.status === 'pending'
}

/** 同一个会话的通知用同一个标识：新的替换旧的，几个标签页同时弹时也只留一条。 */
export function noticeTag(conversationId: string): string {
  return `vc-conversation-${conversationId}`
}

/**
 * 系统通知现在是不是开着。
 * 用户选过就以选的为准；从来没有动过时看平台的默认（浏览器里关，桌面端里开）。
 * 不管怎样，系统那边没有授权就弹不出来，算关。
 */
export function noticesOn(
  choice: 'on' | 'off' | null,
  granted: boolean,
  onByDefault: boolean,
): boolean {
  if (!granted) return false
  return choice === null ? onByDefault : choice === 'on'
}
