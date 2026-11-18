import { Link, Outlet, useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { alerts, formatListTime } from '@vibechat/core'
import type { ConversationView } from '@vibechat/protocol'
import { BellOff, MessageSquarePlus, Pin, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatState, useChatStore, useMembers } from '../../chat'
import { Badge } from '../../components/Badge'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { DesktopPrompt } from '../../desktopClient'
import { useErrorMessage } from '../../errors'
import { useGroupCalls } from '../../groupCalls'
import { TwoPane } from '../../layout/TwoPane'
import { NoticePrompt } from '../../notifications'
import { usePreferences } from '../../preferences'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { ConversationAvatar } from './ConversationAvatar'
import { CreateGroupDialog } from './CreateGroupDialog'
import { MessageMenu } from './MessageMenu'
import { useSearchPanel } from './search'
import { displayName, summarize } from './text'

/** 手机上按住多久算长按。 */
const LONG_PRESS_MS = 500

function ConversationRow({ conversation }: { conversation: ConversationView }) {
  const { t } = useTranslation('chats')
  const language = usePreferences((state) => state.language)
  const me = useMe()
  const store = useChatStore()
  const navigate = useNavigate()
  const errorMessage = useErrorMessage()
  // 打开过的群才有成员名单；没有时名称用消息里带的
  const members = useMembers(conversation.id)
  // 这个群有通话在进行（F10）
  const inCall = useGroupCalls().calls[conversation.id] !== undefined
  const last = conversation.last_message
  const pinned = conversation.pinned_at !== null
  // 右键或长按弹出的菜单：置顶、免打扰、从列表移除
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  // 长按弹出了菜单：接下来的那一下"点击"不要打开会话
  const swallowClick = useRef(false)

  function cancelPress() {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }

  async function run(action: () => Promise<void>) {
    try {
      await action()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const items = [
    {
      label: pinned ? t('pin.off') : t('pin.on'),
      onSelect: () => void run(() => store.pin(conversation.id, !pinned)),
    },
    {
      label: conversation.muted ? t('mute.off') : t('mute.on'),
      onSelect: () => void run(() => store.mute(conversation.id, !conversation.muted)),
    },
    {
      label: t('header.hide'),
      onSelect: () =>
        void run(async () => {
          await store.hide(conversation.id)
          await navigate({ to: '/chats' })
        }),
    },
  ]

  return (
    <li>
      <Link
        to="/chats/$conversationId"
        params={{ conversationId: conversation.id }}
        data-testid="conversation"
        data-pinned={pinned ? '' : undefined}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0]
          if (!touch || event.touches.length > 1) return
          const { clientX: x, clientY: y } = touch
          const timer = window.setTimeout(() => {
            press.current = null
            swallowClick.current = true
            setMenu({ x, y })
          }, LONG_PRESS_MS)
          press.current = { timer, x, y }
        }}
        onTouchMove={(event) => {
          const touch = event.touches[0]
          const start = press.current
          if (touch && start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) {
            cancelPress()
          }
        }}
        onTouchEnd={cancelPress}
        onClick={(event) => {
          if (swallowClick.current) {
            swallowClick.current = false
            event.preventDefault()
          }
        }}
        className={`flex h-16 items-center gap-3 px-4 transition-colors duration-150 hover:bg-hover data-[status=active]:bg-hover [@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none] ${
          pinned ? 'bg-surface' : ''
        }`}
      >
        <ConversationAvatar conversation={conversation} size={40} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <span data-testid="conversation-name" className="min-w-0 truncate">
                {displayName(conversation, t)}
              </span>
              {pinned && (
                <Pin
                  size={12}
                  strokeWidth={1.5}
                  role="img"
                  aria-label={t('pin.pinned')}
                  data-testid="pinned"
                  className="flex-none text-fg-3"
                />
              )}
              {conversation.muted && (
                <BellOff
                  size={12}
                  strokeWidth={1.5}
                  role="img"
                  aria-label={t('mute.muted')}
                  data-testid="muted"
                  className="flex-none text-fg-3"
                />
              )}
            </span>
            {last && (
              <span className="flex-none text-[11px] text-fg-3">
                {formatListTime(last.created_at, Date.now(), language)}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span
              data-testid="conversation-summary"
              className="min-w-0 flex-1 truncate text-[12px] text-fg-2"
            >
              {conversation.group?.mentioned && (
                <span data-testid="mention-flag" className="mr-1 text-accent-fg">
                  {t('mentioned')}
                </span>
              )}
              {inCall && (
                <span data-testid="call-flag" className="mr-1 text-accent-fg">
                  {t('groupCall.listFlag')}
                </span>
              )}
              {last ? summarize(last, conversation, members, me.id, t) : ''}
            </span>
            <Badge
              count={conversation.unread}
              label={t('unread', { count: conversation.unread })}
              // 免打扰的会话只显示一个小圆点，除非里面有 @ 我的消息
              quiet={!alerts(conversation)}
            />
          </span>
        </span>
      </Link>
      {menu && <MessageMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </li>
  )
}

/** 聊天：左边是会话列表，右边是打开的那个会话。 */
export function ChatsPage() {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const navigate = useNavigate()
  const store = useChatStore()
  const conversations = useChatState((state) => state.conversations)
  const listFailed = useChatState((state) => state.listFailed)
  const { conversationId } = useParams({ strict: false })
  const [creating, setCreating] = useState(false)
  const openSearch = useSearchPanel((state) => state.setOpen)
  // 地址停在 /chats 上时没有打开任何会话
  const detailOpen = useLocation({
    select: (location) => location.pathname.replace(/\/$/, '') !== '/chats',
  })

  // Alt 加上下方向键：切换到列表里的上一个、下一个会话。到头了不循环
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      if (!conversations || conversations.length === 0) return
      event.preventDefault()
      const current = conversations.findIndex((item) => item.id === conversationId)
      const step = event.key === 'ArrowDown' ? 1 : -1
      // 还没有打开任何会话时，往下是第一个，往上是最后一个
      const next = current < 0 ? (step > 0 ? 0 : conversations.length - 1) : current + step
      const target = conversations[next]
      if (target) {
        void navigate({ to: '/chats/$conversationId', params: { conversationId: target.id } })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [conversations, conversationId, navigate])

  return (
    <>
      <TwoPane
        title={t('title')}
        detailOpen={detailOpen}
        actions={
          <button
            type="button"
            onClick={() => setCreating(true)}
            aria-label={t('newGroup')}
            title={t('newGroup')}
            className="grid size-11 place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:size-9"
          >
            <MessageSquarePlus size={20} strokeWidth={1.5} aria-hidden />
          </button>
        }
        list={
          <div className="flex min-h-full flex-col">
            {/* 看起来是一个输入框，点了打开搜索面板 */}
            <div className="flex-none p-3 pb-1">
              <button
                type="button"
                onClick={() => openSearch(true)}
                data-testid="open-search"
                className="flex h-11 w-full items-center gap-2 rounded-control border border-border bg-bg px-3 text-left text-fg-3 md:h-9"
              >
                <Search size={16} strokeWidth={1.5} aria-hidden />
                {t('search.open')}
              </button>
            </div>
            <NoticePrompt />
            <DesktopPrompt />
            {conversations === null ? (
              listFailed ? (
                <LoadError
                  message={tCommon('loadFailedShort')}
                  onRetry={() => store.loadConversations().catch(() => {})}
                />
              ) : (
                <ListSkeleton />
              )
            ) : conversations.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-fg-3">
                <p>{t('empty')}</p>
                <p className="text-[12px]">{t('emptyHint')}</p>
              </div>
            ) : (
              <ul data-testid="conversation-list">
                {conversations.map((conversation) => (
                  <ConversationRow key={conversation.id} conversation={conversation} />
                ))}
              </ul>
            )}
          </div>
        }
        detail={<Outlet />}
      />
      <CreateGroupDialog open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

/** 没有打开任何会话时右边显示的内容。 */
export function ChatsPlaceholder() {
  const { t } = useTranslation('chats')
  return <EmptyState>{t('placeholder')}</EmptyState>
}
