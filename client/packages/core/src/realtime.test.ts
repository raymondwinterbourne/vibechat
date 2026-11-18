import type { ServerEvent } from '@vibechat/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backoffDelay, type ConnectionState, RealtimeClient } from './realtime'

/** 测试用的假 WebSocket：记录客户端发出的内容，并让测试扮演服务端。 */
class FakeSocket {
  static readonly OPEN = 1
  static instances: FakeSocket[] = []

  readyState = 0
  sent: unknown[] = []
  closedByClient = false
  onmessage: ((message: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.closedByClient = true
  }

  serverSends(event: ServerEvent) {
    this.readyState = FakeSocket.OPEN
    this.onmessage?.({ data: JSON.stringify(event) })
  }

  serverSaysHello(heartbeatIntervalMs = HEARTBEAT) {
    this.serverSends({
      type: 'sys.hello',
      data: { server_version: '0.1.0', heartbeat_interval_ms: heartbeatIntervalMs },
    })
  }

  connectionDrops() {
    this.readyState = 3
    this.onclose?.()
  }
}

const HEARTBEAT = 30_000

function latestSocket(): FakeSocket {
  const socket = FakeSocket.instances.at(-1)
  if (!socket) throw new Error('no socket has been opened')
  return socket
}

function createClient() {
  const client = new RealtimeClient({
    url: 'ws://test/ws',
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    // 固定取随机系数的上限，重连间隔就是整数：1 秒、2 秒、4 秒……
    random: () => 1,
  })
  const states: ConnectionState[] = []
  client.subscribe((state) => states.push(state))
  return { client, states }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('backoffDelay', () => {
  it('doubles each time up to the limit', () => {
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt, 1000, 8000, () => 1))
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
  })

  it('spreads clients between half and the full delay', () => {
    expect(backoffDelay(2, 1000, 8000, () => 0)).toBe(2000)
    expect(backoffDelay(2, 1000, 8000, () => 0.5)).toBe(3000)
    expect(backoffDelay(2, 1000, 8000, () => 1)).toBe(4000)
  })
})

