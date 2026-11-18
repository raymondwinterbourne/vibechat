// 通话的技术验证页面（F3 第一段，T3）：两个窗口或两台设备互相通话，看能不能接通、走的是哪条路。
//
// 界面上没有入口，只能输入地址 /call-check 打开。连接信息不经过服务端转交，由人复制粘贴：
// 一方点"我先开始"，把"我的连接信息"发给对方（例如用聊天发过去）；对方粘贴后点"接受"，
// 再把他的连接信息发回来；第一方粘贴后点"连接"。正式的通话功能做好以后，这一页只作诊断用。

import { useQuery } from '@tanstack/react-query'
import {
  type CallPath,
  type CandidateKind,
  decodeSignal,
  encodeSignal,
  fetchIceServers,
  readCallPath,
} from '@vibechat/core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/Button'

/** 收集候选地址最多等多久。中转服务连不上时不至于一直等。 */
const GATHER_TIMEOUT_MS = 5000

function waitForGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check)
      clearTimeout(timer)
      resolve()
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, GATHER_TIMEOUT_MS)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

export function CallCheckPage() {
  const { t } = useTranslation()
  const servers = useQuery({
    queryKey: ['ice-servers'],
    queryFn: ({ signal }) => fetchIceServers({ signal }),
    staleTime: 0,
  })
  const [relayOnly, setRelayOnly] = useState(false)
  const [mine, setMine] = useState('')
  // 我的连接信息是开头的一段还是应答，决定下一步该提示什么
  const [mineKind, setMineKind] = useState<'offer' | 'answer'>('offer')
  const [theirs, setTheirs] = useState('')
  const [state, setState] = useState<RTCPeerConnectionState | 'idle'>('idle')
  const [path, setPath] = useState<CallPath | null>(null)
  // 连接卡在 connecting 时看是哪一步：找路（ICE）还是加密握手（DTLS）
  const [steps, setSteps] = useState<{ ice: string; dtls: string } | null>(null)
  const [level, setLevel] = useState(0)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 连中转服务时出的错：地址、错误码和说明。排查连不上的时候看
  const [iceErrors, setIceErrors] = useState<string[]>([])
  const pc = useRef<RTCPeerConnection | null>(null)
  const local = useRef<MediaStream | null>(null)
  const audio = useRef<HTMLAudioElement>(null)

  function hangUp() {
    pc.current?.close()
    pc.current = null
    for (const track of local.current?.getTracks() ?? []) track.stop()
    local.current = null
    setState('idle')
    setPath(null)
    setSteps(null)
    setLevel(0)
    setMine('')
    setIceErrors([])
  }

  // 离开这一页时挂断，麦克风随之释放
  useEffect(
    () => () => {
      pc.current?.close()
      for (const track of local.current?.getTracks() ?? []) track.stop()
    },
    [],
  )

  // 每秒看一次正在用的那条路、收到了多少
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setInterval(async () => {
      const connection = pc.current
      if (!connection) return
      const report = await connection.getStats()
      setPath(readCallPath(report.values() as Iterable<never>))
      const transport = connection.getSenders()[0]?.transport
      setSteps({ ice: connection.iceConnectionState, dtls: transport?.state ?? '—' })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [state])

  /** 准备好一条连接：麦克风、中转服务、收到对方的声音时播放并测音量。 */
  async function prepare(): Promise<RTCPeerConnection> {
    hangUp()
    setError(null)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    local.current = stream
    const connection = new RTCPeerConnection({
      // 只用我们自己的中转服务，不配任何公共服务（需求 NFR-PRI-04）
      iceServers: servers.data?.ice_servers ?? [],
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
    })
    for (const track of stream.getTracks()) connection.addTrack(track, stream)
    connection.addEventListener('connectionstatechange', () => setState(connection.connectionState))
    connection.addEventListener('icecandidateerror', (event) => {
      const failure = event as RTCPeerConnectionIceErrorEvent
      const line = `${failure.url} ${failure.errorCode} ${failure.errorText}`.trim()
      setIceErrors((current) => (current.includes(line) ? current : [...current, line]))
    })
    connection.addEventListener('track', (event) => {
      const [remote] = event.streams
      if (!remote) return
      if (audio.current) {
        audio.current.srcObject = remote
        void audio.current.play().catch(() => {})
      }
      measure(remote)
    })
    pc.current = connection
    setState(connection.connectionState)
    return connection
  }

  /** 对方声音的大小，0 到 1，用来确认真的听得到。 */
  function measure(remote: MediaStream) {
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    context.createMediaStreamSource(remote).connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    const timer = window.setInterval(() => {
      if (!pc.current) {
        window.clearInterval(timer)
        void context.close()
        return
      }
      analyser.getByteTimeDomainData(samples)
      let peak = 0
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128) / 128)
      setLevel(peak)
    }, 200)
  }

  async function run(step: () => Promise<void>) {
    try {
      await step()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  function start() {
    void run(async () => {
      const connection = await prepare()
      await connection.setLocalDescription(await connection.createOffer())
      await waitForGathering(connection)
      const offer = connection.localDescription
      if (offer) {
        setMine(encodeSignal({ type: 'offer', sdp: offer.sdp }))
        setMineKind('offer')
      }
    })
  }

  function useTheirs() {
    void run(async () => {
      const signal = decodeSignal(theirs)
      if (!signal) throw new Error(t('callCheck.badSignal'))
      if (signal.type === 'offer') {
        const connection = await prepare()
        await connection.setRemoteDescription(signal)
        await connection.setLocalDescription(await connection.createAnswer())
        await waitForGathering(connection)
        const answer = connection.localDescription
        if (answer) {
          setMine(encodeSignal({ type: 'answer', sdp: answer.sdp }))
          setMineKind('answer')
        }
      } else {
        if (!pc.current) throw new Error(t('callCheck.startFirst'))
        await pc.current.setRemoteDescription(signal)
      }
      // 用过了就清掉：再点一次不会把同一段又用一遍
      setTheirs('')
    })
  }

  function toggleMute() {
    const next = !muted
    for (const track of local.current?.getAudioTracks() ?? []) track.enabled = !next
    setMuted(next)
  }

  const kind = (value: CandidateKind | null | undefined) =>
    value ? t(`callCheck.kind.${value}`) : t('callCheck.unknown')
  const relay = servers.data?.ice_servers[0]

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        data-testid="call-check"
        className="mx-auto flex max-w-[640px] flex-col gap-5 p-4 md:p-6"
      >
        <header className="flex flex-col gap-1">
          <h1 className="font-medium text-[17px]">{t('callCheck.title')}</h1>
          <p className="text-fg-2">{t('callCheck.intro')}</p>
        </header>

        <p data-testid="call-check-relay" className="text-[13px]">
          {servers.isPending
            ? t('callCheck.loading')
            : relay
              ? t('callCheck.relay', { urls: relay.urls.join(', ') })
              : t('callCheck.noRelay')}
        </p>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={relayOnly}
            onChange={(event) => setRelayOnly(event.target.checked)}
            className="size-4"
          />
          {t('callCheck.relayOnly')}
        </label>

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={start}>
            {t('callCheck.start')}
          </Button>
          {state !== 'idle' && (
            <>
              <Button onClick={toggleMute}>
                {muted ? t('callCheck.unmute') : t('callCheck.mute')}
              </Button>
              <Button variant="danger" onClick={hangUp}>
                {t('callCheck.hangUp')}
              </Button>
            </>
          )}
        </div>

        {mine && (
          <div className="flex flex-col gap-2">
            <span className="text-fg-2">{t('callCheck.mine')}</span>
            <textarea
              readOnly
              value={mine}
              data-testid="call-check-mine"
              className="h-24 rounded-control border border-border bg-surface p-2 font-mono text-[11px]"
            />
            <Button
              className="self-start"
              onClick={() => void navigator.clipboard.writeText(mine).catch(() => {})}
            >
              {t('callCheck.copy')}
            </Button>
            {state !== 'connected' && (
              <p data-testid="call-check-next" className="text-[13px] text-accent">
                {mineKind === 'offer' ? t('callCheck.nextOffer') : t('callCheck.nextAnswer')}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-fg-2">{t('callCheck.theirs')}</span>
          <textarea
            value={theirs}
            onChange={(event) => setTheirs(event.target.value)}
            data-testid="call-check-theirs"
            className="h-24 rounded-control border border-border bg-bg p-2 font-mono text-[11px]"
          />
          <Button className="self-start" onClick={useTheirs} disabled={theirs.trim() === ''}>
            {t('callCheck.use')}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}

        <dl
          data-testid="call-check-status"
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]"
        >
          <dt className="text-fg-2">{t('callCheck.state')}</dt>
          <dd data-testid="call-check-state">{state}</dd>
          <dt className="text-fg-2">{t('callCheck.steps')}</dt>
          <dd data-testid="call-check-steps">
            {steps ? t('callCheck.stepsValue', steps) : t('callCheck.unknown')}
          </dd>
          <dt className="text-fg-2">{t('callCheck.myPath')}</dt>
          <dd data-testid="call-check-local">{kind(path?.local)}</dd>
          <dt className="text-fg-2">{t('callCheck.theirPath')}</dt>
          <dd>{kind(path?.remote)}</dd>
          <dt className="text-fg-2">{t('callCheck.delay')}</dt>
          <dd>{path?.roundTripMs != null ? `${path.roundTripMs} ms` : '—'}</dd>
          <dt className="text-fg-2">{t('callCheck.received')}</dt>
          <dd data-testid="call-check-received" data-bytes={path?.bytesReceived ?? 0}>
            {`${Math.round((path?.bytesReceived ?? 0) / 1024)} KB`}
          </dd>
          <dt className="text-fg-2">{t('callCheck.level')}</dt>
          <dd>
            <span className="inline-block h-2 w-40 overflow-hidden rounded-full bg-surface align-middle">
              <span
                data-testid="call-check-level"
                data-level={level.toFixed(2)}
                className="block h-full bg-accent"
                style={{ width: `${Math.min(100, Math.round(level * 100))}%` }}
              />
            </span>
          </dd>
        </dl>
        {iceErrors.length > 0 && (
          <div className="flex flex-col gap-1 text-[12px]">
            <span className="text-fg-2">{t('callCheck.iceErrors')}</span>
            <ul data-testid="call-check-ice-errors" className="font-mono text-danger">
              {iceErrors.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        {/* biome-ignore lint/a11y/useMediaCaption: 通话的声音没有字幕 */}
        <audio ref={audio} autoPlay />
      </div>
    </div>
  )
}
