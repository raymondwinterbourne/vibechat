// 群通话的技术验证页面（F10 第一段，T3）：几个窗口或几台设备进同一个验证用的房间，
// 看能不能互相听到、谁在说话、走的是 UDP 还是 TCP、占多少流量。
//
// 界面上没有入口，只能输入地址 /group-call-check 打开。声音经过服务器上的媒体转发服务（LiveKit）。
// 同一个账号可以开几个窗口、用几台设备进来，每一个算一个人。正式的群通话做好以后，这一页只作诊断用。
//
// F11 第一段（T2）加上了摄像头：每个人同时发"清楚的、小的"两档画面，这里看得到每一档发了多少；
// 别人的每一路可以指定要清楚的、小的还是不要，旁边是实际收到的大小和码率。
//
// F12 第一段（T2）加上了共享屏幕：只发一档，清晰度优先。共享的人看得到屏幕多大、发出去多大、
// 多少帧、多少码率、是什么限制了质量；别人那里屏幕显示出来，旁边是实际收到的大小和码率。

import {
  ApiError,
  fetchIceServers,
  GROUP_VIDEO,
  groupVideoSettings,
  joinRoom,
  microphoneProblem,
  newDeviceId,
  type RoomHandle,
  type RoomSnapshot,
  type RoomStats,
  type RoomVideoStats,
  requestGroupCheckTicket,
  type VideoLayer,
} from '@vibechat/core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/Button'
import { useErrorMessage } from '../errors'

/** 多久量一次流量。 */
const STATS_INTERVAL_MS = 2000

/** 身份是"用户编号:设备"，只显示每一段的后几位，够区分就行。 */
function shortIdentity(identity: string): string {
  return identity
    .split(':')
    .map((part) => part.slice(-6))
    .join(' · ')
}

/** 一路画面。画面换了（开、关、重新订阅）就跟着换。`screen`：共享的屏幕，完整显示、不裁。 */
function Picture({
  track,
  mirrored,
  screen = false,
  actual = false,
}: {
  track: MediaStreamTrack | null
  mirrored: boolean
  screen?: boolean
  /** 共享的屏幕按原始大小显示：一个像素对一个像素，不缩小。 */
  actual?: boolean
}) {
  const element = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = element.current
    if (!video) return
    video.srcObject = track ? new MediaStream([track]) : null
    return () => {
      video.srcObject = null
    }
  }, [track])
  return (
    <video
      ref={element}
      data-testid={screen ? 'group-check-screen' : 'group-check-picture'}
      autoPlay
      playsInline
      muted
      className={`rounded-control bg-black ${
        screen
          ? actual
            ? 'max-w-none'
            : 'w-full object-contain'
          : 'aspect-video w-40 flex-none object-cover'
      } ${mirrored ? '-scale-x-100' : ''} ${track ? '' : 'hidden'}`}
    />
  )
}

/**
 * 别人共享的屏幕。平时按页面的宽度缩小显示；"按原始大小看"时全屏，一个像素对一个像素，
 * 放不下就滚动：判断字清不清楚要这样看，缩小了看不出来。
 */
function SharedScreen({ track }: { track: MediaStreamTrack | null }) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const [actual, setActual] = useState(false)
  // 用 Esc 退出全屏时也回到缩小的样子
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement !== box.current) setActual(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  function toggle() {
    if (actual) {
      setActual(false)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      return
    }
    setActual(true)
    // 有的浏览器（iPhone 的 Safari）不能把一块内容全屏：那就在原地按原始大小显示，可以滚动
    void box.current?.requestFullscreen?.().catch(() => {})
  }
  return (
    <div ref={box} className={actual ? 'max-h-[80vh] overflow-auto bg-black' : ''}>
      <Picture track={track} mirrored={false} screen actual={actual} />
      <Button
        variant="secondary"
        data-testid="group-check-actual-size"
        aria-pressed={actual}
        onClick={toggle}
        className={actual ? 'fixed top-3 right-3 z-10' : 'mt-2'}
      >
        {actual ? t('groupCheck.fitSize') : t('groupCheck.actualSize')}
      </Button>
    </div>
  )
}

const LAYERS: VideoLayer[] = ['high', 'low', 'off']

