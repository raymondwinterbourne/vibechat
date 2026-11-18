import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../chat'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { TextField } from '../../components/TextField'
import { useErrorMessage } from '../../errors'
import { toast } from '../../toast'
import { FriendPicker } from './FriendPicker'
import { GROUP_NAME_MAX_CHARS } from './text'

/** 一个群除了创建者至少还要有这么多人。 */
const MIN_OTHERS = 2

interface CreateGroupDialogProps {
  open: boolean
  onClose: () => void
  /** 从和某个好友的单聊里发起：他一定在群里，只需要再选别人。 */
  withFriend?: string
}

/** 发起群聊：勾选好友，填群名（可以不填）。 */
export function CreateGroupDialog({ open, onClose, withFriend }: CreateGroupDialogProps) {
  const { t } = useTranslation('chats')
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()} title={t('create.title')}>
      {/* 内容只在打开时存在：每次打开都是空白的 */}
      <CreateGroup onClose={onClose} withFriend={withFriend} />
    </Dialog>
  )
}

function CreateGroup({ onClose, withFriend }: Omit<CreateGroupDialogProps, 'open'>) {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const navigate = useNavigate()
  const store = useChatStore()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])

  // 正在聊天的那一位排在最前面：事件里的顺序就是这里的顺序
  const others = withFriend ? [withFriend, ...picked] : picked
  const enough = others.length >= MIN_OTHERS

  const create = useMutation({
    mutationFn: () => store.createGroup(name.trim(), others),
    onSuccess: async (conversationId) => {
      onClose()
      await navigate({ to: '/chats/$conversationId', params: { conversationId } })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (enough) create.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        label={t('create.name')}
        placeholder={t('create.namePlaceholder')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={GROUP_NAME_MAX_CHARS}
      />
      <div className="flex flex-col gap-1.5">
        <p className="text-[12px] text-fg-2">{t('create.pick')}</p>
        <FriendPicker
          selected={picked}
          onChange={setPicked}
          taken={withFriend ? new Set([withFriend]) : undefined}
          takenLabel={t('picker.inChat')}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <p className="min-w-0 flex-1 text-[12px] text-fg-3">
          {enough
            ? t('create.selected', { count: others.length })
            : withFriend
              ? t('create.hintOneMore')
              : t('create.hint')}
        </p>
        <Button variant="ghost" onClick={onClose}>
          {tCommon('actions.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={!enough || create.isPending}>
          {t('create.submit')}
        </Button>
      </div>
    </form>
  )
}
