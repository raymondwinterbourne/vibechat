// 群通话的状态（F10）：我所在的群里有哪些通话在进行、谁在邀请我、我在不在某个通话里，
// 以及我在通话里时声音的连接。不依赖界面：界面订阅它，按它的样子画。
//
// 谁在通话里、通话什么时候结束由服务端说了算，这里跟着服务端的推送（`group_call.updated`）更新。
// 声音不经过服务端：进了通话的人凭入场凭证连到媒体转发服务，"谁在说话""谁静音了"是从那条连接上知道的。
//
// 一个人同一时间只能在一个通话里。这里只管群通话；一对一通话在 calls.ts 里，界面上两边一起看。
//
// 视频通话（F11）：通话是语音还是视频在发起时定下来。视频通话里可以开关摄像头；
// 别人的每一路画面收哪一档按 groupVideo.ts 的规则，跟着"谁开着摄像头、我放大了谁、屏幕上显示着谁"变。
//
// 共享屏幕（F12）：语音通话、视频通话里都可以。谁在共享由服务端说了算（通话上的 `sharing`），
// 同一时间只有一个人：要共享先问服务端，成了再向浏览器要屏幕、往外发；只收服务端说的那个人的屏幕。

import type {
  GroupCallJoined,
  GroupCallList,
  GroupCallView,
  RoomTicketView,
  ServerEvent,
} from '@vibechat/protocol'
import { ApiError, type ClientErrorCode } from './api'
import { fetchIceServers } from './call'
import {
  CALL_AUDIO,
  type MicrophoneProblem,
  microphoneProblem,
  type ScreenProblem,
  screenProblem,
} from './calls'
import {
  declineGroupCall,
  fetchGroupCalls,
  inviteToGroupCall,
  joinGroupCall,
  leaveGroupCall,
  shareGroupScreen,
  startGroupCall,
  unshareGroupScreen,
} from './groupCall'
import { groupVideoSettings, layersToWatch } from './groupVideo'
import {
  type CameraFacing,
  GROUP_VIDEO,
  type GroupVideoSettings,
  joinRoom,
  type RoomHandle,
  type RoomReceivedVideo,
  type RoomSnapshot,
  type SentScreen,
  type VideoLayer,
} from './room'

export type GroupCallPhase =
  /** 我不在任何群通话里（在这台设备上）。 */
  | 'idle'
  /** 正在进：拿麦克风、向服务端报到、连媒体转发服务。 */
  | 'joining'
  /** 在通话里，声音连着。 */
  | 'active'
  /** 在通话里，声音的连接断了，正在恢复。 */
  | 'reconnecting'

/** 我为什么不在刚才的通话里了。自己离开的不算。 */
export type GroupCallClosed =
  /** 通话结束了（别人都走了、群解散了）。 */
  | 'ended'
  /** 我被请出了通话：被移出了群，或者在别的设备上进了这个通话。 */
  | 'removed'
  /** 声音的连接断了，恢复不了。 */
  | 'lost'

export interface GroupCallSnapshot {
  /** 我所在的群里正在进行的通话，按群的会话编号。 */
  calls: Readonly<Record<string, GroupCallView>>
  phase: GroupCallPhase
  /** 我在这台设备上所在的（或者正在进的）通话。 */
  current: GroupCallView | null
  /** 我的麦克风关着。 */
  muted: boolean
  /** 通话里正在说话的人（用户编号）。 */
  speaking: readonly string[]
  /** 通话里把麦克风关了的人（用户编号）。 */
  silent: readonly string[]
  /** 声音接通的时刻（本机时间），用来显示我在通话里多久了。 */
  connectedAt: number | null
  /** 浏览器不让自动放声音，要用户点一下。 */
  audioBlocked: boolean
  /** 我的摄像头开着。只有视频通话里才可能。 */
  camera: boolean
  /** 我用的是哪一个摄像头。朝着自己的那个，自己看到的画面要左右镜像。 */
  facing: CameraFacing
  /** 通话里开着摄像头的人（用户编号），包括我自己。 */
  cameras: readonly string[]
  /**
   * 画面被暂停了的人：我这边的网络带不动，媒体转发服务先保住声音。界面上那一格显示头像和"画面已暂停"。
   * 我自己说了不要的（滚到屏幕外面的）不算。
   */
  paused: readonly string[]
  /**
   * 我放大了谁的那一格。没有放大谁时是格子。别人共享的屏幕也是一格，放大的是它时这里是 `SCREEN_TILE`；
   * 有人开始共享时自动放大它（F12 的 Q7）。
   */
  enlarged: string | null
  /** 我正在共享屏幕（屏幕已经拿到了）。谁在共享看通话上的 `sharing`。 */
  sharing: boolean
  /** 我在看的那个人的屏幕被媒体转发服务暂停了：我这边的网络带不动。网络好了自己会恢复。 */
  screenPaused: boolean
  /** 屏幕拿不到：浏览器或系统没有授权。用户自己取消的不算。 */
  screenProblem: ScreenProblem | null
  /** 刚才的操作为什么没成功：接口的错误码。 */
  error: ClientErrorCode | null
  /** 麦克风用不了。 */
  microphone: MicrophoneProblem | null
  /** 摄像头用不了。通话照常进行，只是别人看不到我。 */
  cameraProblem: MicrophoneProblem | null
  /** 我不是自己离开的：为什么不在通话里了。界面提示一下，然后清掉。 */
  closed: GroupCallClosed | null
}

