import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { disableUser, enableUser, listUsers, resetUserPassword } from '@vibechat/core'
import type { AdminUserView, UserStatus } from '@vibechat/protocol'
import { Ban, CircleCheck, Copy, KeyRound, MessagesSquare } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyText } from '../../clipboard'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { SegmentedControl } from '../../components/SegmentedControl'
import { useErrorMessage } from '../../errors'
import { toast } from '../../toast'
import {
  AdminBody,
  AdminHeader,
  ConfirmDialog,
  PAGE_SIZE,
  Pager,
  RowAction,
  Tag,
  useFormatTime,
} from './common'

const QUERY_KEY = ['admin', 'users']

const FILTERS = ['all', 'active', 'disabled'] as const
type Filter = 'all' | UserStatus

type Confirming = 'disable' | 'enable' | 'reset' | null

/** 找人用的输入框。管理页面里有两处用到。 */
export function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
      placeholder={label}
      maxLength={50}
      className="h-11 w-full min-w-0 rounded-control border border-border bg-bg px-3 text-fg placeholder:text-fg-3 md:h-9"
    />
  )
}

function UserRow({ user }: { user: AdminUserView }) {
  const { t } = useTranslation('admin')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const formatTime = useFormatTime()
  const [confirming, setConfirming] = useState<Confirming>(null)
  // 重置之后拿到的临时密码。只留在这个对话框里，关掉就没有了
  const [password, setPassword] = useState<string | null>(null)
  const name = user.nickname
  const isAdmin = user.role === 'admin'
  const disabled = user.status === 'disabled'

  async function settle() {
    setConfirming(null)
    await queryClient.invalidateQueries({ queryKey: ['admin'] })
  }

  const disable = useMutation({
    mutationFn: () => disableUser(user.id),
    onSuccess: () => toast.success(t('users.disabledDone')),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: settle,
  })
  const enable = useMutation({
    mutationFn: () => enableUser(user.id),
    onSuccess: () => toast.success(t('users.enabledDone')),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: settle,
  })
  const reset = useMutation({
    mutationFn: () => resetUserPassword(user.id),
    onSuccess: (result) => setPassword(result.password),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: settle,
  })

  async function copy() {
    if (password && (await copyText(password))) toast.success(tCommon('copied'))
    else toast.error(t('users.copyFailed'))
  }

  const details = [
    t('users.registeredAt', { time: formatTime(user.created_at) }),
    user.invite_code && t('users.inviteCode', { code: user.invite_code }),
    user.last_login_at
      ? t('users.lastLogin', { time: formatTime(user.last_login_at) })
      : t('users.neverLoggedIn'),
  ].filter((item): item is string => Boolean(item))

  return (
    <li
      data-testid="admin-user"
      data-status={user.status}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-b py-3"
    >
      <Avatar user={user} />
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span data-testid="admin-user-name" className="truncate">
            {name}
          </span>
          <span className="truncate font-mono text-[12px] text-fg-2">{user.handle}</span>
          {isAdmin && <Tag>{t('users.adminTag')}</Tag>}
          {disabled && <Tag tone="danger">{t('users.status.disabled')}</Tag>}
        </span>
        <span className="text-[12px] text-fg-2">{details.join(' · ')}</span>
      </div>
      <div className="flex flex-none items-center max-md:-ml-4 max-md:w-full">
        <Link
          to="/admin/chats"
          search={{ user: user.id }}
          aria-label={t('users.viewChatsOf', { name })}
          title={t('users.viewChatsOf', { name })}
          className="inline-flex h-11 flex-none items-center justify-center gap-2 whitespace-nowrap rounded-control px-4 font-medium text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:h-9"
        >
          <MessagesSquare size={16} strokeWidth={1.5} aria-hidden />
          <span className="max-lg:hidden">{t('users.viewChats')}</span>
        </Link>
        {/* 管理员不能禁用自己，也不能用这个办法重置自己的密码 */}
        {!isAdmin && (
          <>
            {disabled ? (
              <RowAction
                icon={CircleCheck}
                label={t('users.enable')}
                description={t('users.enableUser', { name })}
                onClick={() => setConfirming('enable')}
              />
            ) : (
              <RowAction
                icon={Ban}
                label={t('users.disable')}
                description={t('users.disableUser', { name })}
                onClick={() => setConfirming('disable')}
              />
            )}
            <RowAction
              icon={KeyRound}
              label={t('users.resetPassword')}
              description={t('users.resetUser', { name })}
              onClick={() => setConfirming('reset')}
            />
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirming === 'disable'}
        onClose={() => setConfirming(null)}
        title={t('users.disableTitle', { name })}
        explain={t('users.disableExplain')}
        confirmLabel={t('users.disable')}
        onConfirm={() => disable.mutate()}
        pending={disable.isPending}
      />
      <ConfirmDialog
        open={confirming === 'enable'}
        onClose={() => setConfirming(null)}
        title={t('users.enableTitle', { name })}
        explain={t('users.enableExplain')}
        confirmLabel={t('users.enable')}
        onConfirm={() => enable.mutate()}
        pending={enable.isPending}
        danger={false}
      />
      <ConfirmDialog
        open={confirming === 'reset'}
        onClose={() => setConfirming(null)}
        title={t('users.resetTitle', { name })}
        explain={t('users.resetExplain')}
        confirmLabel={t('users.resetPassword')}
        onConfirm={() => reset.mutate()}
        pending={reset.isPending}
      />
      <Dialog
        open={password !== null}
        onOpenChange={(open) => !open && setPassword(null)}
        title={t('users.resetDoneTitle')}
      >
        <p className="text-fg-2">{t('users.resetDoneExplain', { name })}</p>
        <p
          data-testid="temp-password"
          className="select-all rounded-control border border-border bg-bg-subtle px-3 py-2 text-center font-mono text-[17px] tracking-wider"
        >
          {password}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPassword(null)}>
            {t('users.close')}
          </Button>
          <Button variant="primary" onClick={copy} aria-label={t('users.copyPassword')}>
            <Copy size={16} strokeWidth={1.5} aria-hidden />
            {tCommon('actions.copy')}
          </Button>
        </div>
      </Dialog>
    </li>
  )
}

