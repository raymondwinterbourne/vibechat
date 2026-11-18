// 一个会话里的消息在本地的样子，以及把新到的消息并进去的规则。
//
// 页面只认序号。推送来的、发送的应答里带回来的、补齐时取回来的，都走同一个入口并进来：
// 已经有的丢弃，正好接在后面的接上，中间有空缺的先不接、去把空缺补上。
// 所以推送丢了、重复了、乱序了，结果都一样。

import type { ChatRecordView, FileView, MessageView, QuoteView } from '@vibechat/protocol'
import type { Mentions } from './api'

/** 正在上传、或者上传好了还没有发出去的文件。 */
export interface PendingAttachment {
  /** 文件本身。刷新之前存进浏览器时空间不够、没存下来的，为 null：这时只能删掉。 */
  content: Blob | null
  name: string
  size: number
  /** 传了多少，0 到 1。 */
  progress: number
  /** 上传完成后服务端交回来的文件。有了它，重试时不用再传一遍。 */
  file?: FileView
  /** 语音的时长，毫秒。有它时这是一条语音。 */
  voiceDurationMs?: number
}

/** 转发的一条：来源，以及原消息的样子。 */
export interface PendingForward {
  conversationId: string
  seq: number
  kind: 'text' | 'image' | 'file' | 'voice' | 'chat_record'
  /** 原消息所附的文件。我看得到原消息，所以也读得到它，可以直接显示。 */
  file: FileView | null
  /** 语音的时长，毫秒。 */
  durationMs?: number
  /** 转发的是一条聊天记录：它的内容。 */
  record?: ChatRecordView
}

/** 合并转发：来源，以及在本地先拼出来的聊天记录的样子。 */
export interface PendingMerge {
  conversationId: string
  /** 按原来的先后。 */
  seqs: number[]
  record: ChatRecordView
}

/** 自己发出、还没有得到服务端确认的消息。 */
export interface PendingMessage {
  /** 客户端生成的编号。重发时不变，服务端据此去重。 */
  clientId: string
  /** 文本消息的文字；带文件时是图片的文字说明，可以为空。 */
  text: string
  /** @ 了谁。重发时原样带上。 */
  mentions?: Mentions
  /** 所附的文件。 */
  attachment?: PendingAttachment
  /** 回复的是哪一条。 */
  reply?: QuoteView
  /** 转发：从哪个会话的哪一条复制。内容（文字、图片和说明、文件）已经放在 `text` 和这里，用来先显示出来。 */
  forward?: PendingForward
  /** 合并转发：把哪个会话的哪几条做成一条聊天记录。 */
  merge?: PendingMerge
  /** 点下发送的时间，本机的时钟。 */
  createdAt: number
  status: 'uploading' | 'sending' | 'failed'
  /**
   * 失败的原因：错误码。另有两种是本地的：上次没有发出去、刷新后取回来的是 `interrupted`；
   * 文件没有保存下来、只能删掉的是 `file_not_saved`。
   */
  error?: string
}

export interface Thread {
  /** 加载最新一段消息的进展。 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 服务端已经确认的，按序号从小到大，中间没有空缺。 */
  messages: MessageView[]
  /** 自己发出、还没有确认的，按发出的先后。显示在确认了的消息之后。 */
  pending: PendingMessage[]
  /** 比已经加载的更早的消息还有没有。 */
  hasOlder: boolean
  loadingOlder: boolean
  /**
   * 比已经加载的更新的消息还有没有。平时没有：加载的这一段一直连到最新一条。
   * 跳到很早的一条消息时，只取了它附近的一段，这时为真；新来的消息不往这一段后面接。
   */
  hasNewer: boolean
  loadingNewer: boolean
  /**
   * 最后几条被我删掉、清空掉了的话，它们原来排到第几条（F6）。这之前的都已经知道了，
   * 新来的消息只要紧接着它就能往后接，不算中间缺了几条。
   */
  through: number
}

export const EMPTY_THREAD: Thread = {
  status: 'idle',
  messages: [],
  pending: [],
  hasOlder: false,
  loadingOlder: false,
  hasNewer: false,
  loadingNewer: false,
  through: 0,
}

/** 去掉几条（我把它们从自己这边删掉了，F6）。 */
export function withoutMessages(thread: Thread, seqs: readonly number[]): Thread {
  const gone = new Set(seqs)
  return {
    ...thread,
    messages: thread.messages.filter((message) => !gone.has(message.seq)),
    through: lastSeq(thread),
  }
}

/** 去掉序号不大于 `seq` 的（我把记录清空到了那一条，F6）。 */
export function withoutUpTo(thread: Thread, seq: number): Thread {
  return {
    ...thread,
    messages: thread.messages.filter((message) => message.seq > seq),
    hasOlder: thread.messages.some((message) => message.seq > seq) ? thread.hasOlder : false,
    through: Math.max(lastSeq(thread), seq),
  }
}

