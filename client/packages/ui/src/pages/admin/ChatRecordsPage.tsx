import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { listUserConversations, listUsers } from '@vibechat/core'
import type { AdminConversationView } from '@vibechat/protocol'
import { ChevronRight, MessageCircle, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { useErrorMessage } from '../../errors'
import { AdminBody, AdminHeader, conversationLabel, Tag, useFormatTime } from './common'
import { SearchBox } from './UsersPage'

/** 找用户时最多列出几个。再多就该把字打得更准一些。 */
const CANDIDATES = 10

const ROW =
  'flex min-h-14 items-center gap-3 border-border border-b py-2 transition-colors duration-150 hover:bg-hover'

/** 第一步：找到一个用户。 */
function UserPicker() {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const [search, setSearch] = useState('')
  const term = search.trim()
  const users = useQuery({
    queryKey: ['admin', 'users', { search: term, pick: true }],
    queryFn: ({ signal }) => listUsers({ search: term, pageSize: CANDIDATES, signal }),
    enabled: term.length > 0,
  })
  return (
    <>
      <p className="py-4 text-fg-2">{t('chats.explain')}</p>
      <SearchBox label={t('chats.search')} value={search} onChange={setSearch} />
      {term.length === 0 ? null : users.isError ? (
        <LoadError message={errorMessage(users.error)} onRetry={() => void users.refetch()} />
      ) : !users.data ? (
        <ListSkeleton rows={2} />
      ) : users.data.items.length === 0 ? (
        <div className="h-32">
          <EmptyState>{t('chats.noUsers')}</EmptyState>
        </div>
      ) : (
        <ul data-testid="admin-user-candidates" className="mt-2">
          {users.data.items.map((user) => (
            <li key={user.id}>
              <Link
                to="/admin/chats"
                search={{ user: user.id }}
                aria-label={t('chats.pick', { name: user.nickname })}
                data-testid="admin-user-candidate"
                className={ROW}
              >
                <Avatar user={user} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{user.nickname}</span>
                  <span className="truncate font-mono text-[12px] text-fg-2">{user.handle}</span>
                </span>
                <ChevronRight size={16} strokeWidth={1.5} aria-hidden className="text-fg-3" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function ConversationRow({ conversation }: { conversation: AdminConversationView }) {
  const { t } = useTranslation('admin')
  const formatTime = useFormatTime()
  const name = conversationLabel(conversation, t('chats.unnamedSeparator'))
  const group = conversation.kind === 'group'
  const Icon = group ? UsersRound : MessageCircle
  const details = [
    group ? t('chats.group') : t('chats.direct'),
    group && t('chats.members', { count: conversation.member_count }),
    conversation.last_at
      ? t('chats.lastAt', { time: formatTime(conversation.last_at) })
      : t('chats.noMessages'),
  ].filter((item): item is string => Boolean(item))
  return (
    <li>
      <Link
        to="/admin/chats/$conversationId"
        params={{ conversationId: conversation.id }}
        aria-label={t('chats.open', { name })}
        data-testid="admin-conversation"
        data-kind={conversation.kind}
        className={ROW}
      >
        <span className="grid size-9 flex-none place-items-center rounded-card bg-surface text-fg-2">
          <Icon size={18} strokeWidth={1.5} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span data-testid="admin-conversation-name" className="truncate">
              {name}
            </span>
            {conversation.dissolved && <Tag tone="danger">{t('chats.dissolved')}</Tag>}
          </span>
          <span className="truncate text-[12px] text-fg-2">{details.join(' · ')}</span>
        </span>
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden className="flex-none text-fg-3" />
      </Link>
    </li>
  )
}

/** 第二步：这个用户参与的会话。 */
function ConversationsOf({ userId }: { userId: string }) {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const navigate = useNavigate()
  const found = useQuery({
    queryKey: ['admin', 'conversations', userId],
    queryFn: ({ signal }) => listUserConversations(userId, { signal }),
  })
  if (found.isError) {
    return <LoadError message={errorMessage(found.error)} onRetry={() => void found.refetch()} />
  }
  if (!found.data) return <ListSkeleton />
  const { user, items } = found.data
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-border border-b py-3">
        <Avatar user={user} />
        <h2 data-testid="admin-chats-user" className="min-w-0 flex-1 truncate">
          {t('chats.conversationsOf', { name: user.nickname })}
        </h2>
        <Button onClick={() => void navigate({ to: '/admin/chats', search: {} })}>
          {t('chats.changeUser')}
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="h-32">
          <EmptyState>{t('chats.noConversations')}</EmptyState>
        </div>
      ) : (
        <ul data-testid="admin-conversations">
          {items.map((conversation) => (
            <ConversationRow key={conversation.id} conversation={conversation} />
          ))}
        </ul>
      )}
    </>
  )
}

/** 聊天记录：按用户找到会话。找会话这一步看不到内容；打开会话才算一次查看。 */
export function ChatRecordsPage() {
  const { t } = useTranslation('admin')
  const { user } = useSearch({ from: '/app/admin/chats' })
  return (
    <>
      <AdminHeader title={t('chats.title')} />
      <AdminBody>{user ? <ConversationsOf userId={user} /> : <UserPicker />}</AdminBody>
    </>
  )
}
