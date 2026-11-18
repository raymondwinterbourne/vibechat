import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  acceptFriendRequest,
  fetchMemberProfile,
  groupRole,
  MUTE_MINUTES,
  sendFriendRequest,
} from '@vibechat/core'
import type { ConversationView, FriendRequestResult, MemberProfile } from '@vibechat/protocol'
import { MessageCircle, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, useMembers } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { useContactsCache } from '../../contacts'
import { useErrorMessage } from '../../errors'
import { useMe } from '../../session'
import { toast } from '../../toast'

interface MemberProps {
  conversation: ConversationView
  userId: string
  onClose: () => void
}

/** 群里一个成员的资料，以及按他和我的关系能做的事。 */
export function Member({ conversation, userId, onClose }: MemberProps) {
  const errorMessage = useErrorMessage()
  const profile = useQuery({
    queryKey: ['member-profile', conversation.id, userId],
    queryFn: ({ signal }) => fetchMemberProfile(conversation.id, userId, { signal }),
    // 关系随时会变，每次打开都取最新的
    staleTime: 0,
    gcTime: 0,
  })

  if (profile.isError) {
    return (
      <p role="alert" className="text-danger">
        {errorMessage(profile.error)}
      </p>
    )
  }
  if (!profile.data) return <div className="h-32" />
  return (
    <Profile
      conversation={conversation}
      profile={profile.data}
      refresh={() => void profile.refetch()}
      onClose={onClose}
    />
  )
}

interface ProfileProps {
  conversation: ConversationView
  profile: MemberProfile
  refresh: () => void
  onClose: () => void
}

