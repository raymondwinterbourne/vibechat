import { Link } from '@tanstack/react-router'
import { totalUnread } from '@vibechat/core'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatState } from '../chat'
import { Badge } from '../components/Badge'
import { usePendingRequestCount } from '../contacts'
import { DesktopRailEntry } from '../desktopClient'
import { useMe } from '../session'
import { adminDestination, destinations, settingsDestination } from './navigation'

interface RailLinkProps {
  to: string
  label: string
  icon: LucideIcon
  /** 图标右上角的提醒数字。 */
  badge?: ReactNode
}

function RailLink({ to, label, icon: Icon, badge }: RailLinkProps) {
  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      className="relative grid size-9 place-items-center rounded-control transition-colors duration-150"
      activeProps={{ className: 'bg-hover text-fg' }}
      inactiveProps={{ className: 'text-fg-2 hover:bg-hover hover:text-fg' }}
    >
      <Icon size={20} strokeWidth={1.5} aria-hidden />
      {badge}
    </Link>
  )
}

/** 电脑上最左侧的一列图标。 */
export function NavRail() {
  const { t } = useTranslation('nav')
  const { t: tContacts } = useTranslation('contacts')
  const { t: tChats } = useTranslation('chats')
  const unread = useChatState((state) => totalUnread(state.conversations ?? []))
  const me = useMe()
  const pending = usePendingRequestCount()
  return (
    <nav
      aria-label={t('label')}
      data-testid="nav-rail"
      className="hidden w-14 flex-none flex-col items-center gap-1 border-border border-r bg-bg-subtle py-3 md:flex"
    >
      {destinations.map(({ to, label, icon }) => (
        <RailLink
          key={to}
          to={to}
          label={t(label)}
          icon={icon}
          badge={
            to === '/contacts' ? (
              <Badge
                count={pending}
                label={tContacts('newRequests', { count: pending })}
                className="-top-1 -right-1 absolute"
              />
            ) : (
              <Badge
                count={unread}
                label={tChats('unread', { count: unread })}
                className="-top-1 -right-1 absolute"
              />
            )
          }
        />
      ))}
      {me.role === 'admin' && (
        <RailLink
          to={adminDestination.to}
          label={t(adminDestination.label)}
          icon={adminDestination.icon}
        />
      )}
      <div className="flex-1" />
      <DesktopRailEntry />
      <RailLink
        to={settingsDestination.to}
        label={t(settingsDestination.desktop.label)}
        icon={settingsDestination.desktop.icon}
      />
    </nav>
  )
}
