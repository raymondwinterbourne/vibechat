import type {
  GroupCallJoined,
  GroupCallView,
  RoomTicketView,
  ServerEvent,
} from '@vibechat/protocol'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  type GroupCallApi,
  GroupCallController,
  type GroupCallMedia,
  groupCallFull,
  ringsFor,
  SCREEN_TILE,
} from './groupCalls'
import { GROUP_VIDEO, type RoomHandle, type RoomSnapshot } from './room'

const ME = 'me'
const DEVICE = 'tab-here'
const GROUP = 'group-1'

function call(patch: Partial<GroupCallView> = {}): GroupCallView {
  return {
    id: 'call-1',
    conversation_id: GROUP,
    starter_id: 'alice',
    started_at: 1000,
    ended_at: null,
    participants: [{ user_id: 'alice', device: 'tab-alice', joined_at: 1000 }],
    ringing: [],
    limit: 6,
    video: false,
    sharing: null,
    ...patch,
  }
}

const withMe = (base: GroupCallView, device = DEVICE): GroupCallView => ({
  ...base,
  participants: [...base.participants, { user_id: ME, device, joined_at: 2000 }],
  ringing: base.ringing.filter((invite) => invite.user_id !== ME),
})

const ticket: RoomTicketView = {
  url: 'ws://example.test/livekit',
  token: 'token',
  room: 'call-call-1',
  identity: ME,
  expires_at: 0,
}

const updated = (data: GroupCallView): ServerEvent => ({ type: 'group_call.updated', data })

/** 假的麦克风：只记着关没关。 */
function fakeStream() {
  const track = {
    stopped: false,
    stop: () => {
      track.stopped = true
    },
  }
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream }
}

function roomSnapshot(patch: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    phase: 'connected',
    members: [
      {
        identity: ME,
        me: true,
        speaking: false,
        muted: false,
        camera: false,
        paused: false,
        screen: false,
        screenPaused: false,
      },
    ],
    muted: false,
    camera: false,
    facing: 'user',
    screen: false,
    audioBlocked: false,
    closedBecause: null,
    ...patch,
  }
}

