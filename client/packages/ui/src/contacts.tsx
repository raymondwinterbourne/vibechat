// 通讯录的数据：好友列表和好友申请放在查询缓存里，随服务端的推送更新。

import { type QueryKey, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  applyFriendProfile,
  countPendingReceived,
  dropFriend,
  listFriendRequests,
  listFriends,
  upsertFriend,
  upsertFriendRequest,
} from '@vibechat/core'
import type { FriendRequestView, FriendView } from '@vibechat/protocol'
import { useEffect, useRef } from 'react'
import { useConnectionState, useRealtime } from './realtime'

export const friendsQuery = queryOptions({
  queryKey: ['friends'] as const,
  queryFn: ({ signal }) => listFriends({ signal }),
  // 变化由推送带来，重新连上时整个重新取一遍，不需要定时刷新
  staleTime: Number.POSITIVE_INFINITY,
})

export const friendRequestsQuery = queryOptions({
  queryKey: ['friend-requests'] as const,
  queryFn: ({ signal }) => listFriendRequests({ signal }),
  staleTime: Number.POSITIVE_INFINITY,
})

/** 我还没有处理的好友申请有几个。 */
export function usePendingRequestCount(): number {
  const { data } = useQuery({ ...friendRequestsQuery, select: countPendingReceived })
  return data ?? 0
}

/** 把一次操作或推送带来的变化放进好友列表、申请列表。 */
export function useContactsCache() {
  const queryClient = useQueryClient()

  function patch<T>(key: QueryKey, change: (current: T) => T) {
    if (queryClient.getQueryData(key) === undefined) {
      // 列表还没有取回来，没有东西可改。正在路上的那一份可能不含这次变化，取完再取一次
      void queryClient.invalidateQueries({ queryKey: key })
      return
    }
    queryClient.setQueryData<T>(key, (current) =>
      current === undefined ? current : change(current),
    )
  }
  const friends = (change: (current: FriendView[]) => FriendView[]) =>
    patch(friendsQuery.queryKey, change)
  const requests = (change: (current: FriendRequestView[]) => FriendRequestView[]) =>
    patch(friendRequestsQuery.queryKey, change)

  return {
    storeFriend: (friend: FriendView) => friends((list) => upsertFriend(list, friend)),
    dropFriend: (userId: string) => friends((list) => dropFriend(list, userId)),
    storeRequest: (request: FriendRequestView) =>
      requests((list) => upsertFriendRequest(list, request)),
    friends,
    requests,
    refetchAll: () => {
      void queryClient.invalidateQueries({ queryKey: friendsQuery.queryKey })
      void queryClient.invalidateQueries({ queryKey: friendRequestsQuery.queryKey })
    },
  }
}

/** 让好友列表和申请列表跟着服务端的推送变。不显示任何东西。 */
export function ContactsSync() {
  const realtime = useRealtime()
  const connection = useConnectionState()
  const cache = useContactsCache()
  // 每次渲染都换成最新的，订阅本身不用跟着重来
  const latest = useRef(cache)
  latest.current = cache

  useEffect(
    () =>
      realtime.onEvent((event) => {
        const cache = latest.current
        switch (event.type) {
          case 'contact.request':
            cache.storeRequest(event.data)
            break
          case 'contact.friend':
            cache.storeFriend(event.data)
            break
          case 'contact.friend_removed':
            cache.dropFriend(event.data.user_id)
            break
          case 'contact.profile': {
            const profile = event.data
            cache.friends((list) => applyFriendProfile(list, profile))
            // 申请列表里的对方也可能就是他
            cache.requests((list) =>
              list.map((request) =>
                request.user.id === profile.user.id ? { ...request, user: profile.user } : request,
              ),
            )
            break
          }
        }
      }),
    [realtime],
  )

  // 连接建立之前和断开期间的推送都收不到。每次连上（包括第一次：列表可能在连接建立之前
  // 就取回来了）都把两个列表整个重新取一遍
  useEffect(() => {
    if (connection === 'open') latest.current.refetchAll()
  }, [connection])

  return null
}
