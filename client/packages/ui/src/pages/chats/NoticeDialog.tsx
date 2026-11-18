import { useMutation } from '@tanstack/react-query'
import { formatMessageTime } from '@vibechat/core'
import type { ConversationView } from '@vibechat/protocol'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../chat'
import { Button } from '../../components/Button'
import { useErrorMessage } from '../../errors'
import { usePreferences } from '../../preferences'
import { toast } from '../../toast'

/** 群公告最多多少个字，和服务端一致。 */
const NOTICE_MAX_CHARS = 1000

interface NoticeViewProps {
  conversation: ConversationView
  /** 群主才能编辑。 */
  canEdit: boolean
  onClose: () => void
}

/**
 * 群公告的对话框内容：看全文；群主可以编辑、发布、清空。
 * 没有公告时，群主直接进入编辑。
 */
export function NoticeView({ conversation, canEdit, onClose }: NoticeViewProps) {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const language = usePreferences((state) => state.language)
  const errorMessage = useErrorMessage()
  const store = useChatStore()
  const notice = conversation.group?.notice ?? null
  const [editing, setEditing] = useState(canEdit && !notice)
  const [draft, setDraft] = useState(notice?.text ?? '')
  const [clearing, setClearing] = useState(false)

  const save = useMutation({
    mutationFn: (text: string) => store.setNotice(conversation.id, text),
    onSuccess: (_, text) => {
      toast.success(text.trim() ? t('groupNotice.saved') : t('groupNotice.cleared'))
      onClose()
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  if (clearing) {
    return (
      <>
        <p className="text-fg-2">{t('groupNotice.clearExplain')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setClearing(false)}>
            {tCommon('actions.cancel')}
          </Button>
          <Button variant="danger" onClick={() => save.mutate('')} disabled={save.isPending}>
            {t('groupNotice.clear')}
          </Button>
        </div>
      </>
    )
  }

  if (editing) {
    const length = [...draft.trim()].length
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate(draft)
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={NOTICE_MAX_CHARS}
          rows={6}
          // biome-ignore lint/a11y/noAutofocus: 打开编辑就是要写公告
          autoFocus
          aria-label={t('groupNotice.title')}
          placeholder={t('groupNotice.placeholder')}
          data-testid="notice-input"
          className="min-h-32 w-full resize-y rounded-control border border-border bg-bg px-3 py-2 text-fg placeholder:text-fg-3"
        />
        {/* 手机上放不下一行：字数单独一行，按钮在下面 */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="basis-full text-[12px] text-fg-3 md:flex-1 md:basis-auto">
            {t('groupNotice.count', { count: length, max: NOTICE_MAX_CHARS })}
          </span>
          {notice && (
            <Button type="button" variant="ghost" onClick={() => setClearing(true)}>
              {t('groupNotice.clear')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => (notice ? setEditing(false) : onClose())}
          >
            {tCommon('actions.cancel')}
          </Button>
          <Button type="submit" disabled={length === 0 || save.isPending}>
            {t('groupNotice.save')}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {notice ? (
        <>
          <p
            data-testid="notice-text"
            className="max-h-[50vh] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {notice.text}
          </p>
          <p className="text-[12px] text-fg-3">
            {t('groupNotice.by', {
              name: notice.by_name ?? '',
              time: formatMessageTime(notice.at, Date.now(), language),
            })}
          </p>
        </>
      ) : (
        <p className="text-fg-3">{t('groupNotice.empty')}</p>
      )}
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing(true)}>{t('groupNotice.edit')}</Button>
        </div>
      )}
    </div>
  )
}