function world(
  options: {
    microphone?: 'denied'
    room?: 'fails'
    camera?: 'denied'
    /** 向浏览器要屏幕时：系统没有授权，或者用户在选择框里取消了。 */
    screen?: 'denied' | 'cancelled'
  } = {},
) {
  const asked: string[] = []
  let server = call()
  const microphone = fakeStream()
  const room = {
    left: false,
    muted: false,
    /** 进房间时带没带画面的参数。 */
    video: false,
    /** 每一路画面被要了哪一档，按先后。 */
    watched: [] as string[],
    switched: [] as string[],
    /** 向浏览器要到过几次屏幕。 */
    captured: 0,
    /** 被要求看谁的屏幕，按先后。 */
    screens: [] as (string | null)[],
    current: roomSnapshot(),
    change: (_snapshot: RoomSnapshot) => {},
  }
  const handle: RoomHandle = {
    snapshot: () => room.current,
    setMuted: async (muted) => {
      room.muted = muted
    },
    startAudio: async () => {},
    stats: async () => {
      throw new Error('not used')
    },
    setCamera: async (on) => {
      if (on && options.camera === 'denied') throw new DOMException('no', 'NotAllowedError')
      room.change({
        ...room.current,
        camera: on,
        members: room.current.members.map((member) =>
          member.me ? { ...member, camera: on } : member,
        ),
      })
    },
    switchCamera: async (facing) => {
      room.switched.push(facing)
      room.change({ ...room.current, facing })
    },
    watch: (identity, layer) => {
      room.watched.push(`${identity} ${layer}`)
    },
    videoTrack: () => null,
    setScreen: async (on, allowed) => {
      if (on && options.screen === 'denied') {
        throw new DOMException('Permission denied by system', 'NotAllowedError')
      }
      if (on && options.screen === 'cancelled') {
        throw new DOMException('Permission denied', 'NotAllowedError')
      }
      // 屏幕拿到了，再问能不能发
      if (on) {
        room.captured += 1
        await allowed?.()
      }
      room.change({
        ...room.current,
        screen: on,
        members: room.current.members.map((member) =>
          member.me ? { ...member, screen: on } : member,
        ),
      })
    },
    watchScreen: (identity) => {
      room.screens.push(identity)
    },
    screenTrack: () => null,
    videoStats: async () => ({
      sent: [],
      received: {},
      screenSent: null,
      screenReceived: null,
    }),
    leave: async () => {
      room.left = true
    },
  }
  const fail: { next: ApiError | null } = { next: null }
  const answer = <T>(value: () => T): Promise<T> => {
    if (fail.next) {
      const error = fail.next
      fail.next = null
      return Promise.reject(error)
    }
    return Promise.resolve(value())
  }
  const joined = (): GroupCallJoined => {
    server = withMe(server)
    return { call: server, ticket }
  }
  const api: GroupCallApi = {
    start: (conversationId, device, invite, video) => {
      asked.push(`start ${conversationId} ${device} [${invite.join(',')}]${video ? ' video' : ''}`)
      return answer(() => {
        server = call({
          starter_id: ME,
          video,
          participants: [],
          ringing: invite.map((user_id) => ({ user_id, by: ME, until: 31_000 })),
        })
        return joined()
      })
    },
    join: (id, device) => {
      asked.push(`join ${id} ${device}`)
      return answer(joined)
    },
    invite: (id, userIds) => {
      asked.push(`invite ${id} [${userIds.join(',')}]`)
      return answer(() => server)
    },
    decline: (id) => {
      asked.push(`decline ${id}`)
      return answer(() => {
        server = { ...server, ringing: server.ringing.filter((invite) => invite.user_id !== ME) }
        return server
      })
    },
    leave: (id, device) => {
      asked.push(`leave ${id} ${device}`)
      return answer(() => {
        const participants = server.participants.filter((entry) => entry.user_id !== ME)
        server = {
          ...server,
          participants,
          ended_at: participants.length === 0 ? 9000 : null,
        }
        return server
      })
    },
    share: (id, device) => {
      asked.push(`share ${id} ${device}`)
      return answer(() => {
        server = { ...server, sharing: ME }
        return server
      })
    },
    unshare: (id, device) => {
      asked.push(`unshare ${id} ${device}`)
      return answer(() => {
        if (server.sharing === ME) server = { ...server, sharing: null }
        return server
      })
    },
    videoSettings: () => Promise.resolve(GROUP_VIDEO),
    list: () => {
      asked.push('list')
      return answer(() => ({ calls: server.ended_at === null ? [server] : [] }))
    },
  }
  const media: GroupCallMedia = {
    microphone: () =>
      options.microphone === 'denied'
        ? Promise.reject(new DOMException('no', 'NotAllowedError'))
        : Promise.resolve(microphone.stream),
    join: (_ticket, _microphone, onChange, video) => {
      if (options.room === 'fails') return Promise.reject(new Error('could not connect'))
      room.video = video !== undefined
      room.change = (snapshot) => {
        room.current = snapshot
        onChange(snapshot)
      }
      return Promise.resolve(handle)
    },
  }
  const controller = new GroupCallController({
    me: ME,
    device: DEVICE,
    api,
    media,
    now: () => 5000,
  })
  return {
    controller,
    asked,
    room,
    microphone: microphone.track,
    fail,
    setServer: (next: GroupCallView) => {
      server = next
    },
    state: () => controller.getState(),
  }
}

