import { describe, expect, it } from 'vitest'
import {
  kbpsBetween,
  orderMembers,
  readAudioBytes,
  readRoomTransport,
  readVideoLayers,
} from './room'

// Chrome 的统计数据大致是这个样子
const report = [
  { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP1' },
  {
    id: 'CP0',
    type: 'candidate-pair',
    state: 'failed',
    localCandidateId: 'L0',
    remoteCandidateId: 'R0',
  },
  {
    id: 'CP1',
    type: 'candidate-pair',
    state: 'succeeded',
    nominated: true,
    localCandidateId: 'L1',
    remoteCandidateId: 'R1',
    currentRoundTripTime: 0.0234,
  },
  { id: 'L0', type: 'local-candidate', candidateType: 'host', protocol: 'tcp' },
  { id: 'L1', type: 'local-candidate', candidateType: 'prflx', protocol: 'udp' },
  {
    id: 'R0',
    type: 'remote-candidate',
    candidateType: 'host',
    address: '203.0.113.10',
    port: 7881,
  },
  {
    id: 'R1',
    type: 'remote-candidate',
    candidateType: 'host',
    address: '203.0.113.10',
    port: 7882,
  },
  { id: 'O1', type: 'outbound-rtp', kind: 'audio', bytesSent: 4000 },
  { id: 'I1', type: 'inbound-rtp', kind: 'audio', bytesReceived: 1500 },
  { id: 'I2', type: 'inbound-rtp', kind: 'audio', bytesReceived: 500 },
  { id: 'I3', type: 'inbound-rtp', kind: 'video', bytesReceived: 90000 },
]

describe('reading which way the audio goes to the media server', () => {
  it('finds the pair in use: UDP or TCP, the server address, the delay', () => {
    expect(readRoomTransport(report)).toEqual({
      protocol: 'udp',
      local: 'prflx',
      server: '203.0.113.10:7882',
      roundTripMs: 23,
    })
  })

  it('falls back to the nominated pair when the browser reports no transport', () => {
    // Firefox 没有 transport 这一项，地址也可能不给
    const firefox = report
      .filter((entry) => entry.type !== 'transport')
      .map((entry) =>
        entry.id === 'R1' ? { id: 'R1', type: 'remote-candidate', candidateType: 'host' } : entry,
      )
    expect(readRoomTransport(firefox)).toEqual({
      protocol: 'udp',
      local: 'prflx',
      server: null,
      roundTripMs: 23,
    })
  })

  it('reads TCP when UDP could not get through', () => {
    const tcp = report.map((entry) =>
      entry.id === 'T01' ? { ...entry, selectedCandidatePairId: 'CP0' } : entry,
    )
    expect(readRoomTransport(tcp)).toMatchObject({ protocol: 'tcp', server: '203.0.113.10:7881' })
  })

  it('knows nothing before there is a connection', () => {
    expect(readRoomTransport([])).toEqual({
      protocol: null,
      local: null,
      server: null,
      roundTripMs: null,
    })
  })
})

describe('measuring the audio', () => {
  it('adds up the audio only, in the asked direction', () => {
    expect(readAudioBytes(report, 'inbound')).toBe(2000)
    expect(readAudioBytes(report, 'outbound')).toBe(4000)
    expect(readAudioBytes([], 'inbound')).toBe(0)
  })

  it('turns two readings into kilobits per second', () => {
    // 2 秒里多了 10000 字节：40 kbps
    expect(kbpsBetween({ bytes: 1000, at: 1000 }, { bytes: 11000, at: 3000 })).toBe(40)
    expect(kbpsBetween(null, { bytes: 11000, at: 3000 })).toBeNull()
    // 时间没走、数字变小了（重新连过）：量不出来
    expect(kbpsBetween({ bytes: 1000, at: 3000 }, { bytes: 2000, at: 3000 })).toBeNull()
    expect(kbpsBetween({ bytes: 5000, at: 1000 }, { bytes: 100, at: 3000 })).toBeNull()
  })
})

describe('listing who is in the room', () => {
  it('puts me first and the others in a stable order', () => {
    const member = (identity: string, me = false) => ({
      identity,
      me,
      speaking: false,
      muted: false,
      camera: false,
      paused: false,
      screen: false,
      screenPaused: false,
    })
    const ordered = orderMembers([member('c'), member('a'), member('b', true), member('aa')])
    expect(ordered.map((entry) => entry.identity)).toEqual(['b', 'a', 'aa', 'c'])
  })
})

describe('measuring the pictures', () => {
  const report = [
    { id: 'a', type: 'outbound-rtp', kind: 'audio', bytesSent: 999 },
    {
      id: 'h',
      type: 'outbound-rtp',
      kind: 'video',
      rid: 'h',
      frameWidth: 640,
      frameHeight: 360,
      framesPerSecond: 14.6,
      bytesSent: 50000,
    },
    {
      id: 'q',
      type: 'outbound-rtp',
      kind: 'video',
      rid: 'q',
      frameWidth: 320,
      frameHeight: 180,
      framesPerSecond: 15,
      bytesSent: 15000,
    },
  ]

  it('lists each tier that is being sent, the small one first', () => {
    expect(readVideoLayers(report, 'outbound')).toEqual([
      { rid: 'q', width: 320, height: 180, fps: 15, bytes: 15000 },
      { rid: 'h', width: 640, height: 360, fps: 15, bytes: 50000 },
    ])
    // 发的不算收的
    expect(readVideoLayers(report, 'inbound')).toEqual([])
  })

  it('shows a tier that has stopped as zero by zero', () => {
    // 没有人要清楚的那一档：浏览器不再报它的大小
    const paused = [{ id: 'h', type: 'outbound-rtp', kind: 'video', rid: 'h', bytesSent: 50000 }]
    expect(readVideoLayers(paused, 'outbound')).toEqual([
      { rid: 'h', width: 0, height: 0, fps: 0, bytes: 50000 },
    ])
  })

  it('reads the one picture received from somebody', () => {
    const received = [
      {
        id: 'v',
        type: 'inbound-rtp',
        kind: 'video',
        frameWidth: 320,
        frameHeight: 180,
        framesPerSecond: 15,
        bytesReceived: 7000,
      },
    ]
    expect(readVideoLayers(received, 'inbound')).toEqual([
      { rid: '', width: 320, height: 180, fps: 15, bytes: 7000 },
    ])
  })
})