/** 已经知道的最新一条的序号：已经确认的最新一条，或者被我删掉、清空掉的最后一条；都没有时是 0。 */
export function lastSeq(thread: Thread): number {
  return Math.max(thread.messages.at(-1)?.seq ?? 0, thread.through)
}

/** 已经加载的最早一条的序号；一条都没有时是 0。 */
export function firstSeq(thread: Thread): number {
  return thread.messages[0]?.seq ?? 0
}

/** 一条消息被撤回之后的样子：只知道是谁发的，内容都没有了。 */
function recalled(message: MessageView): MessageView {
  return {
    ...message,
    recalled: true,
    text: null,
    file: null,
    duration_ms: null,
    record: null,
    call_outcome: null,
    call_video: false,
    call_joined: null,
    approver: null,
    until: null,
    reply: null,
    mentions: [],
    mention_all: false,
  }
}

/** 引用里显示的那一段最多多长：和服务端的一样（QUOTE_MAX_CHARS）。 */
const QUOTE_TEXT_MAX = 100

/**
 * 序号为 `edit.target_seq` 的那条消息被编辑了（F8）：换上新的文字、记下编辑时间，引用了它的回复里
 * 显示的那一段也跟着变。新 @ 到的人加进去（删掉的 @ 文字里已经没有了，留着不影响显示）。
 * 没有加载到的不用管，之后取回来时就已经是新的内容。
 */
function applyEdit(messages: MessageView[], edit: MessageView): MessageView[] {
  const seq = edit.target_seq
  return messages.map((message) => {
    if (message.seq === seq && !message.recalled) {
      const mentions = [...new Set([...message.mentions, ...edit.mentions])]
      return {
        ...message,
        text: edit.text,
        edited_at: edit.created_at,
        mentions,
        mention_all: message.mention_all || edit.mention_all,
      }
    }
    if (message.reply?.seq === seq && message.reply.state === 'shown') {
      const text = edit.text === null ? null : [...edit.text].slice(0, QUOTE_TEXT_MAX).join('')
      return { ...message, reply: { ...message.reply, text } }
    }
    return message
  })
}

/**
 * 序号为 `seq` 的那条消息被撤回了：把它换成撤回之后的样子，引用了它的回复也跟着变。
 * 没有加载到的不用管，之后取回来时服务端交出来的就已经是撤回之后的样子。
 */
function applyRecall(messages: MessageView[], seq: number): MessageView[] {
  return messages.map((message) => {
    if (message.seq === seq) return message.recalled ? message : recalled(message)
    if (message.reply?.seq === seq && message.reply.state !== 'recalled') {
      const reply: QuoteView = {
        seq,
        state: 'recalled',
        sender_id: null,
        sender_name: null,
        kind: null,
        text: null,
        file_name: null,
      }
      return { ...message, reply }
    }
    return message
  })
}

export interface Merged {
  thread: Thread
  /** 新到的消息和已有的之间有空缺：没有接上去，需要把中间的补回来。 */
  gap: boolean
}

/**
 * 把服务端确认过的消息并进来。`myId` 是我的内部编号：
 * 我自己发的消息被确认后，对应的"发送中"那一条就不用再显示了。
 */
export function mergeMessages(
  thread: Thread,
  incoming: readonly MessageView[],
  myId: string,
): Merged {
  const sorted = [...incoming].sort((a, b) => a.seq - b.seq)
  let messages = [...thread.messages]
  const confirmed = new Set<string>()
  let gap = false
  let changed = false

  for (const message of sorted) {
    const mine = message.sender_id === myId && message.client_id
    // 撤回是一条事件：不管它接不接得上，被撤回的那条如果已经加载了，现在就要变
    if (message.kind === 'recalled' && message.target_seq !== null) {
      const target = messages.find((loaded) => loaded.seq === message.target_seq)
      const quoting = messages.some((loaded) => loaded.reply?.seq === message.target_seq)
      if ((target && !target.recalled) || quoting) {
        messages = applyRecall(messages, message.target_seq)
        changed = true
      }
    }
    // 编辑也是一条事件：被编辑的那条如果已经加载了，现在就换成新的内容（F8）
    if (message.kind === 'edited' && message.target_seq !== null) {
      const before = messages
      messages = applyEdit(messages, message)
      if (messages.some((item, at) => item !== before[at])) changed = true
    }
    // 正看着历史里的一段时，新来的消息不往后面接
    if (thread.hasNewer) {
      if (mine) confirmed.add(mine)
      continue
    }
    if (gap) continue
    const last = Math.max(messages.at(-1)?.seq ?? 0, thread.through)
    if (message.seq > last + 1) {
      // 中间缺了几条：不能跳着接，否则顺序就不连续了
      gap = true
      continue
    }
    if (mine) confirmed.add(mine)
    // 序号不大于最新一条的都已经有了（或者比已加载的范围还早），不用再放
    if (message.seq > last) {
      messages.push(message)
      changed = true
    }
  }

  const pending =
    confirmed.size > 0
      ? thread.pending.filter((item) => !confirmed.has(item.clientId))
      : thread.pending
  if (pending.length !== thread.pending.length) changed = true
  return { thread: changed ? { ...thread, messages, pending } : thread, gap }
}