/** 等进行中的异步操作都走完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('knowing about the calls in my groups', () => {
  it('follows the server: a call appears, changes and goes away', () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    expect(w.controller.callIn(GROUP)?.id).toBe('call-1')
    expect(w.controller.callIn('other')).toBeNull()
    w.controller.handleEvent(
      updated(call({ participants: [{ user_id: 'bob', device: 'x', joined_at: 1 }] })),
    )
    expect(w.controller.callIn(GROUP)?.participants[0]?.user_id).toBe('bob')
    w.controller.handleEvent(updated(call({ participants: [], ended_at: 8000 })))
    expect(w.controller.callIn(GROUP)).toBeNull()
  })

  it('does not drop a new call when the end of the previous one arrives late', () => {
    const w = world()
    w.controller.handleEvent(updated(call({ id: 'call-2' })))
    w.controller.handleEvent(updated(call({ id: 'call-1', participants: [], ended_at: 8000 })))
    expect(w.controller.callIn(GROUP)?.id).toBe('call-2')
  })

  it('rings for an invitation until it is taken back, I join, or I ignore it', async () => {
    const w = world()
    const inviting = call({ ringing: [{ user_id: ME, by: 'alice', until: 31_000 }] })
    w.controller.handleEvent(updated(inviting))
    expect(w.controller.ringing()?.id).toBe('call-1')
    // 响够了时间，服务端把邀请拿掉
    w.controller.handleEvent(updated(call()))
    expect(w.controller.ringing()).toBeNull()

    // 我点了"忽略"
    w.setServer(inviting)
    w.controller.handleEvent(updated(inviting))
    await w.controller.decline('call-1')
    expect(w.asked).toContain('decline call-1')
    expect(w.controller.ringing()).toBeNull()
    // 通话还在，随时可以加入
    expect(w.controller.callIn(GROUP)).not.toBeNull()
  })

  it('does not ring while I am in that call on another device', () => {
    const w = world()
    const base = call({ ringing: [{ user_id: ME, by: 'alice', until: 31_000 }] })
    w.controller.handleEvent(updated(withMe(base, 'tab-phone')))
    expect(w.controller.ringing()).toBeNull()
    expect(w.controller.elsewhere()?.id).toBe('call-1')
  })

  it('asks the server again after reconnecting', async () => {
    const w = world()
    w.controller.handleEvent(updated(call({ conversation_id: 'stale', id: 'old' })))
    await w.controller.resync()
    expect(Object.keys(w.state().calls)).toEqual([GROUP])
  })

  it('tells who is being rung and when a call is full', () => {
    const inviting = call({ ringing: [{ user_id: ME, by: 'alice', until: 1 }] })
    expect(ringsFor(inviting, ME)).toBe(true)
    expect(ringsFor(inviting, 'bob')).toBe(false)
    expect(ringsFor(withMe(inviting), ME)).toBe(false)
    expect(groupCallFull(call({ limit: 1 }))).toBe(true)
    expect(groupCallFull(call({ limit: 2 }))).toBe(false)
  })
})

describe('being in a call', () => {
  it('starting takes the microphone first, then tells the server, then connects the audio', async () => {
    const w = world()
    const starting = w.controller.start(GROUP, ['bob', 'carol'])
    expect(w.state().phase).toBe('joining')
    await starting
    expect(w.asked).toEqual([`start ${GROUP} ${DEVICE} [bob,carol]`])
    expect(w.state().phase).toBe('active')
    expect(w.state().current?.starter_id).toBe(ME)
    expect(w.state().connectedAt).toBe(5000)
    expect(w.controller.callIn(GROUP)?.ringing.map((invite) => invite.user_id)).toEqual([
      'bob',
      'carol',
    ])
    // 在通话里的时候，别的邀请不响
    expect(w.controller.ringing()).toBeNull()
    // 已经在通话里：再点发起、加入都不重复进
    await w.controller.join('call-1')
    expect(w.asked).toHaveLength(1)
  })

  it('without the microphone nothing is started, so nobody rings for nothing', async () => {
    const w = world({ microphone: 'denied' })
    await w.controller.start(GROUP, ['bob'])
    expect(w.asked).toEqual([])
    expect(w.state().phase).toBe('idle')
    expect(w.state().microphone).toBe('denied')
    w.controller.clearProblem()
    expect(w.state().microphone).toBeNull()
  })

  it('a refusal from the server is reported and the microphone is let go', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    w.fail.next = new ApiError('group_call_full', 409, 'full')
    await w.controller.join('call-1')
    expect(w.state().phase).toBe('idle')
    expect(w.state().error).toBe('group_call_full')
    expect(w.microphone.stopped).toBe(true)
    // 我们知道的可能是旧的：重新问了一次
    await settle()
    expect(w.asked).toEqual([`join call-1 ${DEVICE}`, 'list'])
  })

  it('when the audio cannot connect I leave again, so I am not counted as being in', async () => {
    const w = world({ room: 'fails' })
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    await settle()
    expect(w.asked).toEqual([`join call-1 ${DEVICE}`, `leave call-1 ${DEVICE}`])
    expect(w.state().phase).toBe('idle')
    expect(w.state().closed).toBe('lost')
    expect(w.microphone.stopped).toBe(true)
  })

  it('shows who is speaking and who is muted from the audio connection', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    w.room.change(
      roomSnapshot({
        members: [
          {
            identity: ME,
            me: true,
            speaking: true,
            muted: false,
            camera: false,
            paused: false,
            screen: false,
            screenPaused: false,
          },
          {
            identity: 'alice',
            me: false,
            speaking: false,
            muted: true,
            camera: false,
            paused: false,
            screen: false,
            screenPaused: false,
          },
          {
            identity: 'bob',
            me: false,
            speaking: true,
            muted: false,
            camera: false,
            paused: false,
            screen: false,
            screenPaused: false,
          },
        ],
      }),
    )
    expect(w.state().speaking).toEqual([ME, 'bob'])
    expect(w.state().silent).toEqual(['alice'])
    // 连接断了正在恢复，又连上
    w.room.change(roomSnapshot({ phase: 'reconnecting' }))
    expect(w.state().phase).toBe('reconnecting')
    w.room.change(roomSnapshot())
    expect(w.state().phase).toBe('active')
  })

  it('muting goes to the audio connection', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    await w.controller.toggleMute()
    expect(w.room.muted).toBe(true)
    expect(w.state().muted).toBe(true)
    await w.controller.toggleMute()
    expect(w.room.muted).toBe(false)
  })

  it('inviting more people goes through the call I am in', async () => {
    const w = world()
    await w.controller.invite(['bob'])
    expect(w.asked).toEqual([])
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    await w.controller.invite(['bob', 'carol'])
    await w.controller.invite([])
    expect(w.asked.at(-1)).toBe('invite call-1 [bob,carol]')
  })

  it('leaving drops the audio and tells the server; the call goes on for the others', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    await w.controller.leave()
    expect(w.room.left).toBe(true)
    expect(w.asked.at(-1)).toBe(`leave call-1 ${DEVICE}`)
    expect(w.state().phase).toBe('idle')
    expect(w.state().current).toBeNull()
    // 自己离开的不提示原因
    expect(w.state().closed).toBeNull()
    expect(w.controller.callIn(GROUP)?.participants.map((entry) => entry.user_id)).toEqual([
      'alice',
    ])
  })

  it('the last one leaving ends the call', async () => {
    const w = world()
    await w.controller.start(GROUP, [])
    await w.controller.leave()
    expect(w.controller.callIn(GROUP)).toBeNull()
    expect(w.state().closed).toBeNull()
  })

  it('when the server no longer has me in the call, I am out and told why', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    // 被移出了群：服务端把我从通话里拿掉了
    w.controller.handleEvent(updated(call()))
    expect(w.state().phase).toBe('idle')
    expect(w.state().closed).toBe('removed')
    expect(w.room.left).toBe(true)
    w.controller.clearProblem()
    expect(w.state().closed).toBeNull()
  })

  it('when the call ends under me, I am out and told so', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    w.controller.handleEvent(updated(call({ participants: [], ended_at: 9000 })))
    expect(w.state().phase).toBe('idle')
    expect(w.state().closed).toBe('ended')
    expect(w.controller.callIn(GROUP)).toBeNull()
  })

  it('when the audio connection is lost for good, I leave and say so', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    w.room.change(roomSnapshot({ phase: 'closed', closedBecause: 'JOIN_FAILURE' }))
    await settle()
    expect(w.state().phase).toBe('idle')
    expect(w.state().closed).toBe('lost')
    expect(w.asked.at(-1)).toBe(`leave call-1 ${DEVICE}`)
  })

  it('being shown out of the room by the server is not reported back to it', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    w.room.change(roomSnapshot({ phase: 'closed', closedBecause: 'PARTICIPANT_REMOVED' }))
    await settle()
    expect(w.state().closed).toBe('removed')
    expect(w.asked).toEqual([`join call-1 ${DEVICE}`])
  })

  it('after reconnecting, a call that ended meanwhile takes me out', async () => {
    const w = world()
    w.controller.handleEvent(updated(call()))
    await w.controller.join('call-1')
    w.setServer(call({ participants: [], ended_at: 9000 }))
    await w.controller.resync()
    expect(w.state().phase).toBe('idle')
    expect(w.state().closed).toBe('ended')
  })

  it('after reconnecting, if the server still has me in on this device though I left, I say it again', async () => {
    const w = world()
    w.setServer(withMe(call()))
    await w.controller.resync()
    await settle()
    expect(w.asked).toEqual(['list', `leave call-1 ${DEVICE}`])
    expect(w.controller.callIn(GROUP)?.participants.map((entry) => entry.user_id)).toEqual([
      'alice',
    ])
  })
})

describe('video calls', () => {
  const member = (identity: string, camera: boolean) => ({
    identity,
    me: identity === ME,
    speaking: false,
    muted: false,
    camera,
    paused: false,
    screen: false,
    screenPaused: false,
  })
  /** 房间里除了我还有这些人，都开着摄像头。 */
  const withCameras = (w: ReturnType<typeof world>, others: string[]) =>
    w.room.change({
      ...w.room.current,
      members: [member(ME, w.room.current.camera), ...others.map((user) => member(user, true))],
    })

  it('starts one with my camera on and tells the server it is a video call', async () => {
    const w = world()
    await w.controller.start(GROUP, ['alice'], true)
    expect(w.asked[0]).toBe(`start ${GROUP} ${DEVICE} [alice] video`)
    expect(w.state().current?.video).toBe(true)
    // 带着画面的参数进的房间
    expect(w.room.video).toBe(true)
    expect(w.state().camera).toBe(true)
    expect(w.state().cameras).toEqual([ME])
  })

  it('keeps a voice call without pictures: no camera, nothing to watch', async () => {
    const w = world()
    await w.controller.start(GROUP, ['alice'])
    expect(w.asked[0]).toBe(`start ${GROUP} ${DEVICE} [alice]`)
    // 进房间时带着画面的参数（语音通话里也可以共享屏幕），但摄像头开不了
    expect(w.room.video).toBe(true)
    await w.controller.toggleCamera()
    await w.controller.flipCamera()
    expect(w.state().camera).toBe(false)
    expect(w.room.switched).toEqual([])
    withCameras(w, ['alice'])
    expect(w.room.watched).toEqual([])
  })

  it('joins with the camera off unless asked, and can turn it on and off later', async () => {
    const w = world()
    w.setServer(call({ video: true }))
    w.controller.handleEvent(updated(call({ video: true })))
    // 从"通话进行中"的横条加入：不开摄像头
    await w.controller.join('call-1')
    expect(w.room.video).toBe(true)
    expect(w.state().camera).toBe(false)
    await w.controller.toggleCamera()
    expect(w.state().camera).toBe(true)
    await w.controller.toggleCamera()
    expect(w.state().camera).toBe(false)
  })

  it('joins from the invitation with the camera on', async () => {
    const w = world()
    w.setServer(call({ video: true }))
    await w.controller.join('call-1', { camera: true })
    expect(w.state().camera).toBe(true)
  })

  it('stays in the call when the camera cannot be used, and says why', async () => {
    const w = world({ camera: 'denied' })
    await w.controller.start(GROUP, [], true)
    expect(w.state().phase).toBe('active')
    expect(w.state().camera).toBe(false)
    expect(w.state().cameraProblem).toBe('denied')
    w.controller.clearProblem()
    expect(w.state().cameraProblem).toBeNull()
  })

  it('switches between the front and the back camera', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    expect(w.state().facing).toBe('user')
    await w.controller.flipCamera()
    expect(w.state().facing).toBe('environment')
    await w.controller.flipCamera()
    expect(w.room.switched).toEqual(['environment', 'user'])
  })

  it('asks for each picture in the tier the rule gives, and only when it changes', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    // 两个人开着摄像头：都要清楚的
    withCameras(w, ['alice', 'bob'])
    expect(w.room.watched).toEqual(['alice high', 'bob high'])
    // 第三个人也开了：都改成小的
    w.room.watched.length = 0
    withCameras(w, ['alice', 'bob', 'carol'])
    expect(w.room.watched).toEqual(['alice low', 'bob low', 'carol low'])
    // 没有变化时不再说一遍
    w.room.watched.length = 0
    withCameras(w, ['alice', 'bob', 'carol'])
    expect(w.room.watched).toEqual([])

    // 放大 bob：只有他变
    w.controller.enlarge('bob')
    expect(w.state().enlarged).toBe('bob')
    expect(w.room.watched).toEqual(['bob high'])
    w.room.watched.length = 0
    w.controller.enlarge(null)
    expect(w.room.watched).toEqual(['bob low'])

    // carol 滚到屏幕外面了：不收她的
    w.room.watched.length = 0
    w.controller.showing(['alice', 'bob'], false)
    expect(w.room.watched).toEqual(['alice high', 'bob high', 'carol off'])
    // 缩小：只显示 alice，收小的
    w.room.watched.length = 0
    w.controller.showing(['alice'], true)
    expect(w.room.watched).toEqual(['alice low', 'bob off'])
  })

  it('asks again when somebody turns the camera off and on', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    withCameras(w, ['alice'])
    withCameras(w, [])
    w.room.watched.length = 0
    withCameras(w, ['alice'])
    expect(w.room.watched).toEqual(['alice high'])
  })

  it('goes back to the grid when the enlarged person leaves', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    withCameras(w, ['alice', 'bob'])
    w.controller.enlarge('alice')
    withCameras(w, ['bob'])
    expect(w.state().enlarged).toBeNull()
  })

  it('forgets the camera and the enlarged tile once I am out of the call', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    withCameras(w, ['alice'])
    w.controller.enlarge('alice')
    await w.controller.leave()
    expect(w.state().camera).toBe(false)
    expect(w.state().cameras).toEqual([])
    expect(w.state().enlarged).toBeNull()
    expect(w.room.left).toBe(true)
  })

  it('marks a picture the media server has paused, and clears the mark when it comes back', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    withCameras(w, ['alice', 'bob'])
    const pause = (paused: string[]) =>
      w.room.change({
        ...w.room.current,
        members: w.room.current.members.map((entry) => ({
          ...entry,
          paused: paused.includes(entry.identity),
        })),
      })
    pause(['alice'])
    expect(w.state().paused).toEqual(['alice'])
    pause([])
    expect(w.state().paused).toEqual([])
    // 我自己说了不要的那一路（滚到屏幕外面了）被停着，不算"暂停"
    w.controller.showing(['alice'], false)
    pause(['bob'])
    expect(w.state().paused).toEqual([])
  })
})

