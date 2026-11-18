interface Option<T extends string> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string> {
  /** 这组选项的名称，读屏软件会念出来。 */
  label: string
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  /** 选项多的时候用：手机上占满整行，各项等宽，免得挤不下。 */
  fillOnPhone?: boolean
}

/** 几个互斥选项排成一排，选中的一项高亮。 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  fillOnPhone = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`gap-0.5 rounded-control border border-border bg-bg p-0.5 ${
        fillOnPhone ? 'flex max-md:w-full md:inline-flex' : 'inline-flex'
      }`}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          // biome-ignore lint/a11y/useSemanticElements: 原生单选框做不出分段按钮的外观
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`h-11 whitespace-nowrap rounded-[4px] transition-colors duration-150 md:h-8 md:min-w-16 md:px-3 ${
              fillOnPhone ? 'max-md:min-w-0 max-md:flex-1 max-md:px-1' : 'min-w-16 px-3'
            } ${selected ? 'bg-hover text-fg' : 'text-fg-2 hover:text-fg'}`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