export const IDLE_GROUP_CALL: GroupCallSnapshot = {
  calls: {},
  phase: 'idle',
  current: null,
  muted: false,
  speaking: [],
  silent: [],
  connectedAt: null,
  audioBlocked: false,
  camera: false,
  facing: 'user',
  cameras: [],
  paused: [],
  enlarged: null,
  sharing: false,
  screenPaused: false,
  screenProblem: null,
  error: null,
  microphone: null,
  cameraProblem: null,
  closed: null,
}

export interface GroupCallApi {
  start(
    conversationId: string,
    device: string,
    invite: string[],
    video: boolean,
  ): Promise<GroupCallJoined>
  join(id: string, device: string): Promise<GroupCallJoined>
  invite(id: string, userIds: string[]): Promise<GroupCallView>
  decline(id: string): Promise<GroupCallView>
  leave(id: string, device: string): Promise<GroupCallView>
  list(): Promise<GroupCallList>
  /** 开始共享屏幕：先问服务端，已经有别人在共享时不行。 */
  share(id: string, device: string): Promise<GroupCallView>
  unshare(id: string, device: string): Promise<GroupCallView>
  /** 群视频的画面参数：两档的码率由管理员在系统设置里定。进视频通话时现取，改了之后进来的人就按新的发。 */
  videoSettings(): Promise<GroupVideoSettings>
}

const http: GroupCallApi = {
  start: (conversationId, device, invite, video) =>
    startGroupCall(conversationId, device, invite, video),
  join: (id, device) => joinGroupCall(id, device),
  invite: (id, userIds) => inviteToGroupCall(id, userIds),
  decline: (id) => declineGroupCall(id),
  leave: (id, device) => leaveGroupCall(id, device),
  list: () => fetchGroupCalls(),
  share: (id, device) => shareGroupScreen(id, device),
  unshare: (id, device) => unshareGroupScreen(id, device),
  videoSettings: async () => groupVideoSettings((await fetchIceServers()).video),
}

/** 麦克风和声音的连接从哪里来。测试时换成假的。 */
export interface GroupCallMedia {
  microphone(): Promise<MediaStream>
  /**
   * 凭入场凭证连到媒体转发服务，用这个麦克风。房间里有变化时调 `onChange`。
   * 带着画面的参数：可以共享屏幕、看别人的屏幕，视频通话里还可以开摄像头、看别人的画面。
   */
  join(
    ticket: RoomTicketView,
    microphone: MediaStream,
    onChange: (snapshot: RoomSnapshot) => void,
    video?: GroupVideoSettings,
  ): Promise<RoomHandle>
}

const browserMedia: GroupCallMedia = {
  microphone: () => navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO }),
  join: (ticket, microphone, onChange, video) => joinRoom(ticket, onChange, { microphone, video }),
}

export interface GroupCallControllerOptions {
  me: string
  device: string
  api?: GroupCallApi
  media?: GroupCallMedia
  now?: () => number
}

/** 这个通话里有没有这个人。 */
export function inGroupCall(call: GroupCallView, user: string): boolean {
  return call.participants.some((entry) => entry.user_id === user)
}

/** 这个通话是不是正在邀请这个人（他的设备该响铃）。 */
export function ringsFor(call: GroupCallView, user: string): boolean {
  return !inGroupCall(call, user) && call.ringing.some((invite) => invite.user_id === user)
}

