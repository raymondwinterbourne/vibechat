// 聊天在本地的全部状态：会话列表，每个打开过的会话里的消息，群的成员。
//
// 不依赖页面：页面订阅它的变化来显示，把用户的操作和服务端的推送交给它。

import type {
  ChatRecordView,
  ConversationView,
  MemberView,
  MessageView,
  QuoteView,
  ServerEvent,
} from '@vibechat/protocol'
import { ApiError } from '../api'
import type { Mentions } from './api'
import * as http from './api'
import {
  applyMessage,
  applyRead,
  changesGroup,
  seenNotice,
  sortConversations,
} from './conversations'
import { applyMemberRead } from './members'
import { MemoryOutbox, type Outbox, type OutboxEntry } from './outbox'
import {
  addPending,
  appendNewer,
  EMPTY_THREAD,
  firstSeq,
  lastSeq,
  loadLatest,
  loadWindow,
  markPlayed,
  mergeMessages,
  type PendingForward,
  type PendingMerge,
  type PendingMessage,
  prependOlder,
  removePending,
  type Thread,
  updatePending,
  withoutMessages,
  withoutUpTo,
} from './thread'

/** 用到的接口。测试时换成假的。 */
export type ChatApi = Pick<
  typeof http,
  | 'listConversations'
  | 'fetchConversation'
  | 'openDirectConversation'
  | 'listMessages'
  | 'sendMessage'
  | 'markConversationRead'
  | 'hideConversation'
  | 'muteConversation'
  | 'pinConversation'
  | 'deleteForMe'
  | 'clearForMe'
  | 'listMembers'
  | 'createGroup'
  | 'inviteMembers'
  | 'removeMember'
  | 'leaveGroup'
  | 'transferOwner'
  | 'setGroupAdmin'
  | 'muteMember'
  | 'unmuteMember'
  | 'setAllMuted'
  | 'setGroupNickname'
  | 'setJoinApproval'
  | 'handleJoinRequest'
  | 'renameGroup'
  | 'setGroupNotice'
  | 'markNoticeSeen'
  | 'uploadGroupAvatar'
  | 'dissolveGroup'
  | 'uploadFile'
  | 'recallMessage'
  | 'editMessage'
  | 'markVoicePlayed'
>

/** 发消息时除了内容之外可以带的东西。 */
export interface SendOptions {
  /** @ 了谁。只在群里的文本消息里有用。 */
  mentions?: Mentions
  /** 回复的是哪一条：被引用的那条消息。 */
  replyTo?: MessageView
  /**
   * 这段文字是和几个文件一起发出的：排在它们后面，等它们都发出去了再发。
   * 不这样的话文字不用上传、会先到，对方看到的顺序就和发的人看到的不一样。
   * 平时发文字不等：前面有个大文件正在传的时候，后发的一句话不应当被它拖住。
   */
  afterFiles?: boolean
}

/** 能不能转发：服务端确认过的文字、图片、文件、语音、聊天记录，没有撤回。系统提示不能。 */
export function isForwardable(message: MessageView): boolean {
  return (
    !message.recalled &&
    (message.kind === 'text' ||
      message.kind === 'image' ||
      message.kind === 'file' ||
      message.kind === 'voice' ||
      message.kind === 'chat_record')
  )
}

/** 一条聊天记录最多放多少条。 */
export const RECORD_MAX_ITEMS = 50

/** 发文件时除了文件之外可以带的东西。 */
export interface SendFileOptions {
  /** 语音的时长，毫秒。给了它，这个文件就按语音发。 */
  voiceDurationMs?: number
  /** 图片的文字说明。 */
  caption?: string
  /** 说明里 @ 了谁。 */
  mentions?: Mentions
  /** 回复的是哪一条。 */
  replyTo?: MessageView
}

/** 跳到一条消息的结果。 */
export type Jumped =
  /** 它已经在页面里了，或者刚取回来：可以滚动过去。 */
  | 'ready'
  /** 取不到：它不存在，或者我看不到它。 */
  | 'unavailable'

export interface ChatState {
  /** 会话列表，最新有动静的在前。还没有取回来时是 null。 */
  conversations: ConversationView[] | null
  /** 会话列表没有取到。取到了就不再是。 */
  listFailed: boolean
  /** 知道、但不在列表里的会话：还没有内容的，或者被我移除了的。打开它们时仍然要显示标题。 */
  unlisted: Record<string, ConversationView>
  /** 打开过的会话里的消息，按会话的编号存放。 */
  threads: Record<string, Thread>
  /** 打开过的群的成员，包括已经离开的。 */
  members: Record<string, MemberView[]>
  /** 每个群的入群申请变过几次：页面据此重新取申请列表。 */
  joinRequests: Record<string, number>
}

export interface ChatStoreOptions {
  /** 我的内部编号。 */
  me: string
  api?: ChatApi
  /** 发出去多久没有结果算发送失败。 */
  sendTimeoutMs?: number
  now?: () => number
  newClientId?: () => string
  /** 还没有确认的消息存在哪里。不给就只在内存里，刷新后就没有了。 */
  outbox?: Outbox
}

const DEFAULT_SEND_TIMEOUT_MS = 15_000
/** 补齐时一次取多少条。 */
const CATCH_UP_BATCH = 100
/** 跳到一条消息时，它前面和后面各取多少条。 */
const WINDOW_HALF = 25

/** 回复里显示的被引用消息的样子，从要引用的那条消息得出。 */
function quoteOf(message: MessageView): QuoteView {
  return {
    seq: message.seq,
    state: 'shown',
    sender_id: message.sender_id,
    sender_name: message.sender_name,
    kind: message.kind,
    // 聊天记录引用的是它的标题
    text: message.record?.title ?? message.text,
    file_name: message.kind === 'file' ? (message.file?.name ?? null) : null,
  }
}

