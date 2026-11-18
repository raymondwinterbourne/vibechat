// 群通话的界面（F10）：别人邀请我时的卡片和铃声，我在通话里时的界面（谁在里面、谁在说话、
// 谁静音了，静音、离开、再邀请），缩小后的小条。群聊里进通话的入口在 pages/chats/GroupCallEntry.tsx。
//
// 声音不在这里放：进了通话之后，别人的声音由声音的连接（core 的 room.ts）自己接到页面上。
//
// 视频通话（F11）：通话界面换成一格一格的画面，点谁放大谁；没开摄像头的人那一格是头像。
// 每一路画面收清楚的还是小的由 core 定，这里只告诉它屏幕上显示着谁、通话是不是缩小了。
//
// 共享屏幕（F12）：语音通话、视频通话里都可以，电脑上才有按钮。别人共享的屏幕在通话界面里也是一格，
// 有人开始共享时它自动成为放大的那一格；语音通话这时也用一格一格的界面（人那几格是头像）。
// 我自己在共享时通话界面自动缩小，屏幕上方有一条"你正在共享屏幕 · 停止共享"。

import {
  canShareScreen,
  type GroupCallSnapshot,
  inGroupCall,
  memberName,
  SCREEN_TILE,
} from '@vibechat/core'
import type { ConversationView, GroupCallView, MemberView } from '@vibechat/protocol'
import {
  Maximize,
  Maximize2,
  Mic,
  MicOff,
  Minimize,
  Minimize2,
  MonitorUp,
  MonitorX,
  Phone,
  PhoneOff,
  SwitchCamera,
  UserPlus,
  Video,
  VideoOff,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../App'
import { SCREEN_DESKTOP_VERSION, useCall } from '../../calls'
import { useChatStore, useConversation, useMembers } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { useDesktopRequirement } from '../../desktopClient'
import { useGroupCallController, useGroupCalls } from '../../groupCalls'
import { inForeground, useNoticesOn } from '../../notifications'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { ConversationAvatar } from '../chats/ConversationAvatar'
import { GroupCallPicker } from '../chats/GroupCallPicker'
import { displayName } from '../chats/text'
import {
  MicrophoneProblemDialog,
  RoundButton,
  useElapsed,
  useFullScreen,
  useSeveralCameras,
  ZoomableScreen,
} from './CallLayer'
import { playTone } from './tones'

export function GroupCallLayer() {
  const { t } = useTranslation('chats')
  const { t: tErrors } = useTranslation('errors')
  const calls = useGroupCalls()
  const controller = useGroupCallController()
  const directPhase = useCall().phase
  const inDirectCall = directPhase !== 'idle' && directPhase !== 'ended'
  const [minimized, setMinimized] = useState(false)

  // 正在邀请我的通话。我在一对一通话里时不打扰（服务端本来也不会让正在通话的人响铃）
  const ringing = inDirectCall ? null : controller.ringing()
  const current = calls.phase === 'idle' ? null : calls.current
  const featured = useFeatured(calls)
  const me = useMe()
  // 我正在看谁共享的屏幕
  const watching = current?.sharing && current.sharing !== me.id ? current.sharing : null

  // 我开始共享了：通话界面让开，好操作要给别人看的东西
  const sharing = calls.sharing
  useEffect(() => {
    if (sharing) setMinimized(true)
  }, [sharing])

  // 每个通话从完整的界面开始
  const currentId = current?.id
  useEffect(() => {
    if (currentId) setMinimized(false)
  }, [currentId])

  // 操作没成功、我不是自己离开的：提示一下
  const { error, closed } = calls
  useEffect(() => {
    if (!error && !closed) return
    if (error) toast.error(tErrors(error))
    else if (closed) toast.success(t(`groupCall.closed.${closed}`))
    controller.clearProblem()
  }, [error, closed, controller, t, tErrors])

  return (
    <>
      <RingAlerts call={ringing} />
      <MicrophoneProblemDialog
        problem={calls.microphone}
        onClose={() => controller.clearProblem()}
        testId="group-call-microphone-problem"
      />
      <CameraProblemDialog
        problem={calls.microphone === null ? calls.cameraProblem : null}
        onClose={() => controller.clearProblem()}
      />
      <ScreenProblemDialog
        problem={
          calls.microphone === null && calls.cameraProblem === null ? calls.screenProblem : null
        }
        onClose={() => controller.clearProblem()}
      />
      {ringing && <InvitationCard call={ringing} />}
      {current && calls.sharing && <SharingBar />}
      {current &&
        (minimized ? (
          // 有人在共享屏幕、有别人开着摄像头时是带画面的小窗，否则是小条
          watching ? (
            <MiniVideo
              calls={calls}
              call={current}
              screenOf={watching}
              onExpand={() => setMinimized(false)}
            />
          ) : current.video && featured ? (
            <MiniVideo
              calls={calls}
              call={current}
              featured={featured}
              onExpand={() => setMinimized(false)}
            />
          ) : (
            <MiniBar calls={calls} call={current} onExpand={() => setMinimized(false)} />
          )
        ) : current.video || watching ? (
          // 语音通话里有人共享屏幕时也用一格一格的界面：屏幕占大块，人那几格是头像
          <VideoCallScreen calls={calls} call={current} onMinimize={() => setMinimized(true)} />
        ) : (
          <CallScreen calls={calls} call={current} onMinimize={() => setMinimized(true)} />
        ))}
    </>
  )
}

/** 这个群的会话和成员名单：没有的话取一次。邀请我的群可能不在我的列表里（被我移除了）。 */
function useGroup(conversationId: string): {
  conversation: ConversationView | undefined
  members: MemberView[] | undefined
} {
  const store = useChatStore()
  const conversation = useConversation(conversationId)
  const members = useMembers(conversationId)
  useEffect(() => {
    store.ensureConversation(conversationId).catch(() => {})
    store.loadMembers(conversationId).catch(() => {})
  }, [conversationId, store])
  return { conversation, members }
}

/** 一个成员在界面上的名字。名单还没取回来、他已经不在名单里时为空。 */
function nameIn(members: MemberView[] | undefined, userId: string): string | null {
  const member = members?.find((candidate) => candidate.user.id === userId)
  return member ? memberName(member) : null
}

/**
 * 被邀请时的提醒：和来电一样的铃声；页面不在前台就弹系统通知，桌面端还把窗口带到前面。
 * 加入、忽略，或者邀请到时间不再响，都停下。
 */
function RingAlerts({ call }: { call: GroupCallView | null }) {
  const { t } = useTranslation('chats')
  const platform = usePlatform()
  const noticesOn = useNoticesOn()
  const conversation = useConversation(call?.conversation_id ?? '')
  const ringing = call?.id ?? null
  const video = call?.video ?? false
  const name = conversation ? displayName(conversation, t) : null

  useEffect(() => {
    if (!ringing) return
    return playTone('ring')
  }, [ringing])

  const latest = useRef({ name, noticesOn, t, video })
  latest.current = { name, noticesOn, t, video }
  useEffect(() => {
    if (!ringing) return
    platform.callAlert(true)
    let notice: Notification | null = null
    const { name, noticesOn, t, video } = latest.current
    if (noticesOn && !inForeground() && typeof Notification !== 'undefined') {
      notice = new Notification(name ?? t(video ? 'groupCall.videoLabel' : 'groupCall.label'), {
        body: t(video ? 'groupCall.invitesYouVideo' : 'groupCall.invitesYou'),
        tag: `vc-group-call-${ringing}`,
        requireInteraction: true,
      })
      notice.onclick = () => {
        platform.showWindow()
        notice?.close()
      }
    }
    return () => {
      platform.callAlert(false)
      notice?.close()
    }
  }, [ringing, platform])

  // 测试和排查时看得到是不是在响铃
  return <span hidden data-testid="group-call-tone" data-tone={ringing ? 'ring' : ''} />
}

/** 邀请：不遮挡页面的卡片，电脑上在右上角，手机上在顶部。 */
function InvitationCard({ call }: { call: GroupCallView }) {
  const { t } = useTranslation('chats')
  const me = useMe()
  const controller = useGroupCallController()
  const { conversation, members } = useGroup(call.conversation_id)
  const by = call.ringing.find((invite) => invite.user_id === me.id)?.by
  const inviter = by ? nameIn(members, by) : null
  const label = t(call.video ? 'groupCall.videoLabel' : 'groupCall.label')
  return (
    <section
      data-testid="group-call-incoming"
      data-video={call.video ? '' : undefined}
      aria-label={label}
      className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-40 flex items-center gap-3 rounded-card border border-border bg-bg p-3 shadow-float md:inset-x-auto md:right-4 md:w-[360px]"
    >
      {conversation && <ConversationAvatar conversation={conversation} size={44} />}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {conversation ? displayName(conversation, t) : label}
        </p>
        <p className="text-[13px] text-fg-2">
          {inviter
            ? t(call.video ? 'groupCall.invitesVideo' : 'groupCall.invites', { name: inviter })
            : t(call.video ? 'groupCall.invitesYouVideo' : 'groupCall.invitesYou')}
        </p>
      </div>
      <button
        type="button"
        data-testid="group-call-ignore"
        aria-label={t('groupCall.ignore')}
        title={t('groupCall.ignore')}
        onClick={() => void controller.decline(call.id)}
        className="grid size-11 flex-none place-items-center rounded-full bg-surface text-fg hover:bg-hover"
      >
        <PhoneOff size={20} />
      </button>
      <button
        type="button"
        data-testid="group-call-accept"
        aria-label={t('groupCall.join')}
        title={t('groupCall.join')}
        // 视频通话从卡片加入时摄像头是开着的（F11 的 Q10）
        onClick={() => void controller.join(call.id, { camera: call.video })}
        className="grid size-11 flex-none place-items-center rounded-full bg-accent text-on-accent hover:opacity-90"
      >
        {call.video ? <Video size={20} /> : <Phone size={20} />}
      </button>
    </section>
  )
}

/** 界面上那一行状态：正在加入、网络不稳定，或者我在通话里多久了。 */
function useStatus(calls: GroupCallSnapshot): { text: string; warning: boolean } {
  const { t } = useTranslation('chats')
  const elapsed = useElapsed(calls.phase === 'active' ? calls.connectedAt : null)
  if (calls.phase === 'joining') return { text: t('groupCall.joining'), warning: false }
  if (calls.phase === 'reconnecting') return { text: t('call.unstable'), warning: true }
  return { text: elapsed, warning: false }
}

/** 通话中：电脑上盖住内容区，手机上占满整个屏幕。 */
function CallScreen({
  calls,
  call,
  onMinimize,
}: {
  calls: GroupCallSnapshot
  call: GroupCallView
  onMinimize: () => void
}) {
  const { t } = useTranslation('chats')
  const me = useMe()
  const controller = useGroupCallController()
  const { conversation, members } = useGroup(call.conversation_id)
  const status = useStatus(calls)
  const [inviting, setInviting] = useState(false)
  const joined = calls.phase !== 'joining'
  const people = call.participants.length
  return (
    <section
      data-testid="group-call-screen"
      data-phase={calls.phase}
      aria-label={t('groupCall.label')}
      className="fixed inset-0 z-30 flex flex-col items-center justify-between gap-6 bg-bg px-4 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] md:left-14 short:left-0! short:gap-2 short:pt-2 short:pb-2"
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <h2 className="max-w-[80vw] truncate font-medium text-[20px]">
          {conversation ? displayName(conversation, t) : t('groupCall.label')}
        </h2>
        <p
          data-testid="group-call-status"
          aria-live="polite"
          className={`text-[15px] ${status.warning ? 'text-danger' : 'text-fg-2'}`}
        >
          {[t('groupCall.people', { count: people }), status.text].filter(Boolean).join(' · ')}
        </p>
      </div>

      <ul
        data-testid="group-call-members"
        className="flex min-h-0 max-w-[560px] flex-1 flex-wrap content-center items-start justify-center gap-x-6 gap-y-5 overflow-y-auto"
      >
        {call.participants.map((entry) => {
          const mine = entry.user_id === me.id
          const member = members?.find((candidate) => candidate.user.id === entry.user_id)
          const speaking = calls.speaking.includes(entry.user_id)
          const silent = mine ? calls.muted : calls.silent.includes(entry.user_id)
          const name = member ? memberName(member) : ''
          return (
            <li
              key={entry.user_id}
              data-testid="group-call-member"
              data-user={entry.user_id}
              data-me={mine ? '' : undefined}
              data-speaking={speaking ? '' : undefined}
              data-muted={silent ? '' : undefined}
              className="flex w-24 flex-col items-center gap-2"
            >
              <span
                className={`relative rounded-card transition-shadow duration-150 ${
                  speaking ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''
                }`}
              >
                {member ? (
                  <Avatar user={member.user} size={72} />
                ) : (
                  <span className="block size-[72px] rounded-card bg-surface" />
                )}
                {silent && (
                  <span
                    role="img"
                    aria-label={t('groupCall.muted')}
                    className="absolute -right-1 -bottom-1 grid size-6 place-items-center rounded-full bg-surface text-fg-2 shadow-float"
                  >
                    <MicOff size={14} aria-hidden />
                  </span>
                )}
              </span>
              <span className="w-full truncate text-center text-[13px]">
                {mine ? t('groupCall.me', { name }) : name}
              </span>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col items-center gap-4">
        {joined && calls.audioBlocked && (
          <Button
            variant="secondary"
            data-testid="group-call-start-audio"
            onClick={() => void controller.startAudio()}
          >
            {t('groupCall.startAudio')}
          </Button>
        )}
        <div className="flex items-end gap-6 md:gap-8">
          {joined && (
            <RoundButton
              testId="group-call-mute"
              label={calls.muted ? t('call.unmute') : t('call.mute')}
              pressed={calls.muted}
              onClick={() => void controller.toggleMute()}
            >
              {calls.muted ? <MicOff size={24} /> : <Mic size={24} />}
            </RoundButton>
          )}
          <RoundButton
            testId="group-call-leave"
            label={t('groupCall.leave')}
            danger
            onClick={() => void controller.leave()}
          >
            <PhoneOff size={26} />
          </RoundButton>
          {joined && <ShareButton calls={calls} call={call} members={members} />}
          {joined && (
            <RoundButton
              testId="group-call-invite"
              label={t('groupCall.invite')}
              onClick={() => setInviting(true)}
            >
              <UserPlus size={24} />
            </RoundButton>
          )}
          {joined && (
            <RoundButton
              testId="group-call-minimize"
              label={t('call.minimize')}
              onClick={onMinimize}
            >
              <Minimize2 size={24} />
            </RoundButton>
          )}
        </div>
      </div>

      <GroupCallPicker
        open={inviting}
        conversationId={call.conversation_id}
        mode="invite"
        exclude={call.participants.map((entry) => entry.user_id)}
        onClose={() => setInviting(false)}
        onConfirm={(userIds) => {
          setInviting(false)
          void controller.invite(userIds)
        }}
      />
    </section>
  )
}

/** 摄像头用不了：说明原因。通话照常进行，只是别人看不到我。 */
function CameraProblemDialog({
  problem,
  onClose,
}: {
  problem: GroupCallSnapshot['cameraProblem']
  onClose: () => void
}) {
  const { t } = useTranslation('chats')
  const platform = usePlatform()
  const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent)
  const key =
    problem === 'denied'
      ? platform.name === 'desktop'
        ? 'deniedDesktop'
        : safari
          ? 'deniedSafari'
          : 'denied'
      : problem
  return (
    <Dialog
      open={problem !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t('call.camera.title')}
    >
      <p data-testid="group-call-camera-problem" className="text-fg-2">
        {key ? `${t(`call.camera.${key}`)} ${t('groupCall.cameraGoOn')}` : ''}
      </p>
      <Button variant="primary" className="self-end" onClick={onClose}>
        {t('call.microphone.ok')}
      </Button>
    </Dialog>
  )
}

/**
 * 缩小之后小窗里显示谁：正在说话、开着摄像头的那个人；他没开摄像头，就还是上一个，
 * 再不然是随便一个开着摄像头的人。没有别人开着摄像头时为空（这时用小条）。
 */
function useFeatured(calls: GroupCallSnapshot): string | null {
  const me = useMe()
  const last = useRef<string | null>(null)
  const others = calls.cameras.filter((user) => user !== me.id)
  const speaking = calls.speaking.find((user) => others.includes(user))
  const featured =
    speaking ??
    (last.current !== null && others.includes(last.current) ? last.current : (others[0] ?? null))
  useEffect(() => {
    last.current = featured
  }, [featured])
  return featured
}

/** 一路画面。画面换了（开、关、换了档位重新订阅）就跟着换。 */
function Picture({
  track,
  mirror = false,
  fit = 'cover',
  className = '',
}: {
  track: MediaStreamTrack | null
  /** 自己朝着自己的摄像头：左右翻转，像照镜子。 */
  mirror?: boolean
  /** 铺满（裁掉边）还是完整显示（留黑边）。 */
  fit?: 'cover' | 'contain'
  className?: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const element = video.current
    if (!element) return
    element.srcObject = track ? new MediaStream([track]) : null
    if (track) void element.play().catch(() => {})
    return () => {
      element.srcObject = null
    }
  }, [track])
  return (
    <video
      ref={video}
      data-testid="group-call-picture"
      autoPlay
      playsInline
      muted
      className={`bg-black ${fit === 'contain' ? 'object-contain' : 'object-cover'} ${mirror ? '-scale-x-100' : ''} ${className}`}
    />
  )
}

/** 屏幕拿不到：说明原因和打开方法。用户自己取消的不会到这里。通话照常进行。 */
function ScreenProblemDialog({
  problem,
  onClose,
}: {
  problem: GroupCallSnapshot['screenProblem']
  onClose: () => void
}) {
  const { t } = useTranslation('chats')
  const platform = usePlatform()
  const key = problem === 'denied' && platform.name === 'desktop' ? 'deniedDesktop' : problem
  return (
    <Dialog
      open={problem !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t('call.screenProblem.title')}
    >
      <p data-testid="group-call-screen-problem" className="text-fg-2">
        {key ? `${t(`call.screenProblem.${key}`)} ${t('call.screenProblem.goOn')}` : ''}
      </p>
      <Button variant="primary" className="self-end" onClick={onClose}>
        {t('call.microphone.ok')}
      </Button>
    </Dialog>
  )
}

/** 我正在共享屏幕：屏幕上方的一条，随时可以停。通话界面这时是缩小着的。 */
function SharingBar() {
  const { t } = useTranslation('chats')
  const controller = useGroupCallController()
  const sent = useScreenStats('sent')
  return (
    <div className="fixed top-3 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-1">
      <div
        data-testid="group-call-sharing-bar"
        role="status"
        className="flex items-center gap-3 rounded-full bg-accent py-1.5 pr-1.5 pl-4 text-on-accent shadow-float"
      >
        <MonitorUp size={16} aria-hidden />
        <span className="whitespace-nowrap text-[14px]">{t('call.youAreSharing')}</span>
        <button
          type="button"
          data-testid="group-call-stop-sharing"
          onClick={() => void controller.stopSharing()}
          className="whitespace-nowrap rounded-full bg-on-accent px-3 py-1 font-medium text-[13px] text-accent hover:opacity-90"
        >
          {t('call.stopSharing')}
        </button>
      </div>
      {sent && (
        <p
          data-testid="group-call-sent"
          className="whitespace-nowrap rounded-full bg-black/60 px-3 py-0.5 text-[12px] text-white tabular-nums"
        >
          {sent}
        </p>
      )}
    </div>
  )
}

/** 多久量一次屏幕这一路。 */
const SCREEN_STATS_EVERY_MS = 2000

/**
 * 屏幕这一路的诊断小字（T14，和一对一共享屏幕的那一行同一个意思）：字看不清时判断是哪个原因。
 * 共享的人看发出去的：屏幕多大、发出去多大、帧率、码率、受什么限制、浏览器接受了"清晰度优先"没有；
 * 看的人看收到的：多大、帧率、码率。还没有数时为空。
 */
function useScreenStats(side: 'sent' | 'received'): string | null {
  const { t } = useTranslation('chats')
  const controller = useGroupCallController()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const size = (item: { width: number; height: number }) => `${item.width}×${item.height}`
    const rate = (kbps: number | null) =>
      kbps === null ? null : kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`
    const measure = async () => {
      const stats = await controller.screenStats()
      if (!live) return
      const parts: (string | null)[] = []
      if (side === 'sent' && stats.sent) {
        const sent = stats.sent
        if (sent.capturedWidth > 0) {
          parts.push(
            t('call.sent.captured', {
              size: size({ width: sent.capturedWidth, height: sent.capturedHeight }),
            }),
          )
        }
        if (sent.width > 0) {
          parts.push(t('call.sent.sending', { size: size(sent) }), `${sent.fps} fps`)
          parts.push(rate(sent.kbps))
        }
        if (
          sent.limitedBy === 'bandwidth' ||
          sent.limitedBy === 'cpu' ||
          sent.limitedBy === 'other'
        ) {
          parts.push(t(`call.sent.limited_${sent.limitedBy}`))
        }
        if (sent.resolutionFirst !== null) {
          parts.push(
            sent.resolutionFirst
              ? t('call.sent.resolutionFirst')
              : t('call.sent.noResolutionFirst'),
          )
        }
      }
      if (side === 'received' && stats.received && stats.received.width > 0) {
        const received = stats.received
        parts.push(size(received), `${received.fps} fps`, rate(received.kbps))
      }
      const shown = parts.filter((part): part is string => part !== null)
      setText(shown.length > 0 ? shown.join(' · ') : null)
    }
    void measure()
    const timer = window.setInterval(() => void measure(), SCREEN_STATS_EVERY_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [controller, side, t])
  return text
}

/**
 * "共享屏幕"按钮。手机浏览器不能共享，没有这个按钮。同一时间只有一个人共享：
 * 别人在共享时不能点，写着是谁。
 */
function ShareButton({
  calls,
  call,
  members,
}: {
  calls: GroupCallSnapshot
  call: GroupCallView
  members: MemberView[] | undefined
}) {
  const { t } = useTranslation('chats')
  const me = useMe()
  const controller = useGroupCallController()
  const desktopAllows = useDesktopRequirement()
  if (!canShareScreen()) return null
  if (calls.sharing) {
    return (
      <RoundButton
        testId="group-call-share"
        label={t('call.stopSharing')}
        pressed
        onClick={() => void controller.stopSharing()}
      >
        <MonitorX size={24} />
      </RoundButton>
    )
  }
  const other = call.sharing !== null && call.sharing !== me.id ? call.sharing : null
  return (
    <RoundButton
      testId="group-call-share"
      label={
        other
          ? t('groupCall.sharingBy', { name: nameIn(members, other) ?? '' })
          : t('call.shareScreen')
      }
      disabled={other !== null}
      onClick={() => {
        // 旧版本的桌面端不放行共享屏幕：先说明要更新
        if (!desktopAllows(t('call.shareScreen'), SCREEN_DESKTOP_VERSION)) return
        // 浏览器要求在点击里直接弹出选择框：这里不能先等别的
        void controller.shareScreen()
      }}
    >
      <MonitorUp size={24} />
    </RoundButton>
  )
}

/**
 * 别人共享的屏幕，在通话界面里也是一格。放大着的时候完整显示，可以全屏、放大、拖动、按原始大小看；
 * 排在旁边、格子里的时候是一小块，点它放大。
 */
function ScreenTile({
  sharer,
  name,
  size,
}: {
  sharer: string
  name: string
  size: 'grid' | 'big' | 'strip'
}) {
  const { t } = useTranslation('chats')
  const controller = useGroupCallController()
  const track = controller.screenTrack(sharer)
  const stream = useMemo(() => (track ? new MediaStream([track]) : null), [track])
  const box = useRef<HTMLLIElement>(null)
  const fullScreen = useFullScreen(box)
  const big = size === 'big'
  const label = t('groupCall.screenOf', { name })
  const paused = useGroupCalls().screenPaused
  // 诊断小字只在放大着的时候量：小的一格里放不下，也不用为它每两秒问一次
  const received = useScreenStats('received')
  return (
    <li
      ref={box}
      data-testid="group-call-screen-tile"
      data-sharer={sharer}
      data-enlarged={big ? '' : undefined}
      data-full-screen={big && fullScreen.pseudo ? '' : undefined}
      className={
        big && fullScreen.pseudo
          ? // 页面内铺满（iPhone 上的"全屏"）：盖住整个页面
            'fixed inset-0 z-50 overflow-hidden bg-black'
          : `relative min-h-0 overflow-hidden rounded-card bg-black ${
              size === 'strip'
                ? 'aspect-video h-full flex-none short:aspect-video short:h-auto short:w-full'
                : 'size-full'
            }`
      }
    >
      {big ? (
        <ZoomableScreen stream={stream} prefix="group-call" inTile />
      ) : (
        <Picture track={track} fit="contain" className="absolute inset-0 size-full" />
      )}
      <span className="pointer-events-none absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 rounded-control bg-black/55 px-1.5 py-0.5 text-[12px] text-white">
        <MonitorUp size={12} aria-hidden className="flex-none" />
        <span className="truncate">{label}</span>
        {big && received && (
          <span
            data-testid="group-call-screen-received"
            className="flex-none tabular-nums opacity-80"
          >
            {received}
          </span>
        )}
      </span>
      {/* 我这边的网络带不动，屏幕这一路被暂停了：声音照常，好了自己恢复 */}
      {paused && size !== 'strip' && (
        <span
          data-testid="group-call-screen-paused"
          role="status"
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-3 text-center text-[13px] text-white"
        >
          <span className="rounded-control bg-black/60 px-2 py-1">
            {t('groupCall.picturePaused')}
          </span>
        </span>
      )}
      {big ? (
        <div
          className={
            fullScreen.pseudo
              ? 'absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] flex gap-2'
              : 'absolute top-2 left-2 flex gap-2'
          }
        >
          <button
            type="button"
            data-testid="group-call-enlarge"
            aria-pressed
            hidden={fullScreen.pseudo}
            onClick={() => controller.enlarge(null)}
            // 按下按钮不算在画面上拖动
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="rounded-full bg-black/50 px-3 py-1.5 text-[13px] text-white hover:bg-black/70 max-md:min-h-11 short:min-h-11"
          >
            {t('groupCall.backToGrid')}
          </button>
          {fullScreen.supported && (
            <button
              data-full-screen-toggle
              type="button"
              data-testid="group-call-fullscreen"
              aria-label={fullScreen.full ? t('call.exitFullScreen') : t('call.fullScreen')}
              title={fullScreen.full ? t('call.exitFullScreen') : t('call.fullScreen')}
              onClick={fullScreen.toggle}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              className="grid size-8 place-items-center rounded-full bg-black/50 text-white hover:bg-black/70 max-md:size-11 short:size-11"
            >
              {fullScreen.full ? <Minimize size={16} /> : <Maximize size={16} />}
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          data-testid="group-call-enlarge"
          aria-pressed={false}
          aria-label={t('groupCall.enlargeScreen', { name })}
          onClick={() => controller.enlarge(SCREEN_TILE)}
          className="absolute inset-0 rounded-card focus-visible:outline-2 focus-visible:outline-accent"
        />
      )}
    </li>
  )
}

/** 格子怎么排：人少时格子大，人多了分成两三列。手机上最多两列。 */
function gridColumns(count: number): string {
  if (count <= 1) return 'grid-cols-1'
  if (count === 2) return 'grid-cols-1 md:grid-cols-2'
  if (count <= 4) return 'grid-cols-2'
  return 'grid-cols-2 md:grid-cols-3'
}

/** 视频通话里的一格：开着摄像头的是画面，没开的是头像。点它放大，再点回到格子。 */
function Tile({
  calls,
  userId,
  member,
  size,
  enlarged,
}: {
  calls: GroupCallSnapshot
  userId: string
  member: MemberView | undefined
  /** 格子里的、放大的，还是放大时排在旁边的小的。 */
  size: 'grid' | 'big' | 'strip'
  enlarged: boolean
}) {
  const { t } = useTranslation('chats')
  const me = useMe()
  const controller = useGroupCallController()
  const mine = userId === me.id
  const speaking = calls.speaking.includes(userId)
  const silent = mine ? calls.muted : calls.silent.includes(userId)
  const camera = calls.cameras.includes(userId)
  // 我这边的网络带不动，媒体转发服务把这一路暂停了：显示头像，写明原因，好了自己会回来
  const paused = calls.paused.includes(userId)
  // 说了"不要"的那一路（滚到屏幕外面了）没有画面，显示头像
  const track = camera && !paused ? controller.videoTrack(userId) : null
  const name = member ? memberName(member) : ''
  const shownName = mine ? t('groupCall.me', { name }) : name
  return (
    <li
      data-testid="group-call-member"
      data-user={userId}
      data-me={mine ? '' : undefined}
      data-speaking={speaking ? '' : undefined}
      data-muted={silent ? '' : undefined}
      data-camera={camera ? '' : undefined}
      data-paused={paused ? '' : undefined}
      data-enlarged={enlarged ? '' : undefined}
      className={`relative min-h-0 overflow-hidden rounded-card bg-surface ${
        size === 'strip' ? 'aspect-video h-full flex-none short:h-auto short:w-full' : 'size-full'
      } ${speaking ? 'ring-2 ring-accent ring-inset' : ''}`}
    >
      {track ? (
        <Picture
          track={track}
          mirror={mine && calls.facing === 'user'}
          // 放大的那一格要看全，不裁；格子里的铺满，排得整齐
          fit={size === 'big' ? 'contain' : 'cover'}
          className="absolute inset-0 size-full"
        />
      ) : (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          {member ? (
            <Avatar user={member.user} size={size === 'strip' ? 40 : 72} />
          ) : (
            <span className="block size-[72px] rounded-card bg-hover" />
          )}
          {paused && size !== 'strip' && (
            <span
              data-testid="group-call-paused"
              className="px-2 text-center text-[12px] text-fg-2"
            >
              {t('groupCall.picturePaused')}
            </span>
          )}
        </span>
      )}
      <span className="absolute bottom-1 left-1 flex max-w-[calc(100%-0.5rem)] items-center gap-1 rounded-control bg-black/55 px-1.5 py-0.5 text-[12px] text-white">
        {silent && (
          <span role="img" aria-label={t('groupCall.muted')} className="flex-none">
            <MicOff size={12} aria-hidden />
          </span>
        )}
        <span className="truncate">{shownName}</span>
      </span>
      {/* 整格都可以点 */}
      <button
        type="button"
        data-testid="group-call-enlarge"
        aria-pressed={enlarged}
        aria-label={enlarged ? t('groupCall.backToGrid') : t('groupCall.enlarge', { name })}
        onClick={() => controller.enlarge(enlarged ? null : userId)}
        className="absolute inset-0 rounded-card focus-visible:outline-2 focus-visible:outline-accent"
      />
    </li>
  )
}

/** 视频通话中：一格一格的画面。电脑上盖住内容区，手机上占满整个屏幕。 */
function VideoCallScreen({
  calls,
  call,
  onMinimize,
}: {
  calls: GroupCallSnapshot
  call: GroupCallView
  onMinimize: () => void
}) {
  const { t } = useTranslation('chats')
  const controller = useGroupCallController()
  const { conversation, members } = useGroup(call.conversation_id)
  const status = useStatus(calls)
  const [inviting, setInviting] = useState(false)
  const severalCameras = useSeveralCameras(calls.camera)
  const joined = calls.phase !== 'joining'
  const people = call.participants.length
  const me = useMe()
  const users = call.participants.map((entry) => entry.user_id)
  // 别人共享的屏幕也是一格，排在最前面
  const sharer = call.sharing !== null && call.sharing !== me.id ? call.sharing : null
  const items = sharer ? [SCREEN_TILE, ...users] : users
  // 放大着的那一格还在才算
  const enlarged = calls.enlarged !== null && items.includes(calls.enlarged) ? calls.enlarged : null
  const rest = items.filter((item) => item !== enlarged)
  const memberOf = (user: string) => members?.find((candidate) => candidate.user.id === user)
  /** 一格：人，或者别人共享的屏幕。 */
  const tile = (item: string, size: 'grid' | 'big' | 'strip') =>
    item === SCREEN_TILE && sharer ? (
      <ScreenTile key={item} sharer={sharer} name={nameIn(members, sharer) ?? ''} size={size} />
    ) : (
      <Tile
        key={item}
        calls={calls}
        userId={item}
        member={memberOf(item)}
        size={size}
        enlarged={size === 'big'}
      />
    )

  // 告诉通话的状态屏幕上显示着哪几格：滚到外面的那些，画面不用收
  const tiles = useRef<HTMLDivElement>(null)
  const layout = `${enlarged ?? ''}|${items.join(',')}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: 格子重新排了就重新看一遍
  useEffect(() => {
    const root = tiles.current
    if (!root || typeof IntersectionObserver === 'undefined') {
      controller.showing(null, false)
      return
    }
    const shown = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const user = (entry.target as HTMLElement).dataset.user
          if (!user) continue
          if (entry.isIntersecting) shown.add(user)
          else shown.delete(user)
        }
        controller.showing([...shown], false)
      },
      { threshold: 0.1 },
    )
    for (const tile of root.querySelectorAll<HTMLElement>('[data-user]')) observer.observe(tile)
    return () => observer.disconnect()
  }, [controller, layout])

  const iconButton =
    'grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg'
  return (
    <section
      data-testid="group-call-screen"
      data-phase={calls.phase}
      data-video={call.video ? '' : undefined}
      data-tiles=""
      aria-label={t(call.video ? 'groupCall.videoLabel' : 'groupCall.label')}
      // 矮屏幕（横过来的手机，F12 第 11 章）：盖住导航栏；左边是画面，占满整个高度，
      // 右边一条窄栏，从上到下是缩小、邀请，排在旁边的人，按钮
      className="fixed inset-0 z-30 flex flex-col items-center gap-3 bg-bg px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] md:left-14 short:left-0! short:grid short:grid-cols-[minmax(0,1fr)_7.5rem] short:grid-rows-[auto_minmax(0,1fr)_auto] short:items-stretch short:gap-2 short:pt-2 short:pr-[max(0.5rem,env(safe-area-inset-right))] short:pb-2 short:pl-[max(0.5rem,env(safe-area-inset-left))]"
    >
      <div className="flex w-full max-w-[1100px] flex-none items-center gap-2 short:col-start-2 short:row-start-1 short:flex-wrap short:justify-between short:gap-0">
        {joined ? (
          <button
            type="button"
            data-testid="group-call-minimize"
            aria-label={t('call.minimize')}
            title={t('call.minimize')}
            onClick={onMinimize}
            className={iconButton}
          >
            <Minimize2 size={20} aria-hidden />
          </button>
        ) : (
          <span className="size-11 flex-none" />
        )}
        <div className="flex min-w-0 flex-1 flex-col items-center text-center short:order-last short:w-full short:flex-none">
          <h2 className="max-w-full truncate font-medium text-[17px] short:text-[13px]">
            {conversation
              ? displayName(conversation, t)
              : t(call.video ? 'groupCall.videoLabel' : 'groupCall.label')}
          </h2>
          <p
            data-testid="group-call-status"
            aria-live="polite"
            className={`text-[13px] short:text-[11px] ${status.warning ? 'text-danger' : 'text-fg-2'}`}
          >
            {[t('groupCall.people', { count: people }), status.text].filter(Boolean).join(' · ')}
          </p>
        </div>
        {joined ? (
          <button
            type="button"
            data-testid="group-call-invite"
            aria-label={t('groupCall.invite')}
            title={t('groupCall.invite')}
            onClick={() => setInviting(true)}
            className={iconButton}
          >
            <UserPlus size={20} aria-hidden />
          </button>
        ) : (
          <span className="size-11 flex-none" />
        )}
      </div>

      <div
        ref={tiles}
        data-testid="group-call-members"
        data-layout={enlarged ? 'focus' : 'grid'}
        className="flex min-h-0 w-full max-w-[1100px] flex-1 flex-col gap-2 short:contents"
      >
        {enlarged ? (
          <>
            <ul className="flex min-h-0 flex-1 short:col-start-1 short:row-span-3 short:row-start-1">
              {tile(enlarged, 'big')}
            </ul>
            {rest.length > 0 && (
              <ul className="flex h-20 flex-none gap-2 overflow-x-auto md:h-28 short:col-start-2 short:row-start-2 short:h-auto short:min-h-0 short:flex-col short:overflow-x-hidden short:overflow-y-auto">
                {rest.map((item) => tile(item, 'strip'))}
              </ul>
            )}
          </>
        ) : (
          <ul
            className={`grid min-h-0 flex-1 auto-rows-[minmax(6rem,1fr)] gap-2 overflow-y-auto ${gridColumns(items.length)} short:col-span-1 short:col-start-1 short:row-span-3 short:row-start-1 short:auto-rows-[minmax(5rem,1fr)] short:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]`}
          >
            {items.map((item) => tile(item, 'grid'))}
          </ul>
        )}
      </div>

      <div className="flex flex-none flex-col items-center gap-3 short:col-start-2 short:row-start-3 short:gap-2">
        {joined && calls.audioBlocked && (
          <Button
            variant="secondary"
            data-testid="group-call-start-audio"
            onClick={() => void controller.startAudio()}
          >
            {t('groupCall.startAudio')}
          </Button>
        )}
        <div className="flex items-end gap-5 md:gap-8 short:grid short:grid-cols-2 short:gap-2">
          {joined && (
            <RoundButton
              testId="group-call-mute"
              label={calls.muted ? t('call.unmute') : t('call.mute')}
              pressed={calls.muted}
              onClick={() => void controller.toggleMute()}
            >
              {calls.muted ? <MicOff size={24} /> : <Mic size={24} />}
            </RoundButton>
          )}
          {joined && call.video && (
            <RoundButton
              testId="group-call-camera"
              label={calls.camera ? t('call.cameraOff') : t('call.cameraOn')}
              pressed={!calls.camera}
              onClick={() => void controller.toggleCamera()}
            >
              {calls.camera ? <Video size={24} /> : <VideoOff size={24} />}
            </RoundButton>
          )}
          {joined && call.video && calls.camera && severalCameras && (
            <RoundButton
              testId="group-call-switch-camera"
              label={t('call.switchCamera')}
              onClick={() => void controller.flipCamera()}
            >
              <SwitchCamera size={24} />
            </RoundButton>
          )}
          {joined && <ShareButton calls={calls} call={call} members={members} />}
          <RoundButton
            testId="group-call-leave"
            label={t('groupCall.leave')}
            danger
            onClick={() => void controller.leave()}
          >
            <PhoneOff size={26} />
          </RoundButton>
        </div>
      </div>

      <GroupCallPicker
        open={inviting}
        conversationId={call.conversation_id}
        mode="invite"
        exclude={users}
        onClose={() => setInviting(false)}
        onConfirm={(userIds) => {
          setInviting(false)
          void controller.invite(userIds)
        }}
      />
    </section>
  )
}

