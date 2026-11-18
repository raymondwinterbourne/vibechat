import type { CallView, ServerEvent } from '@vibechat/protocol'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import {
  type CallApi,
  CallController,
  type CallMedia,
  ENDED_DISPLAY_MS,
  GIVE_UP_AFTER_MS,
  microphoneProblem,
  RESTART_AFTER_MS,
  screenProblem,
} from './calls'

/** 管理员设置的画面参数：和默认值都不一样，看得出用的是取回来的这一份。 */
const VIDEO = {
  screen_max_width: 1920,
  screen_max_fps: 10,
  screen_direct_kbps: 4000,
  screen_relay_kbps: 800,
  camera_relay_kbps: 300,
  group_camera_high_kbps: 400,
  group_camera_low_kbps: 120,
  group_screen_kbps: 1000,
}
const CAMERA_RELAY = VIDEO.camera_relay_kbps * 1000

const ME = 'me'
const PEER = 'friend'
const HERE = 'tab-here'

interface FakeParameters {
  encodings: { maxBitrate?: number; scaleResolutionDownBy?: number; maxFramerate?: number }[]
  degradationPreference?: string
}

/** 画面那一路：发出去的是哪一路画面，方向。 */
class FakeTransceiver {
  direction: string
  readonly sender: {
    track: unknown
    replaceTrack: (track: unknown) => Promise<void>
    parameters: FakeParameters
    getParameters: () => FakeParameters
    setParameters: (parameters: FakeParameters) => Promise<void>
  }
  readonly receiver = { track: { kind: 'video' } }
  constructor(track: unknown, direction: string) {
    this.direction = direction
    const sender = {
      track,
      replaceTrack: async (next: unknown) => {
        sender.track = next
      },
      parameters: { encodings: [{}] } as FakeParameters,
      getParameters: () => structuredClone(sender.parameters),
      setParameters: async (parameters: FakeParameters) => {
        sender.parameters = parameters
      },
    }
    this.sender = sender
  }
}

/** 一条假的音频连接：记下做过什么，可以从外面触发事件。 */
class FakePeer {
  readonly tracks: unknown[] = []
  readonly transceivers: FakeTransceiver[] = []
  readonly added: RTCIceCandidateInit[] = []
  localDescription: { type: string; sdp: string; toJSON(): RTCSessionDescriptionInit } | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  connectionState = 'new'
  closed = false
  /** 正在用的那条路：本机这一端的候选地址是哪一种。 */
  path = 'host'
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>()

  constructor(readonly config: RTCConfiguration) {}

  addTrack(track: unknown) {
    this.tracks.push(track)
  }
  addTransceiver(trackOrKind: unknown, init: { direction: string }) {
    const transceiver = new FakeTransceiver(
      typeof trackOrKind === 'string' ? null : trackOrKind,
      init.direction,
    )
    this.transceivers.push(transceiver)
    return transceiver
  }
  getTransceivers() {
    return this.transceivers
  }
  addEventListener(type: string, handler: (event: unknown) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler])
  }
  emit(type: string, event: unknown = {}) {
    for (const handler of this.handlers.get(type) ?? []) handler(event)
  }
  async createOffer() {
    // 带着画面这一路时，offer 里有 m=video
    return { type: 'offer', sdp: this.transceivers.length > 0 ? 'offer-sdp m=video' : 'offer-sdp' }
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' }
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = {
      ...description,
      toJSON: () => description as RTCSessionDescriptionInit,
    }
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
    // 对方的 offer 带着画面：这边多出画面这一路，先只收不发
    if (description.sdp?.includes('m=video') && this.transceivers.length === 0) {
      this.transceivers.push(new FakeTransceiver(null, 'recvonly'))
    }
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.added.push(candidate)
  }
  close() {
    this.closed = true
  }
  async getStats() {
    const entries = [
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
      { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' },
      { id: 'L', type: 'local-candidate', candidateType: this.path },
      { id: 'R', type: 'remote-candidate', candidateType: 'host' },
    ]
    return new Map(entries.map((entry) => [entry.id, entry]))
  }
  /** 音频接通或断开。 */
  become(state: string) {
    this.connectionState = state
    this.emit('connectionstatechange')
  }
}

class FakeTrack {
  enabled = true
  stopped = false
  contentHint = ''
  onended: (() => void) | null = null
  stop() {
    this.stopped = true
  }
}

function call(patch: Partial<CallView> = {}): CallView {
  return {
    id: 'call-1',
    conversation_id: 'conv-1',
    caller_id: ME,
    callee_id: PEER,
    caller_device: HERE,
    callee_device: null,
    state: 'ringing',
    video: false,
    outcome: null,
    started_at: 1000,
    answered_at: null,
    ended_at: null,
    ...patch,
  }
}