export class ChatStore {
  private state: ChatState = {
    conversations: null,
    listFailed: false,
    unlisted: {},
    threads: {},
    members: {},
    joinRequests: {},
  }
  private readonly listeners = new Set<() => void>()
  private readonly me: string
  private readonly api: ChatApi
  private readonly sendTimeoutMs: number
  private readonly now: () => number
  private readonly newClientId: () => string
  /** 正在进行的补齐，每个会话最多一个。 */
  private readonly catchingUp = new Map<string, Promise<void>>()
  /** 用户此刻正看着最新消息的那个会话。新消息到了直接算已读。 */
  private viewing: string | null = null
  /** 正在进行的上传，按客户端消息编号。取消时用。 */
  private readonly uploads = new Map<string, AbortController>()
  /** 每个会话里排着队的上传：一个传完、发出去了，才开始下一个，对方看到的顺序就是选的顺序。 */
  private readonly queues = new Map<string, Promise<void>>()
  private readonly outbox: Outbox
  /** 存进 outbox 的每一条现在是什么样子，按客户端消息编号。没变就不再存一遍。 */
  private readonly saved = new Map<string, string>()
  /** 已经从 outbox 里取回过的会话。 */
  private readonly restored = new Set<string>()

  constructor(options: ChatStoreOptions) {
    this.me = options.me
    this.api = options.api ?? http
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.newClientId = options.newClientId ?? (() => crypto.randomUUID())
    this.outbox = options.outbox ?? new MemoryOutbox()
  }

  getState = (): ChatState => this.state

  /** 状态变化时调用。返回取消订阅的函数。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 一个会话：在列表里的，或者单独取回来过的。 */
  conversation(id: string): ConversationView | undefined {
    return (
      this.state.conversations?.find((conversation) => conversation.id === id) ??
      this.state.unlisted[id]
    )
  }

  thread(id: string): Thread {
    return this.state.threads[id] ?? EMPTY_THREAD
  }

  // ---------- 会话列表 ----------

  /** 取会话列表。 */
  async loadConversations(): Promise<void> {
    let fresh: ConversationView[]
    try {
      fresh = await this.api.listConversations()
    } catch (error) {
      // 已经有一份列表时，这一次没取到不算什么：下次重新连上还会再取
      if (this.state.conversations === null) this.set({ listFailed: true })
      throw error
    }
    const conversations = sortConversations(fresh.map((item) => this.keepNewer(item)))
    const listed = new Set(conversations.map((conversation) => conversation.id))
    const unlisted = Object.fromEntries(
      Object.entries(this.state.unlisted).filter(([id]) => !listed.has(id)),
    )
    this.set({ conversations, unlisted, listFailed: false })
  }

  /**
   * 连接建立或恢复之后调用：这之前的推送可能没有收到，把会话列表重新取一遍，
   * 再把打开过的会话里缺的消息补回来。
   */
  async resync(): Promise<void> {
    await this.loadConversations()
    const open = Object.keys(this.state.threads)
    await Promise.all(open.map((id) => this.catchUpIfBehind(id)))
    // 断线期间群里可能有人进出
    await Promise.all(Object.keys(this.state.members).map((id) => this.loadMembers(id)))
  }

  /** 取得我和一个好友的会话，返回它的编号。 */
  async openDirect(userId: string): Promise<string> {
    const conversation = await this.api.openDirectConversation(userId)
    this.remember(conversation)
    return conversation.id
  }

  /** 确保知道这个会话是和谁的。不在列表里时单独取一次；取不到会抛出错误。 */
  async ensureConversation(id: string): Promise<void> {
    if (this.conversation(id)) return
    this.remember(await this.api.fetchConversation(id))
  }

  /** 把会话从我的列表里移除。 */
  async hide(id: string): Promise<void> {
    await this.api.hideConversation(id)
    this.unlist(id)
  }

  /** 把会话设为免打扰，或者取消。界面先变；没有设成时变回去。 */
  async mute(id: string, muted: boolean): Promise<void> {
    const before = this.conversation(id)?.muted
    this.updateConversation(id, (conversation) => ({ ...conversation, muted }))
    try {
      await this.api.muteConversation(id, muted)
    } catch (error) {
      if (before !== undefined) {
        this.updateConversation(id, (conversation) => ({ ...conversation, muted: before }))
      }
      throw error
    }
  }

  // ---------- 删除和清空，只对自己（F6） ----------

  /** 把几条从我这边删掉。删掉之后会话列表的摘要、未读数以服务端的为准。 */
  async deleteForMe(id: string, seqs: readonly number[]): Promise<void> {
    const deleted = await this.api.deleteForMe(id, seqs)
    this.forget(id, deleted)
    await this.refreshListing(id)
  }

  /** 清空这个会话到现在为止的记录，只对我。会话还留在列表里。 */
  async clearForMe(id: string): Promise<void> {
    const seq = await this.api.clearForMe(id)
    this.forgetUpTo(id, seq)
    await this.refreshListing(id)
  }

  private forget(id: string, seqs: readonly number[]): void {
    if (this.state.threads[id]) this.setThread(id, (thread) => withoutMessages(thread, seqs))
  }

  private forgetUpTo(id: string, seq: number): void {
    if (this.state.threads[id]) this.setThread(id, (thread) => withoutUpTo(thread, seq))
  }

  /** 再取一次会话在我这边的样子：最新一条、未读数。 */
  private async refreshListing(id: string): Promise<void> {
    try {
      this.replace(await this.api.fetchConversation(id))
    } catch {
      // 取不到就等下一次补齐
    }
  }

