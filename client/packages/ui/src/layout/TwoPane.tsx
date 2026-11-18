import { type ReactNode, useEffect, useRef, useState } from 'react'

interface TwoPaneProps {
  title: string
  /** 标题右侧的按钮。 */
  actions?: ReactNode
  /** 左侧的列表。手机上它占满整屏。 */
  list: ReactNode
  /** 浮在列表右侧、不跟着列表滚动的东西，例如字母索引。列表短得一屏放得下时不显示：用不着。 */
  listAside?: ReactNode
  /** 右侧的内容。 */
  detail: ReactNode
  /** 是否选中了某一项。手机上一次只显示一屏：选中了显示内容，没选中显示列表。 */
  detailOpen?: boolean
}

/** 电脑上"列表加内容"并排；手机上是两屏，先列表，选中一项后是内容。 */
export function TwoPane({
  title,
  actions,
  list,
  listAside,
  detail,
  detailOpen = false,
}: TwoPaneProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const hasAside = listAside !== undefined && listAside !== null
  // 列表的内容变多变少、窗口变高变矮，都重新看一下放不放得下
  useEffect(() => {
    const element = scroller.current
    if (!element || !hasAside) return
    const check = () => setOverflowing(element.scrollHeight > element.clientHeight + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [hasAside])

  return (
    <>
      <section
        className={`min-h-0 w-full flex-col bg-bg md:flex md:w-[300px] md:flex-none md:border-border md:border-r md:bg-bg-subtle ${
          detailOpen ? 'hidden' : 'flex'
        }`}
      >
        <header className="flex h-[52px] flex-none items-center justify-between border-border border-b pr-2 pl-4">
          <h1 className="font-medium text-[17px] md:text-[15px]">{title}</h1>
          {actions}
        </header>
        <div className="relative min-h-0 flex-1">
          <div ref={scroller} className="h-full overflow-auto">
            {list}
          </div>
          {overflowing && listAside}
        </div>
      </section>
      <section className={`min-h-0 min-w-0 flex-1 md:block ${detailOpen ? 'block' : 'hidden'}`}>
        {detail}
      </section>
    </>
  )
}