/** 别人共享的屏幕在通话界面里也是一格：放大的是它时，`enlarged` 是这个值。 */
export const SCREEN_TILE = 'screen'

/** 通话是不是满了。已经在里面的人不受影响。 */
export function groupCallFull(call: GroupCallView): boolean {
  return call.participants.length >= call.limit
}

export class GroupCallController {
  private state: GroupCallSnapshot = IDLE_GROUP_CALL
  private readonly listeners = new Set<() => void>()
  private readonly me: string
  private readonly device: string
  private readonly api: GroupCallApi
  private readonly media: GroupCallMedia
  private readonly now: () => number

  private room: RoomHandle | null = null
  /** 每进一次通话加一：过期的那一次进到一半时，结果不能再算数。 */
  private attempt = 0
  /** 我自己正在离开：这时连接断开不是意外。 */
  private leaving = false
  /** 现在显示在屏幕上的人。为空表示不知道，都当作看得到。 */
  private visible: ReadonlySet<string> | null = null
  /** 通话缩小了。 */
  private compact = false
  /** 已经告诉过声音和画面的连接、每一路要哪一档。 */
  private watching = new Map<string, VideoLayer>()
  /** 已经告诉过连接要看谁的屏幕。 */
  private watchingScreen: string | null = null
  /** 我的屏幕已经在往外发了：之后它没有了，就是用浏览器自己的"停止共享"停掉的。 */
  private screenOut = false

  constructor(options: GroupCallControllerOptions) {
    this.me = options.me
    this.device = options.device
    this.api = options.api ?? http
    this.media = options.media ?? browserMedia
    this.now = options.now ?? Date.now
  }

  getState = (): GroupCallSnapshot => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 这个群正在进行的通话。 */
  callIn(conversationId: string): GroupCallView | null {
    return this.state.calls[conversationId] ?? null
  }

  /** 正在邀请我的通话：我的设备该响铃。我已经在一个群通话里时不响。 */
  ringing(): GroupCallView | null {
    if (this.state.phase !== 'idle') return null
    const calls = Object.values(this.state.calls)
    // 我在别的设备上已经在某个通话里了：也不响
    if (calls.some((call) => inGroupCall(call, this.me))) return null
    return calls.find((call) => ringsFor(call, this.me)) ?? null
  }

  /** 我在另一台设备上所在的通话。 */
  elsewhere(): GroupCallView | null {
    return (
      Object.values(this.state.calls).find((call) =>
        call.participants.some(
          (entry) => entry.user_id === this.me && entry.device !== this.device,
        ),
      ) ?? null
    )
  }

  // ---------- 用户的操作 ----------

  /**
   * 在这个群里发起通话，邀请这些人。先拿到麦克风，再发起：拿不到就不发起，不会白白让别人响铃。
   * `video`：发起的是视频通话，我的摄像头随之打开（打不开的话通话照常，只是别人看不到我）。
   */
  start(conversationId: string, invite: string[], video = false): Promise<void> {
    return this.enter((device) => this.api.start(conversationId, device, invite, video), video)
  }

  /**
   * 加入一个正在进行的通话。`camera`：进去之后打开摄像头，只对视频通话有用。
   * 从邀请的卡片加入时开，从"通话进行中"的横条加入时不开（F11 的 Q10、Q11）。
   */
  join(callId: string, options: { camera?: boolean } = {}): Promise<void> {
    return this.enter((device) => this.api.join(callId, device), options.camera ?? false)
  }

  /** 不理会邀请：我的设备都不再响。 */
  async decline(callId: string): Promise<void> {
    try {
      this.apply(await this.api.decline(callId))
    } catch (error) {
      this.fail(error)
    }
  }

  /** 再邀请几个人：他们的设备响铃一次。 */
  async invite(userIds: string[]): Promise<void> {
    const call = this.state.current
    if (!call || userIds.length === 0) return
    try {
      this.apply(await this.api.invite(call.id, userIds))
    } catch (error) {
      this.fail(error)
    }
  }

  /** 离开通话。 */
  async leave(): Promise<void> {
    const call = this.state.current
    if (!call) return
    this.attempt += 1
    this.leaving = true
    const room = this.room
    this.room = null
    this.set({ ...this.outOfCall(), calls: this.state.calls })
    await room?.leave().catch(() => {})
    this.leaving = false
    try {
      this.apply(await this.api.leave(call.id, this.device))
    } catch {
      // 没告诉到服务端：下一次同步时会发现"服务端以为我还在"，那时再说一次
    }
  }