describe('sharing the screen in a group call', () => {
  /** 服务端推来：通话现在是这个样子（我在里面）。 */
  const serverSays = (w: ReturnType<typeof world>, patch: Partial<GroupCallView>) => {
    const current = w.state().current
    if (!current) throw new Error('not in a call')
    const next = { ...current, ...patch }
    w.setServer(next)
    w.controller.handleEvent(updated(next))
  }

  it('takes the screen, asks the server, then shares, in a voice call too', async () => {
    const w = world()
    await w.controller.start(GROUP, [])
    w.asked.length = 0
    await w.controller.shareScreen()
    expect(w.asked).toEqual([`share call-1 ${DEVICE}`])
    expect(w.state().sharing).toBe(true)
    expect(w.state().current?.sharing).toBe(ME)
    // 我自己的屏幕不用"看"
    expect(w.room.screens.filter((who) => who !== null)).toEqual([])
    // 语音通话还是语音通话：没有摄像头
    expect(w.state().current?.video).toBe(false)
    expect(w.state().camera).toBe(false)
  })

  it('stops, and tells the server', async () => {
    const w = world()
    await w.controller.start(GROUP, [])
    await w.controller.shareScreen()
    w.asked.length = 0
    await w.controller.stopSharing()
    expect(w.asked).toEqual([`unshare call-1 ${DEVICE}`])
    expect(w.state().sharing).toBe(false)
    expect(w.state().current?.sharing).toBeNull()
  })

  it('does not even open the picker when it knows somebody else is sharing', async () => {
    const w = world()
    await w.controller.start(GROUP, [])
    serverSays(w, { sharing: 'alice' })
    w.asked.length = 0
    await w.controller.shareScreen()
    expect(w.room.captured).toBe(0)
    expect(w.asked).toEqual([])
    expect(w.state().error).toBe('group_call_sharing')
  })

  it('lets go of the screen when the server says somebody else got there first', async () => {
    const w = world()
    await w.controller.start(GROUP, [])
    w.asked.length = 0
    w.fail.next = new ApiError('group_call_sharing', 409, 'someone else is sharing')
    await w.controller.shareScreen()
    await settle()
    // 屏幕拿到过，但没有发出去；服务端那里本来就没有记下我，不用再去收回
    expect(w.room.captured).toBe(1)
    expect(w.state().sharing).toBe(false)
    expect(w.state().error).toBe('group_call_sharing')
    expect(w.asked.filter((line) => line.startsWith('unshare'))).toEqual([])
  })

  it('never bothers the server when the system refuses the screen, and says why', async () => {
    const w = world({ screen: 'denied' })
    await w.controller.start(GROUP, [])
    w.asked.length = 0
    await w.controller.shareScreen()
    await settle()
    expect(w.asked).toEqual([])
    expect(w.state().sharing).toBe(false)
    expect(w.state().current?.sharing).toBeNull()
    expect(w.state().screenProblem).toBe('denied')
    w.controller.clearProblem()
    expect(w.state().screenProblem).toBeNull()
  })

  it('says nothing when the user cancels the picker', async () => {
    const w = world({ screen: 'cancelled' })
    await w.controller.start(GROUP, [])
    w.asked.length = 0
    await w.controller.shareScreen()
    await settle()
    expect(w.asked).toEqual([])
    expect(w.state().screenProblem).toBeNull()
    expect(w.state().current?.sharing).toBeNull()
  })

  it("tells the server when the browser's own stop button ends the share", async () => {
    const w = world()
    await w.controller.start(GROUP, [])
    await w.controller.shareScreen()
    w.asked.length = 0
    // 屏幕没有了，不是我点的"停止共享"
    w.room.change({ ...w.room.current, screen: false })
    await settle()
    expect(w.asked).toEqual([`unshare call-1 ${DEVICE}`])
    expect(w.state().sharing).toBe(false)
    expect(w.state().current?.sharing).toBeNull()
  })

  it('keeps the camera as it was while sharing and after', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    expect(w.state().camera).toBe(true)
    await w.controller.shareScreen()
    expect(w.state().camera).toBe(true)
    await w.controller.stopSharing()
    expect(w.state().camera).toBe(true)
  })

  it("watches the sharer's screen, enlarges it by itself, and lets go when it stops", async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    serverSays(w, { sharing: 'alice' })
    expect(w.room.screens.at(-1)).toBe('alice')
    expect(w.state().enlarged).toBe(SCREEN_TILE)
    // 可以放大别人，再点回屏幕
    w.controller.enlarge('bob')
    serverSays(w, { limit: 8 })
    expect(w.state().enlarged).toBe('bob')
    w.controller.enlarge(SCREEN_TILE)
    // 停了：不再看，放大着屏幕的回到格子
    serverSays(w, { sharing: null })
    expect(w.room.screens.at(-1)).toBeNull()
    expect(w.state().enlarged).toBeNull()
    // 换了一个人共享：看新的那个人的
    serverSays(w, { sharing: 'bob' })
    expect(w.room.screens.at(-1)).toBe('bob')
    expect(w.state().enlarged).toBe(SCREEN_TILE)
  })

  it('gets every camera small while a shared screen is being watched', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    const member = (identity: string) => ({
      identity,
      me: false,
      speaking: false,
      muted: false,
      camera: true,
      paused: false,
      screen: false,
      screenPaused: false,
    })
    const [me] = w.room.current.members
    if (!me) throw new Error('no members')
    w.room.change({ ...w.room.current, members: [me, member('alice'), member('bob')] })
    expect(w.room.watched).toEqual(['alice high', 'bob high'])
    w.room.watched.length = 0
    serverSays(w, { sharing: 'alice' })
    expect(w.room.watched).toEqual(['alice low', 'bob low'])
    // 停了：回到原来的档位
    w.room.watched.length = 0
    serverSays(w, { sharing: null })
    expect(w.room.watched).toEqual(['alice high', 'bob high'])
  })

  it('says so when the screen being watched is paused by the media server', async () => {
    const w = world()
    await w.controller.start(GROUP, [], true)
    const [me] = w.room.current.members
    if (!me) throw new Error('no members')
    const alice = (patch: { screen: boolean; screenPaused: boolean }) => ({
      identity: 'alice',
      me: false,
      speaking: false,
      muted: false,
      camera: false,
      paused: false,
      ...patch,
    })
    const room = (patch: { screen: boolean; screenPaused: boolean }) =>
      w.room.change({ ...w.room.current, members: [me, alice(patch)] })
    serverSays(w, { sharing: 'alice' })
    room({ screen: true, screenPaused: false })
    expect(w.state().screenPaused).toBe(false)
    // 我这边的网络带不动：屏幕这一路被暂停了；好了自己恢复
    room({ screen: true, screenPaused: true })
    expect(w.state().screenPaused).toBe(true)
    room({ screen: true, screenPaused: false })
    expect(w.state().screenPaused).toBe(false)
    // 他已经不共享了，留下的"暂停"不算数
    room({ screen: true, screenPaused: true })
    serverSays(w, { sharing: null })
    room({ screen: false, screenPaused: true })
    expect(w.state().screenPaused).toBe(false)
  })

  it('reads how the screen is doing, sent or received, for the small print', async () => {
    const w = world()
    // 不在通话里：没有东西可量
    expect(await w.controller.screenStats()).toEqual({ sent: null, received: null })
    await w.controller.start(GROUP, [], true)
    expect(await w.controller.screenStats()).toEqual({ sent: null, received: null })
  })

  it('sees a share that was already going on when joining', async () => {
    const w = world()
    w.setServer(call({ sharing: 'alice' }))
    await w.controller.join('call-1')
    expect(w.room.screens.at(-1)).toBe('alice')
    // 他的屏幕直接是放大的那一格
    expect(w.state().enlarged).toBe(SCREEN_TILE)
  })

  it('stops sending my screen when the server no longer has me as the sharer', async () => {
    const w = world()
    await w.controller.start(GROUP, [])
    await w.controller.shareScreen()
    serverSays(w, { sharing: null })
    await settle()
    expect(w.state().sharing).toBe(false)
  })

  it('forgets the share once I am out of the call', async () => {
    const w = world()
    await w.controller.start(GROUP, [])
    await w.controller.shareScreen()
    await w.controller.leave()
    expect(w.state().sharing).toBe(false)
    expect(w.room.left).toBe(true)
  })
})
