import { useMutation, useQuery } from '@tanstack/react-query'
import { Navigate, useNavigate, useParams } from '@tanstack/react-router'
import { friendName, removeFriend, setFriendRemark } from '@vibechat/core'
import type { FriendView } from '@vibechat/protocol'
import { MessageCircle, Pencil, Trash2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { TextField } from '../../components/TextField'
import { friendsQuery, useContactsCache } from '../../contacts'
import { useErrorMessage } from '../../errors'
import { toast } from '../../toast'
import { PaneHeader } from './PaneHeader'

const REMARK_MAX_CHARS = 32

function RemarkDialog({ friend, onClose }: { friend: FriendView; onClose: () => void }) {
  const { t } = useTranslation('contacts')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const cache = useContactsCache()
  const [remark, setRemark] = useState(friend.remark ?? '')

  const save = useMutation({
    mutationFn: () => setFriendRemark(friend.user.id, remark),
    onSuccess: (updated) => {
      cache.storeFriend(updated)
      toast.success(tCommon('saved'))
      onClose()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        label={t('friend.remark')}
        hint={t('friend.remarkHint')}
        value={remark}
        onChange={(event) => setRemark(event.target.value)}
        maxLength={REMARK_MAX_CHARS}
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {tCommon('actions.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {tCommon('actions.save')}
        </Button>
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex gap-4 py-2">
      <dt className="w-20 flex-none text-fg-2">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  )
}

function Profile({ friend }: { friend: FriendView }) {
  const { t } = useTranslation('contacts')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const navigate = useNavigate()
  const cache = useContactsCache()
  const chatStore = useChatStore()
  const [dialog, setDialog] = useState<'remark' | 'remove' | null>(null)
  const name = friendName(friend)

  // 打开和他的会话。还没有聊过的话，这时才创建
  const chat = useMutation({
    mutationFn: () => chatStore.openDirect(friend.user.id),
    onSuccess: (conversationId) =>
      navigate({ to: '/chats/$conversationId', params: { conversationId } }),
    onError: (error) => toast.error(errorMessage(error)),
  })

  const remove = useMutation({
    mutationFn: () => removeFriend(friend.user.id),
    onSuccess: async () => {
      toast.success(t('friend.removed'))
      cache.dropFriend(friend.user.id)
      await navigate({ to: '/contacts' })
    },
    onError: (error) => {
      toast.error(errorMessage(error))
      setDialog(null)
      cache.refetchAll()
    },
  })

  return (
    <div data-testid="friend-profile" className="mx-auto flex max-w-[480px] flex-col px-4 md:px-8">
      <div className="flex items-center gap-4 border-border border-b py-6">
        <Avatar user={friend.user} size={64} />
        <p data-testid="friend-name" className="min-w-0 break-words font-medium text-[20px]">
          {name}
        </p>
      </div>
      <dl className="border-border border-b py-3">
        {/* 有备注时名字显示的是备注，昵称另外列出来 */}
        {friend.remark && <Field label={t('friend.nickname')}>{friend.user.nickname}</Field>}
        <div className="flex gap-4 py-2">
          <dt className="w-20 flex-none text-fg-2">{t('friend.handle')}</dt>
          <dd className="min-w-0 flex-1 select-all break-all font-mono">{friend.user.handle}</dd>
        </div>
        <div className="flex gap-4 py-2">
          <dt className="w-20 flex-none text-fg-2">{t('friend.signature')}</dt>
          <dd className={`min-w-0 flex-1 break-words ${friend.signature ? '' : 'text-fg-3'}`}>
            {friend.signature || t('friend.noSignature')}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2 py-5">
        <Button variant="primary" onClick={() => chat.mutate()} disabled={chat.isPending}>
          <MessageCircle size={16} strokeWidth={1.5} aria-hidden />
          {t('friend.sendMessage')}
        </Button>
        <Button onClick={() => setDialog('remark')}>
          <Pencil size={16} strokeWidth={1.5} aria-hidden />
          {t('friend.setRemark')}
        </Button>
        <Button variant="danger" onClick={() => setDialog('remove')}>
          <Trash2 size={16} strokeWidth={1.5} aria-hidden />
          {t('friend.remove')}
        </Button>
      </div>

      <Dialog
        open={dialog === 'remark'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('friend.setRemark')}
      >
        <RemarkDialog friend={friend} onClose={() => setDialog(null)} />
      </Dialog>
      <Dialog
        open={dialog === 'remove'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('friend.removeTitle')}
      >
        <p className="text-fg-2">{t('friend.removeExplain', { name })}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDialog(null)}>
            {tCommon('actions.cancel')}
          </Button>
          <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {t('friend.remove')}
          </Button>
        </div>
      </Dialog>
    </div>
  )
}

/** 一位好友的资料。 */
export function FriendPane() {
  const { t } = useTranslation('contacts')
  const { userId } = useParams({ strict: false })
  const friends = useQuery(friendsQuery)
  const friend = friends.data?.find((candidate) => candidate.user.id === userId)

  // 不是好友（地址是手输的，或者刚刚被对方删除了）：回到列表
  if (friends.data && !friend) return <Navigate to="/contacts" replace />

  return (
    <div className="flex h-full flex-col">
      <PaneHeader title={t('friend.title')} />
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 换一位好友就换一份状态，打开着的对话框不会带过去 */}
        {friend && <Profile key={friend.user.id} friend={friend} />}
      </div>
    </div>
  )
}
