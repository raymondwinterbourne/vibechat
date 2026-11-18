import type { ReactNode } from 'react'

interface MediaFrameProps {
  mine: boolean
  /** 这条消息回复的是哪一条：显示在图片、文件、语音的上方。 */
  quote?: ReactNode
  /** 图片的文字说明：紧贴着显示在图片下方。 */
  caption?: ReactNode
  /** 图片、文件或语音本身。 */
  children: ReactNode
}

/**
 * 图片、文件、语音自己带着外观，不套气泡。带着引用或说明时，引用放在上方，
 * 说明放在下方，三者排成一列，看起来是同一条消息。
 */
export function MediaFrame({ mine, quote, caption, children }: MediaFrameProps) {
  if (!quote && !caption) return children
  return (
    <div className={`flex max-w-full flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
      {quote && (
        <div
          data-testid="media-quote"
          className="max-w-full rounded-control bg-surface px-2 pt-1.5 pb-px"
        >
          {quote}
        </div>
      )}
      {children}
      {caption && (
        <p
          data-testid="message-caption"
          className={`max-w-full whitespace-pre-wrap rounded-[12px] px-3 py-2 [overflow-wrap:anywhere] ${
            mine ? 'bg-accent text-on-accent' : 'bg-surface'
          }`}
        >
          {caption}
        </p>
      )}
    </div>
  )
}
