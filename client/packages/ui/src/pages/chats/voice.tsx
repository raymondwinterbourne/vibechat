// 语音消息：播放，以及录音时格式的选择。

import type { FileView } from '@vibechat/protocol'
import { Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileUrls } from '../../files'

/**
 * 录音用的格式，按优先顺序。浏览器支持哪一种就用哪一种。
 *
 * 不同浏览器录出来的不一样：Safari 是 MP4 里的 AAC，Chrome 和 Firefox 是 WebM 或 Ogg 里的 Opus。
 * 服务端不转码，所以优先选别的浏览器也放得出来的。这个选择只写在这一处：
 * 实测发现哪两种浏览器之间放不出来时，改这里，或者改成由服务端转成统一的格式。
 */
const RECORDING_TYPES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
]

/** 这个浏览器录音用哪种格式。一种都不支持时返回空，由浏览器自己决定。 */
export function recordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

/** 时长写成"分:秒"。不足一秒的按一秒算。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** 正在播放的那一条。同时只播放一条：开始播另一条时，这一条停下。 */
let playing: HTMLAudioElement | null = null

interface VoiceBodyProps {
  file: FileView
  durationMs: number
  mine: boolean
  /** 别人发来的、我还没有听过。 */
  unplayed: boolean
  /** 开始播放时调用：标记为听过。 */
  onPlayed: () => void
}

/** 一条语音消息：点击播放和暂停，播放时有进度。 */
export function VoiceBody({ file, durationMs, mine, unplayed, onPlayed }: VoiceBodyProps) {
  const { t } = useTranslation('chats')
  const urls = useFileUrls()
  const [state, setState] = useState<'idle' | 'playing' | 'failed'>('idle')
  const [position, setPosition] = useState(0)
  const audio = useRef<HTMLAudioElement | null>(null)

  // 离开这个会话时停下
  useEffect(
    () => () => {
      audio.current?.pause()
      if (playing === audio.current) playing = null
    },
    [],
  )

  function toggle() {
    let element = audio.current
    if (!element) {
      element = new Audio(urls.file(file.id))
      audio.current = element
      const created = element
      // 浏览器录出来的文件里常常没有写时长，进度按消息里带的时长来算
      created.ontimeupdate = () =>
        setPosition(Math.min(1, (created.currentTime * 1000) / Math.max(1, durationMs)))
      created.onended = () => {
        setState('idle')
        setPosition(0)
      }
      created.onpause = () => setState((current) => (current === 'playing' ? 'idle' : current))
      created.onerror = () => setState('failed')
    }
    if (state === 'playing') {
      element.pause()
      return
    }
    if (playing && playing !== element) playing.pause()
    playing = element
    const started = element
    started
      .play()
      .then(() => {
        setState('playing')
        onPlayed()
      })
      .catch(() => setState('failed'))
  }

  // 长一点的语音，气泡也长一点
  const width = Math.min(200, 96 + Math.round(durationMs / 1000) * 3)
  const tone = mine ? 'bg-accent text-on-accent' : 'bg-surface text-fg'
  const track = mine ? 'bg-on-accent/30' : 'bg-border'
  const fill = mine ? 'bg-on-accent' : 'bg-accent'
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        aria-label={state === 'playing' ? t('voice.pause') : t('voice.play')}
        title={state === 'failed' ? t('voice.playFailed') : undefined}
        data-testid="message-voice"
        data-state={state}
        style={{ width }}
        className={`flex h-11 items-center gap-2 rounded-[12px] px-3 md:h-10 ${tone}`}
      >
        {state === 'playing' ? (
          <Pause size={16} strokeWidth={1.5} aria-hidden className="flex-none" />
        ) : (
          <Play size={16} strokeWidth={1.5} aria-hidden className="flex-none" />
        )}
        <span className={`h-1 min-w-0 flex-1 overflow-hidden rounded-full ${track}`}>
          <span className={`block h-full ${fill}`} style={{ width: `${position * 100}%` }} />
        </span>
        <span data-testid="voice-duration" className="flex-none text-[12px] tabular-nums">
          {formatDuration(durationMs)}
        </span>
      </button>
      {unplayed && (
        <span
          role="status"
          aria-label={t('voice.unplayed')}
          data-testid="voice-unplayed"
          className="size-2 flex-none rounded-full bg-danger"
        />
      )}
      {state === 'failed' && (
        <span role="alert" className="text-[11px] text-danger">
          {t('voice.playFailed')}
        </span>
      )}
    </span>
  )
}
