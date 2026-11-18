// 群通话的声音和画面的连接（F10、F11）：连到媒体转发服务（LiveKit）的一个房间里，
// 发自己麦克风的声音，听别人的；视频通话里再加上摄像头的画面。
//
// 每个人只和媒体转发服务连一条线，由它把声音转给其他人。进房间要凭服务端签发的入场凭证。
//
// 画面（F11）：每个人同时发"清楚的"和"小的"两档，媒体转发服务给每个观看的人只转其中一档。
// 要哪一档由这里的调用方说了算（`watch`），不用客户端库"按显示的大小自动选"的做法：
// 那样在电脑的大窗口上每一路都会选清楚的，服务器的带宽撑不住。
//
// 共享的屏幕（F12）：和摄像头是各自独立的一路，只发一档，清晰度优先。同一时间只看一个人的屏幕，
// 看谁的同样由调用方说了算（`watchScreen`）。
// LiveKit 的客户端库不小，只在真的要进房间时才加载（动态 import），不拖慢平时打开页面。
// 这里只管声音的连接；谁能进、通话的状态由服务端和上一层管。

import type { RoomTicketView } from '@vibechat/protocol'
import { apiRequest } from './api'
import type { CandidateKind } from './call'

interface Options {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** 验证页面（/group-call-check）要一张进验证用房间的入场凭证。服务器没有配置媒体转发服务时不可用。 */
export function requestGroupCheckTicket(
  device: string,
  options: Options & {
    /** 凭证要不要放行摄像头的画面。 */
    camera?: boolean
    /** 凭证要不要放行共享的屏幕。 */
    screen?: boolean
  } = {},
): Promise<RoomTicketView> {
  const { camera = false, screen = false, ...rest } = options
  return apiRequest('/api/calls/group-check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device, camera, screen }),
    ...rest,
  })
}

/** 群视频里一档画面的样子。 */
export interface VideoTier {
  width: number
  height: number
  /** 码率的上限，千比特每秒。 */
  kbps: number
}

/** 群视频的画面参数（F11 第 1 章）：每个人同时发这两档。 */
export interface GroupVideoSettings {
  /** 清楚的一档：被放大的那一路、人少时的每一路。 */
  high: VideoTier
  /** 小的一档：格子里其余的。 */
  low: VideoTier
  /** 每秒多少帧。 */
  fps: number
  /** 共享的屏幕（F12）：只发一档。 */
  screen: {
    /** 画面最宽多少像素，高度按屏幕的比例。 */
    maxWidth: number
    /** 每秒最多几帧。 */
    fps: number
    /** 码率的上限，千比特每秒。 */
    kbps: number
  }
}

/** 默认的画面参数。码率以后由管理员配置（T13），大小和帧率是固定的。 */
export const GROUP_VIDEO: GroupVideoSettings = {
  high: { width: 640, height: 360, kbps: 400 },
  low: { width: 320, height: 180, kbps: 120 },
  fps: 15,
  screen: { maxWidth: 1920, fps: 10, kbps: 1000 },
}

/** 看别人的画面要哪一档：清楚的、小的、不要。 */
export type VideoLayer = 'high' | 'low' | 'off'

/** 用哪一个摄像头：朝着自己的（前置），还是朝着外面的（后置）。 */
export type CameraFacing = 'user' | 'environment'

/** 房间里的一个人。 */
export interface RoomMember {
  /** 他在房间里的身份，入场凭证里写的。 */
  identity: string
  /** 是我自己。 */
  me: boolean
  /** 正在说话。 */
  speaking: boolean
  /** 麦克风关着，或者还没有发出声音。 */
  muted: boolean
  /** 摄像头开着，画面在发。 */
  camera: boolean
  /**
   * 他的画面被媒体转发服务暂停了：我这边的网络带不动，它先保住声音。网络好了自己会恢复。
   * 我自己的那一项永远是假的。
   */
  paused: boolean
  /** 正在共享屏幕。 */
  screen: boolean
  /** 他共享的屏幕被媒体转发服务暂停了（我这边的网络带不动）。我自己的那一项永远是假的。 */
  screenPaused: boolean
}

