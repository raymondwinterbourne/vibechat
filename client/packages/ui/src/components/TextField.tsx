import { type InputHTMLAttributes, useId } from 'react'

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  /** 输入框下方的说明。 */
  hint?: string
  /** 输入框下方的错误提示；有它时不再显示说明。 */
  error?: string
}

/** 带标签的单行输入框。 */
export function TextField({ label, hint, error, className = '', ...props }: TextFieldProps) {
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[12px] text-fg-2">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="h-11 rounded-control border border-border bg-bg px-3 text-fg placeholder:text-fg-3 aria-invalid:border-danger md:h-9"
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12px] text-fg-3">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
