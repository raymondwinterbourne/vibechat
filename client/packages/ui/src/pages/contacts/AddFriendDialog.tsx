import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { acceptFriendRequest, lookupUser, sendFriendRequest } from '@vibechat/core'
import type { FriendRequestResult, UserLookup } from '@vibechat/protocol'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { TextField } from '../../components/TextField'
import { useContactsCache } from '../../contacts'
import { useErrorMessage } from '../../errors'
import { useMe } from '../../session'
import { toast } from '../../toast'

const MESSAGE_MAX_CHARS = 50

interface AddFriendDialogProps {
  open: boolean
  onClose: () => void
}

/** 添加好友：按 ID 查找，再发申请。 */
export function AddFriendDialog({ open, onClose }: AddFriendDialogProps) {
  const { t } = useTranslation('contacts')
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()} title={t('add.title')}>
      {/* 内容只在打开时存在：每次打开都是空白的，不留着上一次查找的结果 */}
      <AddFriend onClose={onClose} />
    </Dialog>
  )
}

function AddFriend({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('contacts')
  const errorMessage = useErrorMessage()
  const [handle, setHandle] = useState('')

  const find = useMutation({ mutationFn: (handle: string) => lookupUser(handle) })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (handle.trim()) find.mutate(handle.trim())
  }

  return (
    <>
      <form onSubmit={onSubmit} className="flex items-end gap-2">
        <TextField
          label={t('add.handle')}
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          autoFocus
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={find.isPending || !handle.trim()}>
          {t('add.find')}
        </Button>
      </form>
      {find.isError && (
        <p role="alert" className="text-danger">
          {errorMessage(find.error)}
        </p>
      )}
      {find.data && (
        // 换了一个人就换一份状态：验证信息之类不带到下一个人身上
        <Found key={find.data.user.id} found={find.data} onClose={onClose} />
      )}
    </>
  )
}

/** 找到的人，以及按他和我的关系能做的事。 */
function Found({ found, onClose }: { found: UserLookup; onClose: () => void }) {
  const { t } = useTranslation('contacts')
  const errorMessage = useErrorMessage()
  const navigate = useNavigate()
  const me = useMe()
  const cache = useContactsCache()
  const { user, relation } = found
  const [message, setMessage] = useState(t('add.defaultMessage', { nickname: me.nickname }))

  function settled(result: FriendRequestResult) {
    cache.storeRequest(result.request)
    if (result.friend) {
      cache.storeFriend(result.friend)
      toast.success(t('requests.nowFriends', { name: user.nickname }))
    } else {
      toast.success(t('add.sent'))
    }
    onClose()
  }

  const send = useMutation({
    mutationFn: () => sendFriendRequest(user.id, message),
    onSuccess: settled,
    onError: (error) => toast.error(errorMessage(error)),
  })

  const accept = useMutation({
    mutationFn: (requestId: string) => acceptFriendRequest(requestId),
    onSuccess: settled,
    onError: (error) => toast.error(errorMessage(error)),
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    send.mutate()
  }

  async function viewProfile() {
    onClose()
    await navigate({ to: '/contacts/$userId', params: { userId: user.id } })
  }

  const canRequest = relation === 'none' || relation === 'request_sent'

  return (
    <div data-testid="lookup-result" className="flex flex-col gap-4 border-border border-t pt-4">
      <div className="flex items-center gap-3">
        <Avatar user={user} size={44} />
        <div className="min-w-0">
          <p className="truncate font-medium">{user.nickname}</p>
          <p className="truncate font-mono text-[12px] text-fg-2">{user.handle}</p>
        </div>
      </div>

      {relation === 'myself' && <p className="text-fg-2">{t('add.myself')}</p>}

      {relation === 'friend' && (
        <>
          <p className="text-fg-2">{t('add.alreadyFriend')}</p>
          <div className="flex justify-end">
            <Button onClick={viewProfile}>{t('add.viewProfile')}</Button>
          </div>
        </>
      )}

      {relation === 'request_received' && found.request_id && (
        <>
          <p className="text-fg-2">{t('add.theyAsked')}</p>
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => found.request_id && accept.mutate(found.request_id)}
              disabled={accept.isPending}
            >
              {t('requests.accept')}
            </Button>
          </div>
        </>
      )}

      {canRequest && (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {relation === 'request_sent' && <p className="text-fg-2">{t('add.alreadySent')}</p>}
          <TextField
            label={t('add.message')}
            placeholder={t('add.messagePlaceholder')}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={MESSAGE_MAX_CHARS}
          />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={send.isPending}>
              {relation === 'request_sent' ? t('add.sendAgain') : t('add.send')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