  async toggleMute(): Promise<void> {
    const room = this.room
    if (!room) return
    const muted = !this.state.muted
    this.set({ ...this.state, muted })
    await room.setMuted(muted).catch(() => {})
  }

  /** 打开、关掉我的摄像头。只在视频通话里有用。 */
  async toggleCamera(): Promise<void> {
    const room = this.room
    if (!room || !this.state.current?.video) return
    if (this.state.camera) await room.setCamera(false).catch(() => {})
    else await this.turnCameraOn(this.attempt)
  }

  /** 换一个摄像头：手机上切换前后。 */
  async flipCamera(): Promise<void> {
    const room = this.room
    if (!room || !this.state.current?.video) return
    const attempt = this.attempt
    try {
      await room.switchCamera(this.state.facing === 'user' ? 'environment' : 'user')
    } catch (error) {
      // 另一个摄像头用不了：原来的也已经停了，按摄像头关着算
      if (attempt === this.attempt) {
        await room.setCamera(false).catch(() => {})
        this.set({ ...this.state, cameraProblem: microphoneProblem(error) })
      }
    }
  }

  /**
   * 开始共享我的屏幕。要在用户点击的时候直接调：浏览器要求选择框马上弹出。
   *
   * 先向浏览器要屏幕，拿到了再问服务端（同一时间只有一个人共享），它同意了才往外发；
   * 哪一步不成，屏幕都放掉，服务端那里也不留着"我在共享"。用户在选择框里取消的不算出错。
   */
  async shareScreen(): Promise<void> {
    const room = this.room
    const call = this.state.current
    if (!room || !call || this.state.phase === 'joining' || this.state.sharing) return
    // 已经知道有别人在共享：不用弹选择框
    if (call.sharing !== null && call.sharing !== this.me) {
      this.set({ ...this.state, error: 'group_call_sharing' })
      return
    }
    const attempt = this.attempt
    let asked = false
    try {
      await room.setScreen(true, async () => {
        const now = await this.api.share(call.id, this.device)
        asked = true
        this.apply(now)
      })
    } catch (error) {
      if (error instanceof ApiError) {
        // 服务端不同意：多半是别人抢先了一步
        if (attempt === this.attempt) this.fail(error)
        return
      }
      if (attempt === this.attempt) {
        this.set({ ...this.state, screenProblem: screenProblem(error) })
      }
      // 服务端已经记下了、屏幕却没有发出去：收回来
      if (asked) {
        this.api
          .unshare(call.id, this.device)
          .then((now) => this.apply(now))
          .catch(() => {})
      }
    }
  }

  /** 停止共享我的屏幕。 */
  async stopSharing(): Promise<void> {
    const room = this.room
    const call = this.state.current
    if (!room || !call) return
    this.screenOut = false
    await room.setScreen(false).catch(() => {})
    try {
      this.apply(await this.api.unshare(call.id, this.device))
    } catch {
      // 没告诉到服务端：它那里我还在共享，别人暂时不能共享；我离开通话时会清掉
    }
  }

  /** 这个人共享的屏幕（我自己的也可以），拿去放进 video 元素。没有画面时为空。 */
  screenTrack(user: string): MediaStreamTrack | null {
    return this.room?.screenTrack(user) ?? null
  }

  /**
   * 屏幕这一路现在的情况，给诊断小字用（F12 T14）：我在共享时是发出去的，我在看别人的时是收到的。
   * 码率是和上一次量的之间的平均，所以隔几秒量一次。不在通话里、量不出来时都是空。
   */
  async screenStats(): Promise<{ sent: SentScreen | null; received: RoomReceivedVideo | null }> {
    const stats = await this.room?.videoStats().catch(() => null)
    return { sent: stats?.screenSent ?? null, received: stats?.screenReceived ?? null }
  }

  /** 把这个人的那一格放大；给空就回到格子。 */
  enlarge(user: string | null): void {
    if (this.state.enlarged === user) return
    this.set({ ...this.state, enlarged: user })
    this.rewatch()
  }

