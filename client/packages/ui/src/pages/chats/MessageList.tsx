import {
  formatMessageTime,
  isForwardable,
  memberName,
  type PendingMessage,
  readersOf,
  type Thread,
  TIME_GAP_MS,
} from '@vibechat/core'
import type {
  ChatRecordView,
  ConversationView,
  FileView,
  MemberView,
  MessageView,
  QuoteView,
  UserCard,
} from '@vibechat/protocol'
import { ChevronDown, Phone } from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useCall, useCallController, useCallsAvailable } from '../../calls'
import { useChatStore, useLimits } from '../../chat'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { useErrorMessage } from '../../errors'
import { usePreferences } from '../../preferences'
import { useMe } from '../../session'
import { toast } from '../../toast'
import { FileBody, ImageBody, UploadingBody } from './attachments'
import { Bubble, type BubbleStatus } from './Bubble'
import { ChatRecordCard, RecordViewer } from './ChatRecord'
import { Lightbox } from './Lightbox'
import { MediaFrame } from './MediaFrame'
import { type MenuItem, MessageMenu } from './MessageMenu'
import { highlightMentions } from './mentions'
import { NoticeCard } from './NoticeCard'
import { QuoteBlock } from './QuoteBlock'
import { ReadersLists } from './ReadersDialog'
import { callRecordText, displayName, eventText, recalledText, senderName } from './text'
import { VoiceBody } from './voice'

/** 离底部不到这么多像素，就算"在最底部"。 */
const BOTTOM_SLACK = 24
/** 离顶部（或底部）不到这么多像素时，开始取更早（或更新）的消息。 */
const LOAD_MORE_WITHIN = 200
/** 跳到一条消息之后，把它标出来多久。 */
const HIGHLIGHT_MS = 2000

/** 页面是否在前台：没有被切到后台的标签页，也没有最小化。 */
function usePageVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    },
    () => document.visibilityState === 'visible',
  )
}

/**
 * 这条消息现在能不能编辑（F8）：我发的文字消息或图片，没有撤回，还在时限之内（时限是 0 就是不允许）。
 * 服务端会再检查一遍。
 */
export function editable(message: MessageView, myId: string, windowSeconds: number): boolean {
  return (
    message.sender_id === myId &&
    (message.kind === 'text' || message.kind === 'image') &&
    !message.recalled &&
    windowSeconds > 0 &&
    Date.now() - message.created_at < windowSeconds * 1000
  )
}

interface MessageListProps {
  id: string
  conversation: ConversationView | undefined
  thread: Thread
  /** 群的成员名单。单聊没有；群的名单还没取回来时也没有。 */
  members?: readonly MemberView[]
  /** 用户选了"引用"。 */
  onQuote: (message: MessageView) => void
  /** 用户选了"撤回"。 */
  onRecall: (message: MessageView) => void
  /** 用户选了"编辑"（F8）。不给时不能编辑（例如不能发消息的会话）。 */
  onEdit?: (message: MessageView) => void
  /** 从我这边删掉这一条（F6），确认之后。 */
  onDelete: (message: MessageView) => void
  /** 要跳到的那条消息（从搜索结果点进来的）。`token` 变了就再跳一次。 */
  focus?: { seq: number; token: number }
  /** 用户点了一个人的头像。不给时头像不能点。 */
  onProfile?: (userId: string) => void
  /** 消息菜单里选了"转发"：只转发这一条。 */
  onForward?: (message: MessageView) => void
  /** 消息菜单里选了"多选"：进入多选，这一条先勾上。 */
  onStartSelecting?: (message: MessageView) => void
  /** 正在多选：勾上了哪几条（序号），点一条勾上或取消。 */
  selection?: { selected: ReadonlySet<number>; toggle: (message: MessageView) => void }
}

/** 同一个人连续发的几条只显示一次头像：后面几条在头像的位置留出同样宽的空白。 */
const AVATAR_GAP = <span aria-hidden className="w-8 flex-none" />

/** 正在打开的菜单：哪一条消息，出现在屏幕上的什么位置。 */
interface OpenMenu {
  message: MessageView
  x: number
  y: number
  /** 是长按打开的：电脑上"引用"在气泡旁边有单独的按钮，手机上没有，所以菜单里要有。 */
  touch: boolean
}

