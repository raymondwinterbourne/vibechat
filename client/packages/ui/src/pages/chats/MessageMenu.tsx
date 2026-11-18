import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeLayer } from '../../escape'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

interface MessageMenuProps {
  /** 想让菜单出现在屏幕上的什么位置。放不下时会往里挪。 */
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** 离屏幕边缘至少留这么多。 */
const EDGE = 8

/** 一条消息的操作菜单：出现在点的地方。点外面或按 Esc 关闭。 */
export function MessageMenu({ x, y, items, onClose }: MessageMenuProps) {
  const { t } = useTranslation('chats')
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // 量出菜单的大小之后，把它挪到屏幕以内
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect()
    if (!box) return
    setPosition({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - box.width - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - box.height - EDGE)),
    })
    menu.current?.querySelector('button')?.focus()
  }, [x, y])

  useEscapeLayer(true, onClose)
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!menu.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={t('actions.menu')}
      data-testid="message-menu"
      style={position}
      className="fixed z-40 min-w-32 rounded-card border border-border bg-bg p-1 shadow-float"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose()
            item.onSelect()
          }}
          className={`flex h-11 w-full items-center rounded-control px-3 text-left hover:bg-hover md:h-9 ${
            item.danger ? 'text-danger' : ''
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
