// 搜索用到的小东西：把关键词标出来、等用户停下来再搜、面板的开关。

import type { MessageView } from '@vibechat/protocol'
import { type ReactNode, useEffect, useState } from 'react'
import { create } from 'zustand'

/** 关键词最多多少个字。和服务端的上限一致。 */
export const QUERY_MAX_CHARS = 50

/** 全局搜索的面板开着没有。聊天列表上方的搜索框和快捷键都能打开它。 */
export const useSearchPanel = create<{ open: boolean; setOpen: (open: boolean) => void }>(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
  }),
)

/** 一个值停下来不变了才交出去：用户还在打字时不去搜。 */
export function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

/** 把文字里和关键词一样的地方标出来。英文不区分大小写，和搜索的规则一致。 */
export function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  const needle = query.trim().toLowerCase()
  if (!needle) return text
  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (;;) {
    const at = lower.indexOf(needle, from)
    if (at < 0) break
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} className="bg-transparent font-medium text-accent-fg">
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return parts
}

/**
 * 搜到的一条消息里和关键词对上的那段文字：文本消息是它的文字，图片是它的说明，文件消息是文件名。
 * 聊天记录是它的标题，对上的是里面的某一条时，后面再跟着那一条（文字、图片说明或文件名）。
 */
export function hitText(hit: MessageView, query: string): string {
  const oneLine = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ')
  if (hit.record) {
    const { title, items } = hit.record
    const needle = query.trim().toLowerCase()
    if (!needle || title.toLowerCase().includes(needle)) return oneLine(title)
    const inside = items
      .flatMap((item) => [item.text, item.kind === 'file' ? item.file?.name : null])
      .find((text) => text?.toLowerCase().includes(needle))
    return inside ? `${oneLine(title)} · ${oneLine(inside)}` : oneLine(title)
  }
  const text = hit.kind === 'image' ? hit.text : (hit.file?.name ?? hit.text)
  return oneLine(text)
}
