interface SwitchProps {
  /** 这个开关管的是什么，读屏软件会念出来。 */
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

/** 一个开关。 */
export function Switch({ label, checked, onChange, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      // 可以点的范围比看到的大：手机上不小于 44 像素
      className="relative grid h-11 w-12 flex-none place-items-center disabled:opacity-50 md:h-9"
    >
      <span
        className={`flex h-6 w-10 items-center rounded-full p-0.5 transition-colors duration-150 ${
          checked ? 'bg-accent' : 'bg-border'
        }`}
      >
        <span
          className={`size-5 rounded-full bg-white shadow transition-transform duration-150 ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </span>
    </button>
  )
}
