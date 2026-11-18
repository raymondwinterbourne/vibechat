import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { filterFriends, friendName, groupFriends, sortFriends } from '@vibechat/core'
import type { FriendView } from '@vibechat/protocol'
import { UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Badge } from '../../components/Badge'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { friendsQuery, usePendingRequestCount } from '../../contacts'
import { useErrorMessage } from '../../errors'
import { TwoPane } from '../../layout/TwoPane'
import { usePreferences } from '../../preferences'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { AddFriendDialog } from './AddFriendDialog'
import { AlphabetIndex } from './AlphabetIndex'

const ROW =
  'flex h-14 items-center gap-3 px-4 transition-colors duration-150 hover:bg-hover data-[status=active]:bg-hover'

/** 好友列表里的一行。 */
function FriendRow({ friend, indexed }: { friend: FriendView; indexed: boolean }) {
  return (
    <li>
      <Link
        to="/contacts/$userId"
        params={{ userId: friend.user.id }}
        data-testid="friend"
        // 右边有字母索引时让开它
        className={`${ROW} ${indexed ? 'pr-8' : ''}`}
      >
        <Avatar user={friend.user} />
        <span data-testid="friend-label" className="min-w-0 flex-1 truncate">
          {friendName(friend)}
        </span>
      </Link>
    </li>
  )
}

/** 通讯录最上面的一行：我自己。点它打开和自己的对话，给自己记点东西、传个文件。 */
function MyselfRow({ filter }: { filter: string }) {
  const { t } = useTranslation('contacts')
  const errorMessage = useErrorMessage()
  const me = useMe()
  const store = useChatStore()
  const navigate = useNavigate()
  const open = useMutation({
    mutationFn: () => store.openDirect(me.id),
    onSuccess: (id) =>
      void navigate({ to: '/chats/$conversationId', params: { conversationId: id } }),
    onError: (error) => toast.error(errorMessage(error)),
  })
  const label = t('self', { name: me.nickname })
  // 筛选时和好友一样按名字筛，"我"这个字也算
  const needle = filter.trim().toLowerCase()
  if (
    needle &&
    ![label, me.nickname, me.handle].some((text) => text.toLowerCase().includes(needle))
  ) {
    return null
  }
  return (
    <button
      type="button"
      onClick={() => open.mutate()}
      disabled={open.isPending}
      data-testid="friend-me"
      className={`${ROW} w-full text-left`}
    >
      <Avatar user={me} />
      <span data-testid="friend-me-label" className="min-w-0 flex-1 truncate">
        {label}
      </span>
    </button>
  )
}

/** 通讯录：左边是"新的朋友"和好友列表，右边是选中的那一项。 */
export function ContactsPage() {
  const { t } = useTranslation('contacts')
  const errorMessage = useErrorMessage()
  const language = usePreferences((state) => state.language)
  const friends = useQuery(friendsQuery)
  const pending = usePendingRequestCount()
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  // 地址停在 /contacts 上时什么也没选中
  const detailOpen = useLocation({
    select: (location) => location.pathname.replace(/\/$/, '') !== '/contacts',
  })

  const all = friends.data ?? []
  const shown = sortFriends(filterFriends(all, filter), language)
  // 不筛选时按首字母分组，右边有字母索引；筛选时就是一个列表
  const grouped = filter.trim() === ''
  const sections = grouped ? groupFriends(all) : []
  const jump = (letter: string) =>
    document.getElementById(`friend-section-${letter}`)?.scrollIntoView({ block: 'start' })

  return (
    <>
      <TwoPane
        title={t('title')}
        detailOpen={detailOpen}
        actions={
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label={t('add.title')}
            title={t('add.title')}
            className="grid size-11 place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:size-9"
          >
            <UserPlus size={20} strokeWidth={1.5} aria-hidden />
          </button>
        }
        list={
          <div className="flex min-h-full flex-col">
            <div className="p-3">
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                aria-label={t('filter')}
                placeholder={t('filter')}
                className="h-11 w-full rounded-control border border-border bg-bg px-3 text-fg placeholder:text-fg-3 md:h-9"
              />
            </div>
            <Link to="/contacts/new" className={ROW}>
              <span className="grid size-9 flex-none place-items-center rounded-card bg-accent text-on-accent">
                <UserPlus size={18} strokeWidth={1.5} aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate">{t('requests.title')}</span>
              <Badge count={pending} label={t('newRequests', { count: pending })} />
            </Link>
            <Link to="/contacts/groups" className={ROW}>
              <span className="grid size-9 flex-none place-items-center rounded-card bg-accent text-on-accent">
                <Users size={18} strokeWidth={1.5} aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate">{t('groups.title')}</span>
            </Link>
            <MyselfRow filter={filter} />
            {friends.isError ? (
              <LoadError
                message={errorMessage(friends.error)}
                onRetry={() => void friends.refetch()}
              />
            ) : !friends.data ? (
              <ListSkeleton />
            ) : shown.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-fg-3">
                <p>{all.length === 0 ? t('empty') : t('noMatch')}</p>
                {all.length === 0 && <p className="text-[12px]">{t('emptyHint')}</p>}
              </div>
            ) : grouped ? (
              <div data-testid="friend-list">
                {sections.map((section) => (
                  <section
                    key={section.initial}
                    aria-labelledby={`friend-section-${section.initial}`}
                  >
                    <h2
                      id={`friend-section-${section.initial}`}
                      data-testid="friend-section"
                      className="sticky top-0 z-[1] scroll-mt-0 border-border border-b bg-bg-subtle px-4 py-1 text-[12px] text-fg-2 max-md:bg-bg"
                    >
                      {section.initial}
                    </h2>
                    <ul>
                      {section.friends.map((friend) => (
                        <FriendRow key={friend.user.id} friend={friend} indexed />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <ul data-testid="friend-list">
                {shown.map((friend) => (
                  <FriendRow key={friend.user.id} friend={friend} indexed={false} />
                ))}
              </ul>
            )}
          </div>
        }
        listAside={
          grouped && sections.length > 0 ? (
            <AlphabetIndex
              letters={sections.map((section) => section.initial)}
              onPick={jump}
              label={t('index')}
            />
          ) : undefined
        }
        detail={<Outlet />}
      />
      <AddFriendDialog open={adding} onClose={() => setAdding(false)} />
    </>
  )
}

/** 没有选中任何一项时右边显示的内容。 */
export function ContactsPlaceholder() {
  const { t } = useTranslation('contacts')
  return <EmptyState>{t('placeholder')}</EmptyState>
}