describe('RealtimeClient', () => {
  it('is connecting until the server says hello, then open', () => {
    const { client, states } = createClient()
    client.start()
    expect(client.state).toBe('connecting')
    expect(latestSocket().url).toBe('ws://test/ws')

    latestSocket().serverSaysHello()
    expect(client.state).toBe('open')
    expect(states).toEqual(['connecting', 'open'])
  })

  it('hands server events to listeners, except heartbeat replies', () => {
    const { client } = createClient()
    const events: ServerEvent[] = []
    client.onEvent((event) => events.push(event))
    client.start()

    latestSocket().serverSaysHello()
    latestSocket().serverSends({ type: 'sys.pong' })
    expect(events.map((event) => event.type)).toEqual(['sys.hello'])
  })

  it('sends a ping at the interval the server asked for', () => {
    const { client } = createClient()
    client.start()
    const socket = latestSocket()
    socket.serverSaysHello(HEARTBEAT)
    expect(socket.sent).toEqual([])

    vi.advanceTimersByTime(HEARTBEAT)
    expect(socket.sent).toEqual([{ type: 'sys.ping' }])

    socket.serverSends({ type: 'sys.pong' })
    vi.advanceTimersByTime(HEARTBEAT)
    expect(socket.sent).toHaveLength(2)
  })

  it('says I am typing over the open connection, and drops it while not connected', () => {
    const { client } = createClient()
    client.start()
    const socket = latestSocket()
    // 还没连上：不说
    client.typing('c1')
    socket.serverSaysHello(HEARTBEAT)
    client.typing('c1')
    expect(socket.sent).toEqual([{ type: 'conv.typing', data: { conversation_id: 'c1' } }])
  })

  it('gives up on a connection that has been silent for two intervals and reconnects', () => {
    const { client } = createClient()
    client.start()
    const socket = latestSocket()
    socket.serverSaysHello(HEARTBEAT)

    // 服务端从此不再有任何回应
    vi.advanceTimersByTime(HEARTBEAT * 2)
    expect(client.state).toBe('open')
    vi.advanceTimersByTime(HEARTBEAT)
    expect(client.state).toBe('reconnecting')
    expect(socket.closedByClient).toBe(true)

    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('reconnects after a drop, waiting longer each time', () => {
    const { client, states } = createClient()
    client.start()
    latestSocket().serverSaysHello()

    latestSocket().connectionDrops()
    expect(client.state).toBe('reconnecting')
    expect(FakeSocket.instances).toHaveLength(1)

    // 第一次重连等 1 秒
    vi.advanceTimersByTime(999)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)

    // 又没连上：第二次等 2 秒，第三次等 4 秒
    latestSocket().connectionDrops()
    vi.advanceTimersByTime(1999)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)

    latestSocket().connectionDrops()
    vi.advanceTimersByTime(4000)
    expect(FakeSocket.instances).toHaveLength(4)

    latestSocket().serverSaysHello()
    expect(states).toEqual(['connecting', 'open', 'reconnecting', 'open'])
  })

  it('starts from the shortest wait again after a successful reconnect', () => {
    const { client } = createClient()
    client.start()
    latestSocket().serverSaysHello()

    latestSocket().connectionDrops()
    vi.advanceTimersByTime(1000)
    latestSocket().connectionDrops()
    vi.advanceTimersByTime(2000)
    latestSocket().serverSaysHello()
    expect(FakeSocket.instances).toHaveLength(3)

    latestSocket().connectionDrops()
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(4)
  })

  it('shows as reconnecting when the very first attempt fails', () => {
    const { client } = createClient()
    client.start()
    latestSocket().connectionDrops()
    expect(client.state).toBe('reconnecting')
  })

  it('does not reconnect after being stopped', () => {
    const { client, states } = createClient()
    client.start()
    latestSocket().serverSaysHello()
    latestSocket().connectionDrops()

    client.stop()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(states.at(-1)).toBe('closed')
  })

  it('closes the socket and stops the heartbeat when stopped', () => {
    const { client } = createClient()
    client.start()
    const socket = latestSocket()
    socket.serverSaysHello(HEARTBEAT)

    client.stop()
    expect(socket.closedByClient).toBe(true)
    vi.advanceTimersByTime(HEARTBEAT * 3)
    expect(socket.sent).toEqual([])
  })

  it('ignores messages from a connection it has already abandoned', () => {
    const { client } = createClient()
    client.start()
    const first = latestSocket()
    first.serverSaysHello()
    first.connectionDrops()
    vi.advanceTimersByTime(1000)

    const events: ServerEvent[] = []
    client.onEvent((event) => events.push(event))
    first.onmessage?.({ data: JSON.stringify({ type: 'sys.hello', data: {} }) })
    expect(events).toEqual([])
    expect(client.state).toBe('reconnecting')
  })

  it('reconnects at once when told to, without waiting to notice the silence', () => {
    const { client, states } = createClient()
    client.start()
    const asleep = latestSocket()
    asleep.serverSaysHello(HEARTBEAT)

    // 电脑刚醒：旧连接看上去还开着，其实已经没用了
    client.reconnectNow()
    expect(asleep.closedByClient).toBe(true)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(client.state).toBe('reconnecting')

    latestSocket().serverSaysHello(HEARTBEAT)
    expect(states).toEqual(['connecting', 'open', 'reconnecting', 'open'])
    // 旧连接的心跳已经停了，只有新的在发
    vi.advanceTimersByTime(HEARTBEAT)
    expect(asleep.sent).toEqual([])
    expect(latestSocket().sent).toHaveLength(1)
  })

  it('cuts a pending wait short and starts counting from the shortest wait again', () => {
    const { client } = createClient()
    client.start()
    latestSocket().serverSaysHello()
    // 连着两次没连上，下一次本来要等 4 秒
    latestSocket().connectionDrops()
    vi.advanceTimersByTime(1000)
    latestSocket().connectionDrops()
    vi.advanceTimersByTime(2000)
    latestSocket().connectionDrops()
    expect(FakeSocket.instances).toHaveLength(3)

    client.reconnectNow()
    expect(FakeSocket.instances).toHaveLength(4)
    // 原来那一次等待已经取消，不会再多开一个连接
    vi.advanceTimersByTime(4000)
    expect(FakeSocket.instances).toHaveLength(4)

    // 这次又没连上：从 1 秒重新开始
    latestSocket().connectionDrops()
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(5)
  })

  it('does nothing when told to reconnect after being stopped', () => {
    const { client } = createClient()
    client.reconnectNow()
    expect(FakeSocket.instances).toHaveLength(0)
    client.start()
    client.stop()
    client.reconnectNow()
    expect(FakeSocket.instances).toHaveLength(1)
    expect(client.state).toBe('closed')
  })

  it('can be started again after being stopped', () => {
    const { client } = createClient()
    client.start()
    client.stop()
    client.start()
    expect(FakeSocket.instances).toHaveLength(2)
    expect(client.state).toBe('connecting')
  })
})
