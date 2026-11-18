// 通话的界面（设计文档 8.8 节）：呼叫中、来电卡片、通话中、缩小后的小条、结束时的结果。
// 它浮在页面的最上层，切换会话、收发消息都不影响通话。

import {
  type CallSnapshot,
  canShareScreen,
  clampZoom,
  type MicrophoneProblem,
  NO_ZOOM,
  panZoom,
  type ReceivedVideo,
  receivedKbps,
  type SentVideo,
  toggleZoom,
  type Zoom,
  zoomAround,
} from '@vibechat/core'
import type { CallOutcome, ConversationView } from '@vibechat/protocol'
import type { TFunction } from 'i18next'
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
  Video,
  VideoOff,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../App'
import {
  SCREEN_DESKTOP_VERSION,
  useCall,
  useCallController,
  VIDEO_DESKTOP_VERSION,
} from '../../calls'
import { useChatStore, useConversation } from '../../chat'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { useDesktopRequirement } from '../../desktopClient'
import { inForeground, useNoticesOn } from '../../notifications'
import { toast } from '../../toast'
import { ConversationAvatar } from '../chats/ConversationAvatar'
import { callDuration, displayName } from '../chats/text'
import { playTone, type Tone } from './tones'

/** 通话的界面。登录后的页面里放一份。 */
export function CallLayer() {
  const call = useCall()
  const controller = useCallController()
  const { t: tErrors } = useTranslation('errors')
  const [minimized, setMinimized] = useState(false)
  const conversationId = call.call?.conversation_id ?? ''
  const conversation = useConversation(conversationId)
  const store = useChatStore()

  // 来电的会话可能不在我的列表里（被我移除了）：单独取一次，才知道是谁打来的
  useEffect(() => {
    if (conversationId) store.ensureConversation(conversationId).catch(() => {})
  }, [conversationId, store])

  // 每个通话从完整的界面开始
  const callId = call.call?.id
  useEffect(() => {
    if (callId) setMinimized(false)
  }, [callId])

  // 开始共享屏幕：通话界面缩小，好操作要给对方看的东西；对方开始共享：展开给我看（F7）
  const sharing = call.sharing
  const peerSharing = call.peerSharing
  useEffect(() => {
    if (sharing) setMinimized(true)
  }, [sharing])
  useEffect(() => {
    if (peerSharing) setMinimized(false)
  }, [peerSharing])

  // 操作没成功：提示原因
  const error = call.error
  useEffect(() => {
    if (!error || call.phase === 'ended') return
    toast.error(tErrors(error))
    controller.clearProblem()
  }, [error, call.phase, controller, tErrors])

  return (
    <>
      <Alerts call={call} conversation={conversation} />
      <RemoteAudio stream={call.remote} />
      <MicrophoneDialog />
      <CameraDialog />
      <ScreenDialog />
      {call.sharing && <SharingBar />}
      {call.phase === 'incoming' && conversation && <IncomingCard conversation={conversation} />}
      {call.phase === 'elsewhere' && <ElsewhereBar call={call} />}
      {(call.phase === 'outgoing' ||
        call.phase === 'connecting' ||
        call.phase === 'active' ||
        call.phase === 'ended') &&
        conversation &&
        (minimized && call.phase !== 'ended' ? (
          call.call?.video || call.peerSharing ? (
            <MiniVideo
              call={call}
              conversation={conversation}
              onExpand={() => setMinimized(false)}
            />
          ) : (
            <MiniBar call={call} conversation={conversation} onExpand={() => setMinimized(false)} />
          )
        ) : (
          <CallScreen
            call={call}
            conversation={conversation}
            onMinimize={() => setMinimized(true)}
          />
        ))}
    </>
  )
}

/**
 * 响铃时的提醒：来电铃声、打出去时的回铃音；来电时页面不在前台就弹系统通知，
 * 桌面端还把窗口带到前面、程序坞的图标跳动。接听、拒绝或者对方挂断时都停下。
 */
