import { useMutation, useQuery } from '@tanstack/react-query'
import { canManage, formatMessageTime, listJoinRequests } from '@vibechat/core'
import type { ConversationView, JoinRequestView } from '@vibechat/protocol'
import { useTranslation } from 'react-i18next'
import { useChatState, useChatStore } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { useErrorMessage } from '../../errors'
import { usePreferences } from '../../preferences'
import { useMe } from '../../session'
import { toast } from '../../toast'

/**
 * 一个群的入群申请：谁邀请了谁、什么时候、现在怎么样。群主和管理员看到全部，
 * 待处理的可以同意或拒绝；其他人看到自己发出的。新的在前。
 */
export function JoinRequests({ conversation }: { conversation: ConversationView }) {
  const { t } = useTranslation('chats')
  const errorMessage = useErrorMessage()
  const me = useMe()
  const store = useChatStore()
  const language = usePreferences((state) => state.language)
  // 申请变了（推送来的，或者自己刚处理了一条）就重新取
  const version = useChatState((state) => state.joinRequests[conversation.id] ?? 0)
  const requests = useQuery({
    queryKey: ['join-requests', conversation.id, version],
    queryFn: ({ signal }) => listJoinRequests(conversation.id, { signal }),
  })
  const manager = canManage(conversation, me.id)

  const handle = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      store.handleJoinRequest(conversation.id, id, approve),
    onSuccess: (_, { approve }) =>
      toast.success(approve ? t('joinRequests.approved') : t('joinRequests.rejected')),
    onError: (error) => toast.error(errorMessage(error)),
  })

  if (requests.isError) {
    return (
      <p role="alert" className="text-danger">
        {errorMessage(requests.error)}
      </p>
    )
  }
  if (!requests.data) return <div className="h-24" />
  if (requests.data.length === 0) {
    return <p className="py-6 text-center text-fg-3">{t('joinRequests.none')}</p>
  }

  const now = Date.now()
  const status = (request: JoinRequestView) => {
    const label = t(`joinRequests.${request.status}`)
    return request.handled_by_name
      ? t('joinRequests.handledBy', { status: label, name: request.handled_by_name })
      : label
  }

  return (
    <ul data-testid="join-requests" className="-mx-2 flex max-h-[60vh] flex-col overflow-auto">
      {requests.data.map((request) => (
        <li
          key={request.id}
          data-testid="join-request"
          data-status={request.status}
          className="flex items-center gap-3 rounded-control px-2 py-2"
        >
          <Avatar user={request.invitee} size={36} />
          <div className="min-w-0 flex-1">
            <p className="truncate">
              {t('joinRequests.invitedBy', {
                inviter: request.inviter.nickname,
                invitee: request.invitee.nickname,
              })}
            </p>
            <p className="truncate text-[12px] text-fg-3">
              {formatMessageTime(request.created_at, now, language)}
              {request.status !== 'pending' || !manager ? ` · ${status(request)}` : ''}
            </p>
          </div>
          {manager && request.status === 'pending' && (
            <div className="flex flex-none gap-1">
              <Button
                variant="ghost"
                onClick={() => handle.mutate({ id: request.id, approve: false })}
                disabled={handle.isPending}
              >
                {t('joinRequests.reject')}
              </Button>
              <Button
                variant="primary"
                onClick={() => handle.mutate({ id: request.id, approve: true })}
                disabled={handle.isPending}
              >
                {t('joinRequests.approve')}
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
