import { type PointerEvent, useRef, useState } from 'react'

interface AlphabetIndexProps {
  /** 有好友的那几个字母，按顺序。 */
  letters: readonly string[]
  /** 跳到这一组。 */
  onPick: (letter: string) => void
  label: string
}

/**
 * 通讯录右侧竖着的字母索引。点一个字母跳到那一组；按住上下滑动，滑到哪个字母跳到哪一组，
 * 手机上手指底下的字母放大显示在旁边。字母不是一个个按钮：整条一起响应，手指不需要点得很准。
 */
export function AlphabetIndex({ letters, onPick, label }: AlphabetIndexProps) {
  const bar = useRef<HTMLElement>(null)
  const [active, setActive] = useState<string | null>(null)

  /** 指针在这条上的高度对应哪个字母。 */
  function letterAt(clientY: number): string | null {
    const box = bar.current?.getBoundingClientRect()
    if (!box || letters.length === 0) return null
    const index = Math.floor(((clientY - box.top) / box.height) * letters.length)
    return letters[Math.min(letters.length - 1, Math.max(0, index))] ?? null
  }

  function pick(event: PointerEvent<HTMLElement>) {
    const letter = letterAt(event.clientY)
    if (letter && letter !== active) {
      setActive(letter)
      onPick(letter)
    }
  }

  return (
    <nav
      ref={bar}
      aria-label={label}
      data-testid="alphabet-index"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        pick(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event)
      }}
      onPointerUp={() => setActive(null)}
      onPointerCancel={() => setActive(null)}
      // 压在吸顶的分组标题上面：标题有底色，否则会把经过它的字母盖住
      className="-translate-y-1/2 absolute top-1/2 right-1 z-[2] flex touch-none select-none flex-col items-center rounded-full border border-border bg-bg px-0.5 py-1.5 text-[11px] text-fg-2 leading-[16px]"
    >
      {letters.map((letter) => (
        <span
          key={letter}
          data-testid="alphabet-letter"
          className={`grid w-4 place-items-center rounded-full ${
            active === letter ? 'bg-accent text-on-accent' : ''
          }`}
        >
          {letter}
        </span>
      ))}
      {active && (
        <span
          data-testid="alphabet-bubble"
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-10 grid size-14 -translate-y-1/2 place-items-center rounded-card bg-surface font-medium text-[24px] text-fg shadow-float md:hidden"
        >
          {active}
        </span>
      )}
    </nav>
  )
}