/** 会话里的消息。负责滚动：停在最新一条、向上翻阅、翻看历史时不被新消息拉走、跳到某一条。 */
export function MessageList({
  id,
  conversation,
  thread,
  members,
  onQuote,
  onRecall,
  onEdit,
  onDelete,
  focus,
  onProfile,
  onForward,
  onStartSelecting,
  selection,
}: MessageListProps) {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const language = usePreferences((state) => state.language)
  const me = useMe()
  const store = useChatStore()
  const limits = useLimits()
  const visible = usePageVisible()
  const scroller = useRef<HTMLDivElement>(null)
  // 是否跟着最新消息走。用户往上翻了就不跟
  const pinned = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  // 正在看哪一条消息的已读名单
  const [readersFor, setReadersFor] = useState<string | null>(null)
  // 要删掉的那条没有发出去的消息：先确认
  const [discarding, setDiscarding] = useState<string | null>(null)
  const [viewed, setViewed] = useState<FileView | null>(null)
  // 正在查看的聊天记录
  const [record, setRecord] = useState<ChatRecordView | null>(null)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  // 刚跳到的那一条，标出来一小会儿
  const [highlight, setHighlight] = useState<number | null>(null)
  // 要滚动过去的那一条。它出现在页面里之后滚过去
  const target = useRef<number | null>(null)

  const peer = conversation?.peer ?? null
  const inGroup = conversation?.kind === 'group'
  const first = thread.messages[0]?.seq ?? 0
  const last = thread.messages.at(-1)?.seq ?? 0
  const pendingCount = thread.pending.length

  // 向上翻取回来的更早的一段接在了最前面：内容变高了多少，就往下滚多少，原来看的那几条不动
  const previous = useRef({ first: 0, height: 0, pending: 0 })
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const wasLoaded = previous.current.first > 0
    // 跳到另一段时整个换掉了，不是往前接
    if (wasLoaded && first < previous.current.first && target.current === null) {
      element.scrollTop += element.scrollHeight - previous.current.height
    }
  }, [first])

  // 打开会话时停在最新一条；正看着最新消息时，新来的消息把页面带到底部；自己发的总是带到底部
  // biome-ignore lint/correctness/useExhaustiveDependencies: 消息多了一条、会话加载完了，都要重新滚一次
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (pendingCount > previous.current.pending) pinned.current = true
    if (pinned.current && target.current === null) element.scrollTop = element.scrollHeight
  }, [last, pendingCount, thread.status])

  // 要跳到的那一条出现在页面里了：滚过去，标出来
  useLayoutEffect(() => {
    const seq = target.current
    if (seq === null) return
    const element = scroller.current?.querySelector(`[data-seq="${seq}"]`)
    if (!element) return
    target.current = null
    element.scrollIntoView({ block: 'center' })
    setHighlight(seq)
  })
  useEffect(() => {
    if (highlight === null) return
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [highlight])

  // 记下这一次显示之后的样子，下一次变化时拿来比较。放在上面几段之后执行
  useLayoutEffect(() => {
    previous.current = {
      first,
      height: scroller.current?.scrollHeight ?? 0,
      pending: pendingCount,
    }
  })

  function onScroll() {
    const element = scroller.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const bottom = distance < BOTTOM_SLACK
    pinned.current = bottom && !thread.hasNewer
    setAtBottom(bottom)
    if (element.scrollTop < LOAD_MORE_WITHIN) {
      // 取不到就算了，再往上滚一下会重试
      store.loadOlder(id).catch(() => {})
    }
    if (thread.hasNewer && distance < LOAD_MORE_WITHIN) {
      store.loadNewer(id).catch(() => {})
    }
  }

  async function backToLatest() {
    pinned.current = true
    if (thread.hasNewer) {
      await store.jumpToLatest(id).catch(() => {})
      return
    }
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }

  /** 跳到一条消息：已经在页面里就滚过去，否则先把它附近的一段取回来。 */
  async function jump(seq: number) {
    try {
      const result = await store.jumpTo(id, seq)
      if (result === 'unavailable') {
        toast.error(t('jumpUnavailable'))
        return
      }
      pinned.current = false
      target.current = seq
      // 已经在页面里时内容没有变化，自己触发一次滚动
      setHighlight(null)
      const element = scroller.current?.querySelector(`[data-seq="${seq}"]`)
      if (element) {
        target.current = null
        element.scrollIntoView({ block: 'center' })
        setHighlight(seq)
      }
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  // 从搜索结果点进来：会话加载好之后跳到那一条
  const ready = thread.status === 'ready'
  const focused = useRef<number | null>(null)
  const focusSeq = focus?.seq
  const focusToken = focus?.token
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在要跳到的消息变了、或者会话刚加载好时做一次
  useEffect(() => {
    if (!ready || focusSeq === undefined || focusToken === undefined) return
    if (focused.current === focusToken) return
    focused.current = focusToken
    void jump(focusSeq)
  }, [ready, focusSeq, focusToken])

  // 用户此刻是否正看着最新的消息：是的话，到了的消息都算已读
  const viewing = atBottom && visible && ready && !thread.hasNewer
  useEffect(() => {
    store.setViewing(viewing ? id : null)
    return () => store.setViewing(null)
  }, [store, id, viewing])

  const closeMenu = useCallback(() => setMenu(null), [])

  // ---------- 名字 ----------

  /** 一个人在这个会话里显示成什么名字。 */
  function nameOf(userId: string | null, fallback: string | null): string | null {
    if (userId === null) return fallback
    if (userId === me.id) return t('event.you')
    const member = members?.find((candidate) => candidate.user.id === userId)
    if (member) return memberName(member)
    if (peer && peer.user.id === userId && conversation) return displayName(conversation, t)
    return fallback
  }

  /** 消息旁边的头像。能看这个人的资料时可以点。 */
  function avatarOf(user: Pick<UserCard, 'id' | 'nickname' | 'avatar_file_id'>, viewable: boolean) {
    const avatar = <Avatar user={user} size={32} />
    if (!onProfile || !viewable) return avatar
    return (
      <button
        type="button"
        onClick={() => onProfile(user.id)}
        aria-label={t('profile', { name: nameOf(user.id, user.nickname) ?? user.nickname })}
        data-testid="message-avatar"
        // 头像看起来还是那么大；手机上可以点的范围向四周扩出去一点，够手指点
        className="grid flex-none place-items-center self-start rounded-card max-md:-m-1.5 max-md:size-11 md:size-8"
      >
        {avatar}
      </button>
    )
  }

  function quoteBlock(quote: QuoteView, onAccent: boolean, jumpable: boolean) {
    return (
      <QuoteBlock
        quote={quote}
        name={nameOf(quote.sender_id, quote.sender_name)}
        onAccent={onAccent}
        onJump={jumpable && quote.state === 'shown' ? () => void jump(quote.seq) : undefined}
      />
    )
  }

  // ---------- 操作 ----------

  /** 这条消息现在还能不能撤回：是我发的，并且还在时限之内。服务端会再检查一遍。 */
  function recallable(message: MessageView): boolean {
    return (
      message.sender_id === me.id &&
      Date.now() - message.created_at < limits.recall_window_seconds * 1000
    )
  }

  function menuItems(message: MessageView, withQuote: boolean): MenuItem[] {
    const deletion = {
      label: t('actions.delete'),
      danger: true,
      onSelect: () => onDelete(message),
    }
    // 通话记录不能引用、转发、撤回，只能从我这边删掉
    if (message.kind === 'call') return [deletion]
    const items: MenuItem[] = []
    if (withQuote) items.push({ label: t('actions.quote'), onSelect: () => onQuote(message) })
    if (message.kind === 'text' && message.text) {
      const text = message.text
      items.push({
        label: t('actions.copy'),
        onSelect: () => {
          navigator.clipboard.writeText(text).then(
            () => toast.success(t('actions.copied')),
            () => {},
          )
        },
      })
    }
    if (isForwardable(message) && onForward) {
      items.push({ label: t('actions.forward'), onSelect: () => onForward(message) })
    }
    if (onStartSelecting) {
      items.push({ label: t('actions.select'), onSelect: () => onStartSelecting(message) })
    }
    if (onEdit && editable(message, me.id, limits.edit_window_seconds)) {
      items.push({ label: t('actions.edit'), onSelect: () => onEdit(message) })
    }
    if (recallable(message)) {
      items.push({
        label: t('actions.recall'),
        danger: true,
        onSelect: () => onRecall(message),
      })
    }
    items.push(deletion)
    return items
  }

  // 通话记录点了可以再打一次：还是好友、能通话、现在没有在通话
  const calls = useCallController()
  const callPhase = useCall().phase
  const callsAvailable = useCallsAvailable()
  const canCallBack =
    callsAvailable &&
    peer?.is_friend === true &&
    !peer.is_self &&
    (callPhase === 'idle' || callPhase === 'ended')

  // 不能发消息的会话里（不是好友了、离开了群、群解散了）也不能引用
  const closed =
    (peer !== null && !peer.is_friend) ||
    conversation?.group?.left === true ||
    conversation?.group?.dissolved === true

  // ---------- 一行一行排出来 ----------

  const now = Date.now()
  const rows: ReactNode[] = []
  let previousTime: number | null = null
  // 上一行是谁发的消息。中间隔了时间或事件就重新算
  let previousSender: string | null = null
  function timeRow(time: number, key: string) {
    if (previousTime === null || time - previousTime > TIME_GAP_MS) {
      previousSender = null
      rows.push(
        <p key={`time-${key}`} className="self-center text-[11px] text-fg-3">
          {formatMessageTime(time, now, language)}
        </p>,
      )
    }
    previousTime = time
  }

  function eventRow(key: string, text: string, seq?: number) {
    previousSender = null
    rows.push(
      <p
        key={key}
        data-testid="message-event"
        data-seq={seq}
        className="max-w-[90%] self-center text-center text-[12px] text-fg-3 [overflow-wrap:anywhere]"
      >
        {text}
      </p>,
    )
  }

  /** 消息的内容：文字、图片、文件、语音或聊天记录。 */
  function body(message: MessageView, mine: boolean): { content: ReactNode; bare: boolean } {
    const shown = message.record
    if (shown) {
      return {
        content: (
          <MediaFrame
            mine={mine}
            quote={message.reply ? quoteBlock(message.reply, false, true) : undefined}
          >
            <ChatRecordCard record={shown} onOpen={() => setRecord(shown)} />
          </MediaFrame>
        ),
        bare: true,
      }
    }
    const file = message.file
    if (file) {
      const media =
        message.kind === 'image' ? (
          <ImageBody file={file} onOpen={() => setViewed(file)} />
        ) : message.kind === 'voice' ? (
          <VoiceBody
            file={file}
            durationMs={message.duration_ms ?? 0}
            mine={mine}
            unplayed={!mine && !message.played}
            onPlayed={() => store.markPlayed(id, message.seq)}
          />
        ) : (
          <FileBody file={file} />
        )
      // 图片的说明和文字消息一样，@ 的名字标出来
      const caption =
        message.kind === 'image' && message.text
          ? highlightMentions(message, members, mine ? 'font-medium underline' : 'text-accent-fg')
          : undefined
      return {
        content: (
          <MediaFrame
            mine={mine}
            quote={message.reply ? quoteBlock(message.reply, false, true) : undefined}
            caption={caption}
          >
            {media}
          </MediaFrame>
        ),
        bare: true,
      }
    }
    return {
      content: (
        <>
          {message.reply && quoteBlock(message.reply, mine, true)}
          <span data-testid="message-text">
            {highlightMentions(message, members, mine ? 'font-medium underline' : 'text-accent-fg')}
          </span>
        </>
      ),
      bare: false,
    }
  }

  function confirmed(message: MessageView) {
    // 撤回、编辑事件本身不显示：被撤回、被编辑的那一条已经变成了撤回的提示、新的内容
    if (message.kind === 'recalled' || message.kind === 'edited') return
    timeRow(message.created_at, message.id)
    const mine = message.sender_id === me.id
    if (message.recalled) {
      const name = nameOf(message.sender_id, senderName(message, members))
      eventRow(message.id, recalledText(message, name, me.id, t), message.seq)
      return
    }
    if (message.kind === 'call') {
      // 通话记录：主叫那一侧的一条，点它再打一次
      previousSender = null
      const record = callRecordText(message, me.id, t)
      // 群通话的记录记在发起人名下：别人看到的是他的头像和名字
      const starter = members?.find((member) => member.user.id === message.sender_id)
      const starterName = message.call_joined != null && !mine ? senderName(message, members) : null
      rows.push(
        <Bubble
          key={message.id}
          mine={mine}
          seq={message.seq}
          highlighted={highlight === message.seq}
          avatar={
            mine
              ? undefined
              : peer
                ? avatarOf(peer.user, peer.is_friend)
                : starterName !== null
                  ? avatarOf(
                      starter?.user ?? {
                        id: message.sender_id ?? '',
                        nickname: starterName,
                        avatar_file_id: null,
                      },
                      starter?.active === true,
                    )
                  : undefined
          }
          name={starterName}
          onMenu={
            selection
              ? undefined
              : (x: number, y: number, touch: boolean) => setMenu({ message, x, y, touch })
          }
          hasMore={!selection}
        >
          <button
            type="button"
            data-testid="call-record"
            data-outcome={message.call_outcome ?? undefined}
            title={canCallBack ? t('call.record.callBack') : undefined}
            // 群通话的记录不能点：要再打就用标题栏上的按钮，那里可以选邀请谁
            disabled={!canCallBack}
            onClick={() => void calls.start(id)}
            className={`flex items-center gap-2 disabled:cursor-default ${record.missed ? 'text-danger' : ''}`}
          >
            <Phone size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
            <span>{record.text}</span>
          </button>
        </Bubble>,
      )
      return
    }
    if (
      message.kind !== 'text' &&
      message.kind !== 'image' &&
      message.kind !== 'file' &&
      message.kind !== 'voice' &&
      message.kind !== 'chat_record'
    ) {
      // 发布、修改群公告：一张卡片，直接带着那一次的内容
      if (message.kind === 'notice_changed' && message.text) {
        previousSender = null
        rows.push(
          <NoticeCard
            key={message.id}
            seq={message.seq}
            title={eventText(message, members, me.id, t)}
            text={message.text}
          />,
        )
        return
      }
      // 事件：居中的一行提示，不带气泡
      eventRow(message.id, eventText(message, members, me.id, t), message.seq)
      return
    }

    const { content, bare } = body(message, mine)
    // 多选的时候没有别的操作：点一条就是勾上或取消
    const actions = selection
      ? {
          seq: message.seq,
          edited: message.edited_at !== null,
          selection: {
            selected: selection.selected.has(message.seq),
            onToggle: isForwardable(message) ? () => selection.toggle(message) : undefined,
          },
        }
      : {
          seq: message.seq,
          edited: message.edited_at !== null,
          highlighted: highlight === message.seq,
          onQuote: closed ? undefined : () => onQuote(message),
          // 一样操作都没有时，长按也不弹菜单
          onMenu:
            menuItems(message, !closed).length > 0
              ? (x: number, y: number, touch: boolean) => setMenu({ message, x, y, touch })
              : undefined,
          hasMore: menuItems(message, false).length > 0,
        }

    if (!inGroup) {
      // 和自己的对话里没有"对方读了没有"这回事，只显示"已发送"
      const status: BubbleStatus | undefined = mine
        ? peer && !peer.is_self && message.seq <= peer.read_seq
          ? 'read'
          : 'sent'
        : undefined
      rows.push(
        <Bubble
          key={message.id}
          mine={mine}
          bare={bare}
          avatar={!mine && peer ? avatarOf(peer.user, peer.is_friend) : undefined}
          status={status}
          {...actions}
        >
          {content}
        </Bubble>,
      )
      return
    }

    const continued = previousSender === message.sender_id
    previousSender = message.sender_id
    if (mine) {
      // 群里其他人有几个读了。名单还没取回来，或者群里没有别人，就只说"已发送"
      const readers = readersOf(members ?? [], message, me.id)
      const audience = readers.read.length + readers.unread.length
      const allRead = audience > 0 && readers.unread.length === 0
      rows.push(
        <Bubble
          key={message.id}
          mine
          bare={bare}
          status={allRead ? 'read' : 'sent'}
          statusLabel={
            audience === 0
              ? undefined
              : allRead
                ? t('status.readByAll')
                : t('status.readBy', { count: readers.read.length })
          }
          onStatusClick={audience > 0 ? () => setReadersFor(message.id) : undefined}
          {...actions}
        >
          {content}
        </Bubble>,
      )
      return
    }
    const sender = members?.find((member) => member.user.id === message.sender_id)
    const name = senderName(message, members)
    const user = sender?.user ?? {
      id: message.sender_id ?? '',
      nickname: name ?? '',
      avatar_file_id: null,
    }
    rows.push(
      <Bubble
        key={message.id}
        mine={false}
        bare={bare}
        avatar={continued ? AVATAR_GAP : avatarOf(user, sender?.active === true)}
        name={continued ? null : name}
        {...actions}
      >
        {content}
      </Bubble>,
    )
  }

  function unconfirmed(message: PendingMessage) {
    timeRow(message.createdAt, message.clientId)
    const { attachment } = message
    // 文件没有保存下来、也没有传上去过：没有东西可以重发，只能删掉
    const lost = message.error === 'file_not_saved'
    const pendingRecord = message.merge?.record ?? message.forward?.record
    rows.push(
      <Bubble
        key={message.clientId}
        mine
        bare={
          attachment !== undefined ||
          message.merge !== undefined ||
          (message.forward?.kind ?? 'text') !== 'text'
        }
        status={message.status}
        statusLabel={lost ? t('discard.notSaved') : undefined}
        onRetry={lost ? undefined : () => store.retry(id, message.clientId)}
        onDiscard={() => setDiscarding(message.clientId)}
      >
        {pendingRecord ? (
          // 合并转发、转发一条聊天记录：先按拼好的样子显示，确认之后才能点开
          <ChatRecordCard record={pendingRecord} />
        ) : message.forward && message.forward.kind !== 'text' && message.forward.file ? (
          // 转发的图片、文件：原文件我读得到，直接显示
          <MediaFrame mine caption={message.text.trim() === '' ? undefined : message.text}>
            {message.forward.kind === 'image' ? (
              <ImageBody file={message.forward.file} onOpen={() => {}} />
            ) : message.forward.kind === 'voice' ? (
              <VoiceBody
                file={message.forward.file}
                durationMs={message.forward.durationMs ?? 0}
                mine
                unplayed={false}
                onPlayed={() => {}}
              />
            ) : (
              <FileBody file={message.forward.file} />
            )}
          </MediaFrame>
        ) : attachment ? (
          <MediaFrame
            mine
            quote={message.reply ? quoteBlock(message.reply, false, false) : undefined}
            caption={message.text.trim() === '' ? undefined : message.text}
          >
            <UploadingBody
              attachment={attachment}
              onCancel={
                message.status === 'uploading'
                  ? () => store.cancelUpload(id, message.clientId)
                  : undefined
              }
            />
          </MediaFrame>
        ) : (
          <>
            {message.reply && quoteBlock(message.reply, true, false)}
            <span data-testid="message-text">{message.text}</span>
          </>
        )}
      </Bubble>,
    )
  }

  thread.messages.forEach(confirmed)
  // 正看着历史里的一段时，还没发出去的那几条在最新的位置，不在这一段里
  if (!thread.hasNewer) thread.pending.forEach(unconfirmed)

  const unread = conversation?.unread ?? 0
  // 名单开着的时候有人读了，里面的内容跟着变
  const readersMessage = readersFor
    ? thread.messages.find((message) => message.id === readersFor)
    : undefined

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        data-testid="message-list"
        // 浏览器自带的"内容变高时保持位置"各家不一样，关掉，统一用上面的做法
        className="flex h-full flex-col gap-3 overflow-y-auto p-3 [overflow-anchor:none] md:p-4"
      >
        {rows}
      </div>
      {!ready && thread.status !== 'error' && (
        // 最新的一段还在路上：说一声，不是一片空白
        <p
          role="status"
          data-testid="loading"
          className="pointer-events-none absolute inset-0 grid place-items-center text-fg-3"
        >
          {tCommon('loading')}
        </p>
      )}
      {thread.loadingOlder && (
        <p className="pointer-events-none absolute inset-x-0 top-2 text-center text-[11px] text-fg-3">
          {t('loadingOlder')}
        </p>
      )}
      {(thread.hasNewer || (!atBottom && unread > 0)) && (
        <button
          type="button"
          onClick={() => void backToLatest()}
          data-testid="back-to-latest"
          className="absolute right-4 bottom-3 flex h-9 items-center gap-1 rounded-full border border-border bg-bg px-3 text-[12px] text-accent-fg shadow-float"
        >
          <ChevronDown size={16} strokeWidth={1.5} aria-hidden />
          {thread.hasNewer && unread === 0
            ? t('backToLatest')
            : t('newMessages', { count: unread })}
        </button>
      )}
      {menu && (
        <MessageMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.message, menu.touch && !closed)}
          onClose={closeMenu}
        />
      )}
      <Lightbox file={viewed} onClose={() => setViewed(null)} />
      <RecordViewer record={record} onClose={() => setRecord(null)} />
      <Dialog
        open={discarding !== null}
        onOpenChange={(open) => !open && setDiscarding(null)}
        title={t('discard.title')}
      >
        <p className="text-fg-2">{t('discard.explain')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDiscarding(null)}>
            {tCommon('actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (discarding) store.discard(id, discarding)
              setDiscarding(null)
            }}
          >
            {t('discard.action')}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={readersMessage !== undefined}
        onOpenChange={(open) => !open && setReadersFor(null)}
        title={t('readers.title')}
      >
        {readersMessage && (
          <ReadersLists readers={readersOf(members ?? [], readersMessage, me.id)} />
        )}
      </Dialog>
    </div>
  )
}