/** 取回来的这一段里已经有了的"发送中"的消息，不用再显示。 */
function withoutConfirmed(
  pending: PendingMessage[],
  loaded: readonly MessageView[],
  myId: string,
): PendingMessage[] {
  const confirmed = new Set(
    loaded.filter((message) => message.sender_id === myId).map((message) => message.client_id),
  )
  return pending.filter((item) => !confirmed.has(item.clientId))
}

/**
 * 打开会话时取回来的最新一段。取的这一会儿里我可能已经发了消息，并且它已经在这一段里了：
 * 对应的"发送中"那一条不用再显示。
 */
export function loadLatest(
  thread: Thread,
  latest: readonly MessageView[],
  hasOlder: boolean,
  myId: string,
): Thread {
  return {
    ...thread,
    status: 'ready',
    messages: [...latest],
    pending: withoutConfirmed(thread.pending, latest, myId),
    hasOlder,
    hasNewer: false,
    loadingNewer: false,
  }
}

/** 跳到历史里的一条消息时取回来的那一段：换掉已经加载的。 */
export function loadWindow(
  thread: Thread,
  window: readonly MessageView[],
  hasOlder: boolean,
  hasNewer: boolean,
  myId: string,
): Thread {
  return {
    ...thread,
    status: 'ready',
    messages: [...window].sort((a, b) => a.seq - b.seq),
    pending: withoutConfirmed(thread.pending, window, myId),
    hasOlder,
    loadingOlder: false,
    hasNewer,
    loadingNewer: false,
    // 换成了另一段，原来记的位置不再算数
    through: 0,
  }
}

/** 向上翻阅取回来的更早的一段，接在最前面。 */
export function prependOlder(
  thread: Thread,
  older: readonly MessageView[],
  hasOlder: boolean,
): Thread {
  const first = firstSeq(thread)
  const fresh = [...older]
    .sort((a, b) => a.seq - b.seq)
    .filter((message) => thread.messages.length === 0 || message.seq < first)
  return { ...thread, messages: [...fresh, ...thread.messages], hasOlder, loadingOlder: false }
}

/** 正看着历史里的一段时向下翻取回来的更新的一段，接在最后面。接到最新一条就回到平时的样子。 */
export function appendNewer(
  thread: Thread,
  newer: readonly MessageView[],
  hasNewer: boolean,
  myId: string,
): Thread {
  const last = lastSeq(thread)
  const fresh = [...newer].sort((a, b) => a.seq - b.seq).filter((message) => message.seq > last)
  return {
    ...thread,
    messages: [...thread.messages, ...fresh],
    pending: withoutConfirmed(thread.pending, fresh, myId),
    hasNewer,
    loadingNewer: false,
  }
}

export function addPending(thread: Thread, message: PendingMessage): Thread {
  return { ...thread, pending: [...thread.pending, message] }
}

/** 改一条还没有确认的消息：发送失败、重新开始发送、上传的进度。改状态时清掉上一次的错误。 */
export function updatePending(
  thread: Thread,
  clientId: string,
  change: Partial<Pick<PendingMessage, 'status' | 'error' | 'attachment' | 'text' | 'mentions'>>,
): Thread {
  return {
    ...thread,
    pending: thread.pending.map((item) =>
      item.clientId === clientId
        ? { ...item, ...(change.status ? { error: undefined } : {}), ...change }
        : item,
    ),
  }
}

/** 拿掉一条还没有确认的消息（上传被取消了）。 */
export function removePending(thread: Thread, clientId: string): Thread {
  return { ...thread, pending: thread.pending.filter((item) => item.clientId !== clientId) }
}

/** 我听过了一条语音。 */
export function markPlayed(thread: Thread, seq: number): Thread {
  const target = thread.messages.find((message) => message.seq === seq)
  if (!target || target.played) return thread
  return {
    ...thread,
    messages: thread.messages.map((message) =>
      message.seq === seq ? { ...message, played: true } : message,
    ),
  }
}