  /** 置顶或者取消置顶。先在列表里挪过去，服务端说不行再挪回来。 */
  async pin(id: string, pinned: boolean): Promise<void> {
    const before = this.conversation(id)?.pinned_at
    const guess = pinned ? (before ?? this.now()) : null
    this.updateConversation(id, (conversation) => ({ ...conversation, pinned_at: guess }))
    this.resort()
    try {
      const pinnedAt = await this.api.pinConversation(id, pinned)
      this.updateConversation(id, (conversation) => ({ ...conversation, pinned_at: pinnedAt }))
    } catch (error) {
      if (before !== undefined) {
        this.updateConversation(id, (conversation) => ({ ...conversation, pinned_at: before }))
        this.resort()
      }
      throw error
    }
  }

  // ---------- 群 ----------

  /** 拉几个好友建一个群，返回它的编号。 */
  async createGroup(name: string, memberIds: string[]): Promise<string> {
    const group = await this.api.createGroup(name, memberIds)
    this.list(this.keepNewer(group))
    return group.id
  }

  /** 取群的成员名单。 */
  async loadMembers(id: string): Promise<void> {
    const members = await this.api.listMembers(id)
    this.set({ members: { ...this.state.members, [id]: members } })
  }

  /**
   * 邀请好友入群。返回发出了几条入群申请：开着入群审批、我又是普通成员时，邀请的人不直接进来，
   * 而是等群主或管理员同意；直接加进来时是 0。
   */
  async invite(id: string, userIds: string[]): Promise<number> {
    const result = await this.api.inviteMembers(id, userIds)
    await this.changed(result.conversation)
    if (result.requested > 0) this.joinRequestsChanged(id)
    return result.requested
  }

  /** 群主或管理员开关入群审批。 */
  async setJoinApproval(id: string, enabled: boolean): Promise<void> {
    await this.changed(await this.api.setJoinApproval(id, enabled))
  }

  /** 群主或管理员同意或拒绝一条入群申请。 */
  async handleJoinRequest(id: string, requestId: string, approve: boolean): Promise<void> {
    await this.changed(await this.api.handleJoinRequest(id, requestId, approve))
    this.joinRequestsChanged(id)
  }

  private joinRequestsChanged(id: string): void {
    const version = (this.state.joinRequests[id] ?? 0) + 1
    this.set({ joinRequests: { ...this.state.joinRequests, [id]: version } })
  }

  async removeMember(id: string, userId: string): Promise<void> {
    await this.changed(await this.api.removeMember(id, userId))
  }

  async transferOwner(id: string, userId: string): Promise<void> {
    await this.changed(await this.api.transferOwner(id, userId))
  }

  /** 群主设置或取消一名群管理员。 */
  async setAdmin(id: string, userId: string, admin: boolean): Promise<void> {
    await this.changed(await this.api.setGroupAdmin(id, userId, admin))
  }

  /** 禁言一名成员 `minutes` 分钟，为空是直到解除。 */
  async muteMember(id: string, userId: string, minutes: number | null): Promise<void> {
    await this.changed(await this.api.muteMember(id, userId, minutes))
  }

  async unmuteMember(id: string, userId: string): Promise<void> {
    await this.changed(await this.api.unmuteMember(id, userId))
  }

  async setAllMuted(id: string, muted: boolean): Promise<void> {
    await this.changed(await this.api.setAllMuted(id, muted))
  }

  /** 改我在这个群里的昵称，然后重新取名单。群里其他人收到推送后也会重新取。 */
  async setGroupNickname(id: string, nickname: string): Promise<void> {
    await this.api.setGroupNickname(id, nickname)
    await this.loadMembers(id)
  }

  async renameGroup(id: string, name: string): Promise<void> {
    await this.changed(await this.api.renameGroup(id, name))
  }

  /** 群主或管理员发布、修改或清空群公告。 */
  async setNotice(id: string, text: string): Promise<void> {
    await this.changed(await this.api.setGroupNotice(id, text))
  }

  /** 我看过了群公告：公告条立即消失，再告诉服务端。没报上去也没关系，下次打开还会出现。 */
  markNoticeSeen(id: string): void {
    if (!this.conversation(id)?.group?.notice_unseen) return
    this.updateConversation(id, (conversation) => seenNotice(conversation))
    this.api.markNoticeSeen(id).catch(() => {})
  }

  async setGroupAvatar(id: string, file: Blob): Promise<void> {
    await this.changed(await this.api.uploadGroupAvatar(id, file))
  }

  async dissolve(id: string): Promise<void> {
    await this.changed(await this.api.dissolveGroup(id))
  }

  /** 退出一个群。它随即从我的列表里消失。 */
  async leave(id: string): Promise<void> {
    await this.api.leaveGroup(id)
    this.unlist(id)
  }

  /** 我对群做了改动：用服务端交回来的最新样子替换，成员名单也重新取。 */
  private async changed(group: ConversationView): Promise<void> {
    this.replace(this.keepNewer(group))
    if (this.state.members[group.id]) await this.loadMembers(group.id)
  }

  /** 群本身变了（有人进出、换了群主、改了名）：把它和成员名单重新取一遍。 */
  private async refreshGroup(id: string): Promise<void> {
    this.replace(this.keepNewer(await this.api.fetchConversation(id)))
    if (this.state.members[id]) await this.loadMembers(id)
  }

  // ---------- 消息 ----------

  /** 打开一个会话：取回最新的一段消息；是群的话同时取成员名单。已经取过就不再取。 */
  async openThread(id: string): Promise<void> {
    const status = this.thread(id).status
    if (status === 'loading' || status === 'ready') return
    this.setThread(id, (thread) => ({ ...thread, status: 'loading' }))
    try {
      const page = await this.api.listMessages(id)
      this.setThread(id, (thread) => loadLatest(thread, page.items, page.has_more, this.me))
    } catch (error) {
      this.setThread(id, (thread) => ({ ...thread, status: 'error' }))
      throw error
    }
    await this.restoreUnsent(id)
    if (this.conversation(id)?.kind === 'group' && !this.state.members[id]) {
      // 名单取不到不妨碍看消息，名称先用消息里带的
      this.loadMembers(id).catch(() => {})
    }
    // 取的这一会儿可能又来了新消息，推送到的时候这里还没有准备好
    await this.catchUpIfBehind(id)
  }

