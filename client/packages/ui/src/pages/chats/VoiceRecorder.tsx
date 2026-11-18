import { Mic, SendHorizontal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration, recordingType } from './voice'

/** 短于这么久的录音多半是误触，不发。 */
const MIN_DURATION_MS = 500

type Problem = 'denied' | 'noDevice' | 'unsupported' | 'insecure' | 'failed' | 'tooShort'

interface VoiceRecorderProps {
  /** 最长录多少秒。到了自动停下，等用户决定发还是不发。 */
  maxSeconds: number
  onCancel: () => void
  onSend: (recording: Blob, durationMs: number) => void
}

/** 为什么录不了。 */
function problemOf(error: unknown): Problem {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'noDevice'
  return 'failed'
}

/**
 * 录制条：一出现就开始录，显示已录时长，可以取消或发送。
 * 录制结束或取消后立即释放麦克风。
 */
export function VoiceRecorder({ maxSeconds, onCancel, onSend }: VoiceRecorderProps) {
  const { t } = useTranslation('chats')
  const [elapsed, setElapsed] = useState(0)
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)
  // 停下之后录了多久。录着的时候是空
  const duration = useRef<number | null>(null)
  // 停下之后要不要发出去
  const sendWhenStopped = useRef(false)
  const latest = useRef({ onSend, maxSeconds })
  latest.current = { onSend, maxSeconds }

  function release() {
    for (const track of stream.current?.getTracks() ?? []) track.stop()
    stream.current = null
  }

  function finish() {
    const length = duration.current ?? 0
    if (length < MIN_DURATION_MS) {
      setProblem('tooShort')
      return
    }
    const type = recorder.current?.mimeType || chunks.current[0]?.type || 'audio/webm'
    latest.current.onSend(new Blob(chunks.current, { type }), Math.round(length))
  }

  function stop() {
    const active = recorder.current
    if (active && active.state !== 'inactive') active.stop()
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在出现时开始一次
  useEffect(() => {
    let cancelled = false
    async function start() {
      if (!window.isSecureContext) return setProblem('insecure')
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        return setProblem('unsupported')
      }
      try {
        const media = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          for (const track of media.getTracks()) track.stop()
          return
        }
        stream.current = media
        const mimeType = recordingType()
        const active = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
        recorder.current = active
        active.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.current.push(event.data)
        }
        active.onstart = () => {
          startedAt.current = performance.now()
          setRecording(true)
        }
        active.onstop = () => {
          duration.current = performance.now() - startedAt.current
          setElapsed(duration.current)
          setRecording(false)
          // 录完了，马上把麦克风还回去
          release()
          if (sendWhenStopped.current) finish()
        }
        active.onerror = () => {
          release()
          setProblem('failed')
        }
        active.start()
      } catch (error) {
        if (!cancelled) setProblem(problemOf(error))
      }
    }
    void start()
    return () => {
      cancelled = true
      sendWhenStopped.current = false
      stop()
      release()
    }
  }, [])

  // 录着的时候走表；到最长时长自动停下
  // biome-ignore lint/correctness/useExhaustiveDependencies: stop 只用到不会变的引用
  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => {
      const now = performance.now() - startedAt.current
      setElapsed(now)
      if (now >= latest.current.maxSeconds * 1000) stop()
    }, 100)
    return () => window.clearInterval(timer)
  }, [recording])

  function send() {
    if (recording) {
      sendWhenStopped.current = true
      stop()
    } else if (duration.current !== null) {
      finish()
    }
  }

  const stopped = !recording && duration.current !== null
  const reachedLimit = stopped && elapsed >= maxSeconds * 1000 - 200
  const button =
    'grid size-11 flex-none place-items-center rounded-control transition-colors duration-150 md:size-9'
  return (
    <div
      data-testid="voice-recorder"
      className="flex flex-none items-center gap-2 border-border border-t p-2 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))] md:p-3"
    >
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('voice.cancel')}
        title={t('voice.cancel')}
        className={`${button} text-fg-2 hover:bg-hover hover:text-fg`}
      >
        <X size={20} strokeWidth={1.5} aria-hidden />
      </button>
      {problem ? (
        <p
          role="alert"
          data-testid="voice-problem"
          className="min-w-0 flex-1 text-[13px] text-fg-2"
        >
          {t(`voice.${problem}`)}
        </p>
      ) : (
        <p className="flex min-w-0 flex-1 items-center gap-2" aria-live="off">
          <Mic
            size={18}
            strokeWidth={1.5}
            aria-hidden
            className={recording ? 'animate-pulse text-danger' : 'text-fg-3'}
          />
          <span data-testid="voice-elapsed" className="font-medium tabular-nums">
            {formatDuration(elapsed)}
          </span>
          <span className="truncate text-[12px] text-fg-3">
            {reachedLimit
              ? t('voice.reachedLimit')
              : recording
                ? t('voice.limit', { seconds: maxSeconds })
                : ''}
          </span>
        </p>
      )}
      {!problem && (
        <button
          type="button"
          onClick={send}
          disabled={!recording && !stopped}
          aria-label={t('voice.send')}
          title={t('voice.send')}
          className={`${button} bg-accent text-on-accent hover:opacity-90 disabled:opacity-40`}
        >
          <SendHorizontal size={18} strokeWidth={1.5} aria-hidden />
        </button>
      )}
    </div>
  )
}
