import { useQuery } from '@tanstack/react-query'
import { friendName } from '@vibechat/core'
import type { ChatRecordView, ConversationView, MessageView, UserCard } from '@vibechat/protocol'
import { Check } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatState, useChatStore } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { friendsQuery } from '../../contacts'
import { useErrorMessage } from '../../errors'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { ConversationAvatar } from './ConversationAvatar'
import { displayName } from './text'

/** 一次最多发给几个会话。 */
export const FORWARD_MAX_TARGETS = 9
/** 一次最多转发几条。 */
export const FORWARD_MAX_MESSAGES = 50

/** 可以转发到的一处：已有的会话，或者还没有会话的好友（选了再创建）。 */
interface Target {
  key: string
  name: string
  avatar: ReactNode
  conversationId?: string
  friendId?: string
}

/** 这个会话现在能不能发消息：好友的单聊、和自己的对话、我还在的没有解散的群。 */
function sendable(conversation: ConversationView): boolean {
  if (conversation.group) return !conversation.group.left && !conversation.group.dissolved
  return conversation.peer?.is_friend === true
}

interface ForwardDialogProps {
  /** 要转发的消息。 */
  messages: readonly MessageView[]
  /** 合并转发：把这几条做成的聊天记录。没有它就是逐条转发。 */
  record?: ChatRecordView
  onDone: () => void
  onCancel: () => void
}

/**
 * 选择转发到哪里：最近的会话在前，后面是还没有会话的好友。可以搜索、可以多选。
 * 确定之后每个会话里按原来的先后一条一条发出去；合并转发时每个会话里发一条聊天记录。
 */
export function ForwardDialog({ messages, record, onDone, onCancel }: ForwardDialogProps) {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const me = useMe()
  const store = useChatStore()
  const conversations = useChatState((state) => state.conversations) ?? []
  const friends = useQuery(friendsQuery).data ?? []
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [sending, setSending] = useState(false)

  const targets: Target[] = []
  const withConversation = new Set<string>()
  for (const conversation of conversations) {
    if (!sendable(conversation)) continue
    if (conversation.peer) withConversation.add(conversation.peer.user.id)
    targets.push({
      key: conversation.id,
      name: displayName(conversation, t),
      avatar: <ConversationAvatar conversation={conversation} size={32} />,
      conversationId: conversation.id,
    })
  }
  for (const friend of friends) {
    if (withConversation.has(friend.user.id)) continue
    targets.push({
      key: `friend-${friend.user.id}`,
      name: friendName(friend),
      avatar: <Avatar user={friend.user as UserCard} size={32} />,
      friendId: friend.user.id,
    })
  }
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? targets.filter((target) => target.name.toLowerCase().includes(needle))
    : targets
  const full = chosen.length >= FORWARD_MAX_TARGETS

  function toggle(key: string) {
    setChosen((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : current.length >= FORWARD_MAX_TARGETS
          ? current
          : [...current, key],
    )
  }

  async function send() {
    setSending(true)
    try {
      const ids: string[] = []
      for (const key of chosen) {
        const target = targets.find((item) => item.key === key)
        if (!target) continue
        // 还没有会话的好友：先打开和他的会话
        ids.push(target.conversationId ?? (await store.openDirect(target.friendId ?? me.id)))
      }
      if (record) store.forwardMerged(ids, messages, record)
      else store.forward(ids, messages)
      toast.success(t('forward.done'))
      onDone()
    } catch (error) {
      toast.error(errorMessage(error))
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('forward.search')}
        aria-label={t('forward.search')}
        className="h-11 w-full rounded-control border border-border bg-bg px-3 text-fg placeholder:text-fg-3 md:h-10"
      />
      <ul
        data-testid="forward-targets"
        aria-label={t('forward.targets')}
        className="-mx-2 max-h-[50vh] min-h-24 overflow-auto"
      >
        {shown.length === 0 && (
          <li className="px-2 py-6 text-center text-fg-3">{t('forward.none')}</li>
        )}
        {shown.map((target) => {
          const selected = chosen.includes(target.key)
          return (
            <li key={target.key}>
              <label
                data-testid="forward-target"
                className={`flex h-12 w-full items-center gap-3 rounded-control px-2 hover:bg-hover ${
                  !selected && full ? 'opacity-40' : 'cursor-pointer'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={!selected && full}
                  onChange={() => toggle(target.key)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className={`grid size-5 flex-none place-items-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
                    selected ? 'border-accent bg-accent text-on-accent' : 'border-border'
                  }`}
                >
                  {selected && <Check size={14} strokeWidth={2} />}
                </span>
                {target.avatar}
                <span className="min-w-0 flex-1 truncate">{target.name}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12px] text-fg-3">
          {t('forward.chosen', { count: chosen.length })}
          {full && ` · ${t('forward.maxTargets', { max: FORWARD_MAX_TARGETS })}`}
        </span>
        <Button variant="ghost" onClick={onCancel}>
          {tCommon('actions.cancel')}
        </Button>
        <Button onClick={() => void send()} disabled={chosen.length === 0 || sending}>
          {t('forward.send')}
        </Button>
      </div>
    </div>
  )
}