  /**
   * 界面告诉这里现在显示着谁（滚到屏幕外面的不算）、通话是不是缩小了：
   * 看不到的画面不收，缩小时只收小的一档。`visible` 给空表示都看得到。
   */
  showing(visible: readonly string[] | null, compact: boolean): void {
    this.visible = visible === null ? null : new Set(visible)
    this.compact = compact
    this.rewatch()
  }

  /** 这个人的画面（我自己的也可以），拿去放进 video 元素。没有画面时为空。 */
  videoTrack(user: string): MediaStreamTrack | null {
    return this.room?.videoTrack(user) ?? null
  }

  /** 浏览器不让自动放声音时，在用户点击的时候调它。 */
  async startAudio(): Promise<void> {
    await this.room?.startAudio().catch(() => {})
  }

  /** 关掉麦克风、摄像头用不了的提示、操作没成功的提示、"我为什么不在通话里了"的提示。 */
  clearProblem(): void {
    const { error, microphone, cameraProblem, screenProblem, closed } = this.state
    if (
      error === null &&
      microphone === null &&
      cameraProblem === null &&
      screenProblem === null &&
      closed === null
    ) {
      return
    }
    this.set({
      ...this.state,
      error: null,
      microphone: null,
      cameraProblem: null,
      screenProblem: null,
      closed: null,
    })
  }

  // ---------- 服务端的推送 ----------

  handleEvent(event: ServerEvent): void {
    if (event.type === 'group_call.updated') this.apply(event.data)
  }

  /** 连上服务端之后：问一下我所在的群里现在有哪些通话。断开期间可能错过了推送。 */
  async resync(): Promise<void> {
    let list: GroupCallList
    try {
      list = await this.api.list()
    } catch {
      return
    }
    const calls: Record<string, GroupCallView> = {}
    for (const call of list.calls) calls[call.conversation_id] = call
    const current = this.state.current
    const mine = current ? (calls[current.conversation_id] ?? null) : null
    if (current && this.state.phase !== 'joining' && (!mine || mine.id !== current.id)) {
      // 我所在的通话已经没有了
      this.set({ ...this.state, calls })
      this.dropOut('ended')
      return
    }
    this.set({ ...this.state, calls, current: mine ?? current })
    if (mine && this.state.phase !== 'joining') this.checkStillIn(mine)
    // 服务端以为我在这台设备上还在某个通话里，而我并不在：上次离开没告诉到它，再说一次
    if (this.state.phase === 'idle') {
      for (const call of list.calls) {
        const here = call.participants.some(
          (entry) => entry.user_id === this.me && entry.device === this.device,
        )
        if (here) {
          this.api
            .leave(call.id, this.device)
            .then((left) => this.apply(left))
            .catch(() => {})
        }
      }
    }
  }

  /** 退出登录、页面关闭时：放掉麦克风和连接。 */
  dispose(): void {
    this.attempt += 1
    this.leaving = true
    void this.room?.leave().catch(() => {})
    this.room = null
    this.listeners.clear()
  }

  // ---------- 状态 ----------

  /** 进一个通话：`report` 向服务端报到（发起或加入），交回通话和入场凭证。 */
  private async enter(
    report: (device: string) => Promise<GroupCallJoined>,
    camera: boolean,
  ): Promise<void> {
    if (this.state.phase !== 'idle') return
    const attempt = ++this.attempt
    this.visible = null
    this.compact = false
    this.watching = new Map()
    this.watchingScreen = null
    this.screenOut = false
    this.set({ ...this.outOfCall(), calls: this.state.calls, phase: 'joining' })
    let microphone: MediaStream
    try {
      microphone = await this.media.microphone()
    } catch (error) {
      if (attempt === this.attempt) {
        this.set({
          ...this.outOfCall(),
          calls: this.state.calls,
          microphone: microphoneProblem(error),
        })
      }
      return
    }
    const release = () => {
      for (const track of microphone.getTracks()) track.stop()
    }
    if (attempt !== this.attempt) {
      release()
      return
    }
    let joined: GroupCallJoined
    try {
      joined = await report(this.device)
    } catch (error) {
      release()
      if (attempt === this.attempt) {
        this.set({ ...this.outOfCall(), calls: this.state.calls })
        this.fail(error)
      }
      return
    }
    if (attempt !== this.attempt) {
      // 进到一半用户不等了：已经向服务端报了到，再说一声离开
      release()
      this.api.leave(joined.call.id, this.device).catch(() => {})
      return
    }
    this.set({
      ...this.withCall(joined.call),
      current: joined.call,
      // 进来时已经有人在共享：他的屏幕直接占大块
      enlarged:
        joined.call.sharing !== null && joined.call.sharing !== this.me ? SCREEN_TILE : null,
    })
    // 语音通话也带着画面的参数：里面也可以共享屏幕（F12）。摄像头开不了：这里不让开，
    // 入场凭证也不放行。取不到设置时用默认的，不耽误进通话
    const video = await this.api.videoSettings().catch(() => GROUP_VIDEO)
    if (attempt !== this.attempt) {
      release()
      this.api.leave(joined.call.id, this.device).catch(() => {})
      return
    }
    let room: RoomHandle
    try {
      room = await this.media.join(
        joined.ticket,
        microphone,
        (snapshot) => this.onRoom(attempt, snapshot),
        video,
      )
    } catch {
      release()
      if (attempt === this.attempt) {
        this.set({ ...this.outOfCall(), calls: this.state.calls, closed: 'lost' })
      }
      this.api
        .leave(joined.call.id, this.device)
        .then((left) => this.apply(left))
        .catch(() => {})
      return
    }
    if (attempt !== this.attempt) {
      void room.leave().catch(() => {})
      return
    }
    this.room = room
    this.set({ ...this.state, phase: 'active', connectedAt: this.now() })
    this.onRoom(attempt, room.snapshot())
    if (camera && joined.call.video) await this.turnCameraOn(attempt)
  }

