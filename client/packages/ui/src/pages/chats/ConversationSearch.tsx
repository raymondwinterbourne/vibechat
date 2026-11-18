import { useInfiniteQuery } from '@tanstack/react-query'
import { formatListTime, memberName, searchConversation } from '@vibechat/core'
import type { ConversationView, MemberView } from '@vibechat/protocol'
import { ChevronLeft, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { useErrorMessage } from '../../errors'
import { usePreferences } from '../../preferences'
import { useMe } from '../../session'
import { Highlighted, hitText, QUERY_MAX_CHARS, useSettled } from './search'
import { displayName } from './text'

interface ConversationSearchProps {
  conversation: ConversationView
  members: readonly MemberView[] | undefined
  /** 打开时已经填好的关键词（从全局搜索点"查看全部"进来的）。 */
  initialQuery?: string
  onJump: (seq: number) => void
  onClose: () => void
}

/** 只在这一个会话里搜索：电脑上是右侧的面板，手机上盖住整个会话。 */
export function ConversationSearch({
  conversation,
  members,
  initialQuery = '',
  onJump,
  onClose,
}: ConversationSearchProps) {
  const { t } = useTranslation('chats')
  const errorMessage = useErrorMessage()
  const language = usePreferences((state) => state.language)
  const me = useMe()
  const [text, setText] = useState(initialQuery)
  const query = useSettled(text.trim(), 250)

  const found = useInfiniteQuery({
    queryKey: ['conversation-search', conversation.id, query] as const,
    queryFn: ({ pageParam, signal }) =>
      searchConversation(conversation.id, query, { before: pageParam }, { signal }),
    initialPageParam: undefined as number | undefined,
    // 往更早的翻：从上一页最后一条之前接着搜
    getNextPageParam: (last) => (last.has_more ? last.items.at(-1)?.seq : undefined),
    enabled: query.length > 0,
    staleTime: 0,
    gcTime: 0,
  })
  const hits = found.data?.pages.flatMap((page) => page.items) ?? []

  function senderOf(senderId: string | null, fallback: string | null): string {
    if (senderId === me.id) return t('event.you')
    const member = members?.find((candidate) => candidate.user.id === senderId)
    if (member) return memberName(member)
    return conversation.peer ? displayName(conversation, t) : (fallback ?? '')
  }

  return (
    <aside
      data-testid="conversation-search"
      className="absolute inset-0 z-10 flex flex-col bg-bg md:static md:z-auto md:w-[300px] md:flex-none md:border-border md:border-l"
    >
      <header className="flex h-[52px] flex-none items-center gap-1 border-border border-b pr-2 pl-4 max-md:pl-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('search.closeIn')}
          className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:hidden"
        >
          <ChevronLeft size={22} strokeWidth={1.5} aria-hidden />
        </button>
        <h2 className="min-w-0 flex-1 truncate font-medium text-[17px] md:text-[15px]">
          {t('search.inConversation')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('search.closeIn')}
          title={t('search.closeIn')}
          className="hidden size-9 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:grid"
        >
          <X size={20} strokeWidth={1.5} aria-hidden />
        </button>
      </header>
      <div className="flex-none p-3">
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={QUERY_MAX_CHARS}
          aria-label={t('search.inPlaceholder')}
          placeholder={t('search.inPlaceholder')}
          // biome-ignore lint/a11y/noAutofocus: 面板打开就是为了打字
          autoFocus
          className="h-11 w-full rounded-control border border-border bg-bg px-3 text-fg placeholder:text-fg-3 md:h-9 [&::-webkit-search-cancel-button]:appearance-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
        {found.isError ? (
          <p role="alert" className="p-4 text-center text-danger">
            {errorMessage(found.error)}
          </p>
        ) : !query ? (
          <p className="p-6 text-center text-fg-3">{t('search.hint')}</p>
        ) : hits.length === 0 && !found.isFetching && text.trim() === query ? (
          <p className="p-6 text-center text-fg-3">{t('search.none')}</p>
        ) : (
          <ul>
            {hits.map((hit) => (
              <li key={hit.id}>
                <button
                  type="button"
                  data-testid="search-hit"
                  onClick={() => onJump(hit.seq)}
                  className="flex w-full flex-col gap-0.5 rounded-control px-3 py-2 text-left hover:bg-hover"
                >
                  <span className="flex items-baseline gap-2 text-[12px] text-fg-3">
                    <span className="min-w-0 flex-1 truncate">
                      {senderOf(hit.sender_id, hit.sender_name)}
                    </span>
                    <span className="flex-none text-[11px]">
                      {formatListTime(hit.created_at, Date.now(), language)}
                    </span>
                  </span>
                  <span className="line-clamp-2 [overflow-wrap:anywhere]">
                    <Highlighted text={hitText(hit, query)} query={query} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {found.hasNextPage && (
          <div className="flex justify-center p-2">
            <Button onClick={() => void found.fetchNextPage()} disabled={found.isFetchingNextPage}>
              {t('search.loadMore')}
            </Button>
          </div>
        )}
      </div>
    </aside>
  )
}
