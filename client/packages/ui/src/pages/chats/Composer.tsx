import { type Mentions, memberName, publicName } from '@vibechat/core'
import type { MemberView } from '@vibechat/protocol'
import { Check, Mic, Paperclip, Pencil, SendHorizontal, Smile, Users, X } from 'lucide-react'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { hasEscapeLayer, useEscapeLayer } from '../../escape'
import { StagedCard, type StagedFile } from './attachments'
import { EMOJI } from './emoji'
import { mentionQueryAt } from './mentions'
import { VoiceRecorder } from './VoiceRecorder'

const MAX_CHARS = 4000
/** 输入框最多长到这么高，再多就在里面滚动。 */
const MAX_HEIGHT = 160

const ICON_BUTTON =
  'grid size-11 flex-none place-items-center rounded-control text-fg-2 transition-colors duration-150 md:size-9'

/** 群里可以 @ 谁。 */
export interface Mentionable {
  /** 除我以外、现在在群的成员。 */
  members: readonly MemberView[]
  /** 能不能 @ 所有人。只有群主可以。 */
  all: boolean
}

/** @ 的候选项：一个成员，或者"所有人"。 */
type Candidate = { member: MemberView } | { all: true }

/** 正在回复的那条消息，显示在输入框上方。 */
export interface Replying {
  /** 被引用的人显示成什么名字。 */
  name: string | null
  /** 被引用内容的一行摘要。 */
  summary: string
}

/** 外面可以让输入区做的事。 */
export interface ComposerHandle {
  /**
   * 把一段文字放回输入框（撤回了一条消息之后）。输入框里已经有字的话接在后面。
   * `mentions` 是这段文字当初 @ 了谁，按现在的昵称认回来，再发时仍然算 @ 了他们。
   */
  restore: (text: string, mentions?: Mentions) => void
  /**
   * 开始编辑一条消息（F8）：输入框换成它的文字，原来打了一半的先收起来，编辑完放回去。
   * `mentions` 是它 @ 了谁，按现在的昵称认回来。
   */
  startEdit: (text: string, mentions?: Mentions) => void
  /** 编辑结束（保存了或者取消了）：放回原来打了一半的。 */
  endEdit: () => void
}

interface ComposerProps {
  ref?: Ref<ComposerHandle>
  /** 点了发送。文字可能是空的：这时只发下面这些选好的文件。 */
  onSend: (text: string, mentions?: Mentions) => void
  /** 选好了、还没有发出去的文件，显示在输入框上方。 */
  staged: readonly StagedFile[]
  /** 选了、粘贴了文件：先放着，点发送才发出去。 */
  onStage: (files: File[]) => void
  /** 把其中一个拿掉。 */
  onUnstage: (id: number) => void
  onSendVoice: (recording: Blob, durationMs: number) => void
  /** 一条语音最长多少秒。 */
  voiceMaxSeconds: number
  /** 在群里才有：输入"@"时弹出成员列表。 */
  mentionable?: Mentionable
  replying?: Replying | null
  onCancelReply?: () => void
  /** 正在编辑一条消息（F8）：输入框上方一条提示，回车保存，Esc 取消。 */
  editing?: { summary: string; allowEmpty: boolean } | null
  onSaveEdit?: (text: string, mentions?: Mentions) => void
  onCancelEdit?: () => void
  /** 电脑上输入框是空的时候按 ↑：编辑自己发的最后一条（F8 Q7）。 */
  onEditLast?: () => void
  /** 在输入框里打了字（F8）：告诉对方"正在输入"。编辑消息时不算。 */
  onTyping?: () => void
}

/**
 * 输入区：输入框随内容增高；电脑上回车发送、Shift 加回车换行，手机上回车换行、点按钮发送。
 * 旁边是表情、文件、语音三个入口；文件也可以直接粘贴进来。
 * 选的、粘贴的文件不会马上发出去：先排在输入框上方，可以接着打字，点发送时一起发。
 */
