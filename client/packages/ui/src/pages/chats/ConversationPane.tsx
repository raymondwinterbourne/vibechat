import { Link, Navigate, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  ApiError,
  canManage,
  formatFileSize,
  isForwardable,
  type Mentions,
  MUTED_FOREVER,
  memberName,
  silenced,
} from '@vibechat/core'
import type { ChatRecordView, ConversationView, MessageView } from '@vibechat/protocol'
import {
  ChevronLeft,
  Megaphone,
  MoreHorizontal,
  Phone,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react'
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCallController, useCallsAvailable, VIDEO_DESKTOP_VERSION } from '../../calls'
import {
  useChatStore,
  useConversation,
  useLimits,
  useMembers,
  useThread,
  useTyping,
  useTypingTracker,
} from '../../chat'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { Menu } from '../../components/Menu'
import { useDesktopRequirement } from '../../desktopClient'
import { useErrorMessage } from '../../errors'
import { useEscapeLayer } from '../../escape'
import { useFileUrls } from '../../files'
import { useInAnyCall } from '../../groupCalls'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { looksLikeImage, type StagedFile } from './attachments'
import { Composer, type ComposerHandle } from './Composer'
import { ConversationSearch } from './ConversationSearch'
import { CreateGroupDialog } from './CreateGroupDialog'
import { FORWARD_MAX_MESSAGES, ForwardDialog } from './ForwardDialog'
import { GroupCallBanner, GroupCallButton } from './GroupCallEntry'
import { GroupNameEditor } from './GroupNameEditor'
import { GroupPanel } from './GroupPanel'
import { MediaPanel } from './MediaPanel'
import { Member } from './MemberDialog'
import { editable, MessageList } from './MessageList'
import { NoticeView } from './NoticeDialog'
import { contentLabel, displayName, formatSpan } from './text'

/** 语音、视频通话：只有和好友的单聊里能打。打不了的时候是灰色，说明原因。 */
function CallStartButton({
  conversation,
  video,
}: {
  conversation: ConversationView | undefined
  video: boolean
}) {
  const { t } = useTranslation('chats')
  const controller = useCallController()
  const available = useCallsAvailable()
  const peer = conversation?.peer
  const reason = !available
    ? t('call.unavailable')
    : !peer || peer.is_self || !peer.is_friend
      ? t('call.notFriend')
      : null
  // 已经在一个通话里了（一对一的或者群里的）：这个按钮先不能用
  const inCall = useInAnyCall()
  const desktopAllows = useDesktopRequirement()
  const disabled = reason !== null || inCall
  const label = video ? t('header.videoCall') : t('header.voiceCall')
  const Icon = video ? Video : Phone
  return (
    <span title={reason ?? label} className="flex">
      <button
        type="button"
        data-testid={video ? 'video-call' : 'voice-call'}
        disabled={disabled}
        aria-label={label}
        onClick={() => {
          if (!conversation) return
          // 旧版本的桌面端不放行摄像头：先说明要更新
          if (video && !desktopAllows(label, VIDEO_DESKTOP_VERSION)) return
          void controller.start(conversation.id, { video })
        }}
        className="grid size-11 place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent md:size-9"
      >
        <Icon size={20} strokeWidth={1.5} aria-hidden />
      </button>
    </span>
  )
}

/** 拖进来的是不是文件（而不是页面上的一段文字或一张图）。 */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

interface ConversationProps {
  id: string
  /** 打开时要跳到的那条消息（从搜索结果点进来的）。 */
  focusSeq?: number
  /** 打开时就在这个会话里搜这个词（从全局搜索点"查看全部"进来的）。 */
  find?: string
}