/** 别人打给我。 */
function incoming(patch: Partial<CallView> = {}): CallView {
  return call({ caller_id: PEER, callee_id: ME, caller_device: 'tab-friend', ...patch })
}

function updated(view: CallView): ServerEvent {
  return { type: 'call.updated', data: view }
}

function setup(
  options: {
    microphone?: () => Promise<MediaStream>
    camera?: () => Promise<MediaStream>
    screen?: () => Promise<MediaStream>
    screenAccess?: () => Promise<'granted' | 'denied' | 'unknown'>
  } = {},
) {
  const track = new FakeTrack()
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream
  // 每次打开摄像头都是新的一路画面
  const cameras: FakeTrack[] = []
  const facings: string[] = []
  const camera = async (facing: string) => {
    facings.push(facing)
    const video = new FakeTrack()
    cameras.push(video)
    return {
      getTracks: () => [video],
      getVideoTracks: () => [video],
    } as unknown as MediaStream
  }
  // 每次共享都是新的一路屏幕画面
  const screens: FakeTrack[] = []
  const screenAsked: MediaTrackConstraints[] = []
  const screen = async (constraints: MediaTrackConstraints) => {
    screenAsked.push(constraints)
    const shared = new FakeTrack()
    screens.push(shared)
    return {
      getTracks: () => [shared],
      getVideoTracks: () => [shared],
    } as unknown as MediaStream
  }
  const peers: FakePeer[] = []
  const signals: { id: string; device: string; signal: unknown }[] = []
  const api: CallApi = {
    start: vi.fn(async () => call()),
    accept: vi.fn(async (id: string, device: string) =>
      incoming({ id, state: 'active', callee_device: device, answered_at: 2000 }),
    ),
    reject: vi.fn(async (id: string) => incoming({ id, state: 'ended', outcome: 'rejected' })),
    hangUp: vi.fn(async (id: string) => call({ id, state: 'ended', outcome: 'completed' })),
    signal: vi.fn(async (id: string, device: string, signal: string) => {
      signals.push({ id, device, signal: JSON.parse(signal) })
    }),
    current: vi.fn(async () => ({ call: null })),
    iceServers: vi.fn(async () => ({
      ice_servers: [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }],
      expires_at: null,
      video: VIDEO,
      group_calls: false,
    })),
  }
  const media: CallMedia = {
    microphone: options.microphone ?? (async () => stream),
    camera: options.camera ?? camera,
    screen: options.screen ?? screen,
    peer: (config) => {
      const peer = new FakePeer(config)
      peers.push(peer)
      return peer as unknown as RTCPeerConnection
    },
  }
  const timers: { run: () => void; ms: number }[] = []
  let now = 50_000
  const controller = new CallController({
    me: ME,
    device: HERE,
    api,
    media,
    screenAccess: options.screenAccess,
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { run, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const at = timers.indexOf(timer as (typeof timers)[number])
      if (at >= 0) timers.splice(at, 1)
    },
  })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    controller,
    api,
    peers,
    signals,
    track,
    cameras,
    facings,
    screens,
    screenAsked,
    timers,
    flush,
    advance: (ms: number) => {
      now += ms
    },
    state: () => controller.getState(),
  }
}