function Alerts({
  call,
  conversation,
}: {
  call: CallSnapshot
  conversation: ConversationView | undefined
}) {
  const { t } = useTranslation('chats')
  const platform = usePlatform()
  const noticesOn = useNoticesOn()
  const tone: Tone | null =
    call.phase === 'incoming' ? 'ring' : call.phase === 'outgoing' ? 'ringback' : null
  const callId = call.call?.id ?? null
  const video = call.call?.video === true
  const name = conversation ? displayName(conversation, t) : null

  useEffect(() => {
    if (!tone) return
    return playTone(tone)
  }, [tone])

  // 来电：系统通知和桌面端的提醒，每个来电一次
  const ringing = call.phase === 'incoming' ? callId : null
  const latest = useRef({ name, noticesOn, t, video })
  latest.current = { name, noticesOn, t, video }
  useEffect(() => {
    if (!ringing) return
    platform.callAlert(true)
    let notice: Notification | null = null
    const { name, noticesOn, t, video } = latest.current
    if (noticesOn && !inForeground() && typeof Notification !== 'undefined') {
      notice = new Notification(name ?? t('call.incomingLabel'), {
        body: video ? t('call.videoInvites') : t('call.invites'),
        tag: `vc-call-${ringing}`,
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

  // 测试和排查时看得到正在放哪一种声音
  return <span hidden data-testid="call-tone" data-tone={tone ?? ''} />
}

/** 对方的声音。页面上看不见。 */
function RemoteAudio({ stream }: { stream: MediaStream | null }) {
  const audio = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const element = audio.current
    if (!element) return
    element.srcObject = stream
    if (stream) void element.play().catch(() => {})
  }, [stream])
  // biome-ignore lint/a11y/useMediaCaption: 通话的声音没有字幕
  return <audio ref={audio} autoPlay data-testid="call-audio" />
}

/** 一路画面。声音由 RemoteAudio 放，这里一律静音，免得放两遍。 */
function VideoView({
  stream,
  mirror = false,
  fit = 'cover',
  testId,
  className = '',
}: {
  stream: MediaStream | null
  /** 自己的画面左右翻转，像照镜子（F5 Q8）。 */
  mirror?: boolean
  /** 铺满（裁掉边）还是完整显示（留黑边）。 */
  fit?: 'cover' | 'contain'
  testId: string
  className?: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const element = video.current
    if (!element) return
    element.srcObject = stream
    if (stream) void element.play().catch(() => {})
  }, [stream])
  return (
    <video
      ref={video}
      data-testid={testId}
      autoPlay
      playsInline
      muted
      className={`bg-black ${fit === 'contain' ? 'object-contain' : 'object-cover'} ${mirror ? '-scale-x-100' : ''} ${className}`}
    />
  )
}

/** 这台设备有不止一个摄像头（手机的前后摄像头）：可以切换。拿到摄像头的授权之后才数得准。 */
export function useSeveralCameras(cameraOn: boolean): boolean {
  const [several, setSeveral] = useState(false)
  useEffect(() => {
    if (!cameraOn || !navigator.mediaDevices?.enumerateDevices) return
    let live = true
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (live) setSeveral(devices.filter((device) => device.kind === 'videoinput').length > 1)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [cameraOn])
  return several
}

/** 对方的画面能不能显示：接通了、对方的摄像头开着或者在共享屏幕、并且真的收到了画面。 */
function showsPeer(call: CallSnapshot): boolean {
  return (
    (call.phase === 'connecting' || call.phase === 'active') &&
    (call.peerCameraOn || call.peerSharing) &&
    (call.remote?.getVideoTracks().length ?? 0) > 0
  )
}

/**
 * "共享屏幕"按钮：只在能共享的浏览器上出现（手机上没有）；对方在共享时是灰的（F7 Q3）。
 * 旧版本的桌面端点了提示更新（F7 Q9）。
 */
function ShareButton({ call, onDark = false }: { call: CallSnapshot; onDark?: boolean }) {
  const { t } = useTranslation('chats')
  const controller = useCallController()
  const desktopAllows = useDesktopRequirement()
  if (!canShareScreen()) return null
  if (call.sharing) {
    return (
      <RoundButton
        testId="call-share"
        label={t('call.stopSharing')}
        pressed
        onDark={onDark}
        onClick={() => void controller.stopSharing()}
      >
        <MonitorX size={24} />
      </RoundButton>
    )
  }
  return (
    <RoundButton
      testId="call-share"
      label={call.peerSharing ? t('call.peerIsSharing') : t('call.shareScreen')}
      disabled={call.peerSharing}
      onDark={onDark}
      onClick={() => {
        if (!desktopAllows(t('call.shareScreen'), SCREEN_DESKTOP_VERSION)) return
        // 浏览器要求在点击里直接弹出选择框：这里不能先等别的
        void controller.startSharing()
      }}
    >
      <MonitorUp size={24} />
    </RoundButton>
  )
}

/** 两次轻点之间最多隔多久算双击。 */
const DOUBLE_TAP_MS = 300

type Gesture =
  | { kind: 'pan'; x: number; y: number; start: Zoom; moved: boolean }
  | { kind: 'pinch'; distance: number; x: number; y: number; start: Zoom }

/**
 * 对方共享的屏幕：完整显示，不裁边（F7）。手机上可以双指放大、单指拖动，双击放大或还原（F7 Q6）。
 */
export function ZoomableScreen({
  stream,
  prefix = 'call',
  inTile = false,
}: {
  stream: MediaStream | null
  /** 测试用的名字的前缀：群通话里用 `group-call`。 */
  prefix?: string
  /** 放在通话界面的一格里（群通话），不是占满整个界面：按钮贴着这一格的角。 */
  inTile?: boolean
}) {
  const { t } = useTranslation('chats')
  const box = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM)
  const gesture = useRef<Gesture | null>(null)
  const lastTap = useRef(0)
  /** 电脑上用鼠标拖：按下时的位置和那时的样子。 */
  const drag = useRef<{ x: number; y: number; start: Zoom } | null>(null)

  /** 显示区域的大小，以及一点相对于它中心的坐标。 */
  const around = (clientX: number, clientY: number) => {
    const rect = box.current?.getBoundingClientRect()
    const size = { width: rect?.width ?? 0, height: rect?.height ?? 0 }
    return {
      size,
      x: clientX - (rect?.left ?? 0) - size.width / 2,
      y: clientY - (rect?.top ?? 0) - size.height / 2,
    }
  }

  // 电脑上滚轮放大、缩小，以鼠标所在的地方为中心。要拦下页面自己的滚动，只能用原生的监听
  useEffect(() => {
    const element = box.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const { size, x, y } = around(event.clientX, event.clientY)
      const factor = Math.exp(-event.deltaY * 0.002)
      setZoom((current) => zoomAround(current, factor, x, y, size))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  })

  /**
   * 原始大小：画面上的一个点正好是屏幕上的一个点，字最清楚（F7 T16）。
   * 画面本来就不比显示区域大时，就是不放大。
   */
  const actualSize = () => {
    const video = box.current?.querySelector('video')
    const rect = box.current?.getBoundingClientRect()
    if (!video || !rect || video.videoWidth === 0) return
    const fitted = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight)
    const scale = 1 / (fitted * (window.devicePixelRatio || 1))
    setZoom(clampZoom({ scale, x: 0, y: 0 }, rect))
  }

  /** 显示区域的大小，以及一个触点相对于它中心的坐标。 */
  const measure = (touches: React.TouchList) => {
    const rect = box.current?.getBoundingClientRect()
    const size = { width: rect?.width ?? 0, height: rect?.height ?? 0 }
    const center = (touch: React.Touch) => ({
      x: touch.clientX - (rect?.left ?? 0) - size.width / 2,
      y: touch.clientY - (rect?.top ?? 0) - size.height / 2,
    })
    const points = Array.from(touches, center)
    return { size, points }
  }

  const begin = (touches: React.TouchList, current: Zoom) => {
    const { points } = measure(touches)
    const [a, b] = points
    if (a && b) {
      gesture.current = {
        kind: 'pinch',
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        start: current,
      }
    } else if (a) {
      gesture.current = { kind: 'pan', x: a.x, y: a.y, start: current, moved: false }
    } else {
      gesture.current = null
    }
  }

  return (
    <div
      ref={box}
      // 一块自己处理放大、拖动的区域
      role="application"
      aria-label={t('call.peerSharing')}
      data-testid={`${prefix}-screen-zoom`}
      data-scale={zoom.scale.toFixed(2)}
      className={`absolute inset-0 touch-none overflow-hidden ${zoom.scale > 1 ? 'cursor-grab' : ''}`}
      onDoubleClick={(event) => {
        const { size, x, y } = around(event.clientX, event.clientY)
        setZoom((current) => toggleZoom(current, x, y, size))
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'mouse' || zoom.scale <= 1) return
        drag.current = { x: event.clientX, y: event.clientY, start: zoom }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        const { size } = around(event.clientX, event.clientY)
        setZoom(panZoom(current.start, event.clientX - current.x, event.clientY - current.y, size))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onTouchStart={(event) => begin(event.touches, zoom)}
      onTouchMove={(event) => {
        const current = gesture.current
        if (!current) return
        const { size, points } = measure(event.touches)
        const [a, b] = points
        if (current.kind === 'pinch' && a && b) {
          const x = (a.x + b.x) / 2
          const y = (a.y + b.y) / 2
          const factor = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, current.distance)
          const zoomed = zoomAround(current.start, factor, current.x, current.y, size)
          setZoom(panZoom(zoomed, x - current.x, y - current.y, size))
        } else if (current.kind === 'pan' && a) {
          const dx = a.x - current.x
          const dy = a.y - current.y
          if (Math.hypot(dx, dy) > 10) current.moved = true
          setZoom(panZoom(current.start, dx, dy, size))
        }
      }}
      onTouchEnd={(event) => {
        const current = gesture.current
        // 两个手指松开了一个：从现在的样子接着拖
        if (event.touches.length > 0) {
          begin(event.touches, zoom)
          return
        }
        gesture.current = null
        if (current?.kind !== 'pan' || current.moved) return
        const now = Date.now()
        if (now - lastTap.current < DOUBLE_TAP_MS) {
          lastTap.current = 0
          const rect = box.current?.getBoundingClientRect()
          setZoom(
            toggleZoom(zoom, current.x, current.y, {
              width: rect?.width ?? 0,
              height: rect?.height ?? 0,
            }),
          )
        } else {
          lastTap.current = now
        }
      }}
    >
      <div
        className="size-full"
        style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
      >
        <VideoView
          stream={stream}
          fit="contain"
          testId={`${prefix}-shared-screen`}
          className="size-full"
        />
      </div>
      {/* 电脑上：原始大小和适应窗口来回切换。手机上用双指 */}
      <button
        type="button"
        data-testid={`${prefix}-actual-size`}
        onClick={() => (zoom.scale > 1 ? setZoom(NO_ZOOM) : actualSize())}
        // 连点两下按钮不算在画面上双击，按下按钮也不开始拖动
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        className={`absolute rounded-full bg-black/50 px-3 py-1.5 text-[13px] text-white hover:bg-black/70 [@media(pointer:coarse)]:hidden ${
          inTile
            ? 'top-2 right-2'
            : 'top-[max(5.5rem,calc(env(safe-area-inset-top)+4.5rem))] right-4'
        }`}
      >
        {zoom.scale > 1 ? t('call.fitScreen') : t('call.actualSize')}
      </button>
    </div>
  )
}

/**
 * 我共享屏幕时发出去的画面（F7 的诊断小字），例如
 * "屏幕 2560×1600 · 发出 640×360 · 0.1 Mbps · 受网络限制 · 清晰度优先"。
 */
function useSharedVideo(): string | null {
  const { t } = useTranslation('chats')
  const controller = useCallController()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let last: SentVideo | null = null
    let live = true
    const measure = async () => {
      const shared = await controller.sharedVideo()
      if (!live || !shared) return
      const parts: string[] = []
      const size = (item: { width: number; height: number }) => `${item.width}×${item.height}`
      if (shared.captured) parts.push(t('call.sent.captured', { size: size(shared.captured) }))
      const sent = shared.sent
      if (sent) {
        parts.push(t('call.sent.sending', { size: size(sent) }))
        const kbps = last ? receivedKbps(last, sent) : null
        if (kbps !== null) parts.push(`${(kbps / 1000).toFixed(1)} Mbps`)
        if (sent.limitation && sent.limitation !== 'none') {
          parts.push(t(`call.sent.limited_${sent.limitation}`))
        }
      }
      if (shared.resolutionFirst !== null) {
        parts.push(
          shared.resolutionFirst
            ? t('call.sent.resolutionFirst')
            : t('call.sent.noResolutionFirst'),
        )
      }
      last = sent
      setText(parts.length > 0 ? parts.join(' · ') : null)
    }
    void measure()
    const timer = window.setInterval(() => void measure(), STATS_EVERY_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [controller, t])
  return text
}

/** 我在共享屏幕时，页面顶上的提示条和"停止共享"，下面是发出去的画面的诊断小字。 */
function SharingBar() {
  const { t } = useTranslation('chats')
  const controller = useCallController()
  const shared = useSharedVideo()
  return (
    <div className="fixed top-3 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-1">
      <div
        data-testid="call-sharing-bar"
        role="status"
        className="flex items-center gap-3 rounded-full bg-accent py-1.5 pr-1.5 pl-4 text-on-accent shadow-float"
      >
        <MonitorUp size={16} aria-hidden />
        <span className="whitespace-nowrap text-[14px]">{t('call.youAreSharing')}</span>
        <button
          type="button"
          data-testid="call-stop-sharing"
          onClick={() => void controller.stopSharing()}
          className="whitespace-nowrap rounded-full bg-on-accent px-3 py-1 font-medium text-[13px] text-accent hover:opacity-90"
        >
          {t('call.stopSharing')}
        </button>
      </div>
      {shared && (
        <p
          data-testid="call-sent"
          className="whitespace-nowrap rounded-full bg-black/60 px-3 py-0.5 text-[12px] text-white tabular-nums"
        >
          {shared}
        </p>
      )}
    </div>
  )
}

/** 全屏看对方共享的屏幕。浏览器不支持全屏时没有这个按钮。 */
/**
 * 全屏看共享的屏幕。浏览器能把一块内容全屏的（电脑、iPad）用浏览器的全屏；
 * 不能的（iPhone 的 Safari 只让它自己的视频播放器全屏）改成页面内铺满：`pseudo` 为真时，
 * 调用方把那一块盖满整个页面（F12 第 11 章 Q15）。按 Esc 也退出。
 */
export function useFullScreen(target: React.RefObject<HTMLElement | null>) {
  const [full, setFull] = useState(false)
  const [pseudo, setPseudo] = useState(false)
  const native = typeof document !== 'undefined' && document.fullscreenEnabled === true
  useEffect(() => {
    const changed = () => setFull(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  useEffect(() => {
    if (!pseudo) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPseudo(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pseudo])
  const toggle = () => {
    if (!native) {
      setPseudo((current) => !current)
      return
    }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void target.current?.requestFullscreen().catch(() => {})
  }
  return { supported: true, full: native ? full : pseudo, pseudo, toggle }
}

/** 通话时长，每秒更新一次。 */
export function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since])
  return since === null ? '' : callDuration(Math.max(0, now - since))
}

/** 呼叫中、通话中、刚结束：电脑上盖住内容区，手机上占满整个屏幕。 */
function CallScreen({
  call,
  conversation,
  onMinimize,
}: {
  call: CallSnapshot
  conversation: ConversationView
  onMinimize: () => void
}) {
  const { t } = useTranslation('chats')
  const controller = useCallController()
  const elapsed = useElapsed(call.phase === 'active' ? call.connectedAt : null)
  const ended = call.phase === 'ended'

  let status: string
  if (call.phase === 'outgoing') status = t('call.calling')
  else if (call.phase === 'connecting') status = t('call.connecting')
  else if (ended) status = endedText(call, t)
  else if (call.unstable) status = t('call.unstable')
  else status = elapsed

  // 视频通话，或者语音通话里对方在共享屏幕：画面占满
  if ((call.call?.video || call.peerSharing) && !ended) {
    return (
      <VideoScreen
        call={call}
        conversation={conversation}
        status={status}
        onMinimize={onMinimize}
      />
    )
  }

  return (
    <section
      data-testid="call-screen"
      data-phase={call.phase}
      aria-label={t('call.label')}
      className="fixed inset-0 z-30 flex flex-col items-center justify-between bg-bg px-4 pt-[max(4rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] md:left-14 short:left-0! short:pt-4 short:pb-2"
    >
      <div className="flex flex-col items-center gap-3">
        <ConversationAvatar conversation={conversation} size={96} />
        <h2 className="font-medium text-[20px]">{displayName(conversation, t)}</h2>
        <p
          data-testid="call-status"
          aria-live="polite"
          className={`text-[15px] ${call.unstable && !ended ? 'text-danger' : 'text-fg-2'}`}
        >
          {status}
        </p>
        {!ended && <PathLabel call={call} />}
      </div>
      {!ended && (
        <div className="flex items-end gap-8">
          {call.phase !== 'outgoing' && (
            <RoundButton
              testId="call-mute"
              label={call.muted ? t('call.unmute') : t('call.mute')}
              pressed={call.muted}
              onClick={() => controller.toggleMute()}
            >
              {call.muted ? <MicOff size={24} /> : <Mic size={24} />}
            </RoundButton>
          )}
          <RoundButton
            testId="call-hangup"
            label={call.phase === 'outgoing' ? t('call.cancel') : t('call.hangUp')}
            danger
            onClick={() => void controller.hangUp()}
          >
            <PhoneOff size={26} />
          </RoundButton>
          {call.phase !== 'outgoing' && <ShareButton call={call} />}
          {call.phase !== 'outgoing' && (
            <RoundButton testId="call-minimize" label={t('call.minimize')} onClick={onMinimize}>
              <Minimize2 size={24} />
            </RoundButton>
          )}
        </div>
      )}
    </section>
  )
}

/** 视频通话：对方的画面占满，自己的画面在角落的小窗里。对方关了摄像头时显示头像。 */
function VideoScreen({
  call,
  conversation,
  status,
  onMinimize,
}: {
  call: CallSnapshot
  conversation: ConversationView
  status: string
  onMinimize: () => void
}) {
  const { t } = useTranslation('chats')
  const controller = useCallController()
  const peerShown = showsPeer(call)
  const answered = call.phase !== 'outgoing'
  const video = call.call?.video === true
  const severalCameras = useSeveralCameras(call.cameraOn)
  const section = useRef<HTMLElement>(null)
  const fullScreen = useFullScreen(section)
  return (
    <section
      ref={section}
      data-testid="call-screen"
      data-phase={call.phase}
      data-video=""
      data-peer-sharing={call.peerSharing ? '' : undefined}
      aria-label={video ? t('call.videoLabel') : t('call.label')}
      data-full-screen={fullScreen.pseudo ? '' : undefined}
      className="fixed inset-0 z-30 bg-black text-white md:left-14 short:left-0!"
    >
      {peerShown && call.peerSharing ? (
        <ZoomableScreen stream={call.remote} />
      ) : peerShown ? (
        <VideoView
          stream={call.remote}
          testId="call-remote-video"
          className="absolute inset-0 size-full"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <ConversationAvatar conversation={conversation} size={96} />
          {answered && !call.peerCameraOn && (
            <p data-testid="call-peer-camera-off" className="text-[14px] text-white/70">
              {t('call.peerCameraOff')}
            </p>
          )}
        </div>
      )}
      {/* 页面内铺满（iPhone 上的"全屏"）：只留画面和退出的按钮 */}
      {fullScreen.pseudo && (
        <button
          type="button"
          data-testid="call-exit-full-screen"
          aria-label={t('call.exitFullScreen')}
          title={t('call.exitFullScreen')}
          onClick={fullScreen.toggle}
          className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-10 grid size-11 place-items-center rounded-full bg-black/50 text-white"
        >
          <Minimize size={20} />
        </button>
      )}
      {/* 只有文字：点击、拖动、放大都透过它到下面的画面上 */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-1 bg-linear-to-b from-black/60 to-transparent px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-8 short:pt-2 short:pb-4 ${
          fullScreen.pseudo ? 'hidden' : ''
        }`}
      >
        <h2 className="font-medium text-[18px]">{displayName(conversation, t)}</h2>
        <p data-testid="call-status" aria-live="polite" className="text-[14px] text-white/80">
          {call.peerSharing ? `${t('call.peerSharing')} · ${status}` : status}
        </p>
        <PathLabel call={call} onDark />
      </div>
      {call.local && call.cameraOn && (
        <VideoView
          stream={call.local}
          // 前置摄像头像照镜子；后置的照原样（F5 Q8）
          mirror={call.facing === 'user'}
          testId="call-local-video"
          className="absolute top-[max(5.5rem,calc(env(safe-area-inset-top)+4.5rem))] right-4 h-36 w-24 rounded-card shadow-float max-md:landscape:top-4 max-md:landscape:h-24 max-md:landscape:w-36 md:h-40 md:w-56 short:top-2! short:right-2! short:h-20! short:w-32!"
        />
      )}
      <div
        className={`absolute inset-x-0 bottom-0 flex items-end justify-center gap-6 bg-linear-to-t from-black/60 to-transparent px-4 pt-10 pb-[max(2rem,env(safe-area-inset-bottom))] short:gap-4 short:pt-4 short:pb-[max(0.5rem,env(safe-area-inset-bottom))] ${
          fullScreen.pseudo ? 'hidden' : ''
        }`}
      >
        {answered && (
          <RoundButton
            testId="call-mute"
            label={call.muted ? t('call.unmute') : t('call.mute')}
            pressed={call.muted}
            onDark
            onClick={() => controller.toggleMute()}
          >
            {call.muted ? <MicOff size={24} /> : <Mic size={24} />}
          </RoundButton>
        )}
        {video && (
          <RoundButton
            testId="call-camera"
            label={call.cameraOn ? t('call.cameraOff') : t('call.cameraOn')}
            pressed={!call.cameraOn}
            disabled={call.sharing}
            onDark
            onClick={() => void controller.toggleCamera()}
          >
            {call.cameraOn ? <Video size={24} /> : <VideoOff size={24} />}
          </RoundButton>
        )}
        {severalCameras && call.cameraOn && (
          <RoundButton
            testId="call-switch-camera"
            label={t('call.switchCamera')}
            onDark
            onClick={() => void controller.switchCamera()}
          >
            <SwitchCamera size={24} />
          </RoundButton>
        )}
        <RoundButton
          testId="call-hangup"
          label={answered ? t('call.hangUp') : t('call.cancel')}
          danger
          onDark
          onClick={() => void controller.hangUp()}
        >
          <PhoneOff size={26} />
        </RoundButton>
        {answered && <ShareButton call={call} onDark />}
        {call.peerSharing && fullScreen.supported && (
          <RoundButton
            testId="call-full-screen"
            label={fullScreen.full ? t('call.exitFullScreen') : t('call.fullScreen')}
            onDark
            onClick={fullScreen.toggle}
          >
            {fullScreen.full ? <Minimize size={24} /> : <Maximize size={24} />}
          </RoundButton>
        )}
        {answered && (
          <RoundButton
            testId="call-minimize"
            label={t('call.minimize')}
            onDark
            onClick={onMinimize}
          >
            <Minimize2 size={24} />
          </RoundButton>
        )}
      </div>
    </section>
  )
}

export function RoundButton({
  testId,
  label,
  danger = false,
  pressed,
  disabled = false,
  onDark = false,
  onClick,
  children,
}: {
  testId: string
  label: string
  danger?: boolean
  pressed?: boolean
  disabled?: boolean
  /** 放在视频画面上：按钮和文字用浅色。 */
  onDark?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    // 矮屏幕（横过来的手机）上小一号，不写字：名字在按钮的无障碍名称里
    <div className="flex flex-col items-center gap-2 short:gap-0">
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={`grid size-16 place-items-center rounded-full transition-colors duration-150 disabled:opacity-40 short:size-11 ${
          danger
            ? 'bg-danger text-on-accent hover:opacity-90'
            : onDark
              ? pressed
                ? 'bg-white text-black'
                : 'bg-white/20 text-white hover:bg-white/30'
              : pressed
                ? 'bg-fg text-bg'
                : 'bg-surface text-fg hover:bg-hover'
        }`}
      >
        {children}
      </button>
      <span className={`text-[13px] short:sr-only ${onDark ? 'text-white/80' : 'text-fg-2'}`}>
        {label}
      </span>
    </div>
  )
}

/** 缩小后：电脑上是右下角的小条，手机上是顶部的一条。点它回到通话界面。 */
function MiniBar({
  call,
  conversation,
  onExpand,
}: {
  call: CallSnapshot
  conversation: ConversationView
  onExpand: () => void
}) {
  const { t } = useTranslation('chats')
  const elapsed = useElapsed(call.phase === 'active' ? call.connectedAt : null)
  return (
    <button
      type="button"
      data-testid="call-mini"
      onClick={onExpand}
      aria-label={t('call.expand')}
      className="fixed inset-x-0 top-0 z-30 flex items-center gap-2 bg-accent px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 text-on-accent max-md:min-h-11 md:inset-x-auto md:top-auto md:right-6 md:bottom-6 md:rounded-card md:py-2 md:shadow-float"
    >
      <Phone size={16} aria-hidden />
      <span className="min-w-0 truncate">{displayName(conversation, t)}</span>
      <span data-testid="call-mini-status" className="flex-none tabular-nums">
        {call.unstable ? t('call.unstableShort') : elapsed || t('call.connecting')}
      </span>
      <Maximize2 size={14} aria-hidden className="ml-auto flex-none md:ml-2" />
    </button>
  )
}

/** 视频通话缩小后：一个带对方画面的小窗，电脑上在右下角，手机上在右上角（F5 Q4）。 */
function MiniVideo({
  call,
  conversation,
  onExpand,
}: {
  call: CallSnapshot
  conversation: ConversationView
  onExpand: () => void
}) {
  const { t } = useTranslation('chats')
  const elapsed = useElapsed(call.phase === 'active' ? call.connectedAt : null)
  return (
    <button
      type="button"
      data-testid="call-mini"
      onClick={onExpand}
      aria-label={t('call.expand')}
      className="fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-30 h-40 w-28 overflow-hidden rounded-card bg-black text-white shadow-float md:top-auto md:right-6 md:bottom-6 md:h-36 md:w-56"
    >
      {showsPeer(call) ? (
        <VideoView
          stream={call.remote}
          fit={call.peerSharing ? 'contain' : 'cover'}
          testId="call-mini-video"
          className="size-full"
        />
      ) : (
        <span className="grid size-full place-items-center">
          <ConversationAvatar conversation={conversation} size={48} />
        </span>
      )}
      <span
        data-testid="call-mini-status"
        className="absolute inset-x-0 bottom-0 bg-black/50 px-2 py-1 text-center text-[12px] tabular-nums"
      >
        {call.unstable ? t('call.unstableShort') : elapsed || t('call.connecting')}
      </span>
    </button>
  )
}

/** 来电：不遮挡页面的卡片，电脑上在右上角，手机上在顶部。 */
function IncomingCard({ conversation }: { conversation: ConversationView }) {
  const { t } = useTranslation('chats')
  const controller = useCallController()
  const video = useCall().call?.video === true
  const desktopAllows = useDesktopRequirement()
  return (
    <section
      data-testid="call-incoming"
      aria-label={t('call.incomingLabel')}
      className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-40 flex items-center gap-3 rounded-card border border-border bg-bg p-3 shadow-float md:inset-x-auto md:right-4 md:w-[340px]"
    >
      <ConversationAvatar conversation={conversation} size={44} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{displayName(conversation, t)}</p>
        <p className="text-[13px] text-fg-2">
          {video ? t('call.videoInvites') : t('call.invites')}
        </p>
      </div>
      <button
        type="button"
        data-testid="call-reject"
        aria-label={t('call.reject')}
        title={t('call.reject')}
        onClick={() => void controller.reject()}
        className="grid size-11 flex-none place-items-center rounded-full bg-danger text-on-accent hover:opacity-90"
      >
        <PhoneOff size={20} />
      </button>
      {/* 视频来电可以只用语音接听（F5 Q1） */}
      {video && (
        <button
          type="button"
          data-testid="call-accept-voice"
          aria-label={t('call.answerVoice')}
          title={t('call.answerVoice')}
          onClick={() => void controller.accept({ video: false })}
          className="grid size-11 flex-none place-items-center rounded-full bg-surface text-fg hover:bg-hover"
        >
          <Phone size={20} />
        </button>
      )}
      <button
        type="button"
        data-testid="call-accept"
        aria-label={t('call.accept')}
        title={t('call.accept')}
        onClick={() => {
          // 旧版本的桌面端不放行摄像头：说明要更新，这时可以先用语音接听
          if (video && !desktopAllows(t('call.videoLabel'), VIDEO_DESKTOP_VERSION)) return
          void controller.accept()
        }}
        className="grid size-11 flex-none place-items-center rounded-full bg-accent text-on-accent hover:opacity-90"
      >
        {video ? <Video size={20} /> : <Phone size={20} />}
      </button>
    </section>
  )
}

/** 我的通话在另一台设备上。 */
function ElsewhereBar({ call }: { call: CallSnapshot }) {
  const { t } = useTranslation('chats')
  const answeredElsewhere = call.role === 'callee'
  return (
    <p
      data-testid="call-elsewhere"
      role="status"
      className="fixed inset-x-0 top-0 z-30 bg-surface px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 text-center text-[13px] text-fg-2 md:inset-x-auto md:top-auto md:right-6 md:bottom-6 md:rounded-card md:py-2 md:shadow-float"
    >
      {answeredElsewhere ? t('call.answeredElsewhere') : t('call.inCallElsewhere')}
    </p>
  )
}

/** 麦克风用不了：说明原因。 */
function MicrophoneDialog() {
  const call = useCall()
  const controller = useCallController()
  return (
    <MicrophoneProblemDialog
      problem={call.microphone}
      onClose={() => controller.clearProblem()}
      testId="call-microphone-problem"
    />
  )
}

/** 麦克风用不了的说明。一对一通话和群通话共用。 */
export function MicrophoneProblemDialog({
  problem,
  onClose,
  testId,
}: {
  problem: MicrophoneProblem | null
  onClose: () => void
  testId: string
}) {
  const { t } = useTranslation('chats')
  const platform = usePlatform()
  // 没有授权时，在哪里打开要看是哪个浏览器：Safari 在菜单里，桌面端在系统设置里，其余在地址栏左边
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
      title={t('call.microphone.title')}
    >
      <p data-testid={testId} className="text-fg-2">
        {key ? t(`call.microphone.${key}`) : ''}
      </p>
      <Button variant="primary" className="self-end" onClick={onClose}>
        {t('call.microphone.ok')}
      </Button>
    </Dialog>
  )
}

/** 摄像头用不了：说明原因。通话照常进行，只是对方看不到自己。 */
function CameraDialog() {
  const { t } = useTranslation('chats')
  const call = useCall()
  const controller = useCallController()
  const platform = usePlatform()
  const problem = call.camera
  // 麦克风的说明先说完：两个都用不了时一次只说一件
  const open = problem !== null && call.microphone === null
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
      open={open}
      onOpenChange={(next) => {
        if (!next) controller.clearProblem()
      }}
      title={t('call.camera.title')}
    >
      <p data-testid="call-camera-problem" className="text-fg-2">
        {key ? `${t(`call.camera.${key}`)} ${t('call.camera.goOn')}` : ''}
      </p>
      <Button variant="primary" className="self-end" onClick={() => controller.clearProblem()}>
        {t('call.microphone.ok')}
      </Button>
    </Dialog>
  )
}

/** 屏幕的画面拿不到：说明原因。用户自己取消的不说。通话照常进行。 */
function ScreenDialog() {
  const { t } = useTranslation('chats')
  const call = useCall()
  const controller = useCallController()
  const platform = usePlatform()
  const problem = call.screen
  const key = problem === 'denied' && platform.name === 'desktop' ? 'deniedDesktop' : problem
  return (
    <Dialog
      open={problem !== null}
      onOpenChange={(next) => {
        if (!next) controller.clearProblem()
      }}
      title={t('call.screenProblem.title')}
    >
      <p data-testid="call-screen-problem" className="text-fg-2">
        {key ? `${t(`call.screenProblem.${key}`)} ${t('call.screenProblem.goOn')}` : ''}
      </p>
      <Button variant="primary" className="self-end" onClick={() => controller.clearProblem()}>
        {t('call.microphone.ok')}
      </Button>
    </Dialog>
  )
}

/** 隔多久量一次收到的画面。 */
const STATS_EVERY_MS = 2000

/**
 * 收到的画面多大、多少码率（F7 T17），例如"1662×1080 · 2.4 Mbps"。看不清时用来判断
 * 是画面被缩小了还是码率不够。没有画面时为空。
 */
function useReceivedVideo(active: boolean): string | null {
  const controller = useCallController()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!active) {
      setText(null)
      return
    }
    let last: ReceivedVideo | null = null
    let live = true
    const measure = async () => {
      const now = await controller.receivedVideo()
      if (!live) return
      if (!now) {
        setText(null)
      } else {
        const kbps = last ? receivedKbps(last, now) : null
        const rate = kbps === null ? '' : ` · ${(kbps / 1000).toFixed(1)} Mbps`
        setText(`${now.width}×${now.height}${rate}`)
      }
      last = now
    }
    void measure()
    const timer = window.setInterval(() => void measure(), STATS_EVERY_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [active, controller])
  return text
}

/** 走的是直连还是中转（F7 Q7），后面跟着收到的画面的诊断小字。连上之后才有。 */
function PathLabel({ call, onDark = false }: { call: CallSnapshot; onDark?: boolean }) {
  const { t } = useTranslation('chats')
  const active = call.phase === 'active' && call.path !== null
  const received = useReceivedVideo(active)
  if (!active || call.path === null) return null
  return (
    <span
      data-testid="call-path"
      data-path={call.path}
      className={`text-[12px] tabular-nums ${onDark ? 'text-white/60' : 'text-fg-3'}`}
    >
      {t(`call.path.${call.path}`)}
      {received && <span data-testid="call-received">{` · ${received}`}</span>}
    </span>
  )
}

/** 结束时显示的一句话。 */
function endedText(call: CallSnapshot, t: TFunction<'chats'>): string {
  const view = call.call
  const outcome: CallOutcome | null = view?.outcome ?? null
  if (outcome === 'completed' || outcome === 'interrupted') {
    const talked =
      view?.answered_at != null && view.ended_at != null ? view.ended_at - view.answered_at : 0
    const duration = callDuration(talked)
    return outcome === 'completed'
      ? t('call.ended.completed', { duration })
      : t('call.ended.interrupted', { duration })
  }
  if (outcome) return t(`call.ended.${outcome}`)
  return t('call.ended.unknown')
}