/** 连接到了哪一步。 */
export type RoomPhase = 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface RoomSnapshot {
  phase: RoomPhase
  /** 我在最前面，其他人按身份排。 */
  members: RoomMember[]
  /** 我自己的麦克风关着。 */
  muted: boolean
  /** 我自己的摄像头开着。 */
  camera: boolean
  /** 我用的是哪一个摄像头。朝着自己的那个，自己看到的画面要左右镜像。 */
  facing: CameraFacing
  /** 我正在共享屏幕。 */
  screen: boolean
  /** 浏览器不让自动放声音（要用户点一下才行）。这时调 `startAudio`。 */
  audioBlocked: boolean
  /** 连接是怎么断的：LiveKit 给的原因的名字，例如 `CLIENT_INITIATED`（自己离开）、
   * `PARTICIPANT_REMOVED`（被请出去）、`DUPLICATE_IDENTITY`（同一个人在别处又进来了）。还连着时为空。 */
  closedBecause: string | null
}

/** 我这条线的情况：走的是 UDP 还是 TCP、连的是哪个地址、收发了多少。 */
export interface RoomStats {
  /** 声音走的是 UDP 还是 TCP。还不知道时为空。 */
  protocol: 'udp' | 'tcp' | null
  /** 我这一端用的地址是哪一种。 */
  local: CandidateKind | null
  /** 连的是媒体转发服务的哪个地址和端口。 */
  server: string | null
  /** 来回一次的时间，毫秒。 */
  roundTripMs: number | null
  /** 到现在一共发了、收了多少字节的声音。 */
  bytesSent: number
  bytesReceived: number
  /** 和上一次量的之间，平均每秒发、收多少千比特。第一次量时为空。 */
  sentKbps: number | null
  receivedKbps: number | null
}

/** 我发出去的一档画面现在的情况。 */
export interface SentVideoLayer {
  /** 档位的名字：`q` 是小的，`h` 是清楚的。只发一档时可能为空。 */
  rid: string
  /** 实际发出去的大小和帧率；这一档停发时是 0。 */
  width: number
  height: number
  fps: number
  bytes: number
  /** 和上一次量的之间平均每秒多少千比特。第一次量时为空。 */
  kbps: number | null
}

/** 收到的一路画面现在的情况。 */
export interface RoomReceivedVideo {
  width: number
  height: number
  fps: number
  bytes: number
  kbps: number | null
}

/** 我共享出去的屏幕现在的情况。 */
export interface SentScreen {
  /** 拿到的屏幕画面多大。 */
  capturedWidth: number
  capturedHeight: number
  /** 实际发出去的大小和帧率。 */
  width: number
  height: number
  fps: number
  bytes: number
  kbps: number | null
  /** 浏览器说是什么限制了画面的质量：`bandwidth`、`cpu`，没有限制时是 `none`。不知道时为空。 */
  limitedBy: string | null
  /** 浏览器有没有接受"清晰度优先"（网络差时降帧数，不缩小画面）。不知道时为空。 */
  resolutionFirst: boolean | null
}

export interface RoomVideoStats {
  /** 我发出去的每一档，小的在前。没开摄像头时是空的。 */
  sent: SentVideoLayer[]
  /** 我收到的每一路，按对方的身份。 */
  received: Record<string, RoomReceivedVideo>
  /** 我共享出去的屏幕。没在共享时为空。 */
  screenSent: SentScreen | null
  /** 我正在看的那个人的屏幕。没有在看、还没有画面时为空。 */
  screenReceived: RoomReceivedVideo | null
}

