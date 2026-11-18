import { Link } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** 通讯录右侧内容的标题栏。手机上左边有返回列表的按钮。 */
export function PaneHeader({ title }: { title: string }) {
  const { t } = useTranslation('contacts')
  return (
    <header className="flex h-[52px] flex-none items-center gap-1 border-border border-b px-4 max-md:px-2">
      <Link
        to="/contacts"
        aria-label={t('back')}
        className="grid size-11 place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:hidden"
      >
        <ChevronLeft size={22} strokeWidth={1.5} aria-hidden />
      </Link>
      <h2 className="font-medium text-[17px] md:text-[15px]">{title}</h2>
    </header>
  )
}
