import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createInviteCodes,
  deleteInviteCodes,
  listInviteCodes,
  revokeInviteCode,
  revokeInviteCodes,
} from '@vibechat/core'
import type { InviteCodeOrder, InviteCodeStatus, InviteCodeView } from '@vibechat/protocol'
import {
  ArrowDown,
  ArrowUp,
  Ban,
  ChevronLeft,
  ChevronRight,
  Copy,
  type LucideIcon,
  Trash2,
} from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyText } from '../../clipboard'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { SegmentedControl } from '../../components/SegmentedControl'
import { SelectField } from '../../components/SelectField'
import { TextField } from '../../components/TextField'
import { useErrorMessage } from '../../errors'
import { usePreferences } from '../../preferences'
import { toast } from '../../toast'
import { AdminHeader } from './common'

const QUERY_KEY = ['admin', 'invite-codes']
const PAGE_SIZE = 20
const MAX_PER_REQUEST = 20
const NOTE_MAX_CHARS = 100
const CHECKBOX = 'size-4 flex-none accent-accent'

/** 有效期的选项。取值是天数，空表示长期有效。 */
const VALIDITY = ['', '1', '7', '30'] as const
type Validity = (typeof VALIDITY)[number]

/** 按状态筛选的选项：全部，或者只看某一种状态的。 */
const FILTERS = ['all', 'unused', 'used', 'expired', 'revoked'] as const
type Filter = 'all' | InviteCodeStatus

/** 要用户确认的两种操作。 */
type Confirming = 'revoke' | 'delete' | null

/** 还能用来注册的：可以复制、作废。 */
function isUsable(invite: InviteCodeView): boolean {
  return invite.status === 'unused'
}

/** 已经作废或过期、再也用不了的：可以删除。已经使用的记着是谁凭它注册的，不能删除。 */
function isDead(invite: InviteCodeView): boolean {
  return invite.status === 'revoked' || invite.status === 'expired'
}

/** 按 4 位一组显示，方便口头或手写传递。输入时分隔符会被忽略。 */
function grouped(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code
}

function useFormatTime() {
  const language = usePreferences((state) => state.language)
  const format = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' })
  return (time: number) => format.format(time)
}

interface ActionButtonProps {
  icon: LucideIcon
  /** 按钮上的字；手机上只显示图标。 */
  label: string
  /** 完整的说明，例如是对哪个邀请码操作。 */
  description: string
  onClick: () => void
}

/** 一行右侧和多选栏里的操作按钮。 */
function ActionButton({ icon: Icon, label, description, onClick }: ActionButtonProps) {
  return (
    <Button variant="ghost" onClick={onClick} aria-label={description} className="px-3">
      <Icon size={16} strokeWidth={1.5} aria-hidden />
      <span className="max-md:hidden">{label}</span>
    </Button>
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
}

/** 作废和删除都不能撤销，先问一次。 */
function ConfirmDialog({
  open,
  onClose,
  title,
  explain,
  confirmLabel,
  onConfirm,
  pending,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()} title={title}>
      <p className="text-fg-2">{explain}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('actions.cancel')}
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={pending}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}

interface InviteCodeRowProps {
  invite: InviteCodeView
  selected: boolean
  onSelect: (selected: boolean) => void
  /** 列表里有可以勾选的邀请码时，不能勾选的行也留出勾选框的位置，保持对齐。 */
  indent: boolean
}