  /** 向上翻阅：取回比已经加载的更早的一段。 */
  async loadOlder(id: string): Promise<void> {
    const thread = this.thread(id)
    if (thread.status !== 'ready' || !thread.hasOlder || thread.loadingOlder) return
    this.setThread(id, (current) => ({ ...current, loadingOlder: true }))
    try {
      const page = await this.api.listMessages(id, { before: firstSeq(thread) })
      this.setThread(id, (current) => prependOlder(current, page.items, page.has_more))
    } catch (error) {
      this.setThread(id, (current) => ({ ...current, loadingOlder: false }))
      throw error
    }
  }

  /**
   * 正看着历史里的一段时向下翻：取回比已经加载的更新的一段。
   * 接到最新一条之后，就回到平时的样子，新消息照常往后接。
   */
  async loadNewer(id: string): Promise<void> {
    const thread = this.thread(id)
    if (thread.status !== 'ready' || !thread.hasNewer || thread.loadingNewer) return
    this.setThread(id, (current) => ({ ...current, loadingNewer: true }))
    try {
      const page = await this.api.listMessages(id, { after: lastSeq(thread) })
      this.setThread(id, (current) => appendNewer(current, page.items, page.has_more, this.me))
    } catch (error) {
      this.setThread(id, (current) => ({ ...current, loadingNewer: false }))
      throw error
    }
    if (this.viewing === id) this.markRead(id)
  }

  /**
   * 跳到一条消息：点击引用、点击搜索结果时用。它已经加载了就什么也不用取；
   * 否则取回它附近的一段，换掉已经加载的。
   */
  async jumpTo(id: string, seq: number): Promise<Jumped> {
    const thread = this.thread(id)
    if (thread.status === 'ready' && thread.messages.some((message) => message.seq === seq)) {
      return 'ready'
    }
    // 前面的一段带上它自己，后面的一段从它之后开始
    const [older, newer] = await Promise.all([
      this.api.listMessages(id, { before: seq + 1, limit: WINDOW_HALF }),
      this.api.listMessages(id, { after: seq, limit: WINDOW_HALF }),
    ])
    if (!older.items.some((message) => message.seq === seq)) return 'unavailable'
    this.setThread(id, (current) =>
      loadWindow(
        current,
        [...older.items, ...newer.items],
        older.has_more,
        newer.has_more,
        this.me,
      ),
    )
    return 'ready'
  }

  /** 从历史里的一段回到最新：丢掉已经加载的，重新取最新的一段。 */
  async jumpToLatest(id: string): Promise<void> {
    if (!this.thread(id).hasNewer) return
    this.setThread(id, (thread) => ({ ...EMPTY_THREAD, pending: thread.pending }))
    await this.openThread(id)
  }

  /** 发一条文本消息。它立即出现在会话里，状态是"发送中"。返回它的客户端消息编号。 */
  send(id: string, text: string, options: SendOptions = {}): string {
    const clientId = this.newClientId()
    this.addPending(id, {
      clientId,
      text,
      mentions: options.mentions,
      reply: options.replyTo && quoteOf(options.replyTo),
      createdAt: this.now(),
      status: 'sending',
    })
    if (options.afterFiles) this.enqueue(id, () => this.deliver(id, clientId))
    else void this.deliver(id, clientId)
    return clientId
  }

  /**
   * 发一个文件：图片、文件，或者一段语音（给了时长）。先上传，传完再发出去。
   * 它立即出现在会话里，带着上传的进度。同一个会话里的文件一个接一个地传。
   * 图片可以带一段文字说明；传上去之后服务端认定它不是图片，说明就在它后面单独发一条。
   */
  sendFile(id: string, content: Blob, name: string, options: SendFileOptions = {}): string {
    const clientId = this.newClientId()
    this.addPending(id, {
      clientId,
      text: options.caption ?? '',
      mentions: options.caption ? options.mentions : undefined,
      reply: options.replyTo && quoteOf(options.replyTo),
      attachment: {
        content,
        name,
        size: content.size,
        progress: 0,
        voiceDurationMs: options.voiceDurationMs,
      },
      createdAt: this.now(),
      status: 'uploading',
    })
    this.enqueue(id, () => this.uploadThenDeliver(id, clientId))
    return clientId
  }

  /** 取消一个还在上传的文件：它从会话里消失，服务端不留下任何东西。 */
  cancelUpload(id: string, clientId: string): void {
    this.uploads.get(clientId)?.abort()
    this.setThread(id, (thread) => removePending(thread, clientId))
  }

  /** 重发一条发送失败的消息。用的还是原来的编号，所以对方不会收到两条。 */
  retry(id: string, clientId: string): void {
    const pending = this.pending(id, clientId)
    if (pending?.status !== 'failed') return
    if (pending.attachment) {
      let { attachment } = pending
      // 传上去了、但很久没有发出去，服务端已经把它清理掉了：用保存着的文件重新传
      if (pending.error === 'file_unavailable' && attachment.content) {
        attachment = { ...attachment, file: undefined, progress: 0 }
      }
      // 文件没有保存下来，又没有传上去过：没有东西可发，只能删掉
      if (!attachment.file && !attachment.content) return
      // 已经传上去了的不用再传
      const status = attachment.file ? 'sending' : 'uploading'
      this.setThread(id, (thread) => updatePending(thread, clientId, { status, attachment }))
      this.enqueue(id, () => this.uploadThenDeliver(id, clientId))
      return
    }
    this.setThread(id, (thread) => updatePending(thread, clientId, { status: 'sending' }))
    void this.deliver(id, clientId)
  }

