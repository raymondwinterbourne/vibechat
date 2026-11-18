import * as RadixDialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  filterFriends,
  formatListTime,
  friendName,
  searchMessages,
  sortFriends,
} from '@vibechat/core'
import type { ConversationView, MessageView } from '@vibechat/protocol'
import { Search, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { groupsQuery, useChatState, useChatStore } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { friendsQuery } from '../../contacts'
import { useErrorMessage } from '../../errors'
import { usePreferences } from '../../preferences'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { ConversationAvatar } from './ConversationAvatar'
import { Highlighted, hitText, QUERY_MAX_CHARS, useSearchPanel, useSettled } from './search'
import { displayName } from './text'

/** 好友和群各自最多列出几个。 */
const NAMES_SHOWN = 5
/** 每个会话先列出最新的几条。 */
const HITS_SHOWN = 3

/** 结果里可以选中、可以打开的一行。 */
interface Item {
  key: string
  open: () => void
  content: ReactNode
}

/** 让全局搜索在任何页面都能用快捷键打开。面板本身也在这里。 */
export function SearchHost() {
  const { open, setOpen } = useSearchPanel()

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [setOpen])

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-overlay max-md:hidden" />
        <RadixDialog.Content
          aria-describedby={undefined}
          data-testid="search-panel"
          // 电脑上是屏幕中间的一块，手机上占满整屏
          className="fixed inset-0 z-50 flex flex-col bg-bg md:inset-auto md:top-[12vh] md:left-1/2 md:max-h-[70vh] md:w-[560px] md:-translate-x-1/2 md:rounded-card md:border md:border-border md:shadow-float"
        >
          {/* 内容只在打开时存在：每次打开都是空白的 */}
          <SearchBody onClose={() => setOpen(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

function SearchBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('chats')
  const errorMessage = useErrorMessage()
  const navigate = useNavigate()
  const language = usePreferences((state) => state.language)
  const me = useMe()
  const store = useChatStore()
  const conversations = useChatState((state) => state.conversations)
  const unlisted = useChatState((state) => state.unlisted)
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const query = useSettled(text.trim(), 250)

  const friends = useQuery(friendsQuery)
  const groups = useQuery(groupsQuery)
  const found = useQuery({
    queryKey: ['search', query] as const,
    queryFn: ({ signal }) => searchMessages(query, { signal }),
    enabled: query.length > 0,
    // 聊天记录随时在变，每次都重新搜
    staleTime: 0,
    gcTime: 0,
  })

  const conversationOf = (id: string): ConversationView | undefined =>
    conversations?.find((conversation) => conversation.id === id) ?? unlisted[id]

  // 搜到的消息所在的会话可能不在列表里（被移除了的）：把它取回来，才知道叫什么
  const hits = found.data?.items ?? []
  const unknown = [...new Set(hits.map((hit) => hit.conversation_id))]
    .filter((id) => !conversations?.some((conversation) => conversation.id === id))
    .filter((id) => !unlisted[id])
    .join(',')
  useEffect(() => {
    for (const id of unknown ? unknown.split(',') : []) {
      store.ensureConversation(id).catch(() => {})
    }
  }, [store, unknown])

  async function go(conversationId: string, search: { m?: number; find?: string } = {}) {
    onClose()
    await navigate({ to: '/chats/$conversationId', params: { conversationId }, search })
  }

  async function chatWith(userId: string) {
    try {
      await go(await store.openDirect(userId))
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  // ---------- 排出来的结果 ----------

  const sections: { title: string; items: Item[] }[] = []
  if (query) {
    const people = sortFriends(filterFriends(friends.data ?? [], query), language)
    if (people.length > 0) {
      sections.push({
        title: t('search.contacts'),
        items: people.slice(0, NAMES_SHOWN).map((friend) => ({
          key: `friend-${friend.user.id}`,
          open: () => void chatWith(friend.user.id),
          content: (
            <>
              <Avatar user={friend.user} size={32} />
              <span className="min-w-0 flex-1 truncate">
                <Highlighted text={friendName(friend)} query={query} />
              </span>
            </>
          ),
        })),
      })
    }
    const needle = query.toLowerCase()
    const named = (groups.data ?? []).filter((group) =>
      displayName(group, t).toLowerCase().includes(needle),
    )
    if (named.length > 0) {
      sections.push({
        title: t('search.groups'),
        items: named.slice(0, NAMES_SHOWN).map((group) => ({
          key: `group-${group.id}`,
          open: () => void go(group.id),
          content: (
            <>
              <ConversationAvatar conversation={group} size={32} />
              <span className="min-w-0 flex-1 truncate">
                <Highlighted text={displayName(group, t)} query={query} />
              </span>
            </>
          ),
        })),
      })
    }

    // 聊天记录：按会话归类，最新有结果的会话在前
    const byConversation = new Map<string, MessageView[]>()
    for (const hit of hits) {
      const list = byConversation.get(hit.conversation_id) ?? []
      list.push(hit)
      byConversation.set(hit.conversation_id, list)
    }
    const items: Item[] = []
    for (const [conversationId, list] of byConversation) {
      const conversation = conversationOf(conversationId)
      const name = conversation ? displayName(conversation, t) : ''
      for (const hit of list.slice(0, HITS_SHOWN)) {
        const mine = hit.sender_id === me.id
        const sender = mine ? t('event.you') : (hit.sender_name ?? name)
        items.push({
          key: `hit-${hit.id}`,
          open: () => void go(conversationId, { m: hit.seq }),
          content: (
            <>
              {conversation ? (
                <ConversationAvatar conversation={conversation} size={32} />
              ) : (
                <span className="size-8 flex-none rounded-card bg-surface" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline gap-2">
                  <span data-testid="hit-conversation" className="min-w-0 flex-1 truncate">
                    {name}
                  </span>
                  <span className="flex-none text-[11px] text-fg-3">
                    {formatListTime(hit.created_at, Date.now(), language)}
                  </span>
                </span>
                <span data-testid="hit-text" className="truncate text-[12px] text-fg-2">
                  {sender}: <Highlighted text={hitText(hit, query)} query={query} />
                </span>
              </span>
            </>
          ),
        })
      }
      if (list.length > HITS_SHOWN) {
        items.push({
          key: `more-${conversationId}`,
          open: () => void go(conversationId, { find: query }),
          content: (
            <span className="pl-11 text-[12px] text-accent-fg">
              {t('search.count', { count: list.length })} · {t('search.more')}
            </span>
          ),
        })
      }
    }
    if (items.length > 0) sections.push({ title: t('search.messages'), items })
  }
  const flat = sections.flatMap((section) => section.items)
  const selected = Math.min(active, flat.length - 1)

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // 用输入法打字时，回车和方向键是在选字
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flat.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((selected + step + flat.length) % flat.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      flat[selected]?.open()
    }
  }

  const searching = query.length > 0 && (found.isFetching || text.trim() !== query)
  return (
    <>
      <RadixDialog.Title className="sr-only">{t('search.open')}</RadixDialog.Title>
      <div className="flex h-[52px] flex-none items-center gap-2 border-border border-b pr-2 pl-4">
        <Search size={18} strokeWidth={1.5} aria-hidden className="flex-none text-fg-3" />
        <input
          type="search"
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          maxLength={QUERY_MAX_CHARS}
          aria-label={t('search.placeholder')}
          placeholder={t('search.placeholder')}
          // biome-ignore lint/a11y/noAutofocus: 面板打开就是为了打字
          autoFocus
          className="h-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:appearance-none"
        />
        <RadixDialog.Close
          aria-label={t('search.close')}
          title={t('search.close')}
          className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:size-9"
        >
          <X size={20} strokeWidth={1.5} aria-hidden />
        </RadixDialog.Close>
      </div>
      <div data-testid="search-results" className="min-h-0 flex-1 overflow-auto p-2">
        {found.isError ? (
          <p role="alert" className="p-4 text-center text-danger">
            {errorMessage(found.error)}
          </p>
        ) : !query ? (
          <p className="p-6 text-center text-fg-3">{t('search.hint')}</p>
        ) : flat.length === 0 && !searching ? (
          <p className="p-6 text-center text-fg-3">{t('search.none')}</p>
        ) : (
          sections.map((section) => (
            <section key={section.title} aria-label={section.title} className="pb-2">
              <h3 className="px-2 py-1.5 text-[12px] text-fg-3">{section.title}</h3>
              {section.items.map((item) => {
                const index = flat.indexOf(item)
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-testid="search-item"
                    data-active={index === selected || undefined}
                    onClick={item.open}
                    onPointerEnter={() => setActive(index)}
                    className="flex min-h-11 w-full items-center gap-3 rounded-control px-2 py-1.5 text-left data-[active]:bg-hover"
                  >
                    {item.content}
                  </button>
                )
              })}
            </section>
          ))
        )}
        {found.data?.has_more && (
          <p className="p-2 text-center text-[12px] text-fg-3">{t('search.truncated')}</p>
        )}
      </div>
    </>
  )
}