/**
 * 缩小后带画面的小窗：视频通话里是正在说话的人，有人在共享屏幕时是他的屏幕。
 * 电脑上在右下角，手机上在右上角。点它回到通话界面。
 */
function MiniVideo({
  calls,
  call,
  featured,
  screenOf,
  onExpand,
}: {
  calls: GroupCallSnapshot
  call: GroupCallView
  /** 小窗里显示谁的画面。 */
  featured?: string
  /** 小窗里显示这个人共享的屏幕（有人在共享时优先显示它）。 */
  screenOf?: string
  onExpand: () => void
}) {
  const { t } = useTranslation('chats')
  const controller = useGroupCallController()
  const status = useStatus(calls)
  // 只收显示的这一路，并且只要小的一档；显示的是屏幕时摄像头一路都不收
  useEffect(() => {
    controller.showing(screenOf || !featured ? [] : [featured], true)
  }, [controller, featured, screenOf])
  const track = screenOf
    ? controller.screenTrack(screenOf)
    : featured
      ? controller.videoTrack(featured)
      : null
  return (
    <button
      type="button"
      data-testid="group-call-mini"
      data-video=""
      data-user={screenOf ? undefined : featured}
      data-screen={screenOf ? '' : undefined}
      onClick={onExpand}
      aria-label={t('call.expand')}
      className="fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-30 h-28 w-44 overflow-hidden rounded-card bg-black text-white shadow-float md:top-auto md:right-6 md:bottom-6 md:h-36 md:w-56"
    >
      <Picture track={track} fit={screenOf ? 'contain' : 'cover'} className="size-full" />
      <span
        data-testid="group-call-mini-status"
        className="absolute inset-x-0 bottom-0 bg-black/50 px-2 py-1 text-center text-[12px] tabular-nums"
      >
        {[t('groupCall.people', { count: call.participants.length }), status.text]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </button>
  )
}

/** 缩小后：电脑上是右下角的小条，手机上是顶部的一条。点它回到通话界面。 */
function MiniBar({
  calls,
  call,
  onExpand,
}: {
  calls: GroupCallSnapshot
  call: GroupCallView
  onExpand: () => void
}) {
  const { t } = useTranslation('chats')
  const me = useMe()
  const conversation = useConversation(call.conversation_id)
  const status = useStatus(calls)
  // 我自己已经不在名单里的一瞬间（正在被请出去）不用特别处理：界面马上就会收起来
  const people = inGroupCall(call, me.id) ? call.participants.length : 0
  // 小条上没有画面：一路都不用收
  const controller = useGroupCallController()
  useEffect(() => {
    controller.showing([], true)
  }, [controller])
  return (
    <button
      type="button"
      data-testid="group-call-mini"
      onClick={onExpand}
      aria-label={t('call.expand')}
      // 手机上是顶部的一整条，要够手指点
      className="fixed inset-x-0 top-0 z-30 flex items-center gap-2 bg-accent px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 text-on-accent max-md:min-h-11 md:inset-x-auto md:top-auto md:right-6 md:bottom-6 md:rounded-card md:py-2 md:shadow-float"
    >
      <Phone size={16} aria-hidden />
      <span className="min-w-0 truncate">
        {conversation ? displayName(conversation, t) : t('groupCall.label')}
      </span>
      <span data-testid="group-call-mini-status" className="flex-none tabular-nums">
        {[people > 0 ? t('groupCall.people', { count: people }) : '', status.text]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <Maximize2 size={14} aria-hidden className="ml-auto flex-none md:ml-2" />
    </button>
  )
}