export interface RoomHandle {
  snapshot(): RoomSnapshot
  setMuted(muted: boolean): Promise<void>
  /** 浏览器不让自动放声音时，在用户点击的时候调它。 */
  startAudio(): Promise<void>
  stats(): Promise<RoomStats>
  /**
   * 打开、关掉我的摄像头。只在带着 `video` 进的房间里能用。
   * 拿不到摄像头（抛出 DOMException）、入场凭证不放行画面时抛出错误，摄像头已经放掉。
   */
  setCamera(on: boolean): Promise<void>
  /** 换一个摄像头（手机上切换前后）。摄像头关着时只是记下，下次打开时用它。 */
  switchCamera(facing: CameraFacing): Promise<void>
  /** 这个人的画面要哪一档。没说过的按小的一档。只在带着 `video` 进的房间里有用。 */
  watch(identity: string, layer: VideoLayer): void
  /** 这个人的画面（我自己的也可以），拿去放进 video 元素。没有画面时为空。 */
  videoTrack(identity: string): MediaStreamTrack | null
  /**
   * 开始、停止共享我的屏幕。只在带着 `video` 进的房间里能用。
   * 开始时浏览器让用户选共享什么；用户取消、没有授权时抛出 DOMException，入场凭证不放行时抛出别的错误。
   * 用浏览器自己的"停止共享"也算停止：那时 `onChange` 会带着 `screen: false` 调到。
   *
   * `allowed`：拿到屏幕之后、往外发之前调它，它不成（抛出错误）就不发、把屏幕放掉，错误原样抛出来。
   * 用来问服务端"现在能不能共享"。顺序不能反过来：浏览器要求选择框在用户点击时马上弹出，
   * 先等一次网络请求的话有的浏览器（Safari）就不给弹了。
   */
  setScreen(on: boolean, allowed?: () => Promise<void>): Promise<void>
  /** 看谁共享的屏幕。同一时间只看一个人的；给空就谁的都不看。 */
  watchScreen(identity: string | null): void
  /** 这个人共享的屏幕（我自己的也可以）。没有画面时为空。 */
  screenTrack(identity: string): MediaStreamTrack | null
  videoStats(): Promise<RoomVideoStats>
  leave(): Promise<void>
}

type StatsEntry = Record<string, unknown> & { id: string; type: string }

/** 我这条线走的路：从一路声音的统计数据里找出正在用的那一对地址。 */
export interface RoomTransport {
  protocol: 'udp' | 'tcp' | null
  local: CandidateKind | null
  server: string | null
  roundTripMs: number | null
}

export function readRoomTransport(report: Iterable<StatsEntry>): RoomTransport {
  const entries = new Map<string, StatsEntry>()
  for (const entry of report) entries.set(entry.id, entry)
  const all = [...entries.values()]
  // 正在用的那一对：传输层记着它；有的浏览器没有，就找选中、成功的那一对
  const transport = all.find((entry) => entry.type === 'transport')
  const pairId = transport?.selectedCandidatePairId as string | undefined
  const pair =
    (pairId ? entries.get(pairId) : undefined) ??
    all.find(
      (entry) =>
        entry.type === 'candidate-pair' &&
        entry.state === 'succeeded' &&
        (entry.selected === true || entry.nominated === true),
    )
  const candidate = (id: unknown) => (typeof id === 'string' ? entries.get(id) : undefined)
  const local = pair ? candidate(pair.localCandidateId) : undefined
  const remote = pair ? candidate(pair.remoteCandidateId) : undefined
  const protocol = String(local?.protocol ?? remote?.protocol ?? '').toLowerCase()
  const address = remote?.address ?? remote?.ip
  const rtt = pair?.currentRoundTripTime
  return {
    protocol: protocol === 'udp' || protocol === 'tcp' ? protocol : null,
    local: (local?.candidateType as CandidateKind | undefined) ?? null,
    server: typeof address === 'string' && address ? `${address}:${remote?.port ?? '?'}` : null,
    roundTripMs: typeof rtt === 'number' ? Math.round(rtt * 1000) : null,
  }
}

/** 一路声音到现在收了或发了多少字节。`direction` 是 inbound（收）或 outbound（发）。 */
export function readAudioBytes(
  report: Iterable<StatsEntry>,
  direction: 'inbound' | 'outbound',
): number {
  let bytes = 0
  for (const entry of report) {
    if (entry.type !== `${direction}-rtp` || entry.kind !== 'audio') continue
    bytes += Number((direction === 'inbound' ? entry.bytesReceived : entry.bytesSent) ?? 0)
  }
  return bytes
}

type VideoEntry = { rid: string; width: number; height: number; fps: number; bytes: number }

