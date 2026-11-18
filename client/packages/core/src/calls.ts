// 通话的状态和音频连接（F3，设计文档 3.7 节）。不依赖 React，也不操作页面。
//
// 服务端掌握"谁在和谁通话、到了哪一步"，这里按它的推送（call.updated）切换状态；
// 音频连接（WebRTC）在接通之后才建立：主叫发 offer，被叫回 answer，候选地址边找边发（trickle），
// 都经过服务端转给对方通话里的那一台设备（call.signal）。
//
// 每个页面是一台"设备"，编号在页面打开时生成，连 WebSocket 和调通话接口时都带上。

import type {
  CallVideoView,
  CallView,
  CurrentCall,
  HangupReason,
  IceServers,
  RejectReason,
  ServerEvent,
} from '@vibechat/protocol'
import { ApiError, type ClientErrorCode } from './api'
import {
  acceptCall,
  fetchCurrentCall,
  fetchIceServers,
  hangUpCall,
  type ReceivedVideo,
  readCallPath,
  readReceivedVideo,
  readSentVideo,
  rejectCall,
  type SentVideo,
  sendCallSignal,
  startCall,
} from './call'

/** 这个页面的设备编号。页面刷新后是新的一台。 */
export function newDeviceId(): string {
  return `tab-${crypto.randomUUID()}`
}

export type CallPhase =
  /** 没有通话。 */
  | 'idle'
  /** 我在这台设备上打出去，对方在响铃。 */
  | 'outgoing'
  /** 有人打给我，在响铃。 */
  | 'incoming'
  /** 接通了，音频连接正在建立。 */
  | 'connecting'
  /** 通话中。 */
  | 'active'
  /** 我的通话在另一台设备上：主叫的其他设备，或者在别处接听了。 */
  | 'elsewhere'
  /** 刚结束，界面上显示一下结果，过一会儿回到 idle。 */
  | 'ended'

/** 麦克风为什么用不了。 */
export type MicrophoneProblem =
  /** 没有授权。 */
  | 'denied'
  /** 没有麦克风。 */
  | 'missing'
  /** 被别的程序占着。 */
  | 'busy'
  /** 浏览器不支持，或者页面不是在安全的地址上打开的。 */
  | 'unsupported'

export interface CallSnapshot {
  phase: CallPhase
  /** 服务端最后一次告诉我们的样子。idle 时为空。 */
  call: CallView | null
  /** 我是主叫还是被叫。 */
  role: 'caller' | 'callee' | null
  muted: boolean
  /** 音频接通的时刻（本机时间），用来显示通话时长。 */
  connectedAt: number | null
  /** 音频连接断了，正在恢复。 */
  unstable: boolean
  /** 对方的声音和画面。 */
  remote: MediaStream | null
  /** 我自己的画面（视频通话时），给自己看的小窗用。 */
  local: MediaStream | null
  /** 视频通话里我的摄像头开着。 */
  cameraOn: boolean
  /** 视频通话里对方的摄像头开着。 */
  peerCameraOn: boolean
  /** 用的是前置还是后置摄像头。前置的画面给自己看时像照镜子。 */
  facing: Facing
  /** 这一通在走中转：画面限了码率。 */
  relayed: boolean
  /** 连上之后走的是哪条路：直连还是中转（F7 Q7）。还没连上时为空。 */
  path: 'direct' | 'relay' | null
  /** 刚才的操作为什么没成功：接口的错误码。 */
  error: ClientErrorCode | null
  /** 麦克风用不了。 */
  microphone: MicrophoneProblem | null
  /** 摄像头用不了（视频通话照常进行，只是对方看不到我）。 */
  camera: MicrophoneProblem | null
  /** 我正在共享屏幕（F7）。 */
  sharing: boolean
  /** 对方正在共享屏幕。 */
  peerSharing: boolean
  /** 屏幕的画面拿不到。用户自己取消了不算。 */
  screen: ScreenProblem | null
}

/** 屏幕的画面为什么拿不到：浏览器或系统没有授权，或者这里根本不能共享。 */
export type ScreenProblem = 'denied' | 'unsupported'

export const IDLE: CallSnapshot = {
  phase: 'idle',
  call: null,
  role: null,
  muted: false,
  connectedAt: null,
  unstable: false,
  remote: null,
  local: null,
  cameraOn: false,
  peerCameraOn: true,
  facing: 'user',
  relayed: false,
  path: null,
  error: null,
  microphone: null,
  camera: null,
  sharing: false,
  peerSharing: false,
  screen: null,
}

/** 前置（user）还是后置（environment）摄像头。 */
export type Facing = 'user' | 'environment'

