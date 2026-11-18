import { Link } from '@tanstack/react-router'
import { totalUnread } from '@vibechat/core'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatState } from '../chat'
import { Badge } from '../components/Badge'
import { usePendingRequestCount } from '../contacts'
import { destinations, settingsDestination } from './navigation'

interface TabLinkProps {
  to: string
  label: string
  icon: LucideIcon
  /** 图标右上角的提醒数字。 */
  badge?: ReactNode
}

function TabLink({ to, label, icon: Icon, badge }: TabLinkProps) {
  return (
    <Link
      to={to}
      className="flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors duration-150"
      activeProps={{ className: 'text-accent-fg' }}
      inactiveProps={{ className: 'text-fg-3' }}
    >
      <span className="relative">
        <Icon size={22} strokeWidth={1.5} aria-hidden />
        {badge}
      </span>
      {label}
    </Link>
  )
}

/** 手机上底部的标签栏。 */
export function TabBar() {
  const { t } = useTranslation('nav')
  const { t: tContacts } = useTranslation('contacts')
  const { t: tChats } = useTranslation('chats')
  const unread = useChatState((state) => totalUnread(state.conversations ?? []))
  const pending = usePendingRequestCount()
  return (
    <nav
      aria-label={t('label')}
      data-testid="tab-bar"
      // 避开手机底部的系统手势区域
      className="grid flex-none grid-cols-3 border-border border-t bg-bg-subtle pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {destinations.map(({ to, label, icon }) => (
        <TabLink
          key={to}
          to={to}
          label={t(label)}
          icon={icon}
          badge={
            to === '/contacts' ? (
              <Badge
                count={pending}
                label={tContacts('newRequests', { count: pending })}
                className="-top-1.5 -right-2.5 absolute"
              />
            ) : (
              <Badge
                count={unread}
                label={tChats('unread', { count: unread })}
                className="-top-1.5 -right-2.5 absolute"
              />
            )
          }
        />
      ))}
      <TabLink
        to={settingsDestination.to}
        label={t(settingsDestination.mobile.label)}
        icon={settingsDestination.mobile.icon}
      />
    </nav>
  )
}
