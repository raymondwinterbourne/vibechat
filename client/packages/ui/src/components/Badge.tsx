interface BadgeProps {
  count: number
  /** 这个数字是什么，读屏软件会念出来。 */
  label: string
  className?: string
  /** 不显示数字，只显示一个灰色的小圆点：免打扰的会话。 */
  quiet?: boolean
}

/** 提醒用的数字。没有需要提醒的东西时什么也不显示。 */
export function Badge({ count, label, className = '', quiet = false }: BadgeProps) {
  if (count <= 0) return null
  if (quiet) {
    return (
      <span
        role="status"
        aria-label={label}
        data-testid="badge-dot"
        className={`size-2 flex-none rounded-full bg-fg-3 ${className}`}
      />
    )
  }
  return (
    <span
      role="status"
      aria-label={label}
      data-testid="badge"
      className={`grid h-[18px] min-w-[18px] flex-none place-items-center rounded-full bg-accent px-[5px] font-medium text-[11px] text-on-accent leading-none ${className}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