/**
 * 通话画面的参数由管理员在系统设置里调（F7 第 7 章），打电话前随中转账号一起取回来。
 * 取不到时用这一份，和服务端的默认值一样：共享屏幕最宽 2560、每秒 15 帧，直连 6 Mbps、
 * 走中转 1 Mbps；摄像头走中转 0.5 Mbps（大约 640×480），直连不限。
 */
export const DEFAULT_CALL_VIDEO: CallVideoView = {
  screen_max_width: 2560,
  screen_max_fps: 15,
  screen_direct_kbps: 6000,
  screen_relay_kbps: 1000,
  camera_relay_kbps: 500,
  group_camera_high_kbps: 400,
  group_camera_low_kbps: 120,
  group_screen_kbps: 1000,
}

/** 结束之后结果在界面上停留多久。 */
export const ENDED_DISPLAY_MS = 3000
/** 音频连接断了多久还没恢复，主叫就重新找路（ICE restart）。 */
export const RESTART_AFTER_MS = 4000
/** 音频连接断了多久还没恢复，就挂断，通话记录写"网络中断"。 */
export const GIVE_UP_AFTER_MS = 20_000

export interface CallApi {
  start(conversationId: string, device: string, video: boolean): Promise<CallView>
  accept(id: string, device: string): Promise<CallView>
  reject(id: string, reason?: RejectReason): Promise<CallView>
  hangUp(id: string, device: string, reason?: HangupReason): Promise<CallView>
  signal(id: string, device: string, signal: string): Promise<void>
  current(): Promise<CurrentCall>
  iceServers(): Promise<IceServers>
}

const http: CallApi = {
  start: (conversationId, device, video) => startCall(conversationId, device, video),
  accept: (id, device) => acceptCall(id, device),
  reject: (id, reason) => rejectCall(id, reason ?? null),
  hangUp: (id, device, reason) => hangUpCall(id, device, reason ?? null),
  signal: (id, device, signal) => sendCallSignal(id, device, signal),
  current: () => fetchCurrentCall(),
  iceServers: () => fetchIceServers(),
}

/** 麦克风、摄像头和音频连接从哪里来。测试时换成假的。 */
export interface CallMedia {
  microphone(): Promise<MediaStream>
  /** 只要画面，不要声音。 */
  camera(facing: Facing): Promise<MediaStream>
  /** 屏幕的画面：浏览器弹出选择框，选整个屏幕、某个窗口或者标签页。不要声音（F7 Q4）。 */
  screen(constraints: MediaTrackConstraints): Promise<MediaStream>
  peer(config: RTCConfiguration): RTCPeerConnection
}

/**
 * 通话用的麦克风：回声消除、降噪、自动增益都要开。浏览器默认一般都开着，这里写明，
 * 免得某个浏览器或者桌面端的默认值不一样。外放时对方听不到自己的回声，靠的就是回声消除。
 */
export const CALL_AUDIO: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/** 通话用的摄像头：前置，清晰度够看清人就行，省流量。 */
export const CALL_VIDEO: MediaTrackConstraints = {
  facingMode: 'user',
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24 },
}

/** 共享屏幕的画面：最宽多少、每秒最多几帧，按管理员的设置。高度按屏幕的比例。 */
export function screenConstraints(video: CallVideoView): MediaTrackConstraints {
  return {
    width: { max: video.screen_max_width },
    frameRate: { ideal: video.screen_max_fps, max: video.screen_max_fps },
  }
}

const browserMedia: CallMedia = {
  microphone: () => navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO }),
  camera: (facing) =>
    navigator.mediaDevices.getUserMedia({ video: { ...CALL_VIDEO, facingMode: facing } }),
  screen: (constraints) =>
    navigator.mediaDevices.getDisplayMedia({ video: constraints, audio: false }),
  peer: (config) => new RTCPeerConnection(config),
}

/**
 * 这个浏览器能不能共享屏幕。手机浏览器不能（F7 1 节）；有的手机浏览器有这个接口却用不了，
 * 所以触屏为主的设备一律算不能。
 */
export function canShareScreen(): boolean {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.mediaDevices?.getDisplayMedia !== 'function'
  ) {
    return false
  }
  return !(
    typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches
  )
}

/** 系统给没给录屏的权限。只有桌面端问得到（F7 T9）；浏览器里是 unknown。 */
export type ScreenAccess = 'granted' | 'denied' | 'unknown'

