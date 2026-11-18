import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  /** 内容多的：电脑上宽一些、高度有上限，手机上占满整个屏幕；右上角有关闭按钮。 */
  large?: boolean
  /** 右上角的关闭按钮。大的对话框默认有；底部已经有关掉它的按钮时可以不要。 */
  closeButton?: boolean
}

/** 居中的对话框。焦点会被限制在里面，按 Esc 或点击外面关闭。 */
export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  large = false,
  closeButton = large,
}: DialogProps) {
  const { t } = useTranslation()
  const size = large
    ? 'max-md:inset-0 max-md:pt-[max(1.25rem,env(safe-area-inset-top))] max-md:pb-[env(safe-area-inset-bottom)] md:-translate-x-1/2 md:-translate-y-1/2 md:top-1/2 md:left-1/2 md:max-h-[80vh] md:w-[calc(100vw-32px)] md:max-w-[520px] md:rounded-card md:border md:border-border'
    : '-translate-x-1/2 -translate-y-1/2 top-1/2 left-1/2 w-[calc(100vw-32px)] max-w-[400px] rounded-card border border-border'
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <RadixDialog.Content
          // 不需要单独的描述文字
          aria-describedby={undefined}
          className={`fixed z-50 flex flex-col gap-4 bg-bg p-5 shadow-float ${size}`}
        >
          <div className="flex items-center gap-2">
            <RadixDialog.Title
              className={`min-w-0 flex-1 font-medium text-[17px] md:text-[15px] ${large ? 'truncate' : ''}`}
            >
              {title}
            </RadixDialog.Title>
            {closeButton && (
              <RadixDialog.Close
                aria-label={t('actions.close')}
                className="-m-2 grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover md:size-8 md:m-0"
              >
                <X size={18} strokeWidth={1.5} />
              </RadixDialog.Close>
            )}
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
