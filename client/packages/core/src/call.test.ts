import { describe, expect, it } from 'vitest'
import {
  decodeSignal,
  encodeSignal,
  readCallPath,
  readReceivedVideo,
  readSentVideo,
  receivedKbps,
} from './call'

describe('connection details to copy and paste', () => {
  it('survive the round trip, Chinese included', () => {
    const signal = { type: 'offer' as const, sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=通话\r\n' }
    const text = encodeSignal(signal)
    expect(text).not.toMatch(/[\s"]/)
    expect(decodeSignal(`  ${text}\n`)).toEqual(signal)
  })

  it('are refused when they are not ours', () => {
    expect(decodeSignal('not base64 at all!')).toBeNull()
    expect(decodeSignal(btoa('{"type":"hello","sdp":"x"}'))).toBeNull()
    expect(decodeSignal(btoa('[1,2]'))).toBeNull()
  })
})

describe('the path a call takes', () => {
  const base = [
    { id: 'L1', type: 'local-candidate', candidateType: 'relay' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'srflx' },
    { id: 'L2', type: 'local-candidate', candidateType: 'host' },
    { id: 'R2', type: 'remote-candidate', candidateType: 'host' },
    {
      id: 'P1',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'L1',
      remoteCandidateId: 'R1',
      currentRoundTripTime: 0.042,
    },
    {
      id: 'P2',
      type: 'candidate-pair',
      state: 'failed',
      localCandidateId: 'L2',
      remoteCandidateId: 'R2',
    },
    { id: 'A', type: 'inbound-rtp', kind: 'audio', bytesReceived: 1200 },
  ]

  it('is the pair the transport selected', () => {
    const path = readCallPath([
      ...base,
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P1' },
    ])
    expect(path).toEqual({ local: 'relay', remote: 'srflx', bytesReceived: 1200, roundTripMs: 42 })
  })

  it('falls back to the nominated pair that succeeded when the transport does not say', () => {
    expect(readCallPath(base).local).toBe('relay')
  })

  it('is unknown before anything connects', () => {
    expect(readCallPath([])).toEqual({
      local: null,
      remote: null,
      bytesReceived: 0,
      roundTripMs: null,
    })
  })
})

describe('the picture that comes in', () => {
  it('reads its size and works out the bitrate between two readings', () => {
    const reading = (bytes: number, at: number) =>
      readReceivedVideo([
        { id: 'A', type: 'inbound-rtp', kind: 'audio', bytesReceived: 999 },
        {
          id: 'V',
          type: 'inbound-rtp',
          kind: 'video',
          frameWidth: 1662,
          frameHeight: 1080,
          bytesReceived: bytes,
          timestamp: at,
        },
      ])
    const first = reading(1_000_000, 10_000)
    const second = reading(1_600_000, 12_000)
    expect(second).toMatchObject({ width: 1662, height: 1080 })
    // 600 000 字节 / 2 秒 = 2.4 Mbps
    expect(first && second && receivedKbps(first, second)).toBe(2400)
  })

  it('has nothing to say before any picture has arrived', () => {
    expect(
      readReceivedVideo([{ id: 'V', type: 'inbound-rtp', kind: 'video', frameWidth: 0 }]),
    ).toBeNull()
    expect(readReceivedVideo([])).toBeNull()
  })
})

describe('the picture that goes out', () => {
  it('reads its size and what is holding it back', () => {
    const sent = readSentVideo([
      {
        id: 'O',
        type: 'outbound-rtp',
        kind: 'video',
        frameWidth: 640,
        frameHeight: 360,
        bytesSent: 5000,
        timestamp: 1,
        qualityLimitationReason: 'bandwidth',
      },
    ])
    expect(sent).toEqual({ width: 640, height: 360, bytes: 5000, at: 1, limitation: 'bandwidth' })
    // Firefox 不说受什么限制
    expect(
      readSentVideo([
        { id: 'O', type: 'outbound-rtp', kind: 'video', frameWidth: 1, frameHeight: 1 },
      ])?.limitation,
    ).toBeNull()
    expect(readSentVideo([])).toBeNull()
  })
})
