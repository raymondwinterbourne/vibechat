import type { ConversationView } from '@vibechat/protocol'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { displayName } from './text'

/** 会话的头像：单聊是对方的头像；群是群头像，没有设置时显示群名的第一个字。 */
export function ConversationAvatar({
  conversation,
  size,
}: {
  conversation: ConversationView
  size: number
}) {
  const { t } = useTranslation('chats')
  const { peer, group } = conversation
  if (peer) return <Avatar user={peer.user} size={size} />
  if (!group) return null
  return (
    <Avatar
      user={{
        id: conversation.id,
        nickname: displayName(conversation, t),
        avatar_file_id: group.avatar_file_id,
      }}
      size={size}
    />
  )
}
