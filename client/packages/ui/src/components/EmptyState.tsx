interface EmptyStateProps {
  children: string
  /** 下一步可以做什么。 */
  hint?: string
}

/** 列表或内容区没有东西可显示时的一句说明，以及下一步可以做什么。 */
export function EmptyState({ children, hint }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-fg-3">
      <p>{children}</p>
      {hint && <p className="text-[12px]">{hint}</p>}
    </div>
  )
}
