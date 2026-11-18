// 聊天的状态在页面里的入口：登录后创建一份，跟着服务端的推送更新。

import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type ChatState,
  ChatStore,
  changesGroup,
  EMPTY_THREAD,
  fetchLimits,
  listGroups,
  type Thread,
  TypingTracker,
} from '@vibechat/core'
import type { ConversationView, LimitsView, MemberView } from '@vibechat/protocol'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { useConnectionState, useRealtime } from './realtime'
import { outbox, useMe } from './session'

/** 我所在的全部群。通讯录里的"群聊"用。 */
export const groupsQuery = queryOptions({
  queryKey: ['groups'] as const,
  queryFn: ({ signal }) => listGroups({ signal }),
  // 每次打开都取最新的
  staleTime: 0,
})

/** 当前生效的几项上限：文件大小、语音时长、撤回时限。管理员改了之后过一会儿才会跟上。 */
export const limitsQuery = queryOptions({
  queryKey: ['limits'] as const,
  queryFn: ({ signal }) => fetchLimits({ signal }),
  staleTime: 5 * 60 * 1000,
})

/** 还没有取回来时先用的上限，和服务端的默认值一样。服务端总会再检查一遍。 */
const DEFAULT_LIMITS: LimitsView = {
  file_max_bytes: 100 * 1024 * 1024,
  voice_max_seconds: 60,
  recall_window_seconds: 120,
  edit_window_seconds: 24 * 60 * 60,
  group_call_max: 6,
}

export function useLimits(): LimitsView {
  return useQuery(limitsQuery).data ?? DEFAULT_LIMITS
}

const ChatContext = createContext<ChatStore | null>(null)
const TypingContext = createContext<TypingTracker | null>(null)

/** 登录期间维持一份聊天状态。退出登录时它随页面框架一起丢弃，不会留给下一个登录的人。 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const me = useMe()
  const realtime = useRealtime()
  const connection = useConnectionState()
  const queryClient = useQueryClient()
  const [store] = useState(() => new ChatStore({ me: me.id, outbox }))
  // 谁在哪个会话里输入（F8）
  const [typing] = useState(
    () => new TypingTracker({ me: me.id, send: (id) => realtime.typing(id) }),
  )
  useEffect(() => realtime.onEvent((event) => typing.handleEvent(event)), [realtime, typing])
  useEffect(() => () => typing.dispose(), [typing])

  // 不等连接建立就先取一次，页面能早一点显示出来
  useEffect(() => {
    store.loadConversations().catch(() => {})
  }, [store])

  useEffect(
    () =>
      realtime.onEvent((event) => {
        store.handleEvent(event)
        // 会话列表里显示的是对方的名称和头像：好友的资料、备注变了，或者不再是好友了，都要跟着变
        if (
          event.type === 'contact.friend' ||
          event.type === 'contact.friend_removed' ||
          event.type === 'contact.profile'
        ) {
          store.loadConversations().catch(() => {})
          // 群成员名单里也有"是不是好友"和备注
          for (const id of Object.keys(store.getState().members)) {
            store.loadMembers(id).catch(() => {})
          }
        }
        // 进了一个群、离开了一个群、群改了名：通讯录里"群聊"那一份要重新取
        if (event.type === 'msg.new' && changesGroup(event.data)) {
          void queryClient.invalidateQueries({ queryKey: groupsQuery.queryKey })
        }
      }),
    [realtime, store, queryClient],
  )

  // 连接建立之前和断开期间的推送都收不到。每次连上（包括第一次：上面那次取数据可能赶在了
  // 连接建立之前）都把列表重新取一遍，把打开过的会话里缺的消息补回来
  useEffect(() => {
    if (connection === 'open') store.resync().catch(() => {})
  }, [connection, store])

  return (
    <ChatContext value={store}>
      <TypingContext value={typing}>{children}</TypingContext>
    </ChatContext>
  )
}

export function useTypingTracker(): TypingTracker {
  const typing = useContext(TypingContext)
  if (!typing) throw new Error('useTypingTracker must be used inside ChatProvider')
  return typing
}

/** 这个会话里正在输入的人（F8），按开始输入的先后。 */
export function useTyping(id: string): readonly string[] {
  const typing = useTypingTracker()
  return useSyncExternalStore(typing.subscribe, () => typing.typingIn(id))
}

/** 聊天状态本身，用来发消息、打开会话等。 */
export function useChatStore(): ChatStore {
  const store = useContext(ChatContext)
  if (!store) throw new Error('useChatStore must be used inside ChatProvider')
  return store
}

/** 聊天状态里的一部分；它变了页面才重新显示。`select` 要返回状态里现成的值，不要现造对象。 */
export function useChatState<T>(select: (state: ChatState) => T): T {
  const store = useChatStore()
  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}

/** 一个会话：在列表里的，或者单独取回来过的。 */
export function useConversation(id: string): ConversationView | undefined {
  return useChatState(
    (state) => state.conversations?.find((item) => item.id === id) ?? state.unlisted[id],
  )
}

export function useThread(id: string): Thread {
  return useChatState((state) => state.threads[id] ?? EMPTY_THREAD)
}

/** 一个群的成员名单，包括已经离开的。还没有取回来时是 undefined。 */
export function useMembers(id: string): MemberView[] | undefined {
  return useChatState((state) => state.members[id])
}
