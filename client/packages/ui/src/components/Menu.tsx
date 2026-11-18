import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useEscapeLayer } from '../escape'

interface MenuItem {
  label: string
  onSelect: () => void
}

interface MenuProps {
  /** 这个菜单的名称，读屏软件会念出来。 */
  label: string
  /** 打开菜单的按钮上显示的内容。 */
  children: ReactNode
  items: MenuItem[]
}

/** 点一下按钮弹出的小菜单。点菜单外面或按 Esc 关闭。 */
export function Menu({ label, children, items }: MenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  // 按 Esc 关闭，焦点回到打开它的按钮
  const dismiss = useCallback(() => {
    setOpen(false)
    trigger.current?.focus()
  }, [])
  useEscapeLayer(open, dismiss)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
        className="grid size-11 place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:size-9"
      >
        {children}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute top-full right-0 z-20 mt-1 min-w-40 rounded-card border border-border bg-bg p-1 shadow-float"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className="flex h-11 w-full items-center rounded-control px-3 text-left hover:bg-hover md:h-9"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