function InviteCodeRow({ invite, selected, onSelect, indent }: InviteCodeRowProps) {
  const { t } = useTranslation('admin')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const formatTime = useFormatTime()
  const [confirming, setConfirming] = useState<Confirming>(null)
  const code = grouped(invite.code)
  const usable = isUsable(invite)
  const dead = isDead(invite)

  // 不论成败都重新取一次列表：失败往往是因为它刚被别人用掉、作废或删除了
  async function settle() {
    setConfirming(null)
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  }

  const revoke = useMutation({
    mutationFn: () => revokeInviteCode(invite.id),
    onSuccess: () => toast.success(t('inviteCodes.revoked')),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: settle,
  })

  const remove = useMutation({
    mutationFn: () => deleteInviteCodes([invite.id]),
    onSuccess: () => toast.success(t('inviteCodes.deleted')),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: settle,
  })

  async function copy() {
    if (await copyText(code)) toast.success(tCommon('copied'))
    else toast.error(t('inviteCodes.copyFailed'))
  }

  // 第二行：状态、使用者、有效期、生成时间，有什么写什么
  const details = [
    invite.used_by &&
      t('inviteCodes.usedBy', {
        nickname: invite.used_by.nickname,
        handle: invite.used_by.handle,
      }),
    usable &&
      (invite.expires_at
        ? t('inviteCodes.expiresAt', { time: formatTime(invite.expires_at) })
        : t('inviteCodes.neverExpires')),
    t('inviteCodes.createdAt', { time: formatTime(invite.created_at) }),
  ].filter((item): item is string => Boolean(item))

  return (
    <li
      data-testid="invite-code"
      data-status={invite.status}
      className="flex items-center gap-2 border-border border-b py-3"
    >
      {usable || dead ? (
        // 留出比勾选框本身更大的点按范围：手机上不小于 44 像素
        <label className="-my-3.5 -ml-3.5 flex flex-none p-3.5 md:-my-2 md:-ml-2 md:p-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
            aria-label={t('inviteCodes.selectCode', { code })}
            className={CHECKBOX}
          />
        </label>
      ) : (
        indent && <span className="mr-2 size-4 flex-none" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span
            data-testid="invite-code-value"
            className={`select-all font-mono ${usable ? '' : 'text-fg-3 line-through'}`}
          >
            {code}
          </span>
          {invite.note && (
            <span data-testid="invite-code-note" className="text-fg-2">
              {invite.note}
            </span>
          )}
        </span>
        <span className="text-[12px] text-fg-2">
          <span className={usable ? 'text-success' : undefined}>
            {t(`inviteCodes.status.${invite.status}`)}
          </span>
          {details.map((detail) => (
            <span key={detail}>
              {' · '}
              {detail}
            </span>
          ))}
        </span>
      </div>
      {usable && (
        <>
          <ActionButton
            icon={Copy}
            label={tCommon('actions.copy')}
            description={t('inviteCodes.copyCode', { code })}
            onClick={copy}
          />
          <ActionButton
            icon={Ban}
            label={t('inviteCodes.revoke')}
            description={t('inviteCodes.revokeCode', { code })}
            onClick={() => setConfirming('revoke')}
          />
          <ConfirmDialog
            open={confirming === 'revoke'}
            onClose={() => setConfirming(null)}
            title={t('inviteCodes.revokeTitle')}
            explain={t('inviteCodes.revokeExplain', { code })}
            confirmLabel={t('inviteCodes.revoke')}
            onConfirm={() => revoke.mutate()}
            pending={revoke.isPending}
          />
        </>
      )}
      {dead && (
        <>
          <ActionButton
            icon={Trash2}
            label={t('inviteCodes.delete')}
            description={t('inviteCodes.deleteCode', { code })}
            onClick={() => setConfirming('delete')}
          />
          <ConfirmDialog
            open={confirming === 'delete'}
            onClose={() => setConfirming(null)}
            title={t('inviteCodes.deleteTitle')}
            explain={t('inviteCodes.deleteExplain', { code })}
            confirmLabel={t('inviteCodes.delete')}
            onConfirm={() => remove.mutate()}
            pending={remove.isPending}
          />
        </>
      )}
    </li>
  )
}

/**
 * 邀请码：生成（可以带有效期和备注）；分页查看，可以按状态筛选、按生成时间排序；
 * 复制、作废，作废或过期之后可以删除。可以勾选多个一起操作。
 */
export function InviteCodesPage() {
  const { t } = useTranslation('admin')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const [count, setCount] = useState('1')
  const [validity, setValidity] = useState<Validity>('')
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [order, setOrder] = useState<InviteCodeOrder>('newest')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState<Confirming>(null)

  const codes = useQuery({
    queryKey: [...QUERY_KEY, { filter, order, page }],
    queryFn: ({ signal }) =>
      listInviteCodes({
        page,
        pageSize: PAGE_SIZE,
        status: filter === 'all' ? undefined : filter,
        order,
        signal,
      }),
    // 翻页时先留着上一页的内容，新的一页到了再换，页面不会闪一下
    placeholderData: keepPreviousData,
  })
  const items = codes.data?.items ?? []
  const total = codes.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // 确实一个也没有。翻页或换筛选时暂时留着的上一份内容不算数
  const empty = codes.data !== undefined && !codes.isPlaceholderData && total === 0

  // 删除之后页数可能变少：停在已经不存在的页上时，退回最后一页
  if (codes.data && !codes.isPlaceholderData && page > pageCount) {
    setPage(pageCount)
  }

  // 可以勾选的是这一页里还能操作的：能用的可以复制和作废，作废或过期的可以删除
  const selectable = items.filter((invite) => isUsable(invite) || isDead(invite))
  const selected = selectable.filter((invite) => selectedIds.has(invite.id))
  const selectedUsable = selected.filter(isUsable)
  const selectedDead = selected.filter(isDead)
  const allSelected = selected.length > 0 && selected.length === selectable.length

  function goToPage(next: number) {
    setPage(next)
    // 勾选只对当前这一页有效
    setSelectedIds(new Set())
  }

  // 换了筛选或排序，列表就是另一份了：从第一页看起
  function changeFilter(next: Filter) {
    setFilter(next)
    goToPage(1)
  }

  function reverseOrder() {
    setOrder(order === 'newest' ? 'oldest' : 'newest')
    goToPage(1)
  }

  function select(id: string, on: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function selectAll(on: boolean) {
    setSelectedIds(new Set(on ? selectable.map((invite) => invite.id) : []))
  }

  async function copySelected() {
    // 一行一个，顺序与列表一致
    const text = selectedUsable.map((invite) => grouped(invite.code)).join('\n')
    if (await copyText(text)) {
      toast.success(t('inviteCodes.copiedSelected', { count: selectedUsable.length }))
    } else {
      toast.error(t('inviteCodes.copyFailed'))
    }
  }

  async function settle() {
    setConfirming(null)
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  }

  const revokeSelected = useMutation({
    mutationFn: (ids: string[]) => revokeInviteCodes(ids),
    onSuccess: ({ revoked }, ids) => {
      const skipped = ids.length - revoked
      toast.success(
        skipped > 0
          ? t('inviteCodes.revokedSome', { revoked, skipped })
          : t('inviteCodes.revokedSelected', { count: revoked }),
      )
      setSelectedIds(new Set())
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: settle,
  })

  const deleteSelected = useMutation({
    mutationFn: (ids: string[]) => deleteInviteCodes(ids),
    onSuccess: ({ deleted }) => {
      toast.success(t('inviteCodes.deletedSelected', { count: deleted }))
      setSelectedIds(new Set())
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: settle,
  })

  const generate = useMutation({
    mutationFn: () =>
      createInviteCodes({
        count: Number(count),
        note: note.trim() || undefined,
        expires_in_days: validity ? Number(validity) : undefined,
      }),
    onSuccess: async (created) => {
      toast.success(t('inviteCodes.generated', { count: created.items.length }))
      setNote('')
      // 让新生成的出现在眼前：最新的在前、第一页，筛选里也得包含"未使用"的。
      // 直接勾选上，接下来多半是要一起复制出去
      if (filter !== 'unused') setFilter('all')
      setOrder('newest')
      setPage(1)
      setSelectedIds(new Set(created.items.map((invite) => invite.id)))
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    generate.mutate()
  }

  const validityOptions = VALIDITY.map((value) => ({
    value,
    label: t(`inviteCodes.validityOptions.${value === '' ? 'forever' : value}`),
  }))
  const filterOptions = FILTERS.map((value) => ({
    value,
    label: value === 'all' ? t('inviteCodes.filterAll') : t(`inviteCodes.status.${value}`),
  }))
  const OrderIcon = order === 'newest' ? ArrowDown : ArrowUp

  return (
    <>
      <AdminHeader title={t('inviteCodes.title')} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[640px] px-4 md:px-8">
          <form
            onSubmit={onSubmit}
            className="flex flex-wrap items-end gap-2 border-border border-b py-5"
          >
            <TextField
              label={t('inviteCodes.count')}
              type="number"
              min={1}
              max={MAX_PER_REQUEST}
              value={count}
              onChange={(event) => setCount(event.target.value)}
              className="w-20"
              required
            />
            <SelectField
              label={t('inviteCodes.validity')}
              value={validity}
              onChange={(event) => setValidity(event.target.value as Validity)}
              options={validityOptions}
              className="w-28"
            />
            <TextField
              label={t('inviteCodes.note')}
              placeholder={t('inviteCodes.notePlaceholder')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={NOTE_MAX_CHARS}
              className="min-w-40 flex-1"
            />
            <Button type="submit" variant="primary" disabled={generate.isPending}>
              {t('inviteCodes.generate')}
            </Button>
          </form>
          {codes.isError ? (
            <LoadError message={errorMessage(codes.error)} onRetry={() => void codes.refetch()} />
          ) : !codes.data ? (
            <ListSkeleton rows={3} />
          ) : empty && filter === 'all' ? (
            <div className="h-40">
              <EmptyState hint={t('inviteCodes.emptyHint')}>{t('inviteCodes.empty')}</EmptyState>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b py-3">
                <SegmentedControl
                  label={t('inviteCodes.filter')}
                  value={filter}
                  options={filterOptions}
                  onChange={changeFilter}
                  fillOnPhone
                />
                <Button
                  variant="ghost"
                  onClick={reverseOrder}
                  title={t('inviteCodes.orderHint')}
                  className="px-3"
                >
                  <OrderIcon size={16} strokeWidth={1.5} aria-hidden />
                  {t(`inviteCodes.order.${order}`)}
                </Button>
              </div>
              {empty && (
                <div className="h-40">
                  <EmptyState>{t('inviteCodes.noMatch')}</EmptyState>
                </div>
              )}
              {selectable.length > 0 && (
                <div
                  data-testid="invite-code-selection"
                  className="sticky top-0 z-10 flex h-12 items-center gap-2 border-border border-b bg-bg"
                >
                  <label className="-ml-2 flex min-h-11 min-w-0 flex-1 items-center gap-2 p-2 text-fg-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(element) => {
                        if (element) element.indeterminate = selected.length > 0 && !allSelected
                      }}
                      onChange={(event) => selectAll(event.target.checked)}
                      className={CHECKBOX}
                    />
                    <span className="truncate">
                      {selected.length > 0
                        ? t('inviteCodes.selected', { count: selected.length })
                        : t('inviteCodes.selectAll')}
                    </span>
                  </label>
                  {selectedUsable.length > 0 && (
                    <>
                      <ActionButton
                        icon={Copy}
                        label={tCommon('actions.copy')}
                        description={t('inviteCodes.copySelected')}
                        onClick={copySelected}
                      />
                      <ActionButton
                        icon={Ban}
                        label={t('inviteCodes.revoke')}
                        description={t('inviteCodes.revokeSelected')}
                        onClick={() => setConfirming('revoke')}
                      />
                    </>
                  )}
                  {selectedDead.length > 0 && (
                    <ActionButton
                      icon={Trash2}
                      label={t('inviteCodes.delete')}
                      description={t('inviteCodes.deleteSelected')}
                      onClick={() => setConfirming('delete')}
                    />
                  )}
                </div>
              )}
              <ul>
                {items.map((invite) => (
                  <InviteCodeRow
                    key={invite.id}
                    invite={invite}
                    selected={selectedIds.has(invite.id)}
                    onSelect={(on) => select(invite.id, on)}
                    indent={selectable.length > 0}
                  />
                ))}
              </ul>
              {pageCount > 1 && (
                <nav
                  data-testid="invite-code-pager"
                  aria-label={t('inviteCodes.pages')}
                  className="flex items-center gap-1 py-3 text-fg-2"
                >
                  <span className="flex-1">{t('inviteCodes.total', { count: total })}</span>
                  <Button
                    variant="ghost"
                    onClick={() => goToPage(page - 1)}
                    disabled={page <= 1}
                    aria-label={t('inviteCodes.previousPage')}
                    className="px-2"
                  >
                    <ChevronLeft size={16} strokeWidth={1.5} aria-hidden />
                  </Button>
                  <span data-testid="invite-code-page" className="px-1 tabular-nums">
                    {page} / {pageCount}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => goToPage(page + 1)}
                    disabled={page >= pageCount}
                    aria-label={t('inviteCodes.nextPage')}
                    className="px-2"
                  >
                    <ChevronRight size={16} strokeWidth={1.5} aria-hidden />
                  </Button>
                </nav>
              )}
              <ConfirmDialog
                open={confirming === 'revoke'}
                onClose={() => setConfirming(null)}
                title={t('inviteCodes.revokeSelectedTitle', { count: selectedUsable.length })}
                explain={t('inviteCodes.revokeSelectedExplain')}
                confirmLabel={t('inviteCodes.revoke')}
                onConfirm={() => revokeSelected.mutate(selectedUsable.map((invite) => invite.id))}
                pending={revokeSelected.isPending}
              />
              <ConfirmDialog
                open={confirming === 'delete'}
                onClose={() => setConfirming(null)}
                title={t('inviteCodes.deleteSelectedTitle', { count: selectedDead.length })}
                explain={t('inviteCodes.deleteSelectedExplain')}
                confirmLabel={t('inviteCodes.delete')}
                onConfirm={() => deleteSelected.mutate(selectedDead.map((invite) => invite.id))}
                pending={deleteSelected.isPending}
              />
            </>
          )}
        </div>
      </div>
    </>
  )
}
