import type { QuoteView } from '@vibechat/protocol'
import { useTranslation } from 'react-i18next'
import { contentLabel } from './text'

interface QuoteBlockProps {
  quote: QuoteView
  /** 被引用的人显示成什么名字。 */
  name: string | null
  /** 在自己的气泡里：颜色跟着气泡走。 */
  onAccent?: boolean
  /** 点一下跳到原消息。原消息已撤回或看不到时不能跳。 */
  onJump?: () => void
}

/** 回复里被引用的那条消息：发送人和一行摘要。 */
export function QuoteBlock({ quote, name, onAccent = false, onJump }: QuoteBlockProps) {
  const { t } = useTranslation('chats')
  const tone = onAccent ? 'border-on-accent/50 text-on-accent/80' : 'border-border text-fg-2'
  const frame = `mb-1.5 block max-w-full border-l-2 pl-2 text-left text-[12px] ${tone}`

  if (quote.state !== 'shown') {
    return (
      <span data-testid="quote" data-state={quote.state} className={frame}>
        {quote.state === 'recalled' ? t('quote.recalled') : t('quote.unavailable')}
      </span>
    )
  }
  const summary = contentLabel(
    {
      kind: quote.kind ?? 'text',
      text: quote.text,
      file: quote.file_name === null ? null : { name: quote.file_name },
    },
    t,
  )
  const body = (
    <>
      {name && <span className="font-medium">{name}: </span>}
      {summary}
    </>
  )
  if (!onJump) {
    return (
      <span data-testid="quote" data-state="shown" className={`${frame} line-clamp-2`}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onJump}
      title={t('quote.jump')}
      data-testid="quote"
      data-state="shown"
      className={`${frame} line-clamp-2 hover:underline`}
    >
      {body}
    </button>
  )
}
