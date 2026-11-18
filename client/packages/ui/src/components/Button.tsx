import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:opacity-90',
  secondary: 'border border-border bg-bg text-fg hover:bg-hover',
  ghost: 'text-fg-2 hover:bg-hover hover:text-fg',
  danger: 'border border-border bg-bg text-danger hover:bg-hover',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
}

/** 按钮。手机上更高，方便手指点按。 */
export function Button({ variant = 'secondary', className = '', type, ...props }: ButtonProps) {
  return (
    <button
      // 默认不是提交按钮，避免放在表单里时误触发提交
      type={type ?? 'button'}
      className={`inline-flex h-11 flex-none items-center justify-center gap-2 whitespace-nowrap rounded-control px-4 font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 md:h-9 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
}
