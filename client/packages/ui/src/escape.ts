// Esc 一次只关一层：菜单、面板这些"浮在上面的东西"打开时登记一下，按 Esc 时只关最后打开的那个。
//
// 对话框（包括大图和搜索面板）由对话框自己的组件处理 Esc，它们开着的时候这里不动。

import { useEffect } from 'react'

const layers: (() => void)[] = []

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  // 对话框开着：让它自己关，别的都不动
  if (document.querySelector('[role="dialog"][data-state="open"]')) return
  const close = layers.at(-1)
  if (!close) return
  event.preventDefault()
  close()
}

let listening = false

/** 现在有没有浮在上面、按 Esc 会关掉的东西。 */
export function hasEscapeLayer(): boolean {
  return layers.length > 0
}

/** `open` 为真的期间，按 Esc 会调用 `close`；同时有几层时只关最后打开的那一层。 */
export function useEscapeLayer(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    if (!listening) {
      document.addEventListener('keydown', onKeyDown)
      listening = true
    }
    layers.push(close)
    return () => {
      const index = layers.lastIndexOf(close)
      if (index >= 0) layers.splice(index, 1)
    }
  }, [open, close])
}