function Conversation({ id, focusSeq, find }: ConversationProps) {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const navigate = useNavigate()
  const store = useChatStore()
  const conversation = useConversation(id)
  const thread = useThread(id)
  const members = useMembers(id)
  const me = useMe()
  const typing = useTypingTracker()
  const typers = useTyping(id)
  const limits = useLimits()
  // 正在回复的那条消息
  const [replyTo, setReplyTo] = useState<MessageView | null>(null)
  // 正在编辑的那条自己的消息（F8）
  const [editing, setEditing] = useState<MessageView | null>(null)
  // 选好了、还没有发出去的文件。和输入框里的文字一样，换一个会话就没有了
  const [staged, setStaged] = useState<StagedFile[]>([])
  const nextStagedId = useRef(1)
  const composer = useRef<ComposerHandle>(null)
  const urls = useFileUrls()
  // 有文件正拖在会话上方。进进出出里面的元素时事件会成对地来，所以用数的
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  // 右侧的面板：群信息，或者查找聊天记录。一次只开一个
  const [panel, setPanelState] = useState<'group' | 'search' | 'media' | null>(
    find ? 'search' : null,
  )
  const panelOpen = panel === 'group'
  // 打开面板之前焦点在哪里：关掉之后回到那里
  const opener = useRef<HTMLElement | null>(null)
  const pane = useRef<HTMLDivElement>(null)
  const setPanel = useCallback((next: 'group' | 'search' | 'media' | null) => {
    if (next) {
      opener.current = document.activeElement as HTMLElement | null
    } else {
      // 打开它的按钮还在就回到按钮上，否则（它是菜单里的一项，已经不在了）回到输入框
      const back = opener.current?.isConnected
        ? opener.current
        : pane.current?.querySelector('textarea')
      window.setTimeout(() => back?.focus())
    }
    setPanelState(next)
  }, [])
  const setPanelOpen = (open: boolean) => setPanel(open ? 'group' : null)
  const closePanel = useCallback(() => setPanel(null), [setPanel])
  useEscapeLayer(panel !== null, closePanel)
  // 正在看谁的资料（群里点了他的头像）
  const [profileOf, setProfileOf] = useState<string | null>(null)
  // 要跳到的那条消息。同一条可以跳第二次，所以带一个每次都不同的记号
  const [focus, setFocus] = useState(
    focusSeq === undefined ? undefined : { seq: focusSeq, token: 0 },
  )
  const [addingPeople, setAddingPeople] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // 打不开的原因：没有这个会话（或者我不在里面），或者只是这一次没取到
  const [problem, setProblem] = useState<'missing' | 'failed' | null>(null)
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 变了就重新取一次
  useEffect(() => {
    let current = true
    setProblem(null)
    store
      .ensureConversation(id)
      .then(() => store.openThread(id))
      .catch((error) => {
        if (!current) return
        const missing = error instanceof ApiError && error.code === 'conversation_not_found'
        setProblem(missing ? 'missing' : 'failed')
      })
    return () => {
      current = false
    }
  }, [store, id, attempt])

  async function togglePin() {
    try {
      await store.pin(id, conversation?.pinned_at == null)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  async function toggleMute() {
    const muted = !(conversation?.muted ?? false)
    try {
      await store.mute(id, muted)
      toast.success(muted ? t('mute.saved') : t('mute.cleared'))
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  /** 点了消息旁边的头像：群里看成员资料，单聊里看好友资料。 */
  function showProfile(userId: string) {
    if (conversation?.group) setProfileOf(userId)
    else void navigate({ to: '/contacts/$userId', params: { userId } })
  }

  async function hide() {
    try {
      await store.hide(id)
      await navigate({ to: '/chats' })
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  // 被禁言时的倒计时：隔一会儿更新一次，到时间的那一刻再更新一次，输入区自己回来
  const [now, setNow] = useState(() => Date.now())
  const mutedUntil = conversation?.group?.muted_until ?? null
  useEffect(() => {
    setNow(Date.now())
    if (mutedUntil === null || mutedUntil >= MUTED_FOREVER) return
    const tick = window.setInterval(() => setNow(Date.now()), 15_000)
    const end = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, mutedUntil - Date.now()) + 50,
    )
    return () => {
      window.clearInterval(tick)
      window.clearTimeout(end)
    }
  }, [mutedUntil])

  // 多选：勾上了哪几条（序号）。不在多选时为空
  const [selected, setSelected] = useState<ReadonlySet<number> | null>(null)
  // 要转发的消息：选好了，正在选发给谁。合并转发时带着拼好的聊天记录
  const [forwarding, setForwarding] = useState<{
    messages: MessageView[]
    record?: ChatRecordView
  } | null>(null)
  const stopSelecting = useCallback(() => setSelected(null), [])
  // 要从我这边删掉的几条（等确认），清空聊天记录（等确认）（F6）
  const [deleting, setDeleting] = useState<number[] | null>(null)
  const [clearing, setClearing] = useState(false)

  async function deleteForMe(seqs: number[]) {
    try {
      await store.deleteForMe(id, seqs)
      setDeleting(null)
      setSelected(null)
      toast.success(t('delete.done', { count: seqs.length }))
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  async function clearForMe() {
    try {
      await store.clearForMe(id)
      setClearing(false)
      toast.success(t('clear.done'))
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }
  useEscapeLayer(selected !== null && forwarding === null, stopSelecting)
  function toggleSelected(message: MessageView) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(message.seq)) next.delete(message.seq)
      else if (next.size >= FORWARD_MAX_MESSAGES) {
        toast.error(t('selection.max', { max: FORWARD_MAX_MESSAGES }))
        return current
      } else next.add(message.seq)
      return next
    })
  }
  function forwardSelected(merged: boolean) {
    if (!selected) return
    const messages = thread.messages.filter((message) => selected.has(message.seq))
    setForwarding({ messages, record: merged ? recordOf(messages) : undefined })
  }

  /**
   * 合并转发时，在本地先拼出聊天记录的样子：发送中先这样显示，确认后换成服务端存下的那一份。
   * 标题按我现在看到的名字："群名的聊天记录"，单聊是"我和对方的聊天记录"。
   */
  function recordOf(messages: readonly MessageView[]): ChatRecordView {
    const peer = conversation?.peer
    const title =
      !conversation || peer?.is_self
        ? t('record.titleOf', { name: me.nickname })
        : peer
          ? t('record.titleBetween', { a: me.nickname, b: displayName(conversation, t) })
          : t('record.titleOf', { name: displayName(conversation, t) })
    const items = [...messages]
      .filter(isForwardable)
      .sort((a, b) => a.seq - b.seq)
      .map((message) => {
        const member = members?.find((candidate) => candidate.user.id === message.sender_id)
        const sender =
          message.sender_id === me.id ? me : (member?.user ?? (peer ? peer.user : null))
        return {
          sender_id: message.sender_id,
          sender_name: sender?.nickname ?? message.sender_name ?? '',
          sender_avatar_file_id: sender?.avatar_file_id ?? null,
          kind: message.kind,
          // 嵌在里面的聊天记录只留标题
          text: message.record ? message.record.title : message.text,
          file: message.record ? null : message.file,
          duration_ms: message.duration_ms,
          created_at: message.created_at,
        }
      })
    return { title, items }
  }

  // 群公告的对话框：从公告条打开。打开就算看过了
  const [noticeOpen, setNoticeOpen] = useState(false)
  function openNotice() {
    setNoticeOpen(true)
    store.markNoticeSeen(id)
  }

  // 正在编辑的那条被撤回了（例如在别处撤回的）：不再编辑
  const editingSeq = editing?.seq
  const editingGone =
    editingSeq !== undefined &&
    thread.messages.some((message) => message.seq === editingSeq && message.recalled)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 被撤回的那一刻才需要
  useEffect(() => {
    if (editingGone) endEdit()
  }, [editingGone])

  // 正要回复的那条消息被撤回了：不能再引用它
  const replySeq = replyTo?.seq
  const replyGone =
    replySeq !== undefined &&
    thread.messages.some((message) => message.seq === replySeq && message.recalled)
  useEffect(() => {
    if (replyGone) setReplyTo(null)
  }, [replyGone])

  if (problem === 'missing') return <Navigate to="/chats" replace />

  const peer = conversation?.peer
  const group = conversation?.group

  /**
   * 选了、粘贴了、拖进来了几个文件：先放在输入框上方，点发送才发出去。
   * 超过上限的和空的不收，直接说明原因。
   */
  function stage(files: File[]) {
    const accepted: StagedFile[] = []
    for (const file of files) {
      if (file.size > limits.file_max_bytes) {
        toast.error(t('attachment.tooLarge', { size: formatFileSize(limits.file_max_bytes) }))
      } else if (file.size === 0) {
        toast.error(t('attachment.empty'))
      } else {
        accepted.push({ id: nextStagedId.current, file })
        nextStagedId.current += 1
      }
    }
    if (accepted.length > 0) setStaged((current) => [...current, ...accepted])
  }

  /**
   * 撤回一条自己的消息，内容回到输入框里，可以改了再发：
   * 文字（连同 @ 了谁、回复的是哪一条）回到输入框，图片和文件排到输入框上方。
   * 语音只撤回，不放回来：录好的声音没有"改了再发"一说。
   * 文件要在撤回之前取回来：撤回之后就取不到了。
   */
  async function recall(message: MessageView) {
    let file: File | null = null
    let fileLost = false
    if (message.file && message.kind !== 'voice') {
      try {
        const response = await fetch(urls.download(message.file.id))
        if (!response.ok) throw new Error(String(response.status))
        file = new File([await response.blob()], message.file.name, {
          type: response.headers.get('content-type') ?? '',
        })
      } catch {
        fileLost = true
      }
    }
    try {
      await store.recall(id, message.seq)
    } catch (error) {
      toast.error(errorMessage(error))
      return
    }
    if (file) stage([file])
    if (fileLost) toast.error(t('attachment.notRestored'))
    // 文字，以及图片的说明，回到输入框
    if ((message.kind === 'text' || message.kind === 'image') && message.text) {
      composer.current?.restore(message.text, {
        users: message.mentions,
        all: message.mention_all,
      })
    }
    // 它回复的那一条还在的话，继续回复它
    const quoted = message.reply?.seq
    const original = thread.messages.find((item) => item.seq === quoted && !item.recalled)
    if (original) setReplyTo(original)
  }

  /** 开始编辑一条自己的消息（F8）：文字放进输入框，原来打了一半的先收起来。不再引用别的消息。 */
  function startEdit(message: MessageView) {
    setReplyTo(null)
    setEditing(message)
    composer.current?.startEdit(message.text ?? '', {
      users: message.mentions,
      all: message.mention_all,
    })
  }

  /** 编辑结束：放回原来打了一半的。 */
  function endEdit() {
    setEditing(null)
    composer.current?.endEdit()
  }

  /** 保存编辑。没有改什么就直接结束；没成功（例如过了时限）说明原因，接着编辑。 */
  async function saveEdit(text: string, mentions?: Mentions) {
    const message = editing
    if (!message) return
    const sorted = (users: readonly string[]) => [...users].sort().join(',')
    const unchanged =
      text.trim() === (message.text ?? '').trim() &&
      sorted(mentions?.users ?? []) === sorted(message.mentions) &&
      (mentions?.all ?? false) === message.mention_all
    if (unchanged) {
      endEdit()
      return
    }
    try {
      await store.edit(id, message.seq, text, {
        mentions: mentions?.users,
        mentionAll: mentions?.all,
      })
      endEdit()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  /** 电脑上输入框是空的时候按 ↑：编辑自己发的最后一条，它还能编辑的话（F8 Q7）。 */
  function editLast() {
    const last = [...thread.messages]
      .reverse()
      .find((message) => message.sender_id === me.id && message.kind !== 'call')
    if (last && editable(last, me.id, limits.edit_window_seconds)) startEdit(last)
  }

  /**
   * 点了发送。只排着一张图片并且打了字：字是这张图片的说明，一起作为一条消息发出。
   * 否则先发选好的文件，每个文件是一条消息；再发文字，排在这些文件后面。
   * 正在引用的那条消息跟着文字走；只发文件、不打字时，跟着第一个文件。
   */
  function send(text: string, mentions?: Mentions) {
    // 发出去了：下一次打字马上告诉对方
    typing.stopped(id)
    const reply = replyTo ?? undefined
    const typed = text.trim() !== ''
    const [single] = staged
    setStaged([])
    setReplyTo(null)
    if (single && staged.length === 1 && typed && looksLikeImage(single.file)) {
      store.sendFile(id, single.file, single.file.name || 'file', {
        caption: text,
        mentions,
        replyTo: reply,
      })
      return
    }
    staged.forEach(({ file }, index) => {
      store.sendFile(id, file, file.name || 'file', {
        replyTo: index === 0 && !typed ? reply : undefined,
      })
    })
    if (!typed) return
    store.send(id, text, { mentions, replyTo: reply, afterFiles: staged.length > 0 })
  }

  function onDragEnter(event: DragEvent) {
    if (!carriesFiles(event)) return
    dragDepth.current += 1
    setDragging(true)
  }
  function onDragLeave(event: DragEvent) {
    if (!carriesFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  function onDrop(event: DragEvent) {
    if (!carriesFiles(event)) return
    // 不拦下来的话，浏览器会直接打开这个文件
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    stage(Array.from(event.dataTransfer.files))
  }

  /** 正在回复的那条消息的发送人显示成什么名字。 */
  function replyName(message: MessageView): string | null {
    if (message.sender_id === me.id) return t('event.you')
    const member = members?.find((candidate) => candidate.user.id === message.sender_id)
    if (member) return memberName(member)
    return conversation && peer ? displayName(conversation, t) : message.sender_name
  }
  // 群主和管理员可以点标题栏上的群名直接改
  const canRename = conversation ? canManage(conversation, me.id) : false
  // 群里除我以外、现在还在的人：可以 @ 他们
  const others = members?.filter((member) => member.active && member.user.id !== me.id) ?? []
  // 正在输入的人（F8）：单聊里就是对方，群里写出名字，三个人以上不一一列出
  const typingNames = typers.flatMap((user) => {
    const member = members?.find((item) => item.user.id === user)
    return member ? [memberName(member)] : []
  })
  let typingText: string | null = null
  if (typers.length > 0 && !group) typingText = t('typing.direct')
  else if (typingNames.length === 1) typingText = t('typing.one', { name: typingNames[0] })
  else if (typingNames.length === 2) {
    typingText = t('typing.two', { first: typingNames[0], second: typingNames[1] })
  } else if (typingNames.length > 2) typingText = t('typing.several')
  // 发不了消息的原因
  // 被禁言时输入区换成说明，带着还剩多久
  const silence = conversation ? silenced(conversation, me.id, now) : null
  const closed =
    peer && !peer.is_friend
      ? t('composer.notFriends')
      : group?.dissolved
        ? t('composer.dissolved')
        : group?.left
          ? t('composer.left')
          : silence?.kind === 'muted'
            ? silence.until >= MUTED_FOREVER
              ? t('composer.mutedForever')
              : t('composer.muted', { remaining: formatSpan(silence.until - now, t) })
            : silence?.kind === 'all'
              ? t('composer.allMuted')
              : null

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 只是让文件可以拖到会话上；用键盘的人用输入区的"文件"按钮
    <div
      ref={pane}
      data-testid="conversation-pane"
      onDragEnter={closed ? undefined : onDragEnter}
      onDragOver={closed ? undefined : (event) => carriesFiles(event) && event.preventDefault()}
      onDragLeave={closed ? undefined : onDragLeave}
      onDrop={closed ? undefined : onDrop}
      className="relative flex h-full"
    >
      {dragging && (
        <div
          data-testid="drop-hint"
          className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-card border-2 border-accent border-dashed bg-bg/90 text-accent-fg"
        >
          {t('attachment.dropHere')}
        </div>
      )}
      {/* 手机上群信息盖住整个会话：被盖住的部分不能再被点到、读到，但滚动的位置要留着 */}
      <div className={`flex min-w-0 flex-1 flex-col ${panel ? 'max-md:invisible' : ''}`}>
        <header className="flex h-[52px] flex-none items-center gap-1 border-border border-b pr-2 pl-4 max-md:pl-2">
          <Link
            to="/chats"
            aria-label={t('back')}
            className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:hidden"
          >
            <ChevronLeft size={22} strokeWidth={1.5} aria-hidden />
          </Link>
          {conversation && canRename && renaming ? (
            <GroupNameEditor
              conversation={conversation}
              onDone={() => setRenaming(false)}
              testId="title-input"
              className="h-9 min-w-0 flex-1 text-[17px] md:text-[15px]"
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-baseline gap-1">
              <h2
                data-testid="conversation-title"
                className="min-w-0 truncate font-medium text-[17px] md:text-[15px]"
              >
                {conversation && canRename ? (
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    title={t('group.rename')}
                    // 左右各伸出 4 像素，悬停的底色包住文字。宽度跟着外面的标题走，不另外限制：
                    // 限制成"不超过标题的宽度"的话，内边距会把文字挤出去，短短的群名也会被截断
                    className="-mx-1 block truncate rounded-control px-1 transition-colors duration-150 hover:bg-hover max-md:min-h-11"
                  >
                    {displayName(conversation, t)}
                  </button>
                ) : conversation ? (
                  displayName(conversation, t)
                ) : (
                  ''
                )}
              </h2>
              {group && !group.left && !group.dissolved && (
                <span data-testid="member-count" className="flex-none text-fg-3">
                  ({group.member_count})
                </span>
              )}
              {typingText && (
                <span
                  data-testid="typing"
                  role="status"
                  className="ml-1 min-w-0 max-w-[50%] flex-none truncate text-[12px] text-accent"
                >
                  {typingText}
                </span>
              )}
            </div>
          )}
          {group && conversation ? (
            <>
              <GroupCallButton conversation={conversation} video={false} />
              <GroupCallButton conversation={conversation} video />
            </>
          ) : (
            <CallStartButton conversation={conversation} video={false} />
          )}
          {!group && <CallStartButton conversation={conversation} video />}
          {/* 单聊里把别的好友拉进来：另建一个群，原来的单聊不变 */}
          {peer?.is_friend && !peer.is_self && (
            <button
              type="button"
              onClick={() => setAddingPeople(true)}
              aria-label={t('header.addPeople')}
              title={t('header.addPeople')}
              className="grid size-11 flex-none place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:size-9"
            >
              <UserPlus size={20} strokeWidth={1.5} aria-hidden />
            </button>
          )}
          {group && (
            <button
              type="button"
              onClick={() => setPanelOpen(!panelOpen)}
              aria-label={t('header.groupInfo')}
              aria-expanded={panelOpen}
              title={t('header.groupInfo')}
              className="relative grid size-11 flex-none place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:size-9"
            >
              <Users size={20} strokeWidth={1.5} aria-hidden />
              {/* 有入群申请等着我处理 */}
              {group.pending_requests > 0 && (
                <span
                  data-testid="requests-dot"
                  aria-hidden
                  className="absolute top-2 right-2 size-2 rounded-full bg-danger md:top-1 md:right-1"
                />
              )}
            </button>
          )}
          <Menu
            label={t('header.more')}
            items={[
              { label: t('search.inConversation'), onSelect: () => setPanel('search') },
              { label: t('media.title'), onSelect: () => setPanel('media') },
              { label: t('clear.title'), onSelect: () => setClearing(true) },
              {
                label: conversation?.pinned_at != null ? t('pin.off') : t('pin.on'),
                onSelect: () => void togglePin(),
              },
              {
                label: conversation?.muted ? t('mute.off') : t('mute.on'),
                onSelect: () => void toggleMute(),
              },
              { label: t('header.hide'), onSelect: hide },
            ]}
          >
            <MoreHorizontal size={20} strokeWidth={1.5} aria-hidden />
          </Menu>
        </header>

        {group?.notice && group.notice_unseen && !group.left && (
          // 有我还没看过的群公告：标题栏下方一条公告条，点开看全文，可以关掉
          <div
            data-testid="notice-banner"
            className="flex flex-none items-center gap-2 border-border border-b bg-surface py-1 pr-1 pl-4"
          >
            <Megaphone
              size={16}
              strokeWidth={1.5}
              className="flex-none text-accent-fg"
              aria-hidden
            />
            <button
              type="button"
              onClick={openNotice}
              title={t('groupNotice.view')}
              className="min-w-0 flex-1 truncate py-2 text-left text-[13px] max-md:min-h-11"
            >
              <span className="font-medium">{t('groupNotice.title')}</span>
              {'：'}
              {group.notice.text.replace(/\s+/g, ' ')}
            </button>
            <button
              type="button"
              onClick={() => store.markNoticeSeen(id)}
              aria-label={t('groupNotice.dismiss')}
              title={t('groupNotice.dismiss')}
              className="grid size-9 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg max-md:size-11"
            >
              <X size={16} strokeWidth={1.5} aria-hidden />
            </button>
          </div>
        )}

        {/* 群里有通话在进行：几个人在通话，可以加入（F10） */}
        {group && conversation && <GroupCallBanner conversation={conversation} />}

        {problem === 'failed' ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p role="alert" className="text-fg-2">
              {t('loadFailed')}
            </p>
            <Button onClick={() => setAttempt(attempt + 1)}>{tCommon('actions.retry')}</Button>
          </div>
        ) : (
          <MessageList
            id={id}
            conversation={conversation}
            thread={thread}
            members={members}
            onQuote={setReplyTo}
            onRecall={(message) => void recall(message)}
            onEdit={closed ? undefined : startEdit}
            onDelete={(message) => setDeleting([message.seq])}
            focus={focus}
            onProfile={showProfile}
            onForward={(message) => setForwarding({ messages: [message] })}
            // 从哪一条进入多选，就先勾上那一条；不能转发的（语音）不勾
            onStartSelecting={(message) =>
              setSelected(new Set(isForwardable(message) ? [message.seq] : []))
            }
            selection={selected ? { selected, toggle: toggleSelected } : undefined}
          />
        )}

        {selected ? (
          // 多选时输入区换成一条操作栏
          <div
            data-testid="selection-bar"
            className="flex flex-none flex-wrap items-center gap-2 border-border border-t p-2 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))] md:p-3"
          >
            <span className="min-w-0 flex-1 truncate pl-2 text-fg-2">
              {t('selection.count', { count: selected.size })}
            </span>
            <Button variant="ghost" onClick={stopSelecting}>
              {t('selection.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => setDeleting([...selected].sort((a, b) => a - b))}
              disabled={selected.size === 0}
            >
              {t('selection.delete')}
            </Button>
            {/* 手机上两个转发按钮另起一行，各占一半 */}
            <div className="flex gap-2 max-md:w-full">
              <Button
                variant="secondary"
                onClick={() => forwardSelected(false)}
                disabled={selected.size === 0}
                className="max-md:flex-1"
              >
                {t('selection.forward')}
              </Button>
              <Button
                onClick={() => forwardSelected(true)}
                disabled={selected.size === 0}
                className="max-md:flex-1"
              >
                {t('selection.merge')}
              </Button>
            </div>
          </div>
        ) : closed ? (
          <p
            data-testid="composer-closed"
            className="flex-none border-border border-t p-4 text-center text-fg-3"
          >
            {closed}
          </p>
        ) : (
          <Composer
            ref={composer}
            onSend={send}
            staged={staged}
            onStage={stage}
            onUnstage={(removed) =>
              setStaged((current) => current.filter((item) => item.id !== removed))
            }
            onSendVoice={(recording, durationMs) => {
              store.sendFile(id, recording, 'voice', {
                voiceDurationMs: durationMs,
                replyTo: replyTo ?? undefined,
              })
              setReplyTo(null)
            }}
            voiceMaxSeconds={limits.voice_max_seconds}
            mentionable={group ? { members: others, all: canRename } : undefined}
            replying={replyTo && { name: replyName(replyTo), summary: contentLabel(replyTo, t) }}
            onCancelReply={() => setReplyTo(null)}
            editing={
              editing && {
                summary: contentLabel(editing, t),
                allowEmpty: editing.kind === 'image',
              }
            }
            onSaveEdit={(text, mentions) => void saveEdit(text, mentions)}
            onCancelEdit={endEdit}
            onEditLast={editLast}
            onTyping={() => typing.typed(id)}
          />
        )}
      </div>
      {peer && !peer.is_self && (
        <CreateGroupDialog
          open={addingPeople}
          onClose={() => setAddingPeople(false)}
          withFriend={peer.user.id}
        />
      )}
      {conversation && panel === 'search' && (
        <ConversationSearch
          conversation={conversation}
          members={members}
          initialQuery={find}
          onJump={(seq) => {
            setFocus({ seq, token: Date.now() })
            // 手机上面板盖着会话：关掉才看得到跳到的那一条
            if (window.matchMedia('(max-width: 767px)').matches) setPanel(null)
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {conversation && panel === 'media' && (
        <MediaPanel
          conversation={conversation}
          onJump={(seq) => {
            setFocus({ seq, token: Date.now() })
            if (window.matchMedia('(max-width: 767px)').matches) setPanel(null)
          }}
          onClose={() => setPanel(null)}
        />
      )}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('delete.title', { count: deleting?.length ?? 1 })}
      >
        <p data-testid="delete-confirm" className="text-fg-2">
          {t('delete.explain')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            {t('delete.cancel')}
          </Button>
          <Button variant="danger" onClick={() => deleting && void deleteForMe(deleting)}>
            {t('delete.confirm')}
          </Button>
        </div>
      </Dialog>
      <Dialog open={clearing} onOpenChange={setClearing} title={t('clear.title')}>
        <p data-testid="clear-confirm" className="text-fg-2">
          {t('clear.explain')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setClearing(false)}>
            {t('delete.cancel')}
          </Button>
          <Button variant="danger" onClick={() => void clearForMe()}>
            {t('clear.confirm')}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={forwarding !== null}
        onOpenChange={(open) => !open && setForwarding(null)}
        title={forwarding?.record ? t('forward.titleMerged') : t('forward.title')}
      >
        {forwarding && (
          <ForwardDialog
            messages={forwarding.messages}
            record={forwarding.record}
            onCancel={() => setForwarding(null)}
            onDone={() => {
              setForwarding(null)
              setSelected(null)
            }}
          />
        )}
      </Dialog>
      {conversation && (
        <Dialog
          open={noticeOpen}
          onOpenChange={(open) => !open && setNoticeOpen(false)}
          title={t('groupNotice.title')}
        >
          <NoticeView
            conversation={conversation}
            canEdit={canRename}
            onClose={() => setNoticeOpen(false)}
          />
        </Dialog>
      )}
      <Dialog
        open={profileOf !== null}
        onOpenChange={(open) => !open && setProfileOf(null)}
        title={t('member.title')}
      >
        {conversation && profileOf && (
          <Member
            conversation={conversation}
            userId={profileOf}
            onClose={() => setProfileOf(null)}
          />
        )}
      </Dialog>
      {conversation && group && panelOpen && (
        <GroupPanel
          conversation={conversation}
          members={members}
          onClose={() => setPanelOpen(false)}
          onOpenMedia={() => setPanel('media')}
          onClearChat={() => setClearing(true)}
        />
      )}
    </div>
  )
}

/** 一个会话：标题栏、消息、输入区。 */
export function ConversationPane() {
  const { conversationId } = useParams({ strict: false })
  // 地址里带着要跳到的那条消息的序号（从搜索结果点进来的）
  const { m, find } = useSearch({ strict: false })
  if (!conversationId) return null
  // 换一个会话就换一份状态：输到一半的内容、滚动的位置都不带过去。
  // 从搜索结果再点进同一个会话的另一条消息，也重新来一遍
  return (
    <Conversation
      key={`${conversationId}:${m ?? ''}:${find ?? ''}`}
      id={conversationId}
      focusSeq={m}
      find={find}
    />
  )
}
