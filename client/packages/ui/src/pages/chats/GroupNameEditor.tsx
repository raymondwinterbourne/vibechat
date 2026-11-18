import type { ConversationView } from '@vibechat/protocol'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../chat'
import { useErrorMessage } from '../../errors'
import { toast } from '../../toast'
import { displayName, GROUP_NAME_MAX_CHARS } from './text'

interface GroupNameEditorProps {
  conversation: ConversationView
  /** 保存了，或者放弃了。 */
  onDone: () => void
  testId: string
  className?: string
}

/** 群主点了群名：它原地变成输入框。回车或点别处保存，Esc 放弃。 */
export function GroupNameEditor({
  conversation,
  onDone,
  testId,
  className = '',
}: GroupNameEditorProps) {
  const { t } = useTranslation('chats')
  const errorMessage = useErrorMessage()
  const store = useChatStore()
  const current = conversation.group?.name ?? ''
  const [name, setName] = useState(current)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // 按 Esc 放弃了：输入框随后消失时不要再保存
  const cancelled = useRef(false)

  // 一出现就可以直接打字，原来的名称整个选中
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  async function save() {
    if (cancelled.current || saving) return
    const next = name.trim()
    if (next === current) {
      onDone()
      return
    }
    setSaving(true)
    try {
      await store.renameGroup(conversation.id, next)
      toast.success(t('group.renamed'))
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
      cancelled.current = true
      onDone()
    }
  }

  // 留空时群会显示成什么
  const unnamed = conversation.group
    ? displayName({ ...conversation, group: { ...conversation.group, name: null } }, t)
    : ''

  return (
    <input
      ref={input}
      value={name}
      onChange={(event) => setName(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void save()}
      readOnly={saving}
      maxLength={GROUP_NAME_MAX_CHARS}
      aria-label={t('group.name')}
      placeholder={unnamed}
      data-testid={testId}
      className={`rounded-control border border-border bg-bg px-2 font-medium text-fg placeholder:font-normal placeholder:text-fg-3 ${className}`}
    />
  )
}
