import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dissolveGroupAsAdmin, listAllGroups, listConversationMembers } from '@vibechat/core'
import type { AdminConversationView } from '@vibechat/protocol'
import { MessagesSquare, Trash2, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { useErrorMessage } from '../../errors'
import { toast } from '../../toast'
import {
  AdminBody,
  AdminHeader,
  ConfirmDialog,
  conversationLabel,
  PAGE_SIZE,
  Pager,
  RowAction,
  Tag,
  useFormatTime,
  ViewChatLink,
} from './common'
import { SearchBox } from './UsersPage'

const QUERY_KEY = ['admin', 'groups']

/** 一个群的全部成员，包括已经离开的。 */
function MembersDialog({
  group,
  name,
  onClose,
}: {
  group: AdminConversationView | null
  name: string
  onClose: () => void
}) {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const id = group?.id ?? ''
  const members = useQuery({
    queryKey: ['admin', 'members', id],
    queryFn: ({ signal }) => listConversationMembers(id, { signal }),
    enabled: group !== null,
  })
  return (
    <Dialog
      open={group !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('groups.membersTitle', { name })}
    >
      {members.isError ? (
        <LoadError message={errorMessage(members.error)} onRetry={() => void members.refetch()} />
      ) : !members.data ? (
        <ListSkeleton rows={3} />
      ) : (
        <ul data-testid="admin-members" className="-mx-2 max-h-[50dvh] overflow-auto">
          {members.data.items.map((member) => (
            <li
              key={member.user.id}
              data-testid="admin-member"
              className="flex h-12 items-center gap-3 px-2"
            >
              <Avatar user={member.user} size={32} />
              <span className={`min-w-0 flex-1 truncate ${member.active ? '' : 'text-fg-3'}`}>
                {member.user.nickname}
              </span>
              {member.is_owner && <Tag>{t('groups.ownerTag')}</Tag>}
              {!member.active && <Tag>{t('groups.leftTag')}</Tag>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button onClick={onClose}>{t('users.close')}</Button>
      </div>
    </Dialog>
  )
}

function GroupRow({ group }: { group: AdminConversationView }) {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const formatTime = useFormatTime()
  const [showingMembers, setShowingMembers] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const name = conversationLabel(group, t('chats.unnamedSeparator'))

  const dissolve = useMutation({
    mutationFn: () => dissolveGroupAsAdmin(group.id),
    onSuccess: () => toast.success(t('groups.dissolvedDone')),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: async () => {
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: ['admin'] })
    },
  })

  const details = [
    group.owner && t('groups.owner', { name: group.owner.nickname }),
    t('groups.members', { count: group.member_count }),
    t('groups.createdAt', { time: formatTime(group.created_at) }),
  ].filter((item): item is string => Boolean(item))

  return (
    <li
      data-testid="admin-group"
      data-dissolved={group.dissolved}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-b py-3"
    >
      <span className="grid size-9 flex-none place-items-center rounded-card bg-surface text-fg-2">
        <UsersRound size={18} strokeWidth={1.5} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span data-testid="admin-group-name" className="truncate">
            {name}
          </span>
          {group.dissolved && <Tag tone="danger">{t('groups.dissolved')}</Tag>}
        </span>
        <span className="text-[12px] text-fg-2">{details.join(' · ')}</span>
      </div>
      <div className="flex flex-none items-center max-md:-ml-4 max-md:w-full">
        <RowAction
          icon={UsersRound}
          label={t('groups.showMembers')}
          description={t('groups.showMembersOf', { name })}
          onClick={() => setShowingMembers(true)}
        />
        <ViewChatLink
          icon={MessagesSquare}
          label={t('groups.viewChat')}
          description={t('groups.viewChatOf', { name })}
          conversationId={group.id}
        />
        {!group.dissolved && (
          <RowAction
            icon={Trash2}
            label={t('groups.dissolve')}
            description={t('groups.dissolveGroup', { name })}
            onClick={() => setConfirming(true)}
          />
        )}
      </div>
      <MembersDialog
        group={showingMembers ? group : null}
        name={name}
        onClose={() => setShowingMembers(false)}
      />
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('groups.dissolveTitle', { name })}
        explain={t('groups.dissolveExplain')}
        confirmLabel={t('groups.dissolve')}
        onConfirm={() => dissolve.mutate()}
        pending={dissolve.isPending}
      />
    </li>
  )
}

/** 群：全部群的列表和成员，查看聊天记录，解散。 */
export function AdminGroupsPage() {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const groups = useQuery({
    queryKey: [...QUERY_KEY, { search: search.trim(), page }],
    queryFn: ({ signal }) => listAllGroups({ search, page, pageSize: PAGE_SIZE, signal }),
    placeholderData: keepPreviousData,
  })
  const items = groups.data?.items ?? []
  return (
    <>
      <AdminHeader title={t('groups.title')} />
      <AdminBody>
        <div className="border-border border-b py-3">
          <SearchBox
            label={t('groups.search')}
            value={search}
            onChange={(value) => {
              setSearch(value)
              setPage(1)
            }}
          />
        </div>
        {groups.isError ? (
          <LoadError message={errorMessage(groups.error)} onRetry={() => void groups.refetch()} />
        ) : !groups.data ? (
          <ListSkeleton />
        ) : items.length === 0 ? (
          <div className="h-40">
            <EmptyState>{t('groups.empty')}</EmptyState>
          </div>
        ) : (
          <>
            <ul data-testid="admin-groups">
              {items.map((group) => (
                <GroupRow key={group.id} group={group} />
              ))}
            </ul>
            <Pager page={page} total={groups.data.total} onChange={setPage} />
          </>
        )}
      </AdminBody>
    </>
  )
}