export interface CallControllerOptions {
  me: string
  device: string
  /** 拿不到屏幕的画面时问一下系统给没给权限：桌面端被拒绝时浏览器只说"取消了"。 */
  screenAccess?: () => Promise<ScreenAccess>
  api?: CallApi
  media?: CallMedia
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** 经过服务端转给对方的一段连接信息。 */
type Signal =
  | { kind: 'description'; description: RTCSessionDescriptionInit }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit }
  /** 视频通话里我的摄像头开了还是关了。 */
  | { kind: 'camera'; on: boolean }
  /** 我开始、停止共享屏幕了（F7）。 */
  | { kind: 'screen'; on: boolean }

export class CallController {
  private state: CallSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private readonly me: string
  private readonly device: string
  private readonly api: CallApi
  private readonly media: CallMedia
  private readonly now: () => number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly screenAccess: (() => Promise<ScreenAccess>) | null

  private microphone: MediaStream | null = null
  /** 视频通话里我的摄像头。关掉时为空，摄像头的灯也灭。 */
  private cameraStream: MediaStream | null = null
  /** 我正在共享的屏幕。 */
  private screenStream: MediaStream | null = null
  /** 开始共享时摄像头开着：停止共享后重新打开（F7 Q2）。 */
  private cameraBeforeSharing = false
  /** 这一通里共享过：重新连上之后再告诉对方一次现在共不共享，免得断开时的消息丢了。 */
  private sharedThisCall = false
  /** 最近一次连上时走的是不是中转。 */
  private relayedPath = false
  /** 这一通电话的画面参数：建立连接时随中转账号一起取回来。 */
  private video: CallVideoView = DEFAULT_CALL_VIDEO
  /** 共享屏幕时浏览器接受了"清晰度优先"没有。不在共享、还不知道时为空。 */
  private resolutionFirst: boolean | null = null
  private peer: RTCPeerConnection | null = null
  /** 对方的连接信息里先到的候选地址：对方的 offer 或 answer 还没用上时先存着。 */
  private pendingCandidates: RTCIceCandidateInit[] = []
  /** 正在发起：接口还没返回，推送可能先到。 */
  private starting = false
  private endedTimer: unknown = null
  /** 音频连接断开后的两个计时：重新找路、放弃。 */
  private restartTimer: unknown = null
  private giveUpTimer: unknown = null