  /**
   * 转发：把这几条消息发到这几个会话里。每个会话里按原来的先后一条接一条地发，
   * 每一条都立即出现在那个会话里，和自己发的消息一样有发送中、发送失败。
   * 只有文字、图片、文件、语音、聊天记录能转发；其余的跳过。
   */
  forward(targets: readonly string[], messages: readonly MessageView[]): void {
    const forwardable = [...messages]
      .filter((message) => isForwardable(message))
      .sort((a, b) => a.seq - b.seq)
    for (const target of targets) {
      for (const message of forwardable) {
        const clientId = this.newClientId()
        this.addPending(target, {
          clientId,
          text: message.text ?? '',
          forward: {
            conversationId: message.conversation_id,
            seq: message.seq,
            kind: message.kind as PendingForward['kind'],
            file: message.file,
            durationMs: message.duration_ms ?? undefined,
            record: message.record ?? undefined,
          },
          createdAt: this.now(),
          status: 'sending',
        })
        this.enqueue(target, () => this.deliver(target, clientId))
      }
    }
  }

  /**
   * 合并转发：把同一个会话里的这几条做成一条聊天记录，发到这几个会话里。
   * `record` 是页面拼好的样子（标题、每一条的发送人和内容），发送中先这样显示；
   * 确认后换成服务端存下的那一份。不能转发的跳过；一条都不剩就什么也不做。
   */
  forwardMerged(
    targets: readonly string[],
    messages: readonly MessageView[],
    record: ChatRecordView,
  ): void {
    const chosen = [...messages]
      .filter((message) => isForwardable(message))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, RECORD_MAX_ITEMS)
    const [first] = chosen
    if (!first) return
    const merge: PendingMerge = {
      conversationId: first.conversation_id,
      seqs: chosen.map((message) => message.seq),
      record,
    }
    for (const target of targets) {
      const clientId = this.newClientId()
      this.addPending(target, {
        clientId,
        text: '',
        merge,
        createdAt: this.now(),
        status: 'sending',
      })
      this.enqueue(target, () => this.deliver(target, clientId))
    }
  }

  /** 删掉一条没有发出去的消息：它从会话里消失，也不再保存在这台设备上。 */
  discard(id: string, clientId: string): void {
    this.uploads.get(clientId)?.abort()
    this.setThread(id, (thread) => removePending(thread, clientId))
  }

  /** 撤回自己发的一条消息。 */
  async recall(id: string, seq: number): Promise<void> {
    this.receive(await this.api.recallMessage(id, seq))
  }

  /**
   * 编辑我发的一条消息（F8）。交回的编辑事件和推送来的一样处理：已经加载的那一条换成新的内容。
   * 没成功时把服务端的错误交给调用的地方（例如已经超过时限）。
   */
  async edit(
    id: string,
    seq: number,
    text: string,
    options: { mentions?: readonly string[]; mentionAll?: boolean } = {},
  ): Promise<void> {
    const event = await this.api.editMessage(id, seq, {
      text,
      mentions: options.mentions ? [...options.mentions] : [],
      mention_all: options.mentionAll ?? false,
    })
    this.receive(event)
  }

  /** 我听了一条语音：没听过的标记立即消失，再告诉服务端。 */
  markPlayed(id: string, seq: number): void {
    const message = this.thread(id).messages.find((item) => item.seq === seq)
    if (!message || message.played || message.sender_id === this.me) return
    this.setThread(id, (thread) => markPlayed(thread, seq))
    // 没报上去也没关系：下次再听时会再报
    this.api.markVoicePlayed(id, seq).catch(() => {})
  }

  private pending(id: string, clientId: string): PendingMessage | undefined {
    return this.thread(id).pending.find((item) => item.clientId === clientId)
  }

  private addPending(id: string, message: PendingMessage): void {
    // 正看着历史里的一段时发消息：先回到最新，自己发的这一条才看得到
    if (this.thread(id).hasNewer) {
      this.setThread(id, (thread) => ({ ...EMPTY_THREAD, pending: thread.pending }))
      this.openThread(id).catch(() => {})
    }
    this.setThread(id, (thread) => addPending(thread, message))
  }

  private enqueue(id: string, job: () => Promise<void>): void {
    const previous = this.queues.get(id) ?? Promise.resolve()
    this.queues.set(id, previous.then(job, job))
  }

  private async uploadThenDeliver(id: string, clientId: string): Promise<void> {
    const pending = this.pending(id, clientId)
    // 排队的时候被取消了
    if (!pending?.attachment) return
    if (!pending.attachment.file) {
      const abort = new AbortController()
      this.uploads.set(clientId, abort)
      const progress = (fraction: number) => {
        const current = this.pending(id, clientId)?.attachment
        if (!current) return
        const attachment = { ...current, progress: fraction }
        this.setThread(id, (thread) => updatePending(thread, clientId, { attachment }))
      }
      try {
        const { content, name } = pending.attachment
        // 刷新之前没有存下来的文件：传不了
        if (!content) {
          this.setThread(id, (thread) =>
            updatePending(thread, clientId, { status: 'failed', error: 'file_not_saved' }),
          )
          return
        }
        const file = await this.api.uploadFile(content, name, {
          signal: abort.signal,
          onProgress: progress,
        })
        const current = this.pending(id, clientId)
        if (!current?.attachment) return
        const attachment = { ...current.attachment, progress: 1, file }
        this.setThread(id, (thread) =>
          updatePending(thread, clientId, { status: 'sending', attachment }),
        )
        // 只有图片能带说明。服务端认定这不是图片（例如浏览器以为是图片的 HEIC）：
        // 文件照发，说明单独一条排在它后面
        if (current.text.trim() !== '' && file.width === null) {
          const { text, mentions } = current
          this.setThread(id, (thread) =>
            updatePending(thread, clientId, { text: '', mentions: undefined }),
          )
          this.send(id, text, { mentions, afterFiles: true })
        }
      } catch (error) {
        // 被取消的已经从会话里拿掉了
        if (this.pending(id, clientId)) {
          const code = error instanceof ApiError ? error.code : 'network_error'
          this.setThread(id, (thread) =>
            updatePending(thread, clientId, { status: 'failed', error: code }),
          )
        }
        return
      } finally {
        this.uploads.delete(clientId)
      }
    }
    await this.deliver(id, clientId)
  }

  private async deliver(id: string, clientId: string): Promise<void> {
    const pending = this.pending(id, clientId)
    if (!pending) return
    const { attachment } = pending
    const { merge } = pending
    const content: http.Outgoing = merge
      ? {
          merge: {
            conversationId: merge.conversationId,
            seqs: merge.seqs,
            title: merge.record.title,
          },
        }
      : pending.forward
        ? { forward: { conversationId: pending.forward.conversationId, seq: pending.forward.seq } }
        : {
            mentions: pending.mentions,
            replyTo: pending.reply?.seq,
            ...(attachment
              ? {
                  fileId: attachment.file?.id,
                  voiceDurationMs: attachment.voiceDurationMs,
                  text: pending.text.trim() === '' ? undefined : pending.text,
                }
              : { text: pending.text }),
          }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.sendTimeoutMs)
    try {
      const message = await this.api.sendMessage(id, clientId, content, {
        signal: abort.signal,
      })
      this.receive(message)
    } catch (error) {
      // 可能只是没等到应答、其实已经送达了：这时推送或补齐会把它确认掉，不用再标成失败
      const stillPending = this.thread(id).pending.some((item) => item.clientId === clientId)
      if (stillPending) {
        const code = error instanceof ApiError ? error.code : 'network_error'
        this.setThread(id, (thread) =>
          updatePending(thread, clientId, { status: 'failed', error: code }),
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------- 已读 ----------

  /**
   * 页面告诉这里：用户此刻是否正看着某个会话的最新消息
   * （会话打开着、页面在前台、滚动在最底部）。是的话，到了的消息都算已读。
   */
  setViewing(id: string | null): void {
    this.viewing = id
    if (id) this.markRead(id)
  }

  /** 把已经显示出来的消息报为已读。 */
  private markRead(id: string): void {
    const conversation = this.conversation(id)
    // 正看着历史里的一段时，最新的那些还没有看到
    if (this.thread(id).hasNewer) return
    const seq = lastSeq(this.thread(id))
    if (!conversation || seq <= conversation.read_seq) return
    // 界面先改，不等服务端的应答
    this.updateConversation(id, (current) => {
      // 我看得到的最新一条：被我删掉、清空掉的不算（F6）
      const caughtUp = seq >= (current.last_message?.seq ?? current.last_seq)
      return {
        ...current,
        read_seq: seq,
        unread: caughtUp ? 0 : current.unread,
        group: current.group && caughtUp ? { ...current.group, mentioned: false } : current.group,
      }
    })
    // 没报上去也没关系：下一条消息到来或者重新连上时会再报
    this.api.markConversationRead(id, seq).catch(() => {})
  }

  // ---------- 服务端的推送 ----------

  handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'msg.new':
        this.receive(event.data)
        break
      case 'conv.read': {
        const read = event.data
        let stale = false
        this.updateConversation(read.conversation_id, (conversation) => {
          const applied = applyRead(conversation, read, this.me)
          stale = applied.stale
          return applied.conversation
        })
        if (stale) void this.loadConversations().catch(() => {})
        // 群里某个人读到了哪里：发送方据此显示已读人数
        const members = this.state.members[read.conversation_id]
        if (members) {
          this.set({
            members: {
              ...this.state.members,
              [read.conversation_id]: applyMemberRead(members, read),
            },
          })
        }
        break
      }
      case 'conv.hidden':
        this.unlist(event.data.conversation_id)
        break
      case 'conv.muted': {
        // 我在别处把它设成了免打扰，或者取消了
        const { conversation_id, muted } = event.data
        this.updateConversation(conversation_id, (conversation) => ({ ...conversation, muted }))
        break
      }
      case 'conv.pinned': {
        // 我在别处把它置顶了，或者取消了：列表重新排
        const { conversation_id, pinned_at } = event.data
        this.updateConversation(conversation_id, (conversation) => ({ ...conversation, pinned_at }))
        this.resort()
        break
      }
      case 'conv.join_requests': {
        // 入群申请变了：待处理的数目在会话信息里，列表让页面重新取
        const id = event.data.conversation_id
        if (this.conversation(id)) void this.refreshGroup(id).catch(() => {})
        this.joinRequestsChanged(id)
        break
      }
      case 'conv.members': {
        // 群里有人改了群内昵称：取过名单的重新取
        const id = event.data.conversation_id
        if (this.state.members[id]) void this.loadMembers(id).catch(() => {})
        break
      }
      case 'conv.notice_seen': {
        // 我在别处看过了这个群的公告
        const { conversation_id, seq } = event.data
        this.updateConversation(conversation_id, (conversation) =>
          conversation.group?.notice?.seq === seq ? seenNotice(conversation) : conversation,
        )
        break
      }
      case 'msg.deleted': {
        // 我在别处把这几条从自己这边删掉了
        const { conversation_id, seqs } = event.data
        this.forget(conversation_id, seqs)
        void this.refreshListing(conversation_id)
        break
      }
      case 'conv.cleared': {
        // 我在别处清空了这个会话的记录
        const { conversation_id, cleared_seq } = event.data
        this.forgetUpTo(conversation_id, cleared_seq)
        void this.refreshListing(conversation_id)
        break
      }
      case 'msg.played': {
        // 我在别处听过了这条语音
        const { conversation_id, seq } = event.data
        if (this.state.threads[conversation_id]) {
          this.setThread(conversation_id, (thread) => markPlayed(thread, seq))
        }
        break
      }
    }
  }

  /** 一条服务端确认过的消息：来自推送、发送的应答或补齐，都走这里。 */
  private receive(message: MessageView): void {
    const id = message.conversation_id
    const known = this.conversation(id)
    const groupChanged = changesGroup(message)
    const involvesMe = (party: { id: string }) => party.id === this.me

    // 我被拉回了一个离开过的群：以前在群里时的消息不再可见，这个会话从头再取
    if (message.kind === 'member_joined' && message.targets.some(involvesMe) && known) {
      this.reopen(id)
    }

    if (known) {
      const updated = applyMessage(known, message, this.me)
      const iLeft = message.kind === 'member_left' && message.actor?.id === this.me
      if (iLeft) {
        // 自己退的群（可能是在别处退的）不留在列表里
        this.replace(updated)
        this.unlist(id)
      } else if (updated !== known) {
        // 有了新内容的会话要出现在列表里，并排到前面
        this.list(updated)
      }
      if (groupChanged) this.refreshGroup(id).catch(() => {})
    } else if (this.state.conversations !== null) {
      // 一个还不知道的会话：新的，或者被移除之后又有了消息
      void this.loadConversations().catch(() => {})
    }

    const thread = this.state.threads[id]
    if (thread?.status === 'ready') {
      const merged = mergeMessages(thread, [message], this.me)
      if (merged.thread !== thread) this.setThread(id, () => merged.thread)
      if (merged.gap) void this.catchUp(id).catch(() => {})
    } else if (thread?.status === 'idle' && message.sender_id === this.me && message.client_id) {
      // 还没有打开过的会话（例如转发到这里）：确认了的就不再是没发出去的。
      // 正在打开的会话不在这里管：取回来的那一段里有它，到时候自然换掉，免得它先消失一下
      const clientId = message.client_id
      if (thread.pending.some((item) => item.clientId === clientId)) {
        this.setThread(id, (current) => removePending(current, clientId))
      }
    }
    if (this.viewing === id) this.markRead(id)
  }

  private async catchUpIfBehind(id: string): Promise<void> {
    const conversation = this.conversation(id)
    const thread = this.state.threads[id]
    if (!conversation || thread?.status !== 'ready') return
    // 正看着历史里的一段时不往后接，等用户自己翻到最新
    if (thread.hasNewer) return
    // 我看得到的最新一条比已经加载的新才去取：被我删掉的最后几条取不到，不用一直去取（F6）
    const latest = conversation.last_message?.seq ?? conversation.last_seq
    if (latest > lastSeq(thread)) await this.catchUp(id)
  }

  /** 把已经加载的最新一条之后的消息全部取回来。 */
  private catchUp(id: string): Promise<void> {
    const running = this.catchingUp.get(id)
    if (running) return running
    const run = (async () => {
      let rangeChanged = false
      try {
        for (;;) {
          const after = lastSeq(this.thread(id))
          const page = await this.api.listMessages(id, { after, limit: CATCH_UP_BATCH })
          const first = page.items[0]
          if (first && first.seq > after + 1) {
            // 服务端交回来的不是紧接着的下一条：中间有一段我看不到（离开过又回来了）
            rangeChanged = true
            break
          }
          this.setThread(id, (thread) => mergeMessages(thread, page.items, this.me).thread)
          if (!page.has_more) break
        }
      } finally {
        this.catchingUp.delete(id)
      }
      if (rangeChanged) this.reopen(id)
      else if (this.viewing === id) this.markRead(id)
    })()
    this.catchingUp.set(id, run)
    return run
  }

  /** 丢掉一个会话里已经加载的消息。它正打开着的话，重新取一遍。 */
  private reopen(id: string): void {
    const thread = this.state.threads[id]
    if (!thread) return
    // 正在发的那几条留着
    this.setThread(id, () => ({ ...EMPTY_THREAD, pending: thread.pending }))
    if (thread.status === 'ready' || thread.status === 'loading') {
      this.openThread(id).catch(() => {})
    }
  }

  // ---------- 改状态 ----------

  private set(change: Partial<ChatState>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }

  private setThread(id: string, change: (thread: Thread) => Thread): void {
    const before = this.thread(id).pending
    const thread = change(this.thread(id))
    this.set({ threads: { ...this.state.threads, [id]: thread } })
    if (thread.pending !== before) this.saveUnsent(id, before, thread.pending)
  }

  /**
   * 还没有确认的消息跟着变化存进 outbox：新的、内容变了的存下，确认了的、删掉了的拿掉。
   * 只看会影响重发的内容，上传进度和状态不算：刷新之后它们一律是"发送失败"。
   */
  private saveUnsent(id: string, before: PendingMessage[], after: PendingMessage[]): void {
    const kept = new Set(after.map((item) => item.clientId))
    for (const item of before) {
      if (kept.has(item.clientId)) continue
      this.saved.delete(item.clientId)
      this.outbox.remove(this.me, item.clientId).catch(() => {})
    }
    for (const item of after) {
      const { attachment } = item
      const entry: OutboxEntry = {
        userId: this.me,
        conversationId: id,
        clientId: item.clientId,
        text: item.text,
        mentions: item.mentions,
        reply: item.reply,
        forward: item.forward,
        merge: item.merge,
        createdAt: item.createdAt,
        attachment: attachment && {
          content: attachment.content,
          name: attachment.name,
          size: attachment.size,
          voiceDurationMs: attachment.voiceDurationMs,
          file: attachment.file,
        },
      }
      const shape = JSON.stringify({ ...entry, attachment: { ...entry.attachment, content: null } })
      if (this.saved.get(item.clientId) === shape) continue
      this.saved.set(item.clientId, shape)
      this.outbox.put(entry).catch(() => {})
    }
  }

  /**
   * 打开一个会话时，把上次没有发出去的消息取回来，显示为发送失败。
   * 刚取回来的最新一段里已经有了的（当时其实已经送达），不再显示。
   */
  private async restoreUnsent(id: string): Promise<void> {
    if (this.restored.has(id)) return
    this.restored.add(id)
    let entries: OutboxEntry[]
    try {
      entries = await this.outbox.load(this.me, id)
    } catch {
      return
    }
    const thread = this.thread(id)
    const delivered = new Set(
      thread.messages.filter((item) => item.sender_id === this.me).map((item) => item.client_id),
    )
    const present = new Set(thread.pending.map((item) => item.clientId))
    const restored: PendingMessage[] = []
    for (const entry of entries) {
      if (delivered.has(entry.clientId)) {
        this.outbox.remove(this.me, entry.clientId).catch(() => {})
        continue
      }
      if (present.has(entry.clientId)) continue
      const attachment = entry.attachment && { ...entry.attachment, progress: 0 }
      const lost = attachment !== undefined && !attachment.content && !attachment.file
      restored.push({
        clientId: entry.clientId,
        text: entry.text,
        mentions: entry.mentions,
        reply: entry.reply,
        forward: entry.forward,
        merge: entry.merge,
        createdAt: entry.createdAt,
        attachment,
        status: 'failed',
        error: lost ? 'file_not_saved' : 'interrupted',
      })
    }
    if (restored.length === 0) return
    // 上次留下的比这次新发的早，排在前面
    this.setThread(id, (current) => ({ ...current, pending: [...restored, ...current.pending] }))
  }

  /**
   * 服务端交回来的一个会话。取的这一会儿本地可能已经走到了前面，这时以本地的为准：
   *
   * - 推送又带来了更新的消息：最新一条和未读数用本地的。
   * - 我刚把它读完、已读位置报上去了，而取回来的这一份是在那之前生成的：已读位置只前进不后退，
   *   所以已读位置、未读数、"有人 @ 我"都用本地的。否则刚消掉的未读数又会冒出来。
   */
  private keepNewer(fresh: ConversationView): ConversationView {
    const known = this.conversation(fresh.id)
    if (!known) return fresh
    let merged = fresh
    if (known.last_seq > fresh.last_seq) {
      merged = {
        ...merged,
        last_seq: known.last_seq,
        last_message: known.last_message,
        unread: known.unread,
      }
    }
    if (known.read_seq > fresh.read_seq) {
      merged = {
        ...merged,
        read_seq: known.read_seq,
        unread: known.unread,
        group:
          merged.group && known.group
            ? { ...merged.group, mentioned: known.group.mentioned }
            : merged.group,
      }
    }
    return merged
  }

  /** 记住一个会话。它不在列表里时先放在一边，等有了内容再进列表。 */
  private remember(conversation: ConversationView): void {
    if (this.state.conversations?.some((listed) => listed.id === conversation.id)) return
    this.set({ unlisted: { ...this.state.unlisted, [conversation.id]: conversation } })
  }

  /** 换成一个会话的新样子。它在列表里就还在列表里，不在的还放在一边。 */
  private replace(conversation: ConversationView): void {
    const { conversations, unlisted } = this.state
    if (conversations?.some((listed) => listed.id === conversation.id)) {
      this.set({
        conversations: sortConversations(
          conversations.map((listed) => (listed.id === conversation.id ? conversation : listed)),
        ),
      })
    } else {
      this.set({ unlisted: { ...unlisted, [conversation.id]: conversation } })
    }
  }

  /** 把一个会话放进列表（已经在的换成新的），并重新排好顺序。 */
  private list(conversation: ConversationView): void {
    if (this.state.conversations === null) {
      // 列表还没有取回来：先记在一边，列表到了以它为准
      this.set({ unlisted: { ...this.state.unlisted, [conversation.id]: conversation } })
      return
    }
    const others = this.state.conversations.filter((listed) => listed.id !== conversation.id)
    const { [conversation.id]: _, ...unlisted } = this.state.unlisted
    this.set({ conversations: sortConversations([...others, conversation]), unlisted })
  }

  /** 把一个会话从列表里拿掉。还记着它，正打开着的页面仍然能显示标题。 */
  private unlist(id: string): void {
    const conversation = this.conversation(id)
    if (!conversation || this.state.conversations === null) return
    this.set({
      conversations: this.state.conversations.filter((listed) => listed.id !== id),
      unlisted: { ...this.state.unlisted, [id]: conversation },
    })
  }

  /** 列表按现在的样子重新排一次：置顶变了的时候。 */
  private resort(): void {
    const { conversations } = this.state
    if (conversations) this.set({ conversations: sortConversations(conversations) })
  }

  private updateConversation(
    id: string,
    change: (conversation: ConversationView) => ConversationView,
  ): void {
    const { conversations, unlisted } = this.state
    if (conversations?.some((conversation) => conversation.id === id)) {
      this.set({
        conversations: conversations.map((conversation) =>
          conversation.id === id ? change(conversation) : conversation,
        ),
      })
    } else if (unlisted[id]) {
      this.set({ unlisted: { ...unlisted, [id]: change(unlisted[id]) } })
    }
  }
}
