import type { ConversationView } from '@vibechat/protocol'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../chat'
import { useErrorMessage } from '../../errors'
import { toast } from '../../toast'

/** 群内昵称最多多少个字。和服务端的上限一致。 */
export const GROUP_NICKNAME_MAX_CHARS = 20

interface GroupNicknameRowProps {
  conversation: ConversationView
  /** 我现在的群内昵称。 */
  current: string | null
  /** 没有群内昵称时，群里显示的是什么：我的昵称。 */
  fallback: string
}

/**
 * 群信息里的"我在本群的昵称"：点一下原地变成输入框，回车或点别处保存，Esc 放弃。
 * 留空就是去掉，群里显示回我的昵称。
 */
export function GroupNicknameRow({ conversation, current, fallback }: GroupNicknameRowProps) {
  const { t } = useTranslation('chats')
  const [editing, setEditing] = useState(false)
  return (
    <div className="flex items-center gap-3 border-border border-b px-4 py-2">
      <span className="flex-none">{t('nickname.label')}</span>
      <div className="flex min-w-0 flex-1 justify-end">
        {editing ? (
          <Editor
            conversation={conversation}
            current={current ?? ''}
            fallback={fallback}
            onDone={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            data-testid="group-nickname"
            onClick={() => setEditing(true)}
            className={`-mx-1 min-w-0 truncate rounded-control px-1 text-right hover:bg-hover max-md:min-h-11 ${
              current ? '' : 'text-fg-3'
            }`}
          >
            {current || t('nickname.unset')}
          </button>
        )}
      </div>
    </div>
  )
}

function Editor({
  conversation,
  current,
  fallback,
  onDone,
}: {
  conversation: ConversationView
  current: string
  fallback: string
  onDone: () => void
}) {
  const { t } = useTranslation('chats')
  const errorMessage = useErrorMessage()
  const store = useChatStore()
  const [value, setValue] = useState(current)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // 按 Esc 放弃了：输入框随后消失时不要再保存
  const cancelled = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  async function save() {
    if (cancelled.current || saving) return
    const next = value.trim()
    if (next === current) {
      onDone()
      return
    }
    setSaving(true)
    try {
      await store.setGroupNickname(conversation.id, next)
      toast.success(t('nickname.saved'))
    } catch (error) {
      toast.error(errorMessage(error))
    }
    onDone()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // 用输入法打字时，回车是在选字
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      // 不让 Esc 再关掉整个群信息
      event.stopPropagation()
      cancelled.current = true
      onDone()
    }
  }

  return (
    <input
      ref={input}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void save()}
      readOnly={saving}
      maxLength={GROUP_NICKNAME_MAX_CHARS}
      aria-label={t('nickname.label')}
      placeholder={fallback}
      data-testid="group-nickname-input"
      className="h-9 w-full rounded-control border border-border bg-bg px-2 text-right text-fg placeholder:text-fg-3 max-md:h-11"
    />
  )
}