  constructor(options: CallControllerOptions) {
    this.me = options.me
    this.device = options.device
    this.api = options.api ?? http
    this.media = options.media ?? browserMedia
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number))
    this.screenAccess = options.screenAccess ?? null
  }

  getState = (): CallSnapshot => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---------- 用户的操作 ----------

  /**
   * 在这个单聊里给对方打电话。先拿到麦克风（视频通话还有摄像头），再发起。
   * 摄像头拿不到时照常打视频电话，只是对方看不到我。
   */
  async start(conversationId: string, options: { video?: boolean } = {}): Promise<void> {
    if (this.busy()) return
    const video = options.video === true
    this.clearEnded()
    this.set({ ...IDLE })
    if (!(await this.takeMicrophone())) return
    if (video) await this.takeCamera()
    this.starting = true
    let call: CallView
    try {
      call = await this.api.start(conversationId, this.device, video)
    } catch (error) {
      this.releaseMedia()
      this.set({ ...IDLE, error: codeOf(error) })
      return
    } finally {
      this.starting = false
    }
    this.apply(call)
  }

  /**
   * 接听来电。先拿到麦克风、准备好音频连接，再告诉服务端。
   * 视频来电默认打开摄像头；`video: false` 是"语音接听"，之后随时可以再打开。
   */
  async accept(options: { video?: boolean } = {}): Promise<void> {
    const call = this.state.call
    if (this.state.phase !== 'incoming' || !call) return
    this.set({ error: null, microphone: null, camera: null })
    if (!(await this.takeMicrophone())) {
      // 接不了：结束这个通话，告诉主叫是麦克风的问题
      const problem = this.state.microphone
      try {
        this.apply(await this.api.reject(call.id, 'no_microphone'))
      } catch {
        // 已经在别处接了、对方已经挂了：推送会把状态带过去
      }
      this.set({ microphone: problem })
      return
    }
    if (call.video && options.video !== false) await this.takeCamera()
    try {
      await this.preparePeer(call.id)
      this.apply(await this.api.accept(call.id, this.device))
    } catch (error) {
      this.releaseMedia()
      // 在别处接了、对方已经挂了：推送会把状态带过去，这里只记下原因
      this.set({ error: codeOf(error) })
    }
  }

  /** 拒绝来电。 */
  async reject(): Promise<void> {
    const call = this.state.call
    if (this.state.phase !== 'incoming' || !call) return
    try {
      this.apply(await this.api.reject(call.id))
    } catch (error) {
      this.set({ error: codeOf(error) })
    }
  }

  /** 挂断：呼叫中是取消，通话中是结束。 */
  async hangUp(reason?: HangupReason): Promise<void> {
    const call = this.state.call
    const phase = this.state.phase
    if (!call || (phase !== 'outgoing' && phase !== 'connecting' && phase !== 'active')) return
    // 声音马上停，不等服务端
    this.releaseMedia()
    try {
      this.apply(await this.api.hangUp(call.id, this.device, reason))
    } catch (error) {
      // 通话在服务端已经没了：当它结束了
      this.finish(call, codeOf(error))
    }
  }

  toggleMute(): void {
    const muted = !this.state.muted
    for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = !muted
    this.set({ muted })
  }

  /** 视频通话里打开、关掉自己的摄像头。关掉时摄像头真的停下（灯灭），连接不断。 */
  async toggleCamera(): Promise<void> {
    const call = this.state.call
    // 共享屏幕时画面这一路给了屏幕：摄像头等停止共享后再说
    if (!call?.video || this.state.sharing) return
    if (this.state.cameraOn) {
      this.dropCamera()
      await this.videoSender()
        ?.replaceTrack(null)
        .catch(() => {})
    } else {
      if (!(await this.takeCamera())) return
      const track = this.cameraStream?.getVideoTracks()[0] ?? null
      await this.videoSender()
        ?.replaceTrack(track)
        .catch(() => {})
    }
    if (this.peer) this.send(call.id, { kind: 'camera', on: this.state.cameraOn })
  }

  /** 手机上切换前后摄像头。换上新的画面再停掉旧的，对方看到的画面不断。 */
  async switchCamera(): Promise<void> {
    if (!this.state.call?.video || !this.cameraStream) return
    const facing: Facing = this.state.facing === 'user' ? 'environment' : 'user'
    let next: MediaStream
    try {
      next = await this.media.camera(facing)
    } catch {
      // 换不了（例如只有一个摄像头）：照旧用现在这个
      return
    }
    const old = this.cameraStream
    this.cameraStream = next
    await this.videoSender()
      ?.replaceTrack(next.getVideoTracks()[0] ?? null)
      .catch(() => {})
    for (const track of old.getTracks()) track.stop()
    this.set({ local: next, facing })
  }

  /**
   * 开始共享屏幕（F7）：浏览器弹出选择框，选好之后画面这一路换成屏幕的画面，摄像头暂停。
   * 对方正在共享时不能共享（F7 Q3）。浏览器（Safari）要求在点击里直接弹出选择框，
   * 所以拿屏幕的画面放在最前面，前面不能有别的等待。
   */
  async startSharing(): Promise<void> {
    const call = this.state.call
    const phase = this.state.phase
    if (!call || (phase !== 'connecting' && phase !== 'active')) return
    if (this.state.sharing || this.state.peerSharing || this.screenStream) return
    let stream: MediaStream
    try {
      stream = await this.media.screen(screenConstraints(this.video))
    } catch (error) {
      let problem = screenProblem(error)
      // 看起来是取消了：也可能是系统没给权限（桌面端），问一下
      if (problem === null && this.screenAccess) {
        const access = await this.screenAccess().catch(() => 'unknown' as const)
        if (access === 'denied') problem = 'denied'
      }
      if (problem) this.set({ screen: problem })
      return
    }
    const sender = this.videoSender()
    const track = stream.getVideoTracks()[0]
    // 选的这一会儿：通话结束了、对方先共享了，或者对方的页面太旧、没有画面这一路
    if (!track || !sender || this.state.call?.id !== call.id || this.state.peerSharing) {
      for (const item of stream.getTracks()) item.stop()
      return
    }
    // 告诉浏览器这是文字和图形：网络差时先降帧数，不降清晰度
    track.contentHint = 'detail'
    this.screenStream = stream
    this.sharedThisCall = true
    this.cameraBeforeSharing = this.state.cameraOn
    if (this.cameraStream) this.dropCamera()
    // 换上画面之前就设好清晰度优先：有的浏览器（Safari）开头先按低清晰度发，之后不一定改得过来
    await this.limitVideo()
    await sender.replaceTrack(track).catch(() => {})
    // 用浏览器自己的"停止共享"也算停止
    track.onended = () => {
      if (this.screenStream === stream) void this.stopSharing()
    }
    this.set({ sharing: true })
    this.send(call.id, { kind: 'screen', on: true })
    await this.limitVideo()
  }

  /** 停止共享屏幕：画面这一路换回摄像头（开始共享时开着的话），或者空着。 */
  async stopSharing(): Promise<void> {
    const stream = this.screenStream
    if (!stream) return
    this.screenStream = null
    for (const track of stream.getTracks()) track.stop()
    this.set({ sharing: false })
    const call = this.state.call
    if (!call || !this.peer) return
    let track: MediaStreamTrack | null = null
    if (this.cameraBeforeSharing && (await this.takeCamera())) {
      track = this.cameraStream?.getVideoTracks()[0] ?? null
    }
    this.cameraBeforeSharing = false
    await this.videoSender()
      ?.replaceTrack(track)
      .catch(() => {})
    this.send(call.id, { kind: 'screen', on: false })
    this.announceCamera(call.id)
    await this.limitVideo()
  }

  /** 现在收到的画面多大、一共收了多少（F7 T17 的诊断小字）。没有连接、还没有画面时为空。 */
  async receivedVideo(): Promise<ReceivedVideo | null> {
    const peer = this.peer
    if (!peer) return null
    try {
      const report = await peer.getStats()
      return readReceivedVideo(report.values() as Iterable<never>)
    } catch {
      return null
    }
  }

  /**
   * 我共享屏幕时，发出去的画面怎么样（F7 的诊断小字）：屏幕本身多大、发出去多大、
   * 受什么限制、浏览器接受了"清晰度优先"没有。不在共享时为空。
   */
  async sharedVideo(): Promise<{
    captured: { width: number; height: number } | null
    sent: SentVideo | null
    resolutionFirst: boolean | null
  } | null> {
    const peer = this.peer
    const track = this.screenStream?.getVideoTracks()[0]
    if (!peer || !track) return null
    const settings = track.getSettings?.() ?? {}
    const captured =
      settings.width && settings.height ? { width: settings.width, height: settings.height } : null
    let sent: SentVideo | null = null
    try {
      sent = readSentVideo((await peer.getStats()).values() as Iterable<never>)
    } catch {
      sent = null
    }
    return { captured, sent, resolutionFirst: this.resolutionFirst }
  }

  /** 用户看过了出错的原因（接口的错误、麦克风、摄像头或屏幕用不了）。 */
  clearProblem(): void {
    const { error, microphone, camera, screen } = this.state
    if (error === null && microphone === null && camera === null && screen === null) return
    this.set({ error: null, microphone: null, camera: null, screen: null })
  }

  /** 关掉结束时显示的结果。 */
  dismiss(): void {
    if (this.state.phase !== 'ended' && this.state.phase !== 'idle') return
    this.clearEnded()
    this.set({ ...IDLE })
  }

  // ---------- 服务端的推送 ----------

  handleEvent(event: ServerEvent): void {
    if (event.type === 'call.updated') this.apply(event.data)
    else if (event.type === 'call.signal')
      void this.receiveSignal(event.data.call_id, event.data.signal)
  }

  /** 重新连上服务端之后：断开期间可能错过了推送，问一下现在的通话。 */
  async resync(): Promise<void> {
    let current: CurrentCall
    try {
      current = await this.api.current()
    } catch {
      return
    }
    if (current.call) {
      this.apply(current.call)
      return
    }
    // 服务端已经没有这个通话了
    const call = this.state.call
    if (call && this.state.phase !== 'ended') this.finish(call, null)
  }

  /** 退出登录、页面关闭时：放掉麦克风和连接。 */
  dispose(): void {
    this.clearEnded()
    this.releaseMedia()
    this.listeners.clear()
  }

  // ---------- 状态 ----------

  /** 按服务端的样子更新。 */
  private apply(call: CallView): void {
    const mine = this.state.call
    // 别的通话的推送：我已经在一个通话里时不理（服务端不会让一个人同时在两个通话里）
    if (mine && mine.id !== call.id && this.state.phase !== 'ended') return
    const role =
      call.caller_id === this.me ? 'caller' : call.callee_id === this.me ? 'callee' : null
    if (!role) return
    // 这台设备是不是通话里的那一台：发起的那一台，或者接听的那一台
    const here =
      role === 'caller' ? call.caller_device === this.device : call.callee_device === this.device

    if (call.state === 'ended') {
      if (here) {
        this.finish(call, null, role)
      } else if (mine?.id === call.id) {
        // 响铃的、在别处接听的设备：不显示结果，会话里的通话记录会说明
        this.releaseMedia()
        this.clearEnded()
        this.set({ ...IDLE })
      }
      return
    }

    // 这个通话已经结束过了：迟到的推送不再把它拉回来
    if (this.state.phase === 'ended' && mine?.id === call.id) return

    if (call.state === 'ringing') {
      if (role === 'callee') {
        this.set({ ...IDLE, phase: 'incoming', call, role })
      } else if (here) {
        this.set({ phase: 'outgoing', call, role })
      } else {
        this.set({ ...IDLE, phase: 'elsewhere', call, role })
      }
      return
    }

    // 接通了
    if (!here) {
      this.releaseMedia()
      this.set({ ...IDLE, phase: 'elsewhere', call, role })
      return
    }
    const already = this.state.phase === 'connecting' || this.state.phase === 'active'
    this.set({ call, role, phase: already ? this.state.phase : 'connecting' })
    if (!already && role === 'caller') void this.offer(call.id)
  }

  /** 通话结束：放掉麦克风和连接，显示一会儿结果。 */
  private finish(
    call: CallView,
    error: ClientErrorCode | null,
    role: CallSnapshot['role'] = this.state.role,
  ): void {
    this.releaseMedia()
    this.clearEnded()
    this.set({ ...IDLE, phase: 'ended', call, role, error })
    this.endedTimer = this.setTimer(() => {
      this.endedTimer = null
      if (this.state.phase === 'ended') this.set({ ...IDLE })
    }, ENDED_DISPLAY_MS)
  }

  private busy(): boolean {
    const phase = this.state.phase
    return this.starting || (phase !== 'idle' && phase !== 'ended')
  }

  private clearEnded(): void {
    if (this.endedTimer !== null) this.clearTimer(this.endedTimer)
    this.endedTimer = null
  }

  private set(patch: Partial<CallSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  // ---------- 麦克风和音频连接 ----------

  /** 打开摄像头。拿不到时记下原因，返回 false。 */
  private async takeCamera(): Promise<boolean> {
    if (this.cameraStream) return true
    try {
      this.cameraStream = await this.media.camera(this.state.facing)
      this.set({ local: this.cameraStream, cameraOn: true, camera: null })
      return true
    } catch (error) {
      this.set({ camera: microphoneProblem(error), cameraOn: false })
      return false
    }
  }

  private dropCamera(): void {
    for (const track of this.cameraStream?.getTracks() ?? []) track.stop()
    this.cameraStream = null
    this.set({ local: null, cameraOn: false })
  }

  /**
   * 每次连上（包括断网恢复、换了路之后）都看一遍走的是哪条路，再按它给画面限码率。
   */
  private async checkPath(peer: RTCPeerConnection): Promise<void> {
    try {
      const report = await peer.getStats()
      const path = readCallPath(report.values() as Iterable<never>)
      if (peer !== this.peer) return
      this.relayedPath = path.local === 'relay' || path.remote === 'relay'
      this.set({ relayed: this.relayedPath, path: this.relayedPath ? 'relay' : 'direct' })
    } catch {
      return
    }
    await this.limitVideo()
  }

  /**
   * 按管理员的设置给画面限码率：共享屏幕直连、中转各有上限；摄像头走中转时有上限，直连时不限。
   * 共享屏幕时清晰度优先，网络差时先降帧数。
   */
  private async limitVideo(): Promise<void> {
    const sender = this.videoSender()
    if (!sender) return
    const sharing = this.screenStream !== null
    const kbps = sharing
      ? this.relayedPath
        ? this.video.screen_relay_kbps
        : this.video.screen_direct_kbps
      : this.relayedPath
        ? this.video.camera_relay_kbps
        : null
    const parameters = sender.getParameters()
    const encodings = parameters.encodings?.length ? parameters.encodings : [{}]
    for (const encoding of encodings) {
      if (kbps === null) delete encoding.maxBitrate
      else encoding.maxBitrate = kbps * 1000
      if (sharing) {
        // 不缩小，帧数按设置
        encoding.scaleResolutionDownBy = 1
        encoding.maxFramerate = this.video.screen_max_fps
      } else {
        delete encoding.scaleResolutionDownBy
        delete encoding.maxFramerate
      }
    }
    const preference: RTCDegradationPreference = sharing ? 'maintain-resolution' : 'balanced'
    try {
      await sender.setParameters({ ...parameters, encodings, degradationPreference: preference })
    } catch {
      // 有的浏览器不认清晰度优先：只限码率
      await sender.setParameters({ ...parameters, encodings }).catch(() => {})
    }
    // 浏览器接受了没有：读回来看（诊断小字里要说）
    const now = sender.getParameters() as RTCRtpSendParameters & {
      degradationPreference?: RTCDegradationPreference
    }
    this.resolutionFirst = sharing ? now.degradationPreference === 'maintain-resolution' : null
  }

  /** 发画面的那一路。每通电话都有（F7 起语音通话也有，平时空着）。 */
  private videoSender(): RTCRtpSender | null {
    const transceiver = this.peer
      ?.getTransceivers()
      .find((item) => item.receiver.track?.kind === 'video')
    return transceiver?.sender ?? null
  }

  /** 拿到麦克风。拿不到时记下原因，返回 false。 */
  private async takeMicrophone(): Promise<boolean> {
    if (this.microphone) return true
    try {
      this.microphone = await this.media.microphone()
      return true
    } catch (error) {
      this.set({ microphone: microphoneProblem(error) })
      return false
    }
  }

  /** 建好音频连接，带上我的麦克风。 */
  private async preparePeer(callId: string): Promise<RTCPeerConnection> {
    if (this.peer) return this.peer
    const servers = await this.api.iceServers().catch(() => null)
    this.video = servers?.video ?? DEFAULT_CALL_VIDEO
    const peer = this.media.peer({
      // 只用我们自己的中转服务，不配任何公共服务（需求 NFR-PRI-04）
      iceServers: servers?.ice_servers ?? [],
    })
    this.peer = peer
    for (const track of this.microphone?.getTracks() ?? []) {
      track.enabled = !this.state.muted
      peer.addTrack(track, this.microphone as MediaStream)
    }
    // 主叫：一开始就带上画面这一路。摄像头关着、语音通话也带上（空着不传任何东西），
    // 之后打开摄像头、共享屏幕时换上画面，不用重新协商（F7 T1）。
    // 被叫的这一路由对方的 offer 带来，见 receiveSignal
    if (this.state.role === 'caller') {
      const track = this.cameraStream?.getVideoTracks()[0]
      if (track) {
        peer.addTransceiver(track, {
          direction: 'sendrecv',
          streams: [this.cameraStream as MediaStream],
        })
      } else {
        peer.addTransceiver('video', { direction: 'sendrecv' })
      }
    }
    peer.addEventListener('icecandidate', (event) => {
      if (event.candidate && peer === this.peer) {
        this.send(callId, { kind: 'candidate', candidate: event.candidate.toJSON() })
      }
    })
    peer.addEventListener('track', (event) => {
      if (peer !== this.peer) return
      this.set({ remote: withTrack(this.state.remote, event.track, event.streams[0]) })
    })
    peer.addEventListener('connectionstatechange', () => {
      if (peer !== this.peer) return
      const state = peer.connectionState
      if (state === 'connected') {
        this.stopRecovery()
        void this.checkPath(peer)
        // 断开期间告诉对方的可能丢了：再说一次现在共不共享
        if (this.sharedThisCall) this.send(callId, { kind: 'screen', on: this.state.sharing })
        this.set({
          phase: 'active',
          unstable: false,
          connectedAt: this.state.connectedAt ?? this.now(),
        })
      } else if (state === 'disconnected' || state === 'failed') {
        this.set({ unstable: true })
        this.recover(callId, state === 'failed')
      }
    })
    return peer
  }

  /**
   * 音频连接断了：先等它自己恢复（网络短暂抖动）；还不行，主叫重新找路（换网络时，
   * 例如从 Wi-Fi 切到手机网络，原来的路走不通了）；一直恢复不了就挂断，记为网络中断。
   */
  private recover(callId: string, failed: boolean): void {
    if (this.state.role === 'caller') {
      if (failed) this.restartIce(callId)
      else if (this.restartTimer === null) {
        this.restartTimer = this.setTimer(() => {
          this.restartTimer = null
          this.restartIce(callId)
        }, RESTART_AFTER_MS)
      }
    }
    if (this.giveUpTimer === null) {
      this.giveUpTimer = this.setTimer(() => {
        this.giveUpTimer = null
        if (this.state.call?.id === callId && this.state.unstable) void this.hangUp('network')
      }, GIVE_UP_AFTER_MS)
    }
  }

  /** 重新找路：带着 iceRestart 再发一次 offer，对方照常回 answer。 */
  private restartIce(callId: string): void {
    const peer = this.peer
    if (!peer || this.state.call?.id !== callId) return
    void (async () => {
      try {
        await peer.setLocalDescription(await peer.createOffer({ iceRestart: true }))
        const description = peer.localDescription
        if (description && peer === this.peer) {
          this.send(callId, { kind: 'description', description: description.toJSON() })
        }
      } catch {
        // 下一次断开、或者放弃的计时会接着处理
      }
    })()
  }

  private stopRecovery(): void {
    if (this.restartTimer !== null) this.clearTimer(this.restartTimer)
    if (this.giveUpTimer !== null) this.clearTimer(this.giveUpTimer)
    this.restartTimer = null
    this.giveUpTimer = null
  }

  /** 主叫：接通后发出 offer。 */
  private async offer(callId: string): Promise<void> {
    try {
      const peer = await this.preparePeer(callId)
      await peer.setLocalDescription(await peer.createOffer())
      const description = peer.localDescription
      if (description) {
        this.send(callId, { kind: 'description', description: description.toJSON() })
        this.announceCamera(callId)
      }
    } catch {
      this.set({ unstable: true })
    }
  }

  private async receiveSignal(callId: string, text: string): Promise<void> {
    if (this.state.call?.id !== callId) return
    let signal: Signal
    try {
      signal = JSON.parse(text) as Signal
    } catch {
      return
    }
    try {
      const peer = await this.preparePeer(callId)
      if (signal.kind === 'camera') {
        this.set({ peerCameraOn: signal.on })
        return
      }
      if (signal.kind === 'screen') {
        // 两边几乎同时点了共享：让给对方
        if (signal.on && this.state.sharing) await this.stopSharing()
        this.set({ peerSharing: signal.on })
        return
      }
      if (signal.kind === 'candidate') {
        if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate)
        else this.pendingCandidates.push(signal.candidate)
        return
      }
      const first = !peer.remoteDescription
      await peer.setRemoteDescription(signal.description)
      for (const candidate of this.pendingCandidates.splice(0)) {
        await peer.addIceCandidate(candidate)
      }
      if (signal.description.type === 'offer') {
        // 视频通话的被叫：对方的 offer 带来了画面这一路，换上我的摄像头，两边都能看到
        const sender = this.videoSender()
        const track = this.cameraStream?.getVideoTracks()[0]
        if (first && sender && track) await sender.replaceTrack(track)
        for (const transceiver of peer.getTransceivers()) {
          if (transceiver.receiver.track?.kind === 'video') transceiver.direction = 'sendrecv'
        }
        await peer.setLocalDescription(await peer.createAnswer())
        const answer = peer.localDescription
        if (answer) this.send(callId, { kind: 'description', description: answer.toJSON() })
        if (first) this.announceCamera(callId)
      }
    } catch {
      this.set({ unstable: true })
    }
  }

  /** 视频通话：告诉对方我的摄像头开没开。 */
  private announceCamera(callId: string): void {
    if (this.state.call?.video) this.send(callId, { kind: 'camera', on: this.state.cameraOn })
  }

  private send(callId: string, signal: Signal): void {
    this.api.signal(callId, this.device, JSON.stringify(signal)).catch(() => {})
  }

  private releaseMedia(): void {
    this.stopRecovery()
    this.peer?.close()
    this.peer = null
    this.pendingCandidates = []
    for (const track of this.microphone?.getTracks() ?? []) track.stop()
    this.microphone = null
    if (this.cameraStream) this.dropCamera()
    for (const track of this.screenStream?.getTracks() ?? []) track.stop()
    this.screenStream = null
    this.cameraBeforeSharing = false
    this.sharedThisCall = false
    this.relayedPath = false
    this.video = DEFAULT_CALL_VIDEO
    this.resolutionFirst = null
  }
}