/** 一路画面的统计数据里，每一档（发）或者这一路（收）的大小、帧率和字节数。 */
export function readVideoLayers(
  report: Iterable<StatsEntry>,
  direction: 'inbound' | 'outbound',
): VideoEntry[] {
  const layers: VideoEntry[] = []
  for (const entry of report) {
    if (entry.type !== `${direction}-rtp` || entry.kind !== 'video') continue
    layers.push({
      rid: typeof entry.rid === 'string' ? entry.rid : '',
      width: Number(entry.frameWidth ?? 0),
      height: Number(entry.frameHeight ?? 0),
      fps: Math.round(Number(entry.framesPerSecond ?? 0)),
      bytes: Number((direction === 'inbound' ? entry.bytesReceived : entry.bytesSent) ?? 0),
    })
  }
  // 小的在前。按档位的名字排（q、h、f），不按大小：停发的那一档大小是 0
  const order = (rid: string) => {
    const index = ['q', 'h', 'f'].indexOf(rid)
    return index < 0 ? 3 : index
  }
  return layers.sort((a, b) => order(a.rid) - order(b.rid))
}

/** 两次量的之间平均每秒多少千比特。量不出来（时间没走、数字变小了）时为空。 */
export function kbpsBetween(
  before: { bytes: number; at: number } | null,
  after: { bytes: number; at: number },
): number | null {
  if (!before) return null
  const ms = after.at - before.at
  if (ms <= 0 || after.bytes < before.bytes) return null
  return Math.round(((after.bytes - before.bytes) * 8) / ms)
}

/** 房间里的人排个序：我在最前面，其他人按身份排。 */
export function orderMembers(members: RoomMember[]): RoomMember[] {
  return [...members].sort((a, b) => {
    if (a.me !== b.me) return a.me ? -1 : 1
    return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0
  })
}

function entriesOf(report: RTCStatsReport | undefined): StatsEntry[] {
  const entries: StatsEntry[] = []
  report?.forEach((entry) => {
    entries.push(entry as StatsEntry)
  })
  return entries
}

/**
 * 凭入场凭证进房间，打开麦克风。房间里有变化（有人进出、说话、静音，连接断了又连上）时
 * 带着新的样子调 `onChange`；还没进去的时候就可能调到。
 *
 * 先拿麦克风，再进房间。拿不到麦克风、进不去（凭证不对、网络不通）时抛出错误，
 * 麦克风和连接都已经收拾干净。
 */