  /** 打开摄像头。打不开时记下原因，通话照常。 */
  private async turnCameraOn(attempt: number): Promise<void> {
    const room = this.room
    if (!room) return
    try {
      await room.setCamera(true)
    } catch (error) {
      if (attempt === this.attempt) {
        this.set({ ...this.state, cameraProblem: microphoneProblem(error) })
      }
    }
  }

  /** 按规则重新定每一路画面要哪一档，有变化的告诉声音和画面的连接。 */
  private rewatch(): void {
    const room = this.room
    const call = this.state.current
    if (!room || !call) return
    // 看谁的屏幕：服务端说的那个人，不是我自己的话
    const sharer = call.sharing !== null && call.sharing !== this.me ? call.sharing : null
    if (sharer !== this.watchingScreen) {
      this.watchingScreen = sharer
      room.watchScreen(sharer)
    }
    if (!call.video) return
    const layers = layersToWatch({
      cameras: this.state.cameras.filter((user) => user !== this.me),
      enlarged: this.state.enlarged,
      visible: this.visible,
      compact: this.compact,
      screen: sharer !== null,
    })
    for (const [user, layer] of Object.entries(layers)) {
      if (this.watching.get(user) === layer) continue
      this.watching.set(user, layer)
      room.watch(user, layer)
    }
    // 关了摄像头的人：下次再开时重新说一遍
    for (const user of [...this.watching.keys()]) {
      if (!(user in layers)) this.watching.delete(user)
    }
  }

  /** 按服务端的样子更新一个通话。 */
  private apply(call: GroupCallView): void {
    const current = this.state.current
    if (call.ended_at !== null) {
      const { [call.conversation_id]: gone, ...rest } = this.state.calls
      // 只拿掉同一个通话：群里可能已经又发起了一个新的
      const calls = gone && gone.id !== call.id ? this.state.calls : rest
      this.set({ ...this.state, calls })
      if (current?.id === call.id) this.dropOut('ended')
      return
    }
    const mine = current?.id === call.id
    let enlarged = this.state.enlarged
    if (mine) {
      const before = current.sharing !== this.me ? current.sharing : null
      const now = call.sharing !== this.me ? call.sharing : null
      // 有人开始共享：他的屏幕自动占大块；停了：放大着屏幕的回到格子
      if (now !== null && now !== before) enlarged = SCREEN_TILE
      else if (now === null && enlarged === SCREEN_TILE) enlarged = null
    }
    this.set({
      ...this.withCall(call),
      current: mine ? call : current,
      enlarged,
    })
    if (mine) {
      this.rewatch()
      // 服务端那里已经不是我在共享了（比如别的页面接替了这一台），而我的屏幕还在发：停掉
      if (this.screenOut && call.sharing !== this.me) {
        this.screenOut = false
        void this.room?.setScreen(false).catch(() => {})
      }
    }
    if (mine && this.state.phase !== 'joining') this.checkStillIn(call)
  }