/**
 * 对方的声音和画面放在同一个 MediaStream 里。有的浏览器在后来换上的画面上不带 stream，
 * 这时自己并进去；每次都换一个新的对象，界面才知道变了。
 */
function withTrack(
  current: MediaStream | null,
  track: MediaStreamTrack,
  stream: MediaStream | undefined,
): MediaStream | null {
  if (typeof MediaStream === 'undefined') return stream ?? current
  const tracks = [...(current?.getTracks() ?? []), ...(stream?.getTracks() ?? []), track]
  const unique = tracks.filter(
    (item, at) => tracks.findIndex((other) => other.id === item.id) === at,
  )
  return new MediaStream(unique)
}

function codeOf(error: unknown): ClientErrorCode {
  return error instanceof ApiError ? error.code : 'network_error'
}

/**
 * 拿不到屏幕的画面时浏览器给的错误，换成原因。用户在选择框里点了取消也是"不允许"，
 * 这时不用说什么；系统没有授权（macOS 的"录屏"权限）时 Chrome 的说明里带着 system。
 */
export function screenProblem(error: unknown): ScreenProblem | null {
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  const message = error instanceof Error || error instanceof DOMException ? error.message : ''
  switch (name) {
    case 'NotAllowedError':
      return /system/i.test(message) ? 'denied' : null
    case 'NotReadableError':
      return 'denied'
    case 'AbortError':
      return null
    default:
      return 'unsupported'
  }
}

/** 浏览器拿不到麦克风时给的错误，换成原因。 */
export function microphoneProblem(error: unknown): MicrophoneProblem {
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'missing'
    case 'NotReadableError':
    case 'AbortError':
      return 'busy'
    default:
      return 'unsupported'
  }
}