export function Composer({
  ref,
  onSend,
  staged,
  onStage,
  onUnstage,
  onSendVoice,
  voiceMaxSeconds,
  mentionable,
  replying,
  onCancelReply,
  editing,
  onSaveEdit,
  onCancelEdit,
  onEditLast,
  onTyping,
}: ComposerProps) {
  const { t } = useTranslation('chats')
  const [text, setText] = useState('')
  const [recordingVoice, setRecordingVoice] = useState(false)
  const filePicker = useRef<HTMLInputElement>(null)
  const [picking, setPicking] = useState(false)
  // 光标的位置：用来判断是不是正在打一个 @
  const [caret, setCaret] = useState(0)
  // 从列表里选过的人，以及插进文字里的"@昵称"。发送时文字里还留着的才算数
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [allToken, setAllToken] = useState<string | null>(null)
  // 按 Esc 关掉了哪一个"@"的列表；光标离开它之后再打一个才会重新弹出
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  // 用手指操作的设备上没有 Shift 键，回车只能用来换行
  const [touch] = useState(() => window.matchMedia('(pointer: coarse)').matches)

  // 输入框的高度跟着内容走
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容变了才需要重新量高度
  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  // 插入表情或 @ 的名字之后，光标要放到插入的内容后面。必须赶在下一次按键之前放好：
  // 晚一步的话，接着打的字已经进去了，光标再被挪回来，后面的字就插到了它前面
  const caretAfterUpdate = useRef<number | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容更新到输入框之后才能放光标
  useLayoutEffect(() => {
    const position = caretAfterUpdate.current
    if (position === null) return
    caretAfterUpdate.current = null
    input.current?.focus()
    input.current?.setSelectionRange(position, position)
  }, [text])

  // 点表情面板外面或按 Esc 关闭
  const closePicker = useCallback(() => setPicking(false), [])
  useEscapeLayer(picking, closePicker)
  useEffect(() => {
    if (!picking) return
    function onPointerDown(event: PointerEvent) {
      if (!picker.current?.contains(event.target as Node)) setPicking(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [picking])

  // 进入会话后可以直接打字。用手指操作的设备上不这样做：一聚焦键盘就弹出来，挡住半个屏幕
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在进入会话时做一次
  useEffect(() => {
    if (!touch) input.current?.focus()
  }, [])

  // ---------- @ ----------

  const typing = mentionable ? mentionQueryAt(text, caret) : null
  const candidates: Candidate[] = []
  if (mentionable && typing && typing.start !== dismissed) {
    const query = typing.query.toLowerCase()
    if (mentionable.all && t('mention.all').toLowerCase().includes(query)) {
      candidates.push({ all: true })
    }
    for (const member of mentionable.members) {
      const names = [memberName(member), publicName(member), member.user.nickname]
      if (names.some((name) => name.toLowerCase().includes(query))) candidates.push({ member })
    }
  }
  const mentioning = candidates.length > 0
  const highlighted = Math.min(active, candidates.length - 1)

  /** 把正在打的"@…"换成选中的人。文字里写的是他的群内昵称（没有就是昵称）：备注只有我自己看得到。 */
  function choose(candidate: Candidate) {
    if (!typing) return
    const token = `@${'all' in candidate ? t('mention.all') : publicName(candidate.member)}`
    const before = text.slice(0, typing.start)
    const next = `${before}${token} ${text.slice(caret)}`
    const position = before.length + token.length + 1
    caretAfterUpdate.current = position
    setText(next)
    setCaret(position)
    setActive(0)
    if ('all' in candidate) setAllToken(token)
    else setChosen({ ...chosen, [candidate.member.user.id]: token })
  }

  // 有文字或者有选好的文件，才有东西可发。编辑时只看文字：图片的说明可以删光
  const sendable = editing
    ? editing.allowEmpty || text.trim() !== ''
    : text.trim() !== '' || staged.length > 0
  // 开始编辑之前打了一半的：编辑完放回去
  const draftBeforeEdit = useRef<{
    text: string
    chosen: Record<string, string>
    all: string | null
  } | null>(null)

  /** 按现在的昵称把"@昵称"认回来；改过名的认不出，再发时就只是普通的文字。 */
  function recognized(mentions: Mentions, base: Record<string, string>) {
    const picked: Record<string, string> = { ...base }
    for (const member of mentionable?.members ?? []) {
      if (mentions.users.includes(member.user.id)) picked[member.user.id] = `@${publicName(member)}`
    }
    return picked
  }

  useImperativeHandle(ref, () => ({
    restore: (restored, restoredMentions) => {
      const next = text.trim() === '' ? restored : `${text}\n${restored}`
      caretAfterUpdate.current = next.length
      setText(next)
      setCaret(next.length)
      if (!restoredMentions) return
      setChosen(recognized(restoredMentions, chosen))
      if (restoredMentions.all) setAllToken(`@${t('mention.all')}`)
    },
    startEdit: (edited, editedMentions) => {
      if (!draftBeforeEdit.current) draftBeforeEdit.current = { text, chosen, all: allToken }
      caretAfterUpdate.current = edited.length
      setText(edited)
      setCaret(edited.length)
      setChosen(editedMentions ? recognized(editedMentions, {}) : {})
      setAllToken(editedMentions?.all ? `@${t('mention.all')}` : null)
      setDismissed(null)
    },
    endEdit: () => {
      const draft = draftBeforeEdit.current
      draftBeforeEdit.current = null
      caretAfterUpdate.current = draft?.text.length ?? 0
      setText(draft?.text ?? '')
      setCaret(draft?.text.length ?? 0)
      setChosen(draft?.chosen ?? {})
      setAllToken(draft?.all ?? null)
    },
  }))

  function send() {
    if (!sendable) return
    const users = Object.entries(chosen)
      .filter(([, token]) => text.includes(token))
      .map(([id]) => id)
    const all = allToken !== null && text.includes(allToken)
    const mentions = users.length > 0 || all ? { users, all } : undefined
    if (editing) {
      // 输入框里的内容在编辑结束（endEdit）时换回去
      onSaveEdit?.(text, mentions)
      return
    }
    onSend(text, mentions)
    setText('')
    setCaret(0)
    setChosen({})
    setAllToken(null)
    setDismissed(null)
    input.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 用输入法打字时，回车和方向键是在选字。Safari 在选字结束的那一下才报 229
    const composing = event.nativeEvent.isComposing || event.keyCode === 229
    if (mentioning && !composing) {
      const candidate = candidates[highlighted]
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((highlighted + step + candidates.length) % candidates.length)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && candidate) {
        event.preventDefault()
        choose(candidate)
        return
      }
      if (event.key === 'Escape' && typing) {
        event.preventDefault()
        setDismissed(typing.start)
        return
      }
    }
    // 有菜单、面板开着时，Esc 先关它们；都关了再按才是取消编辑、取消引用
    if (event.key === 'Escape' && editing && !composing && !hasEscapeLayer()) {
      event.preventDefault()
      onCancelEdit?.()
      return
    }
    // 电脑上输入框是空的时候按 ↑：编辑自己发的最后一条
    if (
      event.key === 'ArrowUp' &&
      text === '' &&
      !editing &&
      !touch &&
      !composing &&
      onEditLast &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      event.preventDefault()
      onEditLast()
      return
    }
    if (event.key === 'Escape' && replying && !composing && !hasEscapeLayer()) {
      event.preventDefault()
      onCancelReply?.()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || touch || composing) return
    event.preventDefault()
    send()
  }

  /** 把表情插在光标的位置。 */
  function insert(emoji: string) {
    const element = input.current
    const start = element?.selectionStart ?? text.length
    const end = element?.selectionEnd ?? text.length
    caretAfterUpdate.current = start + emoji.length
    setText(text.slice(0, start) + emoji + text.slice(end))
    setCaret(start + emoji.length)
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    // 清空选择，这样再次选同一个文件也会触发
    event.target.value = ''
    if (files.length > 0) onStage(files)
  }

  /** 粘贴的是文件（截图、从文件夹里复制的文件）就放到输入框上方；是文字就照常粘贴。 */
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    event.preventDefault()
    onStage(files)
  }

  // 放进来了文件（选的、粘贴的、拖进来的）：光标回到输入框，可以接着打字，或者直接按回车发送
  useEffect(() => {
    if (staged.length > 0) input.current?.focus()
  }, [staged.length])

  // 选了要回复的消息：光标回到输入框，可以直接打字
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了一条要回复的消息时才需要
  useEffect(() => {
    if (replying) input.current?.focus()
  }, [replying?.summary, replying?.name])

  if (recordingVoice) {
    return (
      <VoiceRecorder
        maxSeconds={voiceMaxSeconds}
        onCancel={() => setRecordingVoice(false)}
        onSend={(recording, durationMs) => {
          setRecordingVoice(false)
          onSendVoice(recording, durationMs)
        }}
      />
    )
  }

  return (
    // 手机上会话占满整屏，输入区贴着屏幕底部：避开系统的手势区域
    <div className="relative flex flex-none flex-wrap items-end gap-1 border-border border-t p-2 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))] md:p-3">
      {editing && (
        <div
          data-testid="editing"
          className="flex w-full items-center gap-2 rounded-control bg-surface py-1 pr-1 pl-3 text-[12px] text-fg-2"
        >
          <Pencil size={14} strokeWidth={1.5} aria-hidden className="flex-none" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{t('editing.title')}</span>
            {': '}
            {editing.summary}
          </span>
          <button
            type="button"
            onClick={onCancelEdit}
            aria-label={t('editing.cancel')}
            title={t('editing.cancel')}
            className="grid size-7 flex-none place-items-center rounded-control hover:bg-hover hover:text-fg max-md:-my-2 max-md:size-11"
          >
            <X size={16} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      )}
      {replying && !editing && (
        <div
          data-testid="replying"
          className="flex w-full items-center gap-2 rounded-control bg-surface py-1 pr-1 pl-3 text-[12px] text-fg-2"
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">
              {t('quote.replyingTo', { name: replying.name ?? '' })}
            </span>
            {': '}
            {replying.summary}
          </span>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label={t('quote.cancel')}
            title={t('quote.cancel')}
            className="grid size-7 flex-none place-items-center rounded-control hover:bg-hover hover:text-fg max-md:-my-2 max-md:size-11"
          >
            <X size={16} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      )}
      {staged.length > 0 && (
        <ul
          data-testid="staged"
          aria-label={t('composer.staged')}
          className="flex w-full gap-2 overflow-x-auto pb-1"
        >
          {staged.map(({ id, file }) => (
            <StagedCard key={id} file={file} onRemove={() => onUnstage(id)} />
          ))}
        </ul>
      )}
      {mentioning && (
        <div
          role="listbox"
          aria-label={t('mention.label')}
          data-testid="mention-list"
          className="absolute right-2 bottom-full left-2 z-20 mb-1 max-h-56 overflow-auto rounded-card border border-border bg-bg p-1 shadow-float md:right-auto md:w-64"
        >
          {candidates.map((candidate, index) => {
            const key = 'all' in candidate ? 'all' : candidate.member.user.id
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                data-testid="mention-option"
                // 点的时候输入框不能失去焦点，否则光标的位置就丢了
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(candidate)}
                onPointerEnter={() => setActive(index)}
                className="flex h-11 w-full items-center gap-2 rounded-control px-2 text-left aria-selected:bg-hover md:h-9"
              >
                {'all' in candidate ? (
                  <>
                    <span className="grid size-6 flex-none place-items-center rounded-card bg-accent text-on-accent">
                      <Users size={14} strokeWidth={1.5} aria-hidden />
                    </span>
                    <span data-testid="mention-name" className="min-w-0 flex-1 truncate">
                      {t('mention.all')}
                    </span>
                  </>
                ) : (
                  <>
                    <Avatar user={candidate.member.user} size={24} />
                    <span data-testid="mention-name" className="min-w-0 flex-1 truncate">
                      {memberName(candidate.member)}
                    </span>
                  </>
                )}
              </button>
            )
          })}
        </div>
      )}
      <div ref={picker} className="flex">
        <button
          type="button"
          onClick={() => setPicking(!picking)}
          aria-label={t('composer.emoji')}
          aria-expanded={picking}
          title={t('composer.emoji')}
          className={`${ICON_BUTTON} hover:bg-hover hover:text-fg`}
        >
          <Smile size={20} strokeWidth={1.5} aria-hidden />
        </button>
        {picking && (
          <div
            data-testid="emoji-panel"
            className="absolute bottom-full left-2 z-20 mb-1 grid w-[min(336px,calc(100%-16px))] grid-cols-8 rounded-card border border-border bg-bg p-2 shadow-float"
          >
            {EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => insert(emoji)}
                className="grid aspect-square place-items-center rounded-control text-[20px] hover:bg-hover"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 编辑时只改文字：不能加文件、录语音 */}
      {!editing && (
        <button
          type="button"
          onClick={() => filePicker.current?.click()}
          aria-label={t('composer.file')}
          title={t('composer.file')}
          className={`${ICON_BUTTON} hover:bg-hover hover:text-fg`}
        >
          <Paperclip size={20} strokeWidth={1.5} aria-hidden />
        </button>
      )}
      <input
        ref={filePicker}
        type="file"
        multiple
        onChange={onPick}
        data-testid="file-input"
        className="hidden"
      />
      {!editing && (
        <button
          type="button"
          onClick={() => setRecordingVoice(true)}
          aria-label={t('voice.record')}
          title={t('voice.record')}
          className={`${ICON_BUTTON} hover:bg-hover hover:text-fg`}
        >
          <Mic size={20} strokeWidth={1.5} aria-hidden />
        </button>
      )}
      <textarea
        ref={input}
        rows={1}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setCaret(event.target.selectionStart)
          if (event.target.value.trim() !== '' && !editing) onTyping?.()
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        maxLength={MAX_CHARS}
        aria-label={t('composer.label')}
        placeholder={t('composer.placeholder')}
        className="min-h-11 min-w-0 flex-1 resize-none rounded-control border border-border bg-bg px-3 py-[9px] text-fg placeholder:text-fg-3 md:min-h-9 md:py-[7px]"
      />
      <button
        type="button"
        onClick={send}
        disabled={!sendable}
        aria-label={editing ? t('editing.save') : t('composer.send')}
        title={editing ? t('editing.save') : t('composer.send')}
        className={`${ICON_BUTTON} bg-accent text-on-accent hover:opacity-90 disabled:opacity-40`}
      >
        {editing ? (
          <Check size={18} strokeWidth={1.5} aria-hidden />
        ) : (
          <SendHorizontal size={18} strokeWidth={1.5} aria-hidden />
        )}
      </button>
    </div>
  )
}