export function GroupCallCheckPage() {
  const { t } = useTranslation()
  const { t: tChats } = useTranslation('chats')
  const errorMessage = useErrorMessage()
  // 这个页面每打开一次是一台新的设备
  const [device] = useState(newDeviceId)
  const room = useRef<RoomHandle | null>(null)
  const [joining, setJoining] = useState(false)
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [stats, setStats] = useState<RoomStats | null>(null)
  const [videoStats, setVideoStats] = useState<RoomVideoStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 入场凭证要不要放行摄像头。不放行的和语音通话的凭证一样
  const [withCamera, setWithCamera] = useState(true)
  // 入场凭证要不要放行共享的屏幕
  const [withScreen, setWithScreen] = useState(true)
  // 每个人的画面要哪一档；没选过的是小的
  const [watching, setWatching] = useState<Record<string, VideoLayer>>({})

  const joined = snapshot !== null && snapshot.phase !== 'closed'

  async function join() {
    setError(null)
    setStats(null)
    setVideoStats(null)
    setWatching({})
    setJoining(true)
    try {
      const ticket = await requestGroupCheckTicket(device, {
        camera: withCamera,
        screen: withScreen,
      })
      // 两档画面的码率用管理员现在设的，和正式的群视频通话一样
      const video = await fetchIceServers()
        .then((servers) => groupVideoSettings(servers.video))
        .catch(() => GROUP_VIDEO)
      const handle = await joinRoom(ticket, setSnapshot, { video })
      room.current = handle
      setSnapshot(handle.snapshot())
    } catch (failure) {
      if (failure instanceof ApiError) {
        setError(failure.code === 'unavailable' ? t('groupCheck.notSetUp') : errorMessage(failure))
      } else if (failure instanceof DOMException) {
        // 拿不到麦克风：说明和一对一通话的一样
        setError(tChats(`call.microphone.${microphoneProblem(failure)}`))
      } else {
        setError(
          t('groupCheck.failed', {
            reason: failure instanceof Error ? failure.message : String(failure),
          }),
        )
      }
    } finally {
      setJoining(false)
    }
  }

  async function leave() {
    const handle = room.current
    room.current = null
    await handle?.leave()
    setSnapshot(null)
    setStats(null)
    setVideoStats(null)
  }

  async function toggleCamera(on: boolean) {
    setError(null)
    try {
      await room.current?.setCamera(on)
    } catch (failure) {
      setError(
        t('groupCheck.cameraFailed', {
          reason: failure instanceof Error ? failure.message : String(failure),
        }),
      )
    }
  }

  async function toggleScreen(on: boolean) {
    setError(null)
    try {
      await room.current?.setScreen(on)
    } catch (failure) {
      // 用户在选择框里点了取消：不算出错
      if (failure instanceof DOMException && failure.name === 'AbortError') return
      setError(
        t('groupCheck.screenFailed', {
          reason: failure instanceof Error ? failure.message : String(failure),
        }),
      )
    }
  }

  function watch(identity: string, layer: VideoLayer) {
    setWatching((current) => ({ ...current, [identity]: layer }))
    room.current?.watch(identity, layer)
  }

  // 离开这一页时退出房间，麦克风随之释放
  useEffect(
    () => () => {
      void room.current?.leave()
      room.current = null
    },
    [],
  )

  // 每隔一会儿量一次这条线的情况
  useEffect(() => {
    if (!joined) return
    let stopped = false
    const measure = async () => {
      const current = await room.current?.stats().catch(() => null)
      if (!stopped && current) setStats(current)
      const pictures = await room.current?.videoStats().catch(() => null)
      if (!stopped && pictures) setVideoStats(pictures)
    }
    void measure()
    const timer = window.setInterval(measure, STATS_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [joined])

  const kbps = (value: number | null | undefined) =>
    value == null ? t('groupCheck.unknown') : `${value} kbps`
  const me = snapshot?.members.find((member) => member.me)
  // 同一时间只看一个人的屏幕：房间里第一个在共享的别人
  const sharer = snapshot?.members.find((member) => !member.me && member.screen)?.identity ?? null
  useEffect(() => {
    room.current?.watchScreen(sharer)
  }, [sharer])
  // 手机浏览器不能共享屏幕
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function'

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div
        data-testid="group-check"
        className="mx-auto flex max-w-[640px] flex-col gap-5 p-4 md:p-6"
      >
        <header className="flex flex-col gap-1">
          <h1 className="font-medium text-[17px]">{t('groupCheck.title')}</h1>
          <p className="text-fg-2">{t('groupCheck.intro')}</p>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          {joined ? (
            <>
              <Button
                variant="secondary"
                onClick={() => void room.current?.setMuted(!snapshot.muted)}
              >
                {snapshot.muted ? t('groupCheck.unmute') : t('groupCheck.mute')}
              </Button>
              <Button variant="secondary" onClick={() => void toggleCamera(!snapshot.camera)}>
                {snapshot.camera ? t('groupCheck.cameraOff') : t('groupCheck.cameraOn')}
              </Button>
              {canShare && (
                <Button variant="secondary" onClick={() => void toggleScreen(!snapshot.screen)}>
                  {snapshot.screen ? t('groupCheck.screenOff') : t('groupCheck.screenOn')}
                </Button>
              )}
              <Button variant="danger" onClick={() => void leave()}>
                {t('groupCheck.leave')}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => void join()} disabled={joining}>
                {joining ? t('groupCheck.joining') : t('groupCheck.join')}
              </Button>
              <label className="flex min-h-11 items-center gap-2 text-[13px] md:min-h-0">
                <input
                  type="checkbox"
                  checked={withCamera}
                  disabled={joining}
                  onChange={(event) => setWithCamera(event.target.checked)}
                />
                <span title={t('groupCheck.withCameraHint')}>{t('groupCheck.withCamera')}</span>
              </label>
              <label className="flex min-h-11 items-center gap-2 text-[13px] md:min-h-0">
                <input
                  type="checkbox"
                  checked={withScreen}
                  disabled={joining}
                  onChange={(event) => setWithScreen(event.target.checked)}
                />
                <span>{t('groupCheck.withScreen')}</span>
              </label>
            </>
          )}
          {joined && snapshot.audioBlocked && (
            <Button variant="secondary" onClick={() => void room.current?.startAudio()}>
              {t('groupCheck.startAudio')}
            </Button>
          )}
        </div>

        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {snapshot?.phase === 'closed' && snapshot.closedBecause && (
          <p data-testid="group-check-closed" className="text-fg-2">
            {t('groupCheck.closed', { reason: snapshot.closedBecause })}
          </p>
        )}

        <dl
          data-testid="group-check-status"
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]"
        >
          <dt className="text-fg-2">{t('groupCheck.state')}</dt>
          <dd data-testid="group-check-state">{snapshot?.phase ?? 'idle'}</dd>
          <dt className="text-fg-2">{t('groupCheck.me')}</dt>
          <dd data-testid="group-check-me">
            {me ? shortIdentity(me.identity) : t('groupCheck.unknown')}
          </dd>
          <dt className="text-fg-2">{t('groupCheck.protocol')}</dt>
          <dd data-testid="group-check-protocol">
            {stats?.protocol ? stats.protocol.toUpperCase() : t('groupCheck.unknown')}
          </dd>
          <dt className="text-fg-2">{t('groupCheck.server')}</dt>
          <dd data-testid="group-check-server">{stats?.server ?? t('groupCheck.unknown')}</dd>
          <dt className="text-fg-2">{t('groupCheck.delay')}</dt>
          <dd>
            {stats?.roundTripMs != null ? `${stats.roundTripMs} ms` : t('groupCheck.unknown')}
          </dd>
          <dt className="text-fg-2">{t('groupCheck.sent')}</dt>
          <dd data-testid="group-check-sent" data-bytes={stats?.bytesSent ?? 0}>
            {kbps(stats?.sentKbps)}
          </dd>
          <dt className="text-fg-2">{t('groupCheck.received')}</dt>
          <dd data-testid="group-check-received" data-bytes={stats?.bytesReceived ?? 0}>
            {kbps(stats?.receivedKbps)}
          </dd>
        </dl>

        {joined && videoStats && videoStats.sent.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] text-fg-2">{t('groupCheck.sentVideo')}</h2>
            <ul data-testid="group-check-sent-video" className="flex flex-col gap-1 text-[13px]">
              {videoStats.sent.map((layer) => (
                <li
                  key={layer.rid}
                  data-testid="group-check-sent-layer"
                  data-rid={layer.rid}
                  data-width={layer.width}
                  data-bytes={layer.bytes}
                  className="flex gap-3"
                >
                  <span className="w-20 flex-none text-fg-2">
                    {layer.rid === 'q'
                      ? t('groupCheck.tierLow')
                      : layer.rid
                        ? t('groupCheck.tierHigh')
                        : t('groupCheck.tierOnly')}
                  </span>
                  <span className="w-32 flex-none">
                    {layer.width > 0
                      ? `${layer.width}×${layer.height} · ${layer.fps} fps`
                      : t('groupCheck.stopped')}
                  </span>
                  <span>{kbps(layer.kbps)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {joined && snapshot.screen && (
          <section className="flex flex-col gap-1 text-[13px]">
            <h2 className="text-fg-2">{t('groupCheck.sentScreen')}</h2>
            <p
              data-testid="group-check-sent-screen"
              data-captured-width={videoStats?.screenSent?.capturedWidth ?? 0}
              data-width={videoStats?.screenSent?.width ?? 0}
              data-bytes={videoStats?.screenSent?.bytes ?? 0}
              data-resolution-first={String(videoStats?.screenSent?.resolutionFirst ?? '')}
            >
              {videoStats?.screenSent
                ? t('groupCheck.sentScreenLine', {
                    captured: `${videoStats.screenSent.capturedWidth}×${videoStats.screenSent.capturedHeight}`,
                    sent: `${videoStats.screenSent.width}×${videoStats.screenSent.height}`,
                    fps: videoStats.screenSent.fps,
                    rate: kbps(videoStats.screenSent.kbps),
                    limit: videoStats.screenSent.limitedBy ?? t('groupCheck.unknown'),
                    first:
                      videoStats.screenSent.resolutionFirst === null
                        ? t('groupCheck.unknown')
                        : videoStats.screenSent.resolutionFirst
                          ? t('groupCheck.yes')
                          : t('groupCheck.no'),
                  })
                : t('groupCheck.unknown')}
            </p>
          </section>
        )}

        {joined && sharer && (
          <section className="flex flex-col gap-2 text-[13px]">
            <h2 className="text-fg-2">
              {t('groupCheck.sharedScreen', { who: shortIdentity(sharer) })}
            </h2>
            <SharedScreen track={room.current?.screenTrack(sharer) ?? null} />
            <span
              data-testid="group-check-received-screen"
              data-width={videoStats?.screenReceived?.width ?? 0}
              data-bytes={videoStats?.screenReceived?.bytes ?? 0}
            >
              {videoStats?.screenReceived
                ? `${videoStats.screenReceived.width}×${videoStats.screenReceived.height} · ${videoStats.screenReceived.fps} fps · ${kbps(videoStats.screenReceived.kbps)}`
                : t('groupCheck.noPicture')}
            </span>
          </section>
        )}

        {joined && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] text-fg-2">
              {t('groupCheck.members', { count: snapshot.members.length })}
            </h2>
            <ul
              data-testid="group-check-members"
              className="flex flex-col divide-y divide-border rounded-control border border-border"
            >
              {snapshot.members.map((member) => (
                <li
                  key={member.identity}
                  data-testid="group-check-member"
                  data-me={member.me ? '' : undefined}
                  data-speaking={member.speaking ? '' : undefined}
                  data-muted={member.muted ? '' : undefined}
                  data-camera={member.camera ? '' : undefined}
                  data-screen={member.screen ? '' : undefined}
                  className="flex flex-wrap items-center gap-3 px-3 py-2"
                >
                  <span
                    aria-hidden
                    className={`size-2.5 flex-none rounded-full ${
                      member.speaking ? 'bg-accent' : 'bg-border'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                    {shortIdentity(member.identity)}
                  </span>
                  <span className="flex-none text-[12px] text-fg-3">
                    {[
                      member.me ? t('groupCheck.you') : null,
                      member.muted ? t('groupCheck.muted') : null,
                      member.speaking ? t('groupCheck.speaking') : null,
                      member.camera ? t('groupCheck.cameraIsOn') : null,
                      member.screen ? t('groupCheck.screenIsOn') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {member.camera && (
                    <div className="flex w-full flex-wrap items-center gap-3">
                      <Picture
                        track={room.current?.videoTrack(member.identity) ?? null}
                        mirrored={member.me}
                      />
                      {!member.me && (
                        <div className="flex flex-col gap-1 text-[13px]">
                          <label className="flex items-center gap-2">
                            <span className="text-fg-2">{t('groupCheck.watch')}</span>
                            <select
                              data-testid="group-check-watch"
                              className="min-h-11 rounded-control border border-border bg-bg px-2 md:min-h-8"
                              value={watching[member.identity] ?? 'low'}
                              onChange={(event) =>
                                watch(member.identity, event.target.value as VideoLayer)
                              }
                            >
                              {LAYERS.map((layer) => (
                                <option key={layer} value={layer}>
                                  {t(
                                    `groupCheck.watch${layer === 'high' ? 'High' : layer === 'low' ? 'Low' : 'Off'}`,
                                  )}
                                </option>
                              ))}
                            </select>
                          </label>
                          <span
                            data-testid="group-check-received-video"
                            data-width={videoStats?.received[member.identity]?.width ?? 0}
                            data-bytes={videoStats?.received[member.identity]?.bytes ?? 0}
                          >
                            {videoStats?.received[member.identity]
                              ? `${videoStats.received[member.identity]?.width}×${videoStats.received[member.identity]?.height} · ${videoStats.received[member.identity]?.fps} fps · ${kbps(videoStats.received[member.identity]?.kbps)}`
                              : t('groupCheck.noPicture')}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
