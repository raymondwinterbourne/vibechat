// 管理页面共用的几样东西：标题栏、翻页、确认对话框、一行里的操作按钮。

import { Link } from '@tanstack/react-router'
import type { AdminConversationView } from '@vibechat/protocol'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { usePreferences } from '../../preferences'

/** 列表每页多少条。 */
export const PAGE_SIZE = 20

/** 时间写成当前语言的样子，例如"2026年10月4日 14:30"。 */
export function useFormatTime() {
  const language = usePreferences((state) => state.language)
  const format = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' })
  return (time: number) => format.format(time)
}

interface AdminHeaderProps {
  title: string
  /** 标题右侧的按钮。 */
  actions?: ReactNode
}

/** 管理页面的标题栏。手机上左边有返回管理导航的按钮。 */
export function AdminHeader({ title, actions }: AdminHeaderProps) {
  const { t } = useTranslation('admin')
  return (
    <header className="flex h-[52px] flex-none items-center gap-1 border-border border-b px-4 max-md:px-2">
      <Link
        to="/admin"
        aria-label={t('nav.back')}
        className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:hidden"
      >
        <ChevronLeft size={22} strokeWidth={1.5} aria-hidden />
      </Link>
      <h1 className="min-w-0 flex-1 truncate font-medium text-[17px] md:text-[15px]">{title}</h1>
      {actions}
    </header>
  )
}

/** 管理页面的正文：居中的一栏，自己滚动。 */
export function AdminBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-[720px] px-4 md:px-8">{children}</div>
    </div>
  )
}

interface PagerProps {
  page: number
  total: number
  onChange: (page: number) => void
}

/** 列表下方的翻页。只有一页时不显示。 */
export function Pager({ page, total, onChange }: PagerProps) {
  const { t } = useTranslation('admin')
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (pageCount <= 1) return null
  return (
    <nav
      data-testid="pager"
      aria-label={t('pager.label')}
      className="flex items-center gap-1 py-3 text-fg-2"
    >
      <span className="flex-1">{t('pager.total', { count: total })}</span>
      <Button
        variant="ghost"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        aria-label={t('pager.previous')}
        className="px-2"
      >
        <ChevronLeft size={16} strokeWidth={1.5} aria-hidden />
      </Button>
      <span data-testid="pager-page" className="px-1 tabular-nums">
        {page} / {pageCount}
      </span>
      <Button
        variant="ghost"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount}
        aria-label={t('pager.next')}
        className="px-2"
      >
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden />
      </Button>
    </nav>
  )
}

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  title: string
  explain: string
  confirmLabel: string
  onConfirm: () => void
  pending: boolean
  /** 不是破坏性的操作（例如启用）时用普通的强调色。 */
  danger?: boolean
}

/** 有后果的操作先问一次。 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  explain,
  confirmLabel,
  onConfirm,
  pending,
  danger = true,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()} title={title}>
      <p className="text-fg-2">{explain}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('actions.cancel')}
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={pending}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}

interface RowActionProps {
  icon: LucideIcon
  /** 按钮上的字；手机上只显示图标。 */
  label: string
  /** 完整的说明：是对谁操作。 */
  description: string
  onClick: () => void
}

/** 一行右侧的操作按钮。 */
export function RowAction({ icon: Icon, label, description, onClick }: RowActionProps) {
  return (
    <Button variant="ghost" onClick={onClick} aria-label={description} title={description}>
      <Icon size={16} strokeWidth={1.5} aria-hidden />
      <span className="max-lg:hidden">{label}</span>
    </Button>
  )
}

const ROW_LINK =
  'inline-flex h-11 flex-none items-center justify-center gap-2 whitespace-nowrap rounded-control px-4 font-medium text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:h-9'

interface RowLinkProps {
  icon: LucideIcon
  label: string
  description: string
  /** 要去的会话。 */
  conversationId: string
}

/** 一行右侧去"查看聊天内容"的链接，样子和操作按钮一样。 */
export function ViewChatLink({ icon: Icon, label, description, conversationId }: RowLinkProps) {
  return (
    <Link
      to="/admin/chats/$conversationId"
      params={{ conversationId }}
      aria-label={description}
      title={description}
      className={ROW_LINK}
    >
      <Icon size={16} strokeWidth={1.5} aria-hidden />
      <span className="max-lg:hidden">{label}</span>
    </Link>
  )
}

/** 小标签：状态、身份。 */
export function Tag({ children, tone = 'muted' }: { children: string; tone?: 'muted' | 'danger' }) {
  return (
    <span
      className={`flex-none rounded-[4px] border px-1.5 text-[11px] leading-[18px] ${
        tone === 'danger' ? 'border-danger/40 text-danger' : 'border-border text-fg-2'
      }`}
    >
      {children}
    </span>
  )
}

/** 一个会话在管理员这里叫什么：群名；没有起名的群和单聊用其中几个人的昵称。 */
export function conversationLabel(conversation: AdminConversationView, separator: string): string {
  return conversation.name ?? conversation.people.map((user) => user.nickname).join(separator)
}
