import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { formatFileSize, listAudit } from '@vibechat/core'
import type { AuditAction, AuditEntryView } from '@vibechat/protocol'
import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { SelectField } from '../../components/SelectField'
import { useErrorMessage } from '../../errors'
import { AdminBody, AdminHeader, PAGE_SIZE, Pager, useFormatTime } from './common'

const ACTIONS: AuditAction[] = [
  'chat_viewed',
  'user_disabled',
  'user_enabled',
  'password_reset',
  'invite_codes_created',
  'invite_codes_revoked',
  'invite_codes_deleted',
  'group_dissolved',
  'setting_changed',
]

const SETTINGS = [
  'file_max_bytes',
  'group_max_members',
  'voice_max_seconds',
  'recall_window_seconds',
  'edit_window_seconds',
  'retention_days',
  'screen_max_width',
  'screen_max_fps',
  'screen_direct_kbps',
  'screen_relay_kbps',
  'camera_relay_kbps',
  'group_camera_high_kbps',
  'group_camera_low_kbps',
  'group_screen_kbps',
  'group_call_max',
] as const
type Setting = (typeof SETTINGS)[number]

function isSetting(key: string | null): key is Setting {
  return SETTINGS.includes(key as Setting)
}

type T = TFunction<'admin'>

/** 一项设置的值写成人读的样子：记录里存的是字节数、秒数、天数。 */
function settingValue(key: Setting, raw: string | null, t: T): string {
  const count = Number(raw ?? 0)
  switch (key) {
    case 'file_max_bytes':
      return formatFileSize(count)
    case 'group_max_members':
      return t('audit.value.people', { count })
    case 'group_call_max':
      return t('audit.value.inCall', { count })
    case 'voice_max_seconds':
      return t('audit.value.seconds', { count })
    case 'recall_window_seconds':
      return count === 0 ? t('audit.value.noRecall') : t('audit.value.seconds', { count })
    case 'edit_window_seconds':
      // 记录里是秒，界面上按小时
      return count === 0 ? t('audit.value.noEdit') : t('audit.value.hours', { count: count / 3600 })
    case 'retention_days':
      return count === 0 ? t('audit.value.forever') : t('audit.value.days', { count })
    case 'screen_max_width':
      return t('audit.value.pixels', { count })
    case 'screen_max_fps':
      return t('audit.value.fps', { count })
    case 'screen_direct_kbps':
    case 'screen_relay_kbps':
    case 'camera_relay_kbps':
      // 记录里是千比特每秒
      return t('audit.value.mbps', { value: count / 1000 })
    case 'group_camera_high_kbps':
    case 'group_camera_low_kbps':
    case 'group_screen_kbps':
      return t('audit.value.kbps', { value: count })
  }
}

/** 一条记录按当前语言写成的一句话。 */
function sentence(entry: AuditEntryView, t: T): string {
  const label = entry.label ?? ''
  const count = entry.count ?? 0
  switch (entry.action) {
    case 'chat_viewed':
      return entry.key === 'group'
        ? t('audit.entry.chat_viewed_group', { label })
        : t('audit.entry.chat_viewed_direct', { label })
    case 'user_disabled':
      return t('audit.entry.user_disabled', { label })
    case 'user_enabled':
      return t('audit.entry.user_enabled', { label })
    case 'password_reset':
      return t('audit.entry.password_reset', { label })
    case 'invite_codes_created':
      return t('audit.entry.invite_codes_created', { count })
    case 'invite_codes_revoked':
      return t('audit.entry.invite_codes_revoked', { count })
    case 'invite_codes_deleted':
      return t('audit.entry.invite_codes_deleted', { count })
    case 'group_dissolved':
      return t('audit.entry.group_dissolved', { label })
    case 'setting_changed': {
      const key = entry.key
      if (!isSetting(key)) return t('audit.action.setting_changed')
      return t('audit.entry.setting_changed', {
        name: t(`audit.setting.${key}`),
        from: settingValue(key, entry.from, t),
        to: settingValue(key, entry.to, t),
      })
    }
  }
}

/** 操作记录：管理员做过的每一件事，从新到旧。只能查看。 */
export function AuditPage() {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const formatTime = useFormatTime()
  const [action, setAction] = useState<AuditAction | ''>('')
  const [page, setPage] = useState(1)
  const log = useQuery({
    queryKey: ['admin', 'audit', { action, page }],
    queryFn: ({ signal }) =>
      listAudit({ action: action || undefined, page, pageSize: PAGE_SIZE, signal }),
    placeholderData: keepPreviousData,
  })
  const items = log.data?.items ?? []

  const options = [
    { value: '', label: t('audit.filterAll') },
    ...ACTIONS.map((value) => ({ value, label: t(`audit.action.${value}`) })),
  ]

  return (
    <>
      <AdminHeader title={t('audit.title')} />
      <AdminBody>
        <p className="pt-4 text-fg-2">{t('audit.explain')}</p>
        <div className="border-border border-b py-3">
          <SelectField
            label={t('audit.filter')}
            value={action}
            onChange={(event) => {
              setAction(event.target.value as AuditAction | '')
              setPage(1)
            }}
            options={options}
            className="max-w-60"
          />
        </div>
        {log.isError ? (
          <LoadError message={errorMessage(log.error)} onRetry={() => void log.refetch()} />
        ) : !log.data ? (
          <ListSkeleton />
        ) : items.length === 0 ? (
          <div className="h-40">
            <EmptyState>{action ? t('audit.noMatch') : t('audit.empty')}</EmptyState>
          </div>
        ) : (
          <>
            <ul data-testid="audit-log">
              {items.map((entry) => (
                <li
                  key={entry.id}
                  data-testid="audit-entry"
                  data-action={entry.action}
                  className="flex flex-col gap-0.5 border-border border-b py-3 md:flex-row md:items-baseline md:gap-4"
                >
                  <time
                    dateTime={new Date(entry.at).toISOString()}
                    className="flex-none text-[12px] text-fg-2 tabular-nums md:w-44"
                  >
                    {formatTime(entry.at)}
                  </time>
                  <span
                    data-testid="audit-entry-text"
                    className="min-w-0 flex-1 [overflow-wrap:anywhere]"
                  >
                    {sentence(entry, t)}
                  </span>
                </li>
              ))}
            </ul>
            <Pager page={page} total={log.data.total} onChange={setPage} />
          </>
        )}
      </AdminBody>
    </>
  )
}
