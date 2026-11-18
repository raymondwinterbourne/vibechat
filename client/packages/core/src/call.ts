// 通话（F3）的接口调用，以及几样小工具：把连接信息写成一段可以复制粘贴的文字（通话验证页面用）、
// 从连接的统计数据里读出走的是哪条路。通话的状态在 calls.ts 里。

import type {
  CallView,
  CurrentCall,
  HangupReason,
  IceServers,
  RejectReason,
} from '@vibechat/protocol'
import { apiRequest } from './api'

interface Options {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

function post(body: unknown, options: Options = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  }
}

/** 中转服务的地址和临时账号。没有配置中转服务时列表为空。 */
export function fetchIceServers(options: Options = {}): Promise<IceServers> {
  return apiRequest('/api/calls/ice-servers', options)
}

/** 在这台设备上给单聊里的好友打电话。对方忙、对方不在线时，交回的通话已经结束了。 */
export function startCall(
  conversationId: string,
  device: string,
  video = false,
  options?: Options,
): Promise<CallView> {
  return apiRequest('/api/calls', post({ conversation_id: conversationId, device, video }, options))
}

/** 在这台设备上接听。 */
export function acceptCall(id: string, device: string, options?: Options): Promise<CallView> {
  return apiRequest(`/api/calls/${id}/accept`, post({ device }, options))
}

/** 拒绝来电；或者点了接听，但麦克风用不了（`no_microphone`）。 */
export function rejectCall(
  id: string,
  reason: RejectReason | null = null,
  options?: Options,
): Promise<CallView> {
  return apiRequest(`/api/calls/${id}/reject`, post({ reason }, options))
}

/** 挂断：响铃时是取消或拒绝，接通后是结束；音频连接断了恢复不了时是 `network`。 */
export function hangUpCall(
  id: string,
  device: string,
  reason: HangupReason | null = null,
  options?: Options,
): Promise<CallView> {
  return apiRequest(`/api/calls/${id}/hangup`, post({ device, reason }, options))
}

/** 把建立连接用的信息发给对方通话里的那一台设备。 */
export function sendCallSignal(
  id: string,
  device: string,
  signal: string,
  options?: Options,
): Promise<void> {
  return apiRequest(`/api/calls/${id}/signal`, post({ device, signal }, options))
}

/** 我现在所在的通话。 */
export function fetchCurrentCall(options: Options = {}): Promise<CurrentCall> {
  return apiRequest('/api/calls/current', options)
}

/** 一方的连接信息（WebRTC 的 offer 或 answer，带着全部候选地址）。 */
export interface Signal {
  type: 'offer' | 'answer'
  sdp: string
}

/** 连接信息写成一段文字，方便复制粘贴：JSON 再转 Base64，中间不会有换行和引号。 */
export function encodeSignal(signal: Signal): string {
  const bytes = new TextEncoder().encode(JSON.stringify(signal))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 读回一段连接信息。看不懂时为空。 */
export function decodeSignal(text: string): Signal | null {
  try {
    const binary = atob(text.trim())
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Signal>
    if ((value.type === 'offer' || value.type === 'answer') && typeof value.sdp === 'string') {
      return { type: value.type, sdp: value.sdp }
    }
    return null
  } catch {
    return null
  }
}

/** 候选地址的种类：本机地址、路由器的公网地址、中转服务的地址。 */
export type CandidateKind = 'host' | 'srflx' | 'prflx' | 'relay'

/** 正在用的那条路，以及收到了多少数据。 */
export interface CallPath {
  /** 我这一端用的地址是哪一种。是 `relay` 就是在走中转。 */
  local: CandidateKind | null
  remote: CandidateKind | null
  /** 收到的音频字节数。在涨，就是听得到对方。 */
  bytesReceived: number
  /** 来回一次的时间，毫秒。 */
  roundTripMs: number | null
}

type StatsEntry = Record<string, unknown> & { id: string; type: string }

/** 从连接的统计数据（RTCPeerConnection.getStats 的结果）里找出正在用的那条路。 */
export function readCallPath(report: Iterable<StatsEntry>): CallPath {
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
  const kind = (id: unknown) => {
    const candidate = typeof id === 'string' ? entries.get(id) : undefined
    return (candidate?.candidateType as CandidateKind | undefined) ?? null
  }
  const audio = all.filter((entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio')
  const rtt = pair?.currentRoundTripTime
  return {
    local: pair ? kind(pair.localCandidateId) : null,
    remote: pair ? kind(pair.remoteCandidateId) : null,
    bytesReceived: audio.reduce((sum, entry) => sum + Number(entry.bytesReceived ?? 0), 0),
    roundTripMs: typeof rtt === 'number' ? Math.round(rtt * 1000) : null,
  }
}

/** 收到的那一路画面：多大，到现在一共收了多少字节，什么时候量的（毫秒）。 */
export interface ReceivedVideo {
  width: number
  height: number
  bytes: number
  at: number
}

/** 从连接的统计数据里找出收到的画面（F7 T17：看不清时判断是画面小了还是码率低了）。还没有画面时为空。 */
export function readReceivedVideo(report: Iterable<StatsEntry>): ReceivedVideo | null {
  for (const entry of report) {
    if (entry.type !== 'inbound-rtp' || entry.kind !== 'video') continue
    const width = Number(entry.frameWidth ?? 0)
    const height = Number(entry.frameHeight ?? 0)
    if (width === 0 || height === 0) return null
    return {
      width,
      height,
      bytes: Number(entry.bytesReceived ?? 0),
      at: Number(entry.timestamp ?? 0),
    }
  }
  return null
}

/** 两次量的之间平均多少千比特每秒。 */
export function receivedKbps(
  before: { bytes: number; at: number },
  after: { bytes: number; at: number },
): number | null {
  const ms = after.at - before.at
  if (ms <= 0 || after.bytes < before.bytes) return null
  return Math.round(((after.bytes - before.bytes) * 8) / ms)
}

/** 发出去的那一路画面：多大，到现在一共发了多少字节，什么时候量的，受什么限制（F7）。 */
export interface SentVideo {
  width: number
  height: number
  bytes: number
  at: number
  /** 浏览器说画质受什么限制：网络（bandwidth）、电脑太忙（cpu）、别的，或者没有限制（none）。不说时为空。 */
  limitation: 'bandwidth' | 'cpu' | 'other' | 'none' | null
}

/** 从连接的统计数据里找出发出去的画面。还没有发出画面时为空。 */
export function readSentVideo(report: Iterable<StatsEntry>): SentVideo | null {
  for (const entry of report) {
    if (entry.type !== 'outbound-rtp' || entry.kind !== 'video') continue
    const width = Number(entry.frameWidth ?? 0)
    const height = Number(entry.frameHeight ?? 0)
    if (width === 0 || height === 0) return null
    const reason = entry.qualityLimitationReason
    return {
      width,
      height,
      bytes: Number(entry.bytesSent ?? 0),
      at: Number(entry.timestamp ?? 0),
      limitation:
        reason === 'bandwidth' || reason === 'cpu' || reason === 'other' || reason === 'none'
          ? reason
          : null,
    }
  }
  return null
}
