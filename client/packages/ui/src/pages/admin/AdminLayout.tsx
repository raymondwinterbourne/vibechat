import { Link, Outlet, useLocation } from '@tanstack/react-router'
import {
  ChevronRight,
  ClipboardList,
  Gauge,
  type LucideIcon,
  MessagesSquare,
  SlidersHorizontal,
  Ticket,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

type Section = 'overview' | 'users' | 'inviteCodes' | 'chats' | 'groups' | 'settings' | 'audit'

const SECTIONS: { to: string; label: Section; icon: LucideIcon }[] = [
  { to: '/admin/overview', label: 'overview', icon: Gauge },
  { to: '/admin/users', label: 'users', icon: UserRound },
  { to: '/admin/invite-codes', label: 'inviteCodes', icon: Ticket },
  { to: '/admin/chats', label: 'chats', icon: MessagesSquare },
  { to: '/admin/groups', label: 'groups', icon: UsersRound },
  { to: '/admin/settings', label: 'settings', icon: SlidersHorizontal },
  { to: '/admin/audit', label: 'audit', icon: ClipboardList },
]

/**
 * 管理区。电脑上左边是二级导航，右边是选中的那一页；
 * 手机上是两屏：先是导航，点进去是那一页，页面的标题栏上有返回的按钮。
 */
export function AdminLayout() {
  const { t } = useTranslation('admin')
  const path = useLocation({ select: (location) => location.pathname.replace(/\/$/, '') })
  // 地址停在 /admin 上时还没有选哪一页：电脑上右边显示概况，手机上只显示导航
  const atRoot = path === '/admin'
  return (
    <>
      <section
        className={`min-h-0 w-full flex-col bg-bg md:flex md:w-[200px] md:flex-none md:border-border md:border-r md:bg-bg-subtle ${
          atRoot ? 'flex' : 'hidden'
        }`}
      >
        <header className="flex h-[52px] flex-none items-center border-border border-b px-4">
          <h1 className="font-medium text-[17px] md:text-[15px]">{t('nav.title')}</h1>
        </header>
        <nav
          aria-label={t('nav.label')}
          data-testid="admin-nav"
          className="min-h-0 flex-1 overflow-auto md:p-2"
        >
          {SECTIONS.map(({ to, label, icon: Icon }) => {
            const active = path.startsWith(to) || (atRoot && label === 'overview')
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? 'page' : undefined}
                className={`flex h-12 items-center gap-3 px-4 transition-colors duration-150 hover:bg-hover max-md:border-border max-md:border-b md:h-9 md:rounded-control md:px-3 ${
                  active ? 'md:bg-hover md:text-fg' : 'md:text-fg-2'
                }`}
              >
                <Icon size={18} strokeWidth={1.5} aria-hidden className="flex-none text-fg-2" />
                <span className="min-w-0 flex-1 truncate">{t(`nav.${label}`)}</span>
                <ChevronRight
                  size={16}
                  strokeWidth={1.5}
                  aria-hidden
                  className="flex-none text-fg-3 md:hidden"
                />
              </Link>
            )
          })}
        </nav>
      </section>
      <section className={`min-h-0 min-w-0 flex-1 flex-col md:flex ${atRoot ? 'hidden' : 'flex'}`}>
        <Outlet />
      </section>
    </>
  )
}
