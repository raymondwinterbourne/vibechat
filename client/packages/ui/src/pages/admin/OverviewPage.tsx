import { useQuery } from '@tanstack/react-query'
import { fetchOverview, formatFileSize } from '@vibechat/core'
import { RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { useErrorMessage } from '../../errors'
import { useConnectionState } from '../../realtime'
import { AdminBody, AdminHeader } from './common'

/** 多久自己刷新一次。在线人数变得快。 */
const REFRESH_MS = 30_000

interface StatProps {
  name: string
  label: string
  value: string
  hint: string
}

function Stat({ name, label, value, hint }: StatProps) {
  return (
    <div
      data-testid={`stat-${name}`}
      className="flex flex-col gap-1 rounded-card border border-border p-4"
    >
      <dt className="text-[12px] text-fg-2">{label}</dt>
      <dd data-testid="stat-value" className="font-medium text-[24px] tabular-nums leading-tight">
        {value}
      </dd>
      <dd className="text-[12px] text-fg-3">{hint}</dd>
    </div>
  )
}

/** 系统概况：用户、在线人数、群、存储占用。 */
export function OverviewPage() {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: ({ signal }) => fetchOverview({ signal }),
    refetchInterval: REFRESH_MS,
  })
  const data = overview.data

  // 自己的连接刚建立好：再取一次，在线人数里才有自己
  const connection = useConnectionState()
  const { refetch } = overview
  useEffect(() => {
    if (connection === 'open') void refetch()
  }, [connection, refetch])
  return (
    <>
      <AdminHeader
        title={t('overview.title')}
        actions={
          <button
            type="button"
            onClick={() => void overview.refetch()}
            aria-label={t('overview.refresh')}
            title={t('overview.refresh')}
            className="grid size-11 flex-none place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:size-9"
          >
            <RefreshCw
              size={18}
              strokeWidth={1.5}
              aria-hidden
              className={overview.isFetching ? 'animate-spin' : undefined}
            />
          </button>
        }
      />
      <AdminBody>
        {overview.isError ? (
          <LoadError
            message={errorMessage(overview.error)}
            onRetry={() => void overview.refetch()}
          />
        ) : !data ? (
          <ListSkeleton rows={3} />
        ) : (
          <dl className="grid grid-cols-1 gap-3 py-5 sm:grid-cols-2">
            <Stat
              name="users"
              label={t('overview.users')}
              value={String(data.users_total)}
              hint={t('overview.usersDisabled', { count: data.users_disabled })}
            />
            <Stat
              name="online"
              label={t('overview.online')}
              value={String(data.online)}
              hint={t('overview.onlineHint')}
            />
            <Stat
              name="groups"
              label={t('overview.groups')}
              value={String(data.groups)}
              hint={t('overview.groupsHint')}
            />
            <Stat
              name="storage"
              label={t('overview.storage')}
              value={formatFileSize(data.files_bytes)}
              hint={`${t('overview.files', { count: data.files_count })} · ${t('overview.filesHint')}`}
            />
          </dl>
        )}
      </AdminBody>
    </>
  )
}