  /** 我所在的通话变了：服务端那里我还在不在这台设备上。不在了就是被请出去了。 */
  private checkStillIn(call: GroupCallView): void {
    const here = call.participants.some(
      (entry) => entry.user_id === this.me && entry.device === this.device,
    )
    if (!here && !this.leaving) this.dropOut('removed')
  }

  /** 声音的连接有变化。 */
  private onRoom(attempt: number, snapshot: RoomSnapshot): void {
    if (attempt !== this.attempt) return
    if (snapshot.phase === 'closed') {
      // 进到一半就断了的，由 enter 处理；自己离开的不算意外
      if (this.leaving || this.state.phase === 'joining') return
      const removed =
        snapshot.closedBecause === 'PARTICIPANT_REMOVED' ||
        snapshot.closedBecause === 'DUPLICATE_IDENTITY'
      const ended = snapshot.closedBecause === 'ROOM_DELETED'
      const call = this.state.current
      this.dropOut(ended ? 'ended' : removed ? 'removed' : 'lost')
      // 连接断了恢复不了：告诉服务端我不在了，别人不用等超时才知道
      if (call && !removed && !ended) {
        this.api
          .leave(call.id, this.device)
          .then((left) => this.apply(left))
          .catch(() => {})
      }
      return
    }
    if (this.state.phase === 'joining' || this.state.phase === 'idle') return
    const others = snapshot.members
    const enlarged = this.state.enlarged
    this.set({
      ...this.state,
      phase: snapshot.phase === 'reconnecting' ? 'reconnecting' : 'active',
      muted: snapshot.muted,
      speaking: others.filter((member) => member.speaking).map((member) => member.identity),
      silent: others.filter((member) => member.muted).map((member) => member.identity),
      audioBlocked: snapshot.audioBlocked,
      camera: snapshot.camera,
      facing: snapshot.facing,
      cameras: others.filter((member) => member.camera).map((member) => member.identity),
      paused: others
        .filter(
          (member) =>
            member.camera && member.paused && this.watching.get(member.identity) !== 'off',
        )
        .map((member) => member.identity),
      // 放大着的那个人离开了通话：回到格子。放大的是共享的屏幕时由服务端的消息管
      enlarged:
        enlarged === SCREEN_TILE ||
        (enlarged !== null && others.some((member) => member.identity === enlarged))
          ? enlarged
          : null,
      sharing: snapshot.screen,
      screenPaused: others.some(
        (member) =>
          !member.me &&
          member.identity === this.state.current?.sharing &&
          member.screen &&
          member.screenPaused,
      ),
    })
    this.rewatch()
    // 屏幕之前在发、现在没有了，又不是我点的停止：是用浏览器自己的"停止共享"停掉的，告诉服务端
    const call = this.state.current
    if (snapshot.screen) this.screenOut = true
    else if (this.screenOut && call) {
      this.screenOut = false
      this.api
        .unshare(call.id, this.device)
        .then((now) => this.apply(now))
        .catch(() => {})
    }
  }

  /** 我不在通话里了（不是自己离开的）：放掉连接，回到空闲，记下原因。 */
  private dropOut(closed: GroupCallClosed): void {
    if (this.state.phase === 'idle' && this.state.current === null) return
    this.attempt += 1
    const room = this.room
    this.room = null
    this.leaving = true
    void room
      ?.leave()
      .catch(() => {})
      .finally(() => {
        this.leaving = false
      })
    if (!room) this.leaving = false
    this.set({ ...this.outOfCall(), calls: this.state.calls, closed })
  }

  private fail(error: unknown): void {
    const code: ClientErrorCode = error instanceof ApiError ? error.code : 'network_error'
    this.set({ ...this.state, error: code })
    // 通话已经没有了、已经满了：我们知道的可能是旧的，重新问一次
    if (
      code === 'call_not_found' ||
      code === 'group_call_running' ||
      code === 'group_call_full' ||
      code === 'group_call_sharing'
    ) {
      void this.resync()
    }
  }

  private withCall(call: GroupCallView): GroupCallSnapshot {
    return { ...this.state, calls: { ...this.state.calls, [call.conversation_id]: call } }
  }

  /** 不在通话里时的样子（不带"有哪些通话"）。 */
  private outOfCall(): GroupCallSnapshot {
    return { ...IDLE_GROUP_CALL }
  }

  private set(next: GroupCallSnapshot): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
