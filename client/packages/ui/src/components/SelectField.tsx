import { type SelectHTMLAttributes, useId } from 'react'

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  options: { value: string; label: string }[]
}

/** 带标签的下拉选择。用浏览器原生的下拉，在手机上是系统的选择器。 */
export function SelectField({ label, options, className = '', ...props }: SelectFieldProps) {
  const id = useId()
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[12px] text-fg-2">
        {label}
      </label>
      <select
        id={id}
        className="h-11 rounded-control border border-border bg-bg px-2 text-fg md:h-9"
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}
