import { useMutation } from '@tanstack/react-query'
import { canManage } from '@vibechat/core'
import type { ConversationView, MemberView } from '@vibechat/protocol'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../chat'
import { Button } from '../../components/Button'
import { useErrorMessage } from '../../errors'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { FriendPicker } from './FriendPicker'

interface InviteProps {
  conversation: ConversationView
  members: readonly MemberView[]
  onClose: () => void
}

/** 邀请好友入群。已经在群里的不能再选；人数到上限时说明原因。 */
export function Invite({ conversation, members, onClose }: InviteProps) {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const store = useChatStore()
  const [picked, setPicked] = useState<string[]>([])

  const group = conversation.group
  const room = group ? Math.max(0, group.max_members - group.member_count) : 0
  const taken = new Set(members.filter((member) => member.active).map((member) => member.user.id))

  const me = useMe()
  // 开着入群审批、我是普通成员：邀请的人要等群主或管理员同意
  const asking = Boolean(group?.join_approval) && !canManage(conversation, me.id)
  const invite = useMutation({
    mutationFn: () => store.invite(conversation.id, picked),
    onSuccess: (requested) => {
      toast.success(requested > 0 ? t('joinRequests.sent') : t('invite.done'))
      onClose()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (picked.length > 0 && picked.length <= room) invite.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {asking && (
        <p data-testid="invite-approval" className="text-[12px] text-fg-2">
          {t('joinRequests.inviteHint')}
        </p>
      )}
      <FriendPicker selected={picked} onChange={setPicked} taken={taken} disabled={room === 0} />
      <div className="flex items-center justify-end gap-2">
        <p
          data-testid="invite-room"
          className={`min-w-0 flex-1 text-[12px] ${
            room === 0 || picked.length > room ? 'text-danger' : 'text-fg-3'
          }`}
        >
          {room === 0
            ? t('invite.full', { max: group?.max_members ?? 0 })
            : picked.length > room
              ? t('invite.tooMany', { count: room })
              : t('invite.room', { count: room })}
        </p>
        <Button variant="ghost" onClick={onClose}>
          {tCommon('actions.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={picked.length === 0 || picked.length > room || invite.isPending}
        >
          {t('invite.submit')}
        </Button>
      </div>
    </form>
  )
}
