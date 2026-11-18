import { Megaphone } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface NoticeCardProps {
  /** 上面那一行："某某发布了群公告"。 */
  title: string
  /** 这一次公告的全文。 */
  text: string
  seq: number
}

/**
 * 消息流里的一则群公告：居中的一张卡片，直接带着那一次的内容。
 * 太长的只显示前几行，可以展开、收起。
 */
export function NoticeCard({ title, text, seq }: NoticeCardProps) {
  const { t } = useTranslation('chats')
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const body = useRef<HTMLParagraphElement>(null)

  // 显示不下才给"展开"
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容变了才需要重新量
  useLayoutEffect(() => {
    const element = body.current
    if (element && !expanded) setClamped(element.scrollHeight > element.clientHeight + 1)
  }, [text, expanded])

  return (
    <div
      data-testid="notice-card"
      data-seq={seq}
      className="w-full max-w-[360px] self-center rounded-card border border-border bg-bg p-3"
    >
      <p className="mb-1.5 flex items-center gap-1.5 text-[12px] text-fg-2">
        <Megaphone size={14} strokeWidth={1.5} className="flex-none text-accent-fg" aria-hidden />
        <span className="min-w-0 truncate">{title}</span>
      </p>
      <p
        ref={body}
        data-testid="notice-card-text"
        className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${expanded ? '' : 'line-clamp-6'}`}
      >
        {text}
      </p>
      {(clamped || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[12px] text-accent-fg hover:underline max-md:min-h-11"
        >
          {expanded ? t('groupNotice.collapse') : t('groupNotice.expand')}
        </button>
      )}
    </div>
  )
}