describe('calling someone', () => {
  it('rings, connects when they answer, and sends the offer from this device', async () => {
    const t = setup()
    await t.controller.start('conv-1')
    expect(t.api.start).toHaveBeenCalledWith('conv-1', HERE, false)
    expect(t.state()).toMatchObject({ phase: 'outgoing', role: 'caller' })

    t.controller.handleEvent(
      updated(call({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    expect(t.state().phase).toBe('connecting')
    await t.flush()
    const [peer] = t.peers
    // 只用我们自己的中转服务
    expect(peer?.config.iceServers).toEqual([
      { urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' },
    ])
    expect(peer?.tracks).toEqual([t.track])
    expect(t.signals).toEqual([
      {
        id: 'call-1',
        device: HERE,
        signal: { kind: 'description', description: { type: 'offer', sdp: 'offer-sdp m=video' } },
      },
    ])

    // 对方的 answer 和候选地址
    t.controller.handleEvent({
      type: 'call.signal',
      data: {
        call_id: 'call-1',
        signal: JSON.stringify({ kind: 'description', description: { type: 'answer', sdp: 'a' } }),
      },
    })
    t.controller.handleEvent({
      type: 'call.signal',
      data: {
        call_id: 'call-1',
        signal: JSON.stringify({ kind: 'candidate', candidate: { candidate: 'c1' } }),
      },
    })
    await t.flush()
    expect(peer?.remoteDescription).toEqual({ type: 'answer', sdp: 'a' })
    expect(peer?.added).toEqual([{ candidate: 'c1' }])

    peer?.become('connected')
    expect(t.state()).toMatchObject({ phase: 'active', connectedAt: 50_000, unstable: false })
  })

  it('shows at once that the other side is busy or offline', async () => {
    const t = setup()
    vi.mocked(t.api.start).mockResolvedValueOnce(call({ state: 'ended', outcome: 'busy' }))
    await t.controller.start('conv-1')
    expect(t.state()).toMatchObject({ phase: 'ended', role: 'caller' })
    expect(t.state().call?.outcome).toBe('busy')
    // 麦克风放掉了
    expect(t.track.stopped).toBe(true)

    // 过一会儿回到没有通话
    expect(t.timers.map((timer) => timer.ms)).toEqual([ENDED_DISPLAY_MS])
    t.timers[0]?.run()
    expect(t.state().phase).toBe('idle')
  })

  it('can be cancelled while it rings', async () => {
    const t = setup()
    vi.mocked(t.api.hangUp).mockResolvedValueOnce(call({ state: 'ended', outcome: 'cancelled' }))
    await t.controller.start('conv-1')
    await t.controller.hangUp()
    expect(t.api.hangUp).toHaveBeenCalledWith('call-1', HERE, undefined)
    expect(t.state().phase).toBe('ended')
    expect(t.state().call?.outcome).toBe('cancelled')
    expect(t.track.stopped).toBe(true)
  })

  it('does not start without a microphone', async () => {
    const t = setup({
      microphone: async () => {
        throw new DOMException('no', 'NotAllowedError')
      },
    })
    await t.controller.start('conv-1')
    expect(t.api.start).not.toHaveBeenCalled()
    expect(t.state()).toMatchObject({ phase: 'idle', microphone: 'denied' })
  })

  it('reports why the server refused', async () => {
    const t = setup()
    vi.mocked(t.api.start).mockRejectedValueOnce(
      new ApiError('already_in_call', 409, 'already in a call'),
    )
    await t.controller.start('conv-1')
    expect(t.state()).toMatchObject({ phase: 'idle', error: 'already_in_call' })
    expect(t.track.stopped).toBe(true)
  })

  it('cannot start a second call while one is going on', async () => {
    const t = setup()
    await t.controller.start('conv-1')
    await t.controller.start('conv-2')
    expect(t.api.start).toHaveBeenCalledTimes(1)
  })
})

describe('being called', () => {
  it('rings, and answering prepares the connection before telling the server', async () => {
    const t = setup()
    t.controller.handleEvent(updated(incoming()))
    expect(t.state()).toMatchObject({ phase: 'incoming', role: 'callee' })

    await t.controller.accept()
    expect(t.api.accept).toHaveBeenCalledWith('call-1', HERE)
    expect(t.peers).toHaveLength(1)
    expect(t.state().phase).toBe('connecting')
    // 被叫不发 offer，等对方的
    expect(t.signals).toEqual([])

    t.controller.handleEvent({
      type: 'call.signal',
      data: {
        call_id: 'call-1',
        signal: JSON.stringify({ kind: 'candidate', candidate: { candidate: 'early' } }),
      },
    })
    t.controller.handleEvent({
      type: 'call.signal',
      data: {
        call_id: 'call-1',
        signal: JSON.stringify({ kind: 'description', description: { type: 'offer', sdp: 'o' } }),
      },
    })
    await t.flush()
    const [peer] = t.peers
    // 先到的候选地址等 offer 用上之后再加
    expect(peer?.added).toEqual([{ candidate: 'early' }])
    expect(t.signals.map((sent) => sent.signal)).toEqual([
      { kind: 'description', description: { type: 'answer', sdp: 'answer-sdp' } },
    ])
  })

  it('stops ringing when it is answered on another device', () => {
    const t = setup()
    t.controller.handleEvent(updated(incoming()))
    t.controller.handleEvent(
      updated(incoming({ state: 'active', callee_device: 'tab-phone', answered_at: 2000 })),
    )
    expect(t.state()).toMatchObject({ phase: 'elsewhere', role: 'callee' })

    // 结束了：这台设备不显示结果
    t.controller.handleEvent(updated(incoming({ state: 'ended', outcome: 'completed' })))
    expect(t.state().phase).toBe('idle')
  })

  it('goes quiet when the caller cancels', () => {
    const t = setup()
    t.controller.handleEvent(updated(incoming()))
    t.controller.handleEvent(updated(incoming({ state: 'ended', outcome: 'cancelled' })))
    expect(t.state().phase).toBe('idle')
  })

  it('can be rejected', async () => {
    const t = setup()
    t.controller.handleEvent(updated(incoming()))
    await t.controller.reject()
    expect(t.api.reject).toHaveBeenCalledWith('call-1')
    expect(t.state().phase).toBe('idle')
  })

  it('ends the call and tells the caller when the microphone cannot be used', async () => {
    const t = setup({
      microphone: async () => {
        throw new DOMException('no', 'NotFoundError')
      },
    })
    vi.mocked(t.api.reject).mockResolvedValueOnce(
      incoming({ state: 'ended', outcome: 'no_microphone' }),
    )
    t.controller.handleEvent(updated(incoming()))
    await t.controller.accept()
    expect(t.api.accept).not.toHaveBeenCalled()
    expect(t.api.reject).toHaveBeenCalledWith('call-1', 'no_microphone')
    // 来电收起，留下原因给用户看
    expect(t.state()).toMatchObject({ phase: 'idle', microphone: 'missing' })
  })
})

describe('during a call', () => {
  async function connected() {
    const t = setup()
    await t.controller.start('conv-1')
    t.controller.handleEvent(
      updated(call({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    await t.flush()
    t.peers[0]?.become('connected')
    return t
  }

  it('mutes and unmutes the microphone', async () => {
    const t = await connected()
    t.controller.toggleMute()
    expect(t.state().muted).toBe(true)
    expect(t.track.enabled).toBe(false)
    t.controller.toggleMute()
    expect(t.track.enabled).toBe(true)
  })

  it('shows when the connection drops and comes back', async () => {
    const t = await connected()
    t.peers[0]?.become('disconnected')
    expect(t.state().unstable).toBe(true)
    expect(t.timers.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([
      RESTART_AFTER_MS,
      GIVE_UP_AFTER_MS,
    ])
    t.advance(3000)
    t.peers[0]?.become('connected')
    // 时长从第一次接通算起；不用再重新找路了
    expect(t.state()).toMatchObject({ unstable: false, connectedAt: 50_000 })
    expect(t.timers).toEqual([])
  })

  it('looks for a new path when the connection stays down', async () => {
    const t = await connected()
    const sent = t.signals.length
    t.peers[0]?.become('disconnected')
    t.timers.find((timer) => timer.ms === RESTART_AFTER_MS)?.run()
    await t.flush()
    // 主叫再发一次 offer
    expect(t.signals.slice(sent).map((signal) => signal.signal)).toEqual([
      { kind: 'description', description: { type: 'offer', sdp: 'offer-sdp m=video' } },
    ])
    // 彻底断了：马上重新找路
    t.peers[0]?.become('failed')
    await t.flush()
    expect(t.signals.length).toBe(sent + 2)
  })

  it('gives up and records a dropped call when the connection does not come back', async () => {
    const t = await connected()
    vi.mocked(t.api.hangUp).mockResolvedValueOnce(call({ state: 'ended', outcome: 'interrupted' }))
    t.peers[0]?.become('failed')
    t.timers.find((timer) => timer.ms === GIVE_UP_AFTER_MS)?.run()
    await t.flush()
    expect(t.api.hangUp).toHaveBeenCalledWith('call-1', HERE, 'network')
    expect(t.state().phase).toBe('ended')
    expect(t.state().call?.outcome).toBe('interrupted')
  })

  it('the callee waits for the caller to find a new path', async () => {
    const t = setup()
    t.controller.handleEvent(updated(incoming()))
    await t.controller.accept()
    t.peers[0]?.become('connected')
    t.peers[0]?.become('disconnected')
    // 只有放弃的计时
    expect(t.timers.map((timer) => timer.ms)).toEqual([GIVE_UP_AFTER_MS])
    // 主叫重新发来的 offer，照常回 answer
    t.controller.handleEvent({
      type: 'call.signal',
      data: {
        call_id: 'call-1',
        signal: JSON.stringify({ kind: 'description', description: { type: 'offer', sdp: 'o2' } }),
      },
    })
    await t.flush()
    expect(t.signals.map((sent) => sent.signal)).toEqual([
      { kind: 'description', description: { type: 'answer', sdp: 'answer-sdp' } },
    ])
  })

  it('hangs up, releasing the microphone and the connection at once', async () => {
    const t = await connected()
    await t.controller.hangUp()
    expect(t.peers[0]?.closed).toBe(true)
    expect(t.track.stopped).toBe(true)
    expect(t.state()).toMatchObject({ phase: 'ended' })
    expect(t.state().call?.outcome).toBe('completed')
  })

  it('ends when the other side hangs up', async () => {
    const t = await connected()
    t.controller.handleEvent(updated(call({ state: 'ended', outcome: 'completed' })))
    expect(t.state().phase).toBe('ended')
    expect(t.peers[0]?.closed).toBe(true)
  })

  it('ignores connection details for another call', async () => {
    const t = await connected()
    t.controller.handleEvent({
      type: 'call.signal',
      data: { call_id: 'call-2', signal: JSON.stringify({ kind: 'candidate', candidate: {} }) },
    })
    await t.flush()
    expect(t.peers[0]?.added).toEqual([])
  })

  it('learns after reconnecting that the call ended meanwhile', async () => {
    const t = await connected()
    await t.controller.resync()
    expect(t.state().phase).toBe('ended')
    expect(t.peers[0]?.closed).toBe(true)
  })
})

describe('another device of mine', () => {
  it('shows that I am in a call elsewhere and goes quiet when it ends', () => {
    const t = setup()
    t.controller.handleEvent(updated(call({ caller_device: 'tab-laptop' })))
    expect(t.state()).toMatchObject({ phase: 'elsewhere', role: 'caller' })
    t.controller.handleEvent(
      updated(call({ caller_device: 'tab-laptop', state: 'ended', outcome: 'missed' })),
    )
    expect(t.state().phase).toBe('idle')
  })

  it('picks up a call that started before the page connected', async () => {
    const t = setup()
    vi.mocked(t.api.current).mockResolvedValueOnce({ call: incoming() })
    await t.controller.resync()
    expect(t.state().phase).toBe('incoming')
  })
})

describe('microphone problems', () => {
  it('are told apart by the error the browser gives', () => {
    expect(microphoneProblem(new DOMException('', 'NotAllowedError'))).toBe('denied')
    expect(microphoneProblem(new DOMException('', 'NotFoundError'))).toBe('missing')
    expect(microphoneProblem(new DOMException('', 'NotReadableError'))).toBe('busy')
    expect(microphoneProblem(new TypeError('no mediaDevices'))).toBe('unsupported')
  })
})

describe('video calls', () => {
  const video = (patch: Partial<CallView> = {}) => call({ video: true, ...patch })
  const incomingVideo = (patch: Partial<CallView> = {}) => incoming({ video: true, ...patch })
  const signalled = (t: ReturnType<typeof setup>) => t.signals.map((sent) => sent.signal)
  /** 被叫接听：服务端交回的通话还是视频通话。 */
  const answersVideo = (t: ReturnType<typeof setup>) =>
    vi
      .mocked(t.api.accept)
      .mockImplementationOnce(async (id, device) =>
        incomingVideo({ id, state: 'active', callee_device: device, answered_at: 2000 }),
      )

  it('the caller turns the camera on, sends a picture and says the camera is on', async () => {
    const t = setup()
    vi.mocked(t.api.start).mockResolvedValueOnce(video())
    await t.controller.start('conv-1', { video: true })
    expect(t.api.start).toHaveBeenCalledWith('conv-1', HERE, true)
    expect(t.cameras).toHaveLength(1)
    expect(t.state()).toMatchObject({ cameraOn: true })
    expect(t.state().local).not.toBeNull()

    t.controller.handleEvent(
      updated(video({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    await t.flush()
    const [peer] = t.peers
    expect(peer?.transceivers.map((item) => [item.sender.track, item.direction])).toEqual([
      [t.cameras[0], 'sendrecv'],
    ])
    expect(signalled(t)).toEqual([
      { kind: 'description', description: { type: 'offer', sdp: 'offer-sdp m=video' } },
      { kind: 'camera', on: true },
    ])
  })

  it('the callee answers with the camera on and its picture goes back', async () => {
    const t = setup()
    t.controller.handleEvent(updated(incomingVideo()))
    answersVideo(t)
    await t.controller.accept()
    expect(t.cameras).toHaveLength(1)
    t.controller.handleEvent({
      type: 'call.signal',
      data: {
        call_id: 'call-1',
        signal: JSON.stringify({
          kind: 'description',
          description: { type: 'offer', sdp: 'o m=video' },
        }),
      },
    })
    await t.flush()
    const [peer] = t.peers
    expect(peer?.transceivers.map((item) => [item.sender.track, item.direction])).toEqual([
      [t.cameras[0], 'sendrecv'],
    ])
    expect(signalled(t)).toEqual([
      { kind: 'description', description: { type: 'answer', sdp: 'answer-sdp' } },
      { kind: 'camera', on: true },
    ])
  })

  it('a callee can answer with voice only and turn the camera on later', async () => {
    const t = setup()
    t.controller.handleEvent(updated(incomingVideo()))
    answersVideo(t)
    await t.controller.accept({ video: false })
    expect(t.cameras).toHaveLength(0)
    t.controller.handleEvent({
      type: 'call.signal',
      data: {
        call_id: 'call-1',
        signal: JSON.stringify({
          kind: 'description',
          description: { type: 'offer', sdp: 'o m=video' },
        }),
      },
    })
    await t.flush()
    expect(signalled(t).at(-1)).toEqual({ kind: 'camera', on: false })
    expect(t.state().cameraOn).toBe(false)

    await t.controller.toggleCamera()
    expect(t.peers[0]?.transceivers[0]?.sender.track).toBe(t.cameras[0])
    expect(t.state().cameraOn).toBe(true)
    expect(signalled(t).at(-1)).toEqual({ kind: 'camera', on: true })
  })

  it('turning the camera off really stops it, without breaking the call', async () => {
    const t = setup()
    vi.mocked(t.api.start).mockResolvedValueOnce(video())
    await t.controller.start('conv-1', { video: true })
    t.controller.handleEvent(
      updated(video({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    await t.flush()
    await t.controller.toggleCamera()
    expect(t.cameras[0]?.stopped).toBe(true)
    expect(t.peers[0]?.transceivers[0]?.sender.track).toBeNull()
    expect(t.state()).toMatchObject({ cameraOn: false, local: null })
    expect(t.peers[0]?.closed).toBe(false)
    expect(signalled(t).at(-1)).toEqual({ kind: 'camera', on: false })
  })

  it('shows when the other side turns the camera off', async () => {
    const t = setup()
    vi.mocked(t.api.start).mockResolvedValueOnce(video())
    await t.controller.start('conv-1', { video: true })
    t.controller.handleEvent(
      updated(video({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    expect(t.state().peerCameraOn).toBe(true)
    t.controller.handleEvent({
      type: 'call.signal',
      data: { call_id: 'call-1', signal: JSON.stringify({ kind: 'camera', on: false }) },
    })
    await t.flush()
    expect(t.state().peerCameraOn).toBe(false)
  })

  it('goes ahead without a picture when the camera cannot be used', async () => {
    const t = setup({
      camera: async () => {
        throw new DOMException('no', 'NotFoundError')
      },
    })
    vi.mocked(t.api.start).mockResolvedValueOnce(video())
    await t.controller.start('conv-1', { video: true })
    expect(t.api.start).toHaveBeenCalledWith('conv-1', HERE, true)
    expect(t.state()).toMatchObject({ phase: 'outgoing', cameraOn: false, camera: 'missing' })
    t.controller.handleEvent(
      updated(video({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    await t.flush()
    // 画面这一路照样带上，之后打开摄像头时换上
    expect(t.peers[0]?.transceivers.map((item) => item.sender.track)).toEqual([null])
  })

  it('hanging up turns the camera off', async () => {
    const t = setup()
    vi.mocked(t.api.start).mockResolvedValueOnce(video())
    await t.controller.start('conv-1', { video: true })
    await t.controller.hangUp()
    expect(t.cameras[0]?.stopped).toBe(true)
    expect(t.state().local).toBeNull()
  })

  it('a voice call sends no picture, but has an empty picture path for sharing a screen', async () => {
    const t = setup()
    await t.controller.start('conv-1')
    t.controller.handleEvent(
      updated(call({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    await t.flush()
    expect(t.cameras).toHaveLength(0)
    expect(t.peers[0]?.transceivers.map((item) => [item.sender.track, item.direction])).toEqual([
      [null, 'sendrecv'],
    ])
    expect(signalled(t).map((signal) => (signal as { kind: string }).kind)).toEqual(['description'])
  })
})

describe('video on phones and through the relay', () => {
  async function videoConnected(path = 'host') {
    const t = setup()
    vi.mocked(t.api.start).mockResolvedValueOnce(call({ video: true }))
    await t.controller.start('conv-1', { video: true })
    t.controller.handleEvent(
      updated(
        call({ video: true, state: 'active', callee_device: 'tab-friend', answered_at: 2000 }),
      ),
    )
    await t.flush()
    const peer = t.peers[0] as FakePeer
    peer.path = path
    peer.become('connected')
    await t.flush()
    return { t, peer }
  }

  it('limits the picture when the call goes through the relay', async () => {
    const { t, peer } = await videoConnected('relay')
    expect(peer.transceivers[0]?.sender.parameters.encodings).toEqual([
      { maxBitrate: CAMERA_RELAY },
    ])
    expect(t.state()).toMatchObject({ relayed: true, path: 'relay' })
  })

  it('leaves a direct call alone, and lifts the limit when the path becomes direct', async () => {
    const { t, peer } = await videoConnected('host')
    expect(peer.transceivers[0]?.sender.parameters.encodings).toEqual([{}])
    expect(t.state()).toMatchObject({ relayed: false, path: 'direct' })

    // 断开后换了一条路：从中转换成直连
    peer.path = 'relay'
    peer.become('disconnected')
    peer.become('connected')
    await t.flush()
    expect(peer.transceivers[0]?.sender.parameters.encodings[0]?.maxBitrate).toBe(CAMERA_RELAY)
    peer.path = 'srflx'
    peer.become('disconnected')
    peer.become('connected')
    await t.flush()
    expect(peer.transceivers[0]?.sender.parameters.encodings).toEqual([{}])
  })

  it('switches between the front and back camera without a gap', async () => {
    const { t, peer } = await videoConnected()
    expect(t.state().facing).toBe('user')
    await t.controller.switchCamera()
    expect(t.facings).toEqual(['user', 'environment'])
    expect(peer.transceivers[0]?.sender.track).toBe(t.cameras[1])
    expect(t.cameras[0]?.stopped).toBe(true)
    expect(t.state()).toMatchObject({ facing: 'environment', cameraOn: true })
    await t.controller.switchCamera()
    expect(t.state().facing).toBe('user')
  })

  it('keeps the camera it has when the other one cannot be opened', async () => {
    // 只有一个摄像头：第一次打得开，换的时候打不开
    let opened = 0
    const video = new FakeTrack()
    const t = setup({
      camera: async () => {
        opened += 1
        if (opened > 1) throw new DOMException('no', 'OverconstrainedError')
        return { getTracks: () => [video], getVideoTracks: () => [video] } as unknown as MediaStream
      },
    })
    vi.mocked(t.api.start).mockResolvedValueOnce(call({ video: true }))
    await t.controller.start('conv-1', { video: true })
    t.controller.handleEvent(
      updated(
        call({ video: true, state: 'active', callee_device: 'tab-friend', answered_at: 2000 }),
      ),
    )
    await t.flush()
    await t.controller.switchCamera()
    expect(t.peers[0]?.transceivers[0]?.sender.track).toBe(video)
    expect(video.stopped).toBe(false)
    expect(t.state()).toMatchObject({ facing: 'user', cameraOn: true })
  })
})

describe('sharing the screen', () => {
  const signalled = (t: ReturnType<typeof setup>) => t.signals.map((sent) => sent.signal)
  const screenSignal = (on: boolean) =>
    ({
      type: 'call.signal',
      data: { call_id: 'call-1', signal: JSON.stringify({ kind: 'screen', on }) },
    }) as ServerEvent

  /** 打出去、接通、连上。 */
  async function connected(options: { video?: boolean; path?: string } = {}) {
    const t = setup()
    const video = options.video === true
    vi.mocked(t.api.start).mockResolvedValueOnce(call({ video }))
    await t.controller.start('conv-1', { video })
    t.controller.handleEvent(
      updated(call({ video, state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    await t.flush()
    const peer = t.peers[0] as FakePeer
    peer.path = options.path ?? 'host'
    peer.become('connected')
    await t.flush()
    return { t, peer, sender: () => peer.transceivers[0]?.sender }
  }

  it('in a voice call the screen goes out on the empty picture path, and the other side is told', async () => {
    const { t, sender } = await connected()
    await t.controller.startSharing()
    const [screen] = t.screens
    expect(sender()?.track).toBe(screen)
    // 文字和图形：清晰度优先
    expect(screen?.contentHint).toBe('detail')
    expect(sender()?.parameters.degradationPreference).toBe('maintain-resolution')
    expect(t.state().sharing).toBe(true)
    expect(signalled(t).at(-1)).toEqual({ kind: 'screen', on: true })

    await t.controller.stopSharing()
    expect(screen?.stopped).toBe(true)
    expect(sender()?.track).toBeNull()
    expect(t.state().sharing).toBe(false)
    expect(signalled(t).at(-1)).toEqual({ kind: 'screen', on: false })
  })

  it('in a video call the camera pauses while sharing and comes back afterwards', async () => {
    const { t, sender } = await connected({ video: true })
    await t.controller.startSharing()
    expect(t.cameras[0]?.stopped).toBe(true)
    expect(t.state()).toMatchObject({ sharing: true, cameraOn: false, local: null })
    expect(sender()?.track).toBe(t.screens[0])
    // 共享时不能开关摄像头
    await t.controller.toggleCamera()
    expect(t.cameras).toHaveLength(1)

    await t.controller.stopSharing()
    expect(t.cameras).toHaveLength(2)
    expect(sender()?.track).toBe(t.cameras[1])
    expect(t.state()).toMatchObject({ sharing: false, cameraOn: true })
    expect(signalled(t).slice(-2)).toEqual([
      { kind: 'screen', on: false },
      { kind: 'camera', on: true },
    ])
  })

  it('a camera that was off before sharing stays off afterwards', async () => {
    const { t, sender } = await connected({ video: true })
    await t.controller.toggleCamera()
    await t.controller.startSharing()
    await t.controller.stopSharing()
    expect(t.cameras).toHaveLength(1)
    expect(sender()?.track).toBeNull()
    expect(t.state().cameraOn).toBe(false)
    expect(signalled(t).at(-1)).toEqual({ kind: 'camera', on: false })
  })

  it("stopping from the browser's own bar counts as stopping", async () => {
    const { t } = await connected()
    await t.controller.startSharing()
    t.screens[0]?.onended?.()
    await t.flush()
    expect(t.state().sharing).toBe(false)
    expect(signalled(t).at(-1)).toEqual({ kind: 'screen', on: false })
  })

  it('only one side shares at a time', async () => {
    const { t } = await connected()
    t.controller.handleEvent(screenSignal(true))
    await t.flush()
    expect(t.state().peerSharing).toBe(true)
    await t.controller.startSharing()
    expect(t.screens).toHaveLength(0)

    t.controller.handleEvent(screenSignal(false))
    await t.flush()
    expect(t.state().peerSharing).toBe(false)
    // 两边几乎同时点了：我让给对方
    await t.controller.startSharing()
    t.controller.handleEvent(screenSignal(true))
    await t.flush()
    expect(t.state()).toMatchObject({ sharing: false, peerSharing: true })
    expect(t.screens[0]?.stopped).toBe(true)
  })

  it('a callee in a voice call can share too', async () => {
    const t = setup()
    t.controller.handleEvent(updated(incoming()))
    await t.controller.accept()
    t.controller.handleEvent({
      type: 'call.signal',
      data: {
        call_id: 'call-1',
        signal: JSON.stringify({
          kind: 'description',
          description: { type: 'offer', sdp: 'o m=video' },
        }),
      },
    })
    await t.flush()
    await t.controller.startSharing()
    expect(t.peers[0]?.transceivers[0]?.sender.track).toBe(t.screens[0])
  })

  it('follows the administrator settings for the screen and the limits on each path', async () => {
    const { t, peer, sender } = await connected({ video: true, path: 'relay' })
    expect(sender()?.parameters.encodings).toEqual([{ maxBitrate: CAMERA_RELAY }])
    await t.controller.startSharing()
    expect(t.screenAsked).toEqual([{ width: { max: 1920 }, frameRate: { ideal: 10, max: 10 } }])
    // 共享时不缩小，帧数按设置
    const sharing = { scaleResolutionDownBy: 1, maxFramerate: 10 }
    expect(sender()?.parameters.encodings).toEqual([{ maxBitrate: 800_000, ...sharing }])
    expect(await t.controller.sharedVideo()).toMatchObject({ resolutionFirst: true })
    await t.controller.stopSharing()
    expect(sender()?.parameters).toMatchObject({
      encodings: [{ maxBitrate: CAMERA_RELAY }],
      degradationPreference: 'balanced',
    })
    // 直连：共享屏幕按直连的上限，摄像头不限
    await t.controller.startSharing()
    peer.path = 'host'
    peer.become('disconnected')
    peer.become('connected')
    await t.flush()
    expect(sender()?.parameters.encodings).toEqual([{ maxBitrate: 4_000_000, ...sharing }])
    // 重新连上后再告诉对方一次在共享
    expect(signalled(t).at(-1)).toEqual({ kind: 'screen', on: true })
  })

  it('cancelling the picker says nothing; a refusal by the system is explained', async () => {
    let refusal = new DOMException('Permission denied', 'NotAllowedError')
    const t = setup({
      screen: async () => {
        throw refusal
      },
    })
    await t.controller.start('conv-1')
    t.controller.handleEvent(
      updated(call({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    await t.flush()
    await t.controller.startSharing()
    expect(t.state()).toMatchObject({ sharing: false, screen: null })
    refusal = new DOMException('Permission denied by system', 'NotAllowedError')
    await t.controller.startSharing()
    expect(t.state().screen).toBe('denied')
    t.controller.clearProblem()
    expect(t.state().screen).toBeNull()
  })

  it('on the desktop app a refusal that looks like cancelling is checked with the system', async () => {
    let access: 'granted' | 'denied' = 'granted'
    const t = setup({
      screen: async () => {
        throw new DOMException('', 'AbortError')
      },
      screenAccess: async () => access,
    })
    await t.controller.start('conv-1')
    t.controller.handleEvent(
      updated(call({ state: 'active', callee_device: 'tab-friend', answered_at: 2000 })),
    )
    await t.flush()
    await t.controller.startSharing()
    expect(t.state().screen).toBeNull()
    access = 'denied'
    await t.controller.startSharing()
    expect(t.state().screen).toBe('denied')
  })

  it('hanging up stops sharing', async () => {
    const { t } = await connected()
    await t.controller.startSharing()
    await t.controller.hangUp()
    expect(t.screens[0]?.stopped).toBe(true)
    expect(t.state().sharing).toBe(false)
  })

  it('tells the reasons apart', () => {
    expect(screenProblem(new DOMException('Permission denied', 'NotAllowedError'))).toBeNull()
    expect(screenProblem(new DOMException('Permission denied by system', 'NotAllowedError'))).toBe(
      'denied',
    )
    expect(screenProblem(new DOMException('', 'NotReadableError'))).toBe('denied')
    expect(screenProblem(new TypeError('getDisplayMedia is not a function'))).toBe('unsupported')
  })
})
