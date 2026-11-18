import { CornerUpLeft, MoreHorizontal } from 'lucide-react'
import { type ReactNode, type TouchEvent, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/** 手指按住多久算长按。 */
const LONG_PRESS_MS = 500
/** 按住的时候手指挪动超过这么多像素，就是在滚动，不算长按。 */
const LONG_PRESS_SLACK = 10

export type BubbleStatus = 'uploading' | 'sending' | 'sent' | 'read' | 'failed'

interface BubbleProps {
  mine: boolean
  /** 消息的内容。 */
  children: ReactNode
  /** 内容自己带着外观（图片、文件、语音），不要再套气泡。 */
  bare?: boolean
  /** 这条消息的序号。还没有发出去的没有。 */
  seq?: number
  /** 对方的头像。自己的消息不显示头像。 */
  avatar?: ReactNode
  /** 群里别人的消息上方显示的名称。 */
  name?: string | null
  /** 自己的消息下方的状态。 */
  status?: BubbleStatus
  /** 状态处显示的文字。不给就用状态本身的名称。 */
  statusLabel?: string
  /** 状态可以点开（群里看已读名单）。 */
  onStatusClick?: () => void
  /** 发送失败的消息：重发。不给就不能重发（例如文件没有保存下来）。 */
  onRetry?: () => void
  /** 发送失败的消息：删掉不发。 */
  onDiscard?: () => void
  /** 刚跳到这一条：短暂地标出来。 */
  highlighted?: boolean
  /** 可以对这条消息做操作时给出：点"引用"。 */
  onQuote?: () => void
  /** 打开操作菜单，位置是屏幕上的坐标。电脑上点"更多"，手机上长按（`touch` 为真）。 */
  onMenu?: (x: number, y: number, touch: boolean) => void
  /** "更多"里有没有东西。没有时电脑上不显示这个按钮。 */
  hasMore?: boolean
  /** 内容下方的一句标注，例如管理员查看时的"已撤回"。 */
  note?: string
  /** 这条消息编辑过（F8）：内容下方标"已编辑"。 */
  edited?: boolean
  /**
   * 多选的时候给出：前面有一个勾选框，点整行就是勾上或取消。
   * `onToggle` 不给表示这一条不能选（语音、已撤回的）。
   */
  selection?: { selected: boolean; onToggle?: () => void }
}

const ACTION =
  'grid size-7 place-items-center rounded-control text-fg-3 transition-colors duration-150 hover:bg-hover hover:text-fg'

/** 一条消息的外框：头像、名称、内容、状态，以及旁边的操作。 */
export function Bubble({
  mine,
  children,
  bare = false,
  seq,
  avatar,
  name,
  status,
  statusLabel,
  onStatusClick,
  onRetry,
  onDiscard,
  highlighted = false,
  onQuote,
  onMenu,
  hasMore = false,
  note,
  edited = false,
  selection,
}: BubbleProps) {
  const { t } = useTranslation('chats')
  const label = status ? (statusLabel ?? t(`status.${status}`)) : ''
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)

  function endPress() {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }
  function onTouchStart(event: TouchEvent) {
    const touch = event.touches[0]
    if (!onMenu || !touch || event.touches.length > 1) return
    const { clientX: x, clientY: y } = touch
    const timer = window.setTimeout(() => {
      press.current = null
      onMenu(x, y, true)
    }, LONG_PRESS_MS)
    press.current = { timer, x, y }
  }
  function onTouchMove(event: TouchEvent) {
    const touch = event.touches[0]
    const start = press.current
    if (!touch || !start) return
    const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y)
    if (moved > LONG_PRESS_SLACK) endPress()
  }

  const frame = bare
    ? ''
    : `whitespace-pre-wrap rounded-[12px] px-3 py-2 [overflow-wrap:anywhere] ${
        mine ? 'bg-accent text-on-accent' : 'bg-surface'
      }`
  const bubble = (
    <div
      data-testid="message"
      data-seq={seq}
      data-mine={mine}
      data-status={status}
      data-highlighted={highlighted || undefined}
      className={`group/message flex max-w-[84%] gap-2 md:max-w-[76%] ${
        mine ? 'flex-row-reverse self-end' : 'self-start'
      }`}
    >
      {avatar}
      <div className={`flex min-w-0 flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
        {name && (
          <span data-testid="message-sender" className="px-1 text-[12px] text-fg-3">
            {name}
          </span>
        )}
        <div className={`flex max-w-full items-center gap-1 ${mine ? 'flex-row-reverse' : ''}`}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 长按只是手机上打开菜单的另一种方式；同样的操作在旁边的按钮里，用键盘够得到 */}
          <div
            // 文字消息保留换行；很长的一串字符也要折行，不能把页面撑宽
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={endPress}
            onTouchCancel={endPress}
            // 手机上长按是打开菜单，不让系统再弹出自己的"选字"和"存图"
            onContextMenu={(event) => onMenu && press.current === null && event.preventDefault()}
            className={`min-w-0 max-w-full transition-shadow duration-300 [@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none] ${frame} ${
              highlighted ? 'rounded-[12px] ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''
            }`}
          >
            {children}
          </div>
          {(onQuote || hasMore) && (
            // 鼠标移上来才出现；用键盘走到按钮上时也出现。用手指操作的设备上不显示，改用长按
            <div className="flex flex-none opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100 [@media(pointer:coarse)]:hidden">
              {onQuote && (
                <button
                  type="button"
                  onClick={onQuote}
                  aria-label={t('actions.quote')}
                  title={t('actions.quote')}
                  className={ACTION}
                >
                  <CornerUpLeft size={16} strokeWidth={1.5} aria-hidden />
                </button>
              )}
              {onMenu && hasMore && (
                <button
                  type="button"
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect()
                    onMenu(box.left, box.bottom + 4, false)
                  }}
                  aria-label={t('actions.more')}
                  aria-haspopup="menu"
                  title={t('actions.more')}
                  className={ACTION}
                >
                  <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden />
                </button>
              )}
            </div>
          )}
        </div>
        {note && (
          <span data-testid="message-note" className="px-1 text-[11px] text-danger">
            {note}
          </span>
        )}
        {edited && (
          <span data-testid="message-edited" className="px-1 text-[11px] text-fg-3">
            {t('edited')}
          </span>
        )}
        {status && (
          <span
            data-testid="message-status"
            className={`flex items-center gap-2 text-[11px] ${
              status === 'failed' ? 'text-danger' : 'text-fg-3'
            }`}
          >
            {/* 手机上这几个按钮看起来不变，能点的范围向上下扩到够手指点 */}
            {onStatusClick ? (
              <button
                type="button"
                onClick={onStatusClick}
                className="max-md:-my-3.5 max-md:min-h-11 max-md:min-w-11 hover:underline"
              >
                {label}
              </button>
            ) : (
              label
            )}
            {status === 'failed' && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="max-md:-my-3.5 max-md:min-h-11 max-md:min-w-11 font-medium underline"
              >
                {t('retry')}
              </button>
            )}
            {status === 'failed' && onDiscard && (
              <button
                type="button"
                onClick={onDiscard}
                className="max-md:-my-3.5 max-md:min-h-11 max-md:min-w-11 font-medium underline"
              >
                {t('discard.action')}
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
  if (!selection) return bubble
  const { selected, onToggle } = selection
  return (
    // 多选：一整行都可以点，前面是勾选框
    // biome-ignore lint/a11y/useKeyWithClickEvents: 用键盘的人用勾选框本身
    // biome-ignore lint/a11y/noStaticElementInteractions: 同上
    <div
      // 点在勾选框（和它的 label）上时由勾选框自己处理，这里不再算一次
      onClick={(event) => {
        if (!(event.target as Element).closest('label')) onToggle?.()
      }}
      data-testid="selectable"
      data-selected={selected}
      className={`flex w-full items-center gap-3 rounded-card px-1 ${
        onToggle ? 'cursor-pointer hover:bg-hover' : 'opacity-50'
      }`}
    >
      {/* 勾选框本身小，外面的 label 够手指点 */}
      <label className="grid size-11 flex-none place-items-center md:size-7">
        <input
          type="checkbox"
          checked={selected}
          disabled={!onToggle}
          onChange={onToggle}
          aria-label={t('selection.select')}
          className="size-5 accent-accent"
        />
      </label>
      <div className={`flex min-w-0 flex-1 flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {bubble}
      </div>
    </div>
  )
}