function Profile({ conversation, profile, refresh, onClose }: ProfileProps) {
  const { t } = useTranslation('chats')
  const { t: tContacts } = useTranslation('contacts')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const navigate = useNavigate()
  const me = useMe()
  const store = useChatStore()
  const cache = useContactsCache()
  // 移出和转让都要先确认；禁言要先选时长
  const [confirming, setConfirming] = useState<'remove' | 'transfer' | 'mute' | null>(null)
  const members = useMembers(conversation.id)

  const { user, relation } = profile
  const name = profile.remark || user.nickname
  const role = groupRole(conversation, me.id)
  const target = members?.find((member) => member.user.id === user.id)
  const targetIsAdmin = target?.is_admin === true
  // 群主可以移出任何人；管理员只能移出普通成员
  const canRemove =
    relation !== 'myself' &&
    (role === 'owner' || (role === 'admin' && !target?.is_owner && !targetIsAdmin))
  // 群主和管理员可以禁言普通成员
  const canMute =
    role !== 'member' &&
    relation !== 'myself' &&
    target !== undefined &&
    !target.is_owner &&
    !targetIsAdmin
  const targetMuted =
    target?.muted_until !== null &&
    target?.muted_until !== undefined &&
    target.muted_until > Date.now()
  const failed = (error: unknown) => toast.error(errorMessage(error))

  const chat = useMutation({
    mutationFn: () => store.openDirect(user.id),
    onSuccess: async (conversationId) => {
      onClose()
      await navigate({ to: '/chats/$conversationId', params: { conversationId } })
    },
    onError: failed,
  })

  function settled(result: FriendRequestResult) {
    cache.storeRequest(result.request)
    if (result.friend) {
      cache.storeFriend(result.friend)
      toast.success(tContacts('requests.nowFriends', { name: user.nickname }))
    } else {
      toast.success(tContacts('add.sent'))
    }
    refresh()
  }

  const request = useMutation({
    mutationFn: () =>
      sendFriendRequest(user.id, tContacts('add.defaultMessage', { nickname: me.nickname })),
    onSuccess: settled,
    onError: failed,
  })

  const accept = useMutation({
    mutationFn: (requestId: string) => acceptFriendRequest(requestId),
    onSuccess: settled,
    onError: failed,
  })

  const remove = useMutation({
    mutationFn: () => store.removeMember(conversation.id, user.id),
    onSuccess: () => {
      toast.success(t('member.removed'))
      onClose()
    },
    onError: failed,
  })

  // 设为还是取消，按点下去那一刻的：成功时名单已经更新过了
  const appoint = useMutation({
    mutationFn: (admin: boolean) => store.setAdmin(conversation.id, user.id, admin),
    onSuccess: (_, admin) => {
      toast.success(admin ? t('member.adminAdded') : t('member.adminRemoved'))
      onClose()
    },
    onError: failed,
  })

  const mute = useMutation({
    mutationFn: (minutes: number | null) => store.muteMember(conversation.id, user.id, minutes),
    onSuccess: () => {
      toast.success(t('silence.done'))
      onClose()
    },
    onError: failed,
  })

  const unmute = useMutation({
    mutationFn: () => store.unmuteMember(conversation.id, user.id),
    onSuccess: () => {
      toast.success(t('silence.lifted'))
      onClose()
    },
    onError: failed,
  })

  const transfer = useMutation({
    mutationFn: () => store.transferOwner(conversation.id, user.id),
    onSuccess: () => {
      toast.success(t('member.transferred'))
      onClose()
    },
    onError: failed,
  })

  if (confirming === 'mute') {
    return (
      <div data-testid="mute-durations" className="flex flex-col gap-3">
        <p className="text-fg-2">{t('silence.choose')}</p>
        <div className="flex flex-col gap-1">
          {[...MUTE_MINUTES, null].map((minutes) => (
            <Button
              key={minutes ?? 'forever'}
              variant="ghost"
              onClick={() => mute.mutate(minutes)}
              disabled={mute.isPending}
              className="justify-start"
            >
              {minutes === null ? t('silence.forever') : t(`silence.minutes_${minutes}`)}
            </Button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => setConfirming(null)}>
            {tCommon('actions.cancel')}
          </Button>
        </div>
      </div>
    )
  }

  if (confirming) {
    const action = confirming === 'remove' ? remove : transfer
    return (
      <>
        <p className="text-fg-2">
          {confirming === 'remove'
            ? t('member.removeExplain', { name })
            : t('member.transferExplain', { name })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirming(null)}>
            {tCommon('actions.cancel')}
          </Button>
          <Button
            variant={confirming === 'remove' ? 'danger' : 'primary'}
            onClick={() => action.mutate()}
            disabled={action.isPending}
          >
            {t('member.confirm')}
          </Button>
        </div>
      </>
    )
  }

  return (
    <div data-testid="member-profile" className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Avatar user={user} size={56} />
        <div className="min-w-0">
          <p data-testid="member-profile-name" className="break-words font-medium text-[17px]">
            {name}
          </p>
          {profile.remark && (
            <p className="truncate text-[12px] text-fg-2">
              {tContacts('friend.nickname')}: {user.nickname}
            </p>
          )}
        </div>
      </div>
      <dl>
        <div className="flex gap-4 py-1.5">
          <dt className="w-20 flex-none text-fg-2">{tContacts('friend.handle')}</dt>
          <dd className="min-w-0 flex-1 select-all break-all font-mono">{user.handle}</dd>
        </div>
        <div className="flex gap-4 py-1.5">
          <dt className="w-20 flex-none text-fg-2">{tContacts('friend.signature')}</dt>
          <dd className={`min-w-0 flex-1 break-words ${profile.signature ? '' : 'text-fg-3'}`}>
            {profile.signature || tContacts('friend.noSignature')}
          </dd>
        </div>
      </dl>

      {relation === 'request_sent' && <p className="text-fg-2">{t('member.requestSent')}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        {canRemove && (
          <Button variant="danger" onClick={() => setConfirming('remove')}>
            {t('member.remove')}
          </Button>
        )}
        {canMute &&
          (targetMuted ? (
            <Button onClick={() => unmute.mutate()} disabled={unmute.isPending}>
              {t('silence.lift')}
            </Button>
          ) : (
            <Button onClick={() => setConfirming('mute')}>{t('silence.member')}</Button>
          ))}
        {role === 'owner' && relation !== 'myself' && (
          <>
            <Button onClick={() => appoint.mutate(!targetIsAdmin)} disabled={appoint.isPending}>
              {targetIsAdmin ? t('member.unsetAdmin') : t('member.setAdmin')}
            </Button>
            <Button onClick={() => setConfirming('transfer')}>{t('member.transfer')}</Button>
          </>
        )}
        {relation === 'friend' && (
          <Button variant="primary" onClick={() => chat.mutate()} disabled={chat.isPending}>
            <MessageCircle size={16} strokeWidth={1.5} aria-hidden />
            {tContacts('friend.sendMessage')}
          </Button>
        )}
        {relation === 'none' && (
          <Button variant="primary" onClick={() => request.mutate()} disabled={request.isPending}>
            <UserPlus size={16} strokeWidth={1.5} aria-hidden />
            {t('member.addFriend')}
          </Button>
        )}
        {relation === 'request_received' && profile.request_id && (
          <Button
            variant="primary"
            onClick={() => profile.request_id && accept.mutate(profile.request_id)}
            disabled={accept.isPending}
          >
            {t('member.acceptRequest')}
          </Button>
        )}
      </div>
    </div>
  )
}
