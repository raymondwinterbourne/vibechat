// 群聊里进群通话的入口（F10、F11）：标题栏上的"语音通话""视频通话"按钮，和通话进行期间顶上的那一条。
//
// 群里没有通话时，按钮打开选人的对话框，选好了发起；已经有通话时，只留下和它同一种的那个按钮，
// 它和顶上的那一条都是"加入"。通话是语音还是视频在发起时定下来，之后不变。
// 一个人同一时间只能在一个通话里，所以我已经在别的通话里时都不能点。

import { groupCallFull } from '@vibechat/core'
import type { ConversationView, GroupCallView } from '@vibechat/protocol'
import { Phone, Video } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VIDEO_DESKTOP_VERSION } from '../../calls'
import { useLimits } from '../../chat'
import { Button } from '../../components/Button'
import { useDesktopRequirement } from '../../desktopClient'
import { DEVICE_ID } from '../../device'
import {
  useGroupCallController,
  useGroupCalls,
  useGroupCallsAvailable,
  useInAnyCall,
} from '../../groupCalls'
import { useMe } from '../../session'
import { GroupCallPicker } from './GroupCallPicker'

/** 我和这个通话的关系：在这台设备上在里面、在别的设备上在里面，或者不在里面。 */
function useMyPlace(call: GroupCallView | null): 'here' | 'elsewhere' | 'out' {
  const me = useMe()
  const mine = call?.participants.find((entry) => entry.user_id === me.id)
  if (!mine) return 'out'
  return mine.device === DEVICE_ID ? 'here' : 'elsewhere'
}

/**
 * 标题栏上的"语音通话"或"视频通话"：群里没有通话时发起，有通话时加入。
 * 群里已经有通话时，不是它那一种的按钮不显示：不能在语音通话进行的时候另外发起视频通话。
 */
export function GroupCallButton({
  conversation,
  video,
}: {
  conversation: ConversationView
  video: boolean
}) {
  const { t } = useTranslation('chats')
  const controller = useGroupCallController()
  const calls = useGroupCalls()
  const available = useGroupCallsAvailable()
  const inCall = useInAnyCall()
  const [picking, setPicking] = useState(false)
  const call = calls.calls[conversation.id] ?? null
  const place = useMyPlace(call)
  const limit = useLimits().group_call_max
  const desktopAllows = useDesktopRequirement()
  const group = conversation.group
  const gone = !group || group.left || group.dissolved

  const reason = !available
    ? t('groupCall.unavailable')
    : gone
      ? t('groupCall.notMember')
      : place !== 'out'
        ? t('groupCall.alreadyIn')
        : inCall
          ? t('groupCall.busy')
          : call && groupCallFull(call)
            ? t('groupCall.full')
            : null
  if (call && call.video !== video) return null
  const label = call
    ? t(video ? 'groupCall.joinVideoCall' : 'groupCall.joinCall')
    : t(video ? 'header.videoCall' : 'header.voiceCall')
  const Icon = video ? Video : Phone
  return (
    <>
      <span title={reason ?? label} className="flex">
        <button
          type="button"
          data-testid={video ? 'group-video-call' : 'group-voice-call'}
          disabled={reason !== null}
          aria-label={label}
          onClick={() => {
            // 从这里加入不开摄像头，进去之后自己开
            if (call) void controller.join(call.id)
            // 旧版本的桌面端不放行摄像头：先说明要更新
            else if (!video || desktopAllows(label, VIDEO_DESKTOP_VERSION)) setPicking(true)
          }}
          className="grid size-11 place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent md:size-9"
        >
          <Icon size={20} strokeWidth={1.5} aria-hidden />
        </button>
      </span>
      <GroupCallPicker
        open={picking}
        conversationId={conversation.id}
        mode="start"
        video={video}
        limit={limit}
        onClose={() => setPicking(false)}
        onConfirm={(userIds) => {
          setPicking(false)
          void controller.start(conversation.id, userIds, video)
        }}
      />
    </>
  )
}

/** 群里有通话在进行时，会话顶上的一条：几个人在通话，我可以加入。 */
export function GroupCallBanner({ conversation }: { conversation: ConversationView }) {
  const { t } = useTranslation('chats')
  const controller = useGroupCallController()
  const calls = useGroupCalls()
  const inCall = useInAnyCall()
  const call = calls.calls[conversation.id] ?? null
  const place = useMyPlace(call)
  const group = conversation.group
  // 我已经不在这个群里了（或者群解散了）：这里知道的通话可能是旧的，不显示
  if (!call || !group || group.left || group.dissolved) return null
  const count = call.participants.length
  const full = groupCallFull(call)
  return (
    <div
      data-testid="group-call-banner"
      data-place={place}
      data-video={call.video ? '' : undefined}
      role="status"
      className="flex flex-none items-center gap-2 border-border border-b bg-surface px-4 py-2 text-[13px]"
    >
      {call.video ? (
        <Video size={16} strokeWidth={1.75} aria-hidden className="flex-none text-accent-fg" />
      ) : (
        <Phone size={16} strokeWidth={1.75} aria-hidden className="flex-none text-accent-fg" />
      )}
      <span className="min-w-0 flex-1 truncate">
        {place === 'here'
          ? t('groupCall.inHere', { count })
          : place === 'elsewhere'
            ? t('groupCall.elsewhere', { count })
            : t(call.video ? 'groupCall.ongoingVideo' : 'groupCall.ongoing', { count })}
      </span>
      {place === 'out' &&
        (full ? (
          <span data-testid="group-call-full" className="flex-none text-fg-3">
            {t('groupCall.full')}
          </span>
        ) : (
          <Button
            variant="primary"
            data-testid="group-call-join"
            className="flex-none"
            disabled={inCall}
            title={inCall ? t('groupCall.busy') : undefined}
            onClick={() => void controller.join(call.id)}
          >
            {t('groupCall.join')}
          </Button>
        ))}
    </div>
  )
}
