import { useMutation, useQuery } from '@tanstack/react-query'
import { acceptFriendRequest, rejectFriendRequest } from '@vibechat/core'
import type { FriendRequestResult, FriendRequestView } from '@vibechat/protocol'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { SegmentedControl } from '../../components/SegmentedControl'
import { friendRequestsQuery, useContactsCache } from '../../contacts'
import { useErrorMessage } from '../../errors'
import { toast } from '../../toast'
import { PaneHeader } from './PaneHeader'

type Direction = FriendRequestView['direction']

function RequestRow({ request }: { request: FriendRequestView }) {
  const { t } = useTranslation('contacts')
  const errorMessage = useErrorMessage()
  const cache = useContactsCache()
  const name = request.user.nickname

  function settled(result: FriendRequestResult) {
    cache.storeRequest(result.request)
    if (result.friend) {
      cache.storeFriend(result.friend)
      toast.success(t('requests.nowFriends', { name }))
    }
  }
  // 失败多半是因为它刚在别处被处理掉了：重新取一遍，显示真实的状态
  function failed(error: unknown) {
    toast.error(errorMessage(error))
    cache.refetchAll()
  }

  const accept = useMutation({
    mutationFn: () => acceptFriendRequest(request.id),
    onSuccess: settled,
    onError: failed,
  })
  const reject = useMutation({
    mutationFn: () => rejectFriendRequest(request.id),
    onSuccess: settled,
    onError: failed,
  })
  const busy = accept.isPending || reject.isPending
  const canHandle = request.direction === 'received' && request.status === 'pending'

  return (
    <li
      data-testid="friend-request"
      data-status={request.status}
      className="flex items-center gap-3 border-border border-b py-3"
    >
      <Avatar user={request.user} size={40} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="truncate">{name}</span>
          <span className="truncate font-mono text-[12px] text-fg-3">{request.user.handle}</span>
        </span>
        {request.message && (
          <span className="truncate text-[12px] text-fg-2">{request.message}</span>
        )}
      </div>
      {canHandle ? (
        <>
          <Button
            variant="ghost"
            onClick={() => reject.mutate()}
            disabled={busy}
            aria-label={t('requests.rejectFrom', { name })}
            className="px-3"
          >
            {t('requests.reject')}
          </Button>
          <Button
            variant="primary"
            onClick={() => accept.mutate()}
            disabled={busy}
            aria-label={t('requests.acceptFrom', { name })}
            className="px-3"
          >
            {t('requests.accept')}
          </Button>
        </>
      ) : (
        <span className="flex-none text-[12px] text-fg-2">
          {t(`requests.status.${request.status}`)}
        </span>
      )}
    </li>
  )
}

/** 新的朋友：收到的和发出的好友申请。 */
export function RequestsPane() {
  const { t } = useTranslation('contacts')
  const errorMessage = useErrorMessage()
  const requests = useQuery(friendRequestsQuery)
  const [direction, setDirection] = useState<Direction>('received')
  const shown = (requests.data ?? []).filter((request) => request.direction === direction)

  return (
    <div className="flex h-full flex-col">
      <PaneHeader title={t('requests.title')} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex min-h-full max-w-[640px] flex-col px-4 md:px-8">
          <div className="border-border border-b py-3">
            <SegmentedControl
              label={t('requests.kind')}
              value={direction}
              options={[
                { value: 'received', label: t('requests.received') },
                { value: 'sent', label: t('requests.sent') },
              ]}
              onChange={setDirection}
            />
          </div>
          {requests.isError ? (
            <LoadError
              message={errorMessage(requests.error)}
              onRetry={() => void requests.refetch()}
            />
          ) : !requests.data ? (
            <ListSkeleton rows={3} />
          ) : shown.length === 0 ? (
            <div className="h-40">
              <EmptyState
                hint={
                  direction === 'received'
                    ? t('requests.noneReceivedHint')
                    : t('requests.noneSentHint')
                }
              >
                {direction === 'received' ? t('requests.noneReceived') : t('requests.noneSent')}
              </EmptyState>
            </div>
          ) : (
            <ul>
              {shown.map((request) => (
                <RequestRow key={request.id} request={request} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