/** 用户：全部用户的列表，按 ID 或昵称查找；禁用、启用、重置密码。 */
export function UsersPage() {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)

  const users = useQuery({
    queryKey: [...QUERY_KEY, { search: search.trim(), filter, page }],
    queryFn: ({ signal }) =>
      listUsers({
        search,
        status: filter === 'all' ? undefined : filter,
        page,
        pageSize: PAGE_SIZE,
        signal,
      }),
    placeholderData: keepPreviousData,
  })
  const items = users.data?.items ?? []
  const total = users.data?.total ?? 0

  const filterOptions = FILTERS.map((value) => ({
    value,
    label: value === 'all' ? t('users.filterAll') : t(`users.status.${value}`),
  }))

  return (
    <>
      <AdminHeader title={t('users.title')} />
      <AdminBody>
        <div className="flex flex-wrap items-center gap-2 border-border border-b py-3">
          <div className="min-w-40 flex-1">
            <SearchBox
              label={t('users.search')}
              value={search}
              onChange={(value) => {
                setSearch(value)
                setPage(1)
              }}
            />
          </div>
          <SegmentedControl
            label={t('users.filter')}
            value={filter}
            options={filterOptions}
            onChange={(value) => {
              setFilter(value)
              setPage(1)
            }}
            fillOnPhone
          />
        </div>
        {users.isError ? (
          <LoadError message={errorMessage(users.error)} onRetry={() => void users.refetch()} />
        ) : !users.data ? (
          <ListSkeleton />
        ) : items.length === 0 ? (
          <div className="h-40">
            <EmptyState>{t('users.empty')}</EmptyState>
          </div>
        ) : (
          <>
            <ul data-testid="admin-users">
              {items.map((user) => (
                <UserRow key={user.id} user={user} />
              ))}
            </ul>
            <Pager page={page} total={total} onChange={setPage} />
          </>
        )}
      </AdminBody>
    </>
  )
}