export async function joinRoom(
  ticket: RoomTicketView,
  onChange: (snapshot: RoomSnapshot) => void,
  options: {
    microphone?: MediaStream
    /** 视频通话：可以开摄像头、看别人的画面，按这组参数发两档。不给就是只有声音。 */
    video?: GroupVideoSettings
  } = {},
): Promise<RoomHandle> {
  const {
    DisconnectReason,
    Room,
    RoomEvent,
    Track,
    VideoPreset,
    VideoQuality,
    createLocalAudioTrack,
    createLocalVideoTrack,
  } = await import('livekit-client')
  const video = options.video
  // 先拿麦克风，再进房间：拿不到就不进去；并且有的浏览器（Firefox）在用户允许用麦克风之前
  // 找路很保守，先进房间的话可能连不上。调用方已经拿到了麦克风的话就用它的，不再要一次。
  // 自己拿时和一对一通话一样：回声消除、降噪、自动增益都开
  const given = options.microphone?.getAudioTracks()[0]
  const microphone =
    given ??
    (await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }))
  const stopMicrophone = () => {
    for (const track of options.microphone?.getTracks() ?? []) track.stop()
    if (!given) microphone.stop()
  }
  const room = new Room({
    // 看哪一档由我们自己定（watch），不让客户端库按显示的大小自动选
    adaptiveStream: false,
    // 有画面时：没有人要的那一档自动停发，不白白占上行
    dynacast: video !== undefined,
    // 页面关掉、刷新时马上离开，别人不用等超时
    disconnectOnPageLeave: true,
  })

  let phase: RoomPhase = 'connecting'
  let closedBecause: string | null = null
  // 别人的声音各放在一个 audio 元素里，挂在页面上（有的浏览器不挂上去不出声）
  const players = document.createElement('div')
  players.hidden = true
  players.dataset.room = ticket.room
  document.body.appendChild(players)

  let facing: CameraFacing = 'user'
  // 我的摄像头。关着时为空
  let camera: Awaited<ReturnType<typeof createLocalVideoTrack>> | null = null
  const stopCamera = () => {
    camera?.stop()
    camera = null
  }
  // 连接已经断了。写成函数：等了一会儿之后再问，答案可能变了
  const isClosed = () => phase === 'closed'
  // 开、关、换摄像头一件一件来：打开到一半时又点了一次，不能拿到两个摄像头、发出两路画面
  let cameraJobs: Promise<unknown> = Promise.resolve()
  const cameraJob = <T>(job: () => Promise<T>): Promise<T> => {
    const next = cameraJobs.then(job, job)
    cameraJobs = next.catch(() => {})
    return next
  }
  // 每个人的画面要哪一档；没说过的按小的
  const wanted = new Map<string, VideoLayer>()
  // 我共享出去的屏幕。没在共享时为空
  let screen: MediaStreamTrack | null = null
  let screenSender: RTCRtpSender | null = null
  const stopScreen = () => {
    screen?.stop()
    screen = null
    screenSender = null
  }
  // 看谁的屏幕
  let screenWanted: string | null = null

  /**
   * 有画面的房间里不自动订阅：声音都要，画面按 `wanted` 来。
   * 自动订阅的话，别人一开摄像头，清楚的那一档就先发过来了。
   */
  const subscribe = () => {
    if (!video) return
    for (const other of room.remoteParticipants.values()) {
      for (const publication of other.trackPublications.values()) {
        if (publication.kind === Track.Kind.Audio) {
          if (!publication.isDesired) publication.setSubscribed(true)
          continue
        }
        if (publication.source === Track.Source.ScreenShare) {
          // 同一时间只看一个人的屏幕；别人即使发了也不收
          const want = other.identity === screenWanted
          if (publication.isDesired !== want) publication.setSubscribed(want)
          continue
        }
        if (publication.source !== Track.Source.Camera) continue
        const layer = wanted.get(other.identity) ?? 'low'
        if (layer === 'off') {
          // 订阅过的只是停掉，不退订：退订再订的话，媒体转发服务会忘掉要的是哪一档，
          // 先把清楚的发过来
          if (publication.isDesired) publication.setEnabled(false)
          continue
        }
        if (!publication.isDesired) publication.setSubscribed(true)
        publication.setEnabled(true)
        publication.setVideoQuality(layer === 'high' ? VideoQuality.HIGH : VideoQuality.LOW)
      }
    }
  }

  const snapshot = (): RoomSnapshot => {
    const me = room.localParticipant
    const members: RoomMember[] = [
      {
        identity: me.identity,
        me: true,
        speaking: me.isSpeaking,
        muted: !me.isMicrophoneEnabled,
        camera: me.isCameraEnabled,
        paused: false,
        screen: screen !== null,
        screenPaused: false,
      },
    ]
    for (const other of room.remoteParticipants.values()) {
      members.push({
        identity: other.identity,
        me: false,
        speaking: other.isSpeaking,
        muted: !other.isMicrophoneEnabled,
        camera: other.isCameraEnabled,
        paused:
          other.getTrackPublication(Track.Source.Camera)?.track?.streamState ===
          Track.StreamState.Paused,
        screen: other.isScreenShareEnabled,
        screenPaused:
          other.getTrackPublication(Track.Source.ScreenShare)?.track?.streamState ===
          Track.StreamState.Paused,
      })
    }
    return {
      phase,
      members: phase === 'closed' ? [] : orderMembers(members),
      muted: !me.isMicrophoneEnabled,
      camera: me.isCameraEnabled,
      facing,
      screen: screen !== null,
      audioBlocked: phase !== 'closed' && !room.canPlaybackAudio,
      closedBecause,
    }
  }

  const cleanUp = () => {
    players.remove()
  }
  // 连接断了（自己离开、被请出去、网络断了恢复不了）：麦克风也放掉，浏览器上的指示灯才会灭
  const changed = () => onChange(snapshot())
  // 有人进来、有人开始发声音或画面：先定下要不要、要哪一档
  const published = () => {
    subscribe()
    changed()
  }

  room
    .on(RoomEvent.ParticipantConnected, published)
    .on(RoomEvent.ParticipantDisconnected, changed)
    .on(RoomEvent.ActiveSpeakersChanged, changed)
    .on(RoomEvent.TrackMuted, changed)
    .on(RoomEvent.TrackUnmuted, changed)
    .on(RoomEvent.TrackPublished, published)
    .on(RoomEvent.TrackUnpublished, changed)
    .on(RoomEvent.LocalTrackPublished, changed)
    .on(RoomEvent.LocalTrackUnpublished, changed)
    .on(RoomEvent.AudioPlaybackStatusChanged, changed)
    // 网络带不动时媒体转发服务暂停某一路画面，好了再恢复
    .on(RoomEvent.TrackStreamStateChanged, changed)
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) players.appendChild(track.attach())
      // 订阅成了再说一遍要哪一档：订阅之前说的不一定算数
      else subscribe()
      changed()
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) element.remove()
      changed()
    })
    .on(RoomEvent.Reconnecting, () => {
      phase = 'reconnecting'
      changed()
    })
    .on(RoomEvent.Reconnected, () => {
      phase = 'connected'
      changed()
    })
    .on(RoomEvent.Disconnected, (reason) => {
      phase = 'closed'
      // 原因是 LiveKit 定的一个编号，写成它的名字（例如 PARTICIPANT_REMOVED），排查时看得懂
      closedBecause =
        reason === undefined ? 'unknown' : (DisconnectReason[reason] ?? String(reason))
      stopMicrophone()
      stopCamera()
      stopScreen()
      cleanUp()
      changed()
    })

  try {
    // 不用任何找路服务器：媒体转发服务有公网地址，浏览器直接连它。
    // 明确给一个空的列表，LiveKit 交过来的（默认是 Google 的公共服务器）就不会被用上
    await room.connect(ticket.url, ticket.token, {
      rtcConfig: { iceServers: [] },
      autoSubscribe: video === undefined,
    })
    phase = 'connected'
    // 已经在房间里的人
    subscribe()
    await room.localParticipant.publishTrack(microphone, { source: Track.Source.Microphone })
  } catch (error) {
    phase = 'closed'
    await room.disconnect().catch(() => {})
    stopMicrophone()
    cleanUp()
    throw error
  }
  changed()

  /** 停止共享屏幕：不再往外发，把屏幕放掉。 */
  const endScreen = async () => {
    const track = screen
    if (!track) return
    stopScreen()
    // 先让界面知道已经停了，再去撤下这一路：屏幕是被浏览器自己停掉的时候，客户端库也在撤，
    // 两边撞在一起时这一步可能迟迟不回来（Firefox），不能让它卡住后面的开、关摄像头
    changed()
    const withdrawn = room.localParticipant.unpublishTrack(track, true).catch(() => {})
    await Promise.race([withdrawn, new Promise((resolve) => setTimeout(resolve, 3000))])
    changed()
  }

  let lastSentVideo = new Map<string, { bytes: number; at: number }>()
  let lastSentScreen: { bytes: number; at: number } | null = null
  let lastReceivedScreen: { bytes: number; at: number } | null = null
  let lastReceivedVideo = new Map<string, { bytes: number; at: number }>()

  let lastSent: { bytes: number; at: number } | null = null
  let lastReceived: { bytes: number; at: number } | null = null

  return {
    snapshot,
    async setMuted(muted) {
      await room.localParticipant.setMicrophoneEnabled(!muted)
      changed()
    },
    async startAudio() {
      await room.startAudio()
      changed()
    },
    async stats() {
      const at = Date.now()
      const mine = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
      const sent = entriesOf(await mine?.getRTCStatsReport())
      let bytesReceived = 0
      let received: StatsEntry[] = []
      for (const other of room.remoteParticipants.values()) {
        for (const publication of other.audioTrackPublications.values()) {
          const entries = entriesOf(await publication.track?.getRTCStatsReport())
          if (entries.length > 0) received = entries
          bytesReceived += readAudioBytes(entries, 'inbound')
        }
      }
      // 发和收可能各走一条连接；有发的就看发的那条，没有（比如静音了）看收的
      const transport = readRoomTransport(sent.length > 0 ? sent : received)
      const nowSent = { bytes: readAudioBytes(sent, 'outbound'), at }
      const nowReceived = { bytes: bytesReceived, at }
      const stats: RoomStats = {
        ...transport,
        bytesSent: nowSent.bytes,
        bytesReceived,
        sentKbps: kbpsBetween(lastSent, nowSent),
        receivedKbps: kbpsBetween(lastReceived, nowReceived),
      }
      lastSent = nowSent
      lastReceived = nowReceived
      return stats
    },
    setCamera(on) {
      return cameraJob(async () => {
        if (!video) throw new Error('this room has no video')
        if (isClosed()) return
        if (!on) {
          const track = camera
          camera = null
          if (track) await room.localParticipant.unpublishTrack(track, true)
          changed()
          return
        }
        if (camera) return
        const track = await createLocalVideoTrack({
          facingMode: facing,
          resolution: { width: video.high.width, height: video.high.height, frameRate: video.fps },
        })
        try {
          // 同时发两档：清楚的是这一路本身，小的是另加的一层。用各种浏览器都支持的 VP8
          await room.localParticipant.publishTrack(track, {
            source: Track.Source.Camera,
            videoCodec: 'vp8',
            simulcast: true,
            videoEncoding: { maxBitrate: video.high.kbps * 1000, maxFramerate: video.fps },
            videoSimulcastLayers: [
              new VideoPreset(video.low.width, video.low.height, video.low.kbps * 1000, video.fps),
            ],
          })
        } catch (error) {
          track.stop()
          throw error
        }
        // 打开的过程中连接断了：不留着摄像头
        if (isClosed()) {
          track.stop()
          return
        }
        camera = track
        changed()
      })
    },
    switchCamera(next) {
      return cameraJob(async () => {
        if (!video) throw new Error('this room has no video')
        if (camera && next !== facing) {
          await camera.restartTrack({
            facingMode: next,
            resolution: {
              width: video.high.width,
              height: video.high.height,
              frameRate: video.fps,
            },
          })
        }
        facing = next
        changed()
      })
    },
    setScreen(on, allowed) {
      return cameraJob(async () => {
        if (!video) throw new Error('this room has no video')
        if (!on) return endScreen()
        if (screen || isClosed()) return
        // 和一对一通话一样直接向浏览器要屏幕：能选什么由浏览器决定；不要电脑播放的声音
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { max: video.screen.maxWidth },
            frameRate: { ideal: video.screen.fps, max: video.screen.fps },
          },
          audio: false,
        })
        const track = stream.getVideoTracks()[0]
        if (!track) throw new DOMException('no screen picture', 'NotFoundError')
        // 告诉浏览器这是文字和图形：网络差时先降帧数，不降清晰度
        track.contentHint = 'detail'
        let ended = false
        // 用 onended，和一对一通话的写法一样（calls.ts）：这一路画面是我们自己要来的，没有别人在用这个位置
        track.onended = () => {
          ended = true
          if (screen === track) void cameraJob(endScreen)
        }
        // 屏幕拿到了，再问一下能不能发（同一时间只有一个人共享）
        try {
          await allowed?.()
        } catch (error) {
          track.stop()
          throw error
        }
        if (ended || isClosed()) {
          track.stop()
          return
        }
        // 从这里起就算在共享：发出去要一会儿，这期间用户用浏览器自己的"停止共享"也要算数
        screen = track
        changed()
        try {
          // 只发一档：小的一档字看不清，没有用
          const publication = await room.localParticipant.publishTrack(track, {
            source: Track.Source.ScreenShare,
            videoCodec: 'vp8',
            simulcast: false,
            screenShareEncoding: {
              maxBitrate: video.screen.kbps * 1000,
              maxFramerate: video.screen.fps,
            },
            degradationPreference: 'maintain-resolution',
          })
          if (screen === track) screenSender = publication.track?.sender ?? null
        } catch (error) {
          if (screen === track) stopScreen()
          else track.stop()
          changed()
          // 发到一半屏幕被停掉了：不算出错
          if (ended) return
          throw error
        }
        // 发的过程中连接断了、屏幕被停掉了：不留着
        if (isClosed() || ended) await endScreen()
      })
    },
    watchScreen(identity) {
      screenWanted = identity
      subscribe()
    },
    screenTrack(identity) {
      if (identity === room.localParticipant.identity) return screen
      for (const other of room.remoteParticipants.values()) {
        if (other.identity !== identity) continue
        const publication = other.getTrackPublication(Track.Source.ScreenShare)
        if (!publication?.isSubscribed || publication.isMuted) return null
        return publication.track?.mediaStreamTrack ?? null
      }
      return null
    },
    watch(identity, layer) {
      wanted.set(identity, layer)
      subscribe()
    },
    videoTrack(identity) {
      if (identity === room.localParticipant.identity) return camera?.mediaStreamTrack ?? null
      for (const other of room.remoteParticipants.values()) {
        if (other.identity !== identity) continue
        const publication = other.getTrackPublication(Track.Source.Camera)
        if (!publication?.isSubscribed || !publication.isEnabled || publication.isMuted) return null
        return publication.track?.mediaStreamTrack ?? null
      }
      return null
    },
    async videoStats() {
      const at = Date.now()
      const rate = (last: Map<string, { bytes: number; at: number }>, key: string, bytes: number) =>
        kbpsBetween(last.get(key) ?? null, { bytes, at })
      const sentNow = new Map<string, { bytes: number; at: number }>()
      const sent: SentVideoLayer[] = []
      for (const layer of readVideoLayers(
        entriesOf(await camera?.getRTCStatsReport()),
        'outbound',
      )) {
        sent.push({ ...layer, kbps: rate(lastSentVideo, layer.rid, layer.bytes) })
        sentNow.set(layer.rid, { bytes: layer.bytes, at })
      }
      const receivedNow = new Map<string, { bytes: number; at: number }>()
      const received: Record<string, RoomReceivedVideo> = {}
      for (const other of room.remoteParticipants.values()) {
        const publication = other.getTrackPublication(Track.Source.Camera)
        // 说了不要的那一路不算收到
        if (!publication?.isEnabled) continue
        const report = entriesOf(await publication.track?.getRTCStatsReport())
        const [layer] = readVideoLayers(report, 'inbound')
        if (!layer) continue
        const { rid: _rid, ...rest } = layer
        received[other.identity] = {
          ...rest,
          kbps: rate(lastReceivedVideo, other.identity, layer.bytes),
        }
        receivedNow.set(other.identity, { bytes: layer.bytes, at })
      }
      lastSentVideo = sentNow
      lastReceivedVideo = receivedNow

      // 我共享出去的屏幕
      let screenSent: SentScreen | null = null
      if (screen && screenSender) {
        const report = entriesOf(await screenSender.getStats().catch(() => undefined))
        const [layer] = readVideoLayers(report, 'outbound')
        const outbound = report.find(
          (entry) => entry.type === 'outbound-rtp' && entry.kind === 'video',
        )
        const settings = screen.getSettings()
        const preference = screenSender.getParameters().degradationPreference
        const now = { bytes: layer?.bytes ?? 0, at }
        screenSent = {
          capturedWidth: settings.width ?? 0,
          capturedHeight: settings.height ?? 0,
          width: layer?.width ?? 0,
          height: layer?.height ?? 0,
          fps: layer?.fps ?? 0,
          bytes: now.bytes,
          kbps: kbpsBetween(lastSentScreen, now),
          limitedBy:
            typeof outbound?.qualityLimitationReason === 'string'
              ? outbound.qualityLimitationReason
              : null,
          resolutionFirst: preference === undefined ? null : preference === 'maintain-resolution',
        }
        lastSentScreen = now
      } else {
        lastSentScreen = null
      }
      // 我正在看的屏幕
      let screenReceived: RoomReceivedVideo | null = null
      const sharer = [...room.remoteParticipants.values()].find(
        (other) => other.identity === screenWanted,
      )
      const shared = sharer?.getTrackPublication(Track.Source.ScreenShare)
      const [incoming] = readVideoLayers(
        entriesOf(await shared?.track?.getRTCStatsReport()),
        'inbound',
      )
      if (incoming) {
        const { rid: _rid, ...rest } = incoming
        const now = { bytes: incoming.bytes, at }
        screenReceived = { ...rest, kbps: kbpsBetween(lastReceivedScreen, now) }
        lastReceivedScreen = now
      } else {
        lastReceivedScreen = null
      }
      return { sent, received, screenSent, screenReceived }
    },
    async leave() {
      await room.disconnect()
    },
  }
}
