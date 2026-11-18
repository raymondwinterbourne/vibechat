import type { ConversationView, GroupView, MemberView, MessageView } from '@vibechat/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api'
import type { Outgoing } from './api'
import { MemoryOutbox, type Outbox } from './outbox'
import { type ChatApi, ChatStore, isForwardable } from './store'

const ME = 'me'
const PEER = 'peer'

/** 一个假的服务端：消息存在内存里，可以让下一次发送失败、卡住，或者"存下了但应答丢了"。 */
class FakeServer {
  conversations: ConversationView[] = []
  log: Record<string, MessageView[]> = {}
  /** 每一次接口调用，按先后记下来。 */
  calls: string[] = []
  /** 接下来的发送怎么处理。 */
  sending: 'ok' | 'fail' | 'lose-reply' | 'hang' = 'ok'
  private clock = 1000

  /** 建一个和对方的会话，里面已经有 `count` 条对方发的消息，我都看过了。 */
  conversation(id: string, count: number): ConversationView {
    this.log[id] = []
    for (let n = 0; n < count; n++) this.append(id, PEER, `old ${n + 1}`, null)
    const conversation: ConversationView = {
      id,
      kind: 'direct',
      peer: {
        user: { id: PEER, handle: 'peer_id', nickname: '小红', avatar_file_id: null },
        is_self: false,
        remark: null,
        is_friend: true,
        read_seq: 0,
      },
      group: null,
      last_seq: count,
      read_seq: count,
      last_message: this.log[id]?.at(-1) ?? null,
      unread: 0,
      muted: false,
      pinned_at: null,
    }
    this.conversations.push(conversation)
    return conversation
  }

  /** 往会话里存一条，像真的服务端那样分配序号，并让会话列表跟着变。 */
  append(id: string, sender: string, text: string, clientId: string | null): MessageView {
    const log = this.log[id] ?? []
    this.log[id] = log
    const conversation = this.conversations.find((item) => item.id === id)
    // 删掉、清空的序号不回收
    const seq = Math.max(log.at(-1)?.seq ?? 0, conversation?.last_seq ?? 0) + 1
    const message: MessageView = {
      id: `${id}-${seq}`,
      conversation_id: id,
      seq,
      sender_id: sender,
      client_id: clientId,
      kind: 'text',
      text,
      sender_name: null,
      actor: null,
      targets: [],
      name: null,
      mentions: [],
      mention_all: false,
      file: null,
      duration_ms: null,
      record: null,
      call_outcome: null,
      call_video: false,
      call_joined: null,
      approver: null,
      until: null,
      reply: null,
      recalled: false,
      target_seq: null,
      played: false,
      edited_at: null,
      previous_text: null,
      created_at: this.clock++,
    }
    log.push(message)
    if (conversation) {
      conversation.last_seq = message.seq
      conversation.last_message = message
      if (sender !== ME) conversation.unread += 1
    }
    return message
  }

  api: ChatApi = {
    listConversations: async () => {
      this.calls.push('list')
      return this.conversations.filter((item) => item.last_seq > 0).map((item) => ({ ...item }))
    },
    fetchConversation: async (id) => {
      this.calls.push(`fetch ${id}`)
      const found = this.conversations.find((item) => item.id === id)
      if (!found) throw new ApiError('conversation_not_found', 404, 'no such conversation')
      return { ...found }
    },
    openDirectConversation: async (userId) => {
      this.calls.push(`direct ${userId}`)
      const found = this.conversations.find((item) => item.peer?.user.id === userId)
      if (!found) throw new ApiError('not_friends', 404, 'not friends')
      return { ...found }
    },
    listMessages: async (id, range = {}) => {
      this.calls.push(`messages ${id} ${JSON.stringify(range)}`)
      const log = this.log[id] ?? []
      const limit = range.limit ?? 50
      if (range.after !== undefined) {
        const after = range.after
        const rest = log.filter((item) => item.seq > after)
        return { items: rest.slice(0, limit), has_more: rest.length > limit }
      }
      const before = range.before ?? Number.POSITIVE_INFINITY
      const earlier = log.filter((item) => item.seq < before)
      return { items: earlier.slice(-limit), has_more: earlier.length > limit }
    },
    sendMessage: async (id, clientId, content, options) => {
      const text = content.text ?? ''
      this.calls.push(`send ${id} ${clientId}`)
      if (this.sending === 'fail') throw new ApiError('network_error', null, 'offline')
      if (content.fileId && this.expired.has(content.fileId)) {
        throw new ApiError('file_unavailable', 404, 'no such file')
      }
      if (this.sending === 'hang') {
        // 永远等不到应答，直到被调用方放弃
        return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        })
      }
      const existing = this.log[id]?.find(
        (item) => item.sender_id === ME && item.client_id === clientId,
      )
      const message = existing ?? this.append(id, ME, text, clientId)
      if (!existing && content.forward) {
        // 转发：内容从原消息复制
        const { conversationId, seq } = content.forward
        const source = this.log[conversationId]?.find((item) => item.seq === seq)
        if (source)
          Object.assign(message, { kind: source.kind, text: source.text, file: source.file })
      }
      if (!existing && content.merge) {
        // 合并转发：做成一条聊天记录
        const { conversationId, seqs, title } = content.merge
        const items = seqs.flatMap((seq) => {
          const source = this.log[conversationId]?.find((item) => item.seq === seq)
          if (!source) return []
          return [
            {
              sender_id: source.sender_id,
              sender_name: source.sender_id ?? '',
              sender_avatar_file_id: null,
              kind: source.kind,
              text: source.text,
              file: source.file,
              duration_ms: source.duration_ms,
              created_at: source.created_at,
            },
          ]
        })
        Object.assign(message, { kind: 'chat_record', text: null, record: { title, items } })
      }
      if (!existing) {
        this.sent.push(content)
        if (content.fileId) {
          const name = content.fileId.replace(/^f-/, '')
          Object.assign(message, {
            kind: content.voiceDurationMs ? 'voice' : name.endsWith('.png') ? 'image' : 'file',
            // 图片的说明
            text: content.text ?? null,
            file: { id: content.fileId, name, size: 1, width: null, height: null, audio: false },
            duration_ms: content.voiceDurationMs ?? null,
          })
        }
      }
      if (this.sending === 'lose-reply') throw new ApiError('network_error', null, 'reply lost')
      return message
    },
    markConversationRead: async (id, seq) => {
      this.calls.push(`read ${id} ${seq}`)
      const conversation = this.conversations.find((item) => item.id === id)
      if (conversation) {
        conversation.read_seq = seq
        conversation.unread = 0
      }
      return { conversation_id: id, user_id: ME, read_seq: seq }
    },
    hideConversation: async (id) => {
      this.calls.push(`hide ${id}`)
    },
    deleteForMe: async (id, seqs) => {
      this.calls.push(`delete ${id} ${seqs.join(',')}`)
      // 像服务端那样：从我这边的记录里去掉，会话的最新一条换成还剩下的
      this.log[id] = (this.log[id] ?? []).filter((item) => !seqs.includes(item.seq))
      const conversation = this.conversations.find((item) => item.id === id)
      if (conversation) conversation.last_message = this.log[id]?.at(-1) ?? null
      return [...seqs].sort((a, b) => a - b)
    },
    clearForMe: async (id) => {
      this.calls.push(`clear ${id}`)
      const conversation = this.conversations.find((item) => item.id === id)
      const seq = conversation?.last_seq ?? 0
      this.log[id] = []
      if (conversation) {
        conversation.last_message = null
        conversation.unread = 0
        conversation.read_seq = seq
      }
      return seq
    },
    pinConversation: async (id, pinned) => {
      this.calls.push(`pin ${id} ${pinned}`)
      if (this.pinning === 'fail') throw new ApiError('network_error', null, 'offline')
      const conversation = this.conversations.find((item) => item.id === id)
      const at = pinned ? (conversation?.pinned_at ?? 9_000) : null
      if (conversation) conversation.pinned_at = at
      return at
    },
    muteConversation: async (id, muted) => {
      this.calls.push(`mute ${id} ${muted}`)
      if (this.muting === 'fail') throw new ApiError('network_error', null, 'offline')
      const conversation = this.conversations.find((item) => item.id === id)
      if (conversation) conversation.muted = muted
    },
    listMembers: async (id) => {
      this.calls.push(`members ${id}`)
      return this.members[id] ?? []
    },
    createGroup: async (name, memberIds) => {
      this.calls.push(`create ${name} ${memberIds.join(',')}`)
      return this.group('g-new', memberIds.length + 1)
    },
    inviteMembers: async (id, userIds) => ({
      conversation: this.changed(`invite ${id} ${userIds.join(',')}`, id),
      requested: 0,
    }),
    setJoinApproval: async (id, enabled) => this.changed(`join-approval ${id} ${enabled}`, id),
    handleJoinRequest: async (id, requestId, approve) =>
      this.changed(`join-request ${id} ${requestId} ${approve}`, id),
    removeMember: async (id, userId) => this.changed(`remove ${id} ${userId}`, id),
    transferOwner: async (id, userId) => this.changed(`transfer ${id} ${userId}`, id),
    setGroupAdmin: async (id, userId, admin) => this.changed(`admin ${id} ${userId} ${admin}`, id),
    muteMember: async (id, userId, minutes) => this.changed(`mute ${id} ${userId} ${minutes}`, id),
    unmuteMember: async (id, userId) => this.changed(`unmute ${id} ${userId}`, id),
    setAllMuted: async (id, muted) => this.changed(`all-muted ${id} ${muted}`, id),
    setGroupNickname: async (id, nickname) => {
      this.calls.push(`nickname ${id} ${nickname}`)
    },
    renameGroup: async (id, name) => this.changed(`rename ${id} ${name}`, id),
    setGroupNotice: async (id, text) => {
      const changed = this.changed(`notice ${id} ${text}`, id)
      if (!changed.group) return changed
      const notice = text.trim()
        ? { text: text.trim(), by_id: ME, by_name: '我', at: 1, seq: 9 }
        : null
      const conversation = this.conversations.find((item) => item.id === id)
      if (conversation?.group) conversation.group = { ...conversation.group, notice }
      return { ...changed, group: { ...changed.group, notice } }
    },
    markNoticeSeen: async (id) => {
      this.calls.push(`notice-seen ${id}`)
    },
    uploadGroupAvatar: async (id) => this.changed(`avatar ${id}`, id),
    dissolveGroup: async (id) => this.changed(`dissolve ${id}`, id),
    leaveGroup: async (id) => {
      this.calls.push(`leave ${id}`)
    },
    uploadFile: async (content, name, options) => {
      this.calls.push(`upload ${name}`)
      options?.onProgress?.(0.5)
      if (this.uploading === 'fail') throw new ApiError('file_too_large', 413, 'too large')
      if (this.uploading === 'hang') {
        return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        })
      }
      return {
        id: `f-${name}`,
        name,
        size: content.size,
        width: name.endsWith('.png') ? 640 : null,
        height: name.endsWith('.png') ? 480 : null,
        audio: name.endsWith('.webm'),
      }
    },
    recallMessage: async (id, seq) => {
      this.calls.push(`recall ${id} ${seq}`)
      const target = this.log[id]?.find((item) => item.seq === seq)
      if (!target) throw new ApiError('message_not_found', 404, 'no such message')
      Object.assign(target, { recalled: true, text: null, file: null })
      return this.event(id, 'recalled', {
        actor: { id: target.sender_id ?? ME, nickname: '' },
        target_seq: seq,
      })
    },
    editMessage: async (id, seq, edit) => {
      this.calls.push(`edit ${id} ${seq} ${edit.text}`)
      const target = this.log[id]?.find((item) => item.seq === seq)
      if (!target) throw new ApiError('message_not_found', 404, 'no such message')
      const conversation = this.conversations.find((item) => item.id === id)
      const summary = conversation?.last_message ?? null
      const event = this.event(id, 'edited', {
        actor: { id: ME, nickname: '' },
        target_seq: seq,
        text: edit.text,
        mentions: edit.mentions ?? [],
      })
      Object.assign(target, { text: edit.text, edited_at: event.created_at })
      // 像服务端那样：会话列表的摘要不算编辑事件
      if (conversation) conversation.last_message = summary
      return event
    },
    markVoicePlayed: async (id, seq) => {
      this.calls.push(`played ${id} ${seq}`)
    },
  }

  uploading: 'ok' | 'fail' | 'hang' = 'ok'
  /** 传上去之后太久没有发出去、已经被清理掉的文件。 */
  expired = new Set<string>()
  muting: 'ok' | 'fail' = 'ok'
  pinning: 'ok' | 'fail' = 'ok'
  /** 发送接口收到的内容，按先后。 */
  sent: Outgoing[] = []

  members: Record<string, MemberView[]> = {}

  /** 建一个群，我是群主，里面已经有"建群"这一条。 */
  group(id: string, memberCount: number): ConversationView {
    this.log[id] = []
    const created = this.event(id, 'group_created')
    const conversation: ConversationView = {
      id,
      kind: 'group',
      peer: null,
      group: {
        name: '项目组',
        name_hint: [],
        avatar_file_id: null,
        owner_id: ME,
        dissolved: false,
        member_count: memberCount,
        max_members: 10,
        left: false,
        mentioned: false,
        notice: null,
        notice_unseen: false,
        admin_ids: [],
        all_muted: false,
        muted_until: null,
        join_approval: false,
        pending_requests: 0,
      },
      last_seq: 1,
      read_seq: 1,
      last_message: created,
      unread: 0,
      muted: false,
      pinned_at: null,
    }
    this.conversations.push(conversation)
    this.members[id] = [member(ME, '我'), member(PEER, '小红'), member('third', '小刚')]
    return conversation
  }

  /** 往群里写一条事件。 */
  event(id: string, kind: MessageView['kind'], extra: Partial<MessageView> = {}): MessageView {
    const message = this.append(id, PEER, '', null)
    Object.assign(message, { kind, text: null, sender_id: null, ...extra })
    const conversation = this.conversations.find((item) => item.id === id)
    // 事件不算未读
    if (conversation) conversation.unread = Math.max(0, conversation.unread - 1)
    return message
  }

  private changed(call: string, id: string): ConversationView {
    this.calls.push(call)
    const found = this.conversations.find((item) => item.id === id)
    if (!found) throw new ApiError('conversation_not_found', 404, 'no such conversation')
    return { ...found }
  }
}

function member(id: string, nickname: string, readSeq = 0): MemberView {
  return {
    user: { id, handle: `${id}_id`, nickname, avatar_file_id: null },
    remark: null,
    is_friend: true,
    is_owner: id === ME,
    is_admin: false,
    group_nickname: null,
    muted_until: null,
    active: true,
    joined_seq: 0,
    read_seq: readSeq,
  }
}

/** 等所有已经排上的异步步骤做完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function opened(server: FakeServer, id = 'c1', outbox?: Outbox, prefix = 'k') {
  let next = 0
  const store = new ChatStore({
    me: ME,
    api: server.api,
    sendTimeoutMs: 50,
    now: () => 5000,
    newClientId: () => `${prefix}${++next}`,
    outbox,
  })
  await store.loadConversations()
  await store.openThread(id)
  return store
}

const texts = (store: ChatStore, id = 'c1') => store.thread(id).messages.map((item) => item.text)
const pending = (store: ChatStore, id = 'c1') =>
  store.thread(id).pending.map((item) => [item.clientId, item.status])
const push = (store: ChatStore, message: MessageView) =>
  store.handleEvent({ type: 'msg.new', data: message })

afterEach(() => {
  vi.useRealTimers()
})

describe('opening', () => {
  it('loads the list newest first and the latest page of a conversation', async () => {
    const server = new FakeServer()
    server.conversation('c1', 60)
    server.conversation('c2', 1)
    server.append('c2', PEER, 'newest', null)
    const store = await opened(server)

    expect(store.getState().conversations?.map((item) => item.id)).toEqual(['c2', 'c1'])
    const thread = store.thread('c1')
    expect(thread.status).toBe('ready')
    expect(thread.messages).toHaveLength(50)
    expect([thread.messages[0]?.seq, thread.messages.at(-1)?.seq]).toEqual([11, 60])
    expect(thread.hasOlder).toBe(true)

    // 再打开一次不会重新取
    await store.openThread('c1')
    expect(server.calls.filter((call) => call.startsWith('messages c1'))).toHaveLength(1)
  })

  it('loads older pages until the first message, keeping everything in order', async () => {
    const server = new FakeServer()
    server.conversation('c1', 120)
    const store = await opened(server)

    await store.loadOlder('c1')
    expect(store.thread('c1').messages[0]?.seq).toBe(21)
    await store.loadOlder('c1')
    const thread = store.thread('c1')
    expect(thread.messages.map((item) => item.seq)).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    )
    expect(thread.hasOlder).toBe(false)

    // 到头了：不再请求
    const before = server.calls.length
    await store.loadOlder('c1')
    expect(server.calls).toHaveLength(before)
  })

  it('catches a message that arrived while the first page was loading', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    const store = new ChatStore({ me: ME, api: server.api })
    await store.loadConversations()

    const loading = store.openThread('c1')
    // 这时会话还没有准备好，推送来的消息放不进去
    push(store, server.append('c1', PEER, 'during load', null))
    await loading

    expect(texts(store)).toEqual(['old 1', 'old 2', 'during load'])
  })

  it('knows a conversation that is not in the list once it is fetched', async () => {
    const server = new FakeServer()
    server.conversation('c1', 0)
    const store = new ChatStore({ me: ME, api: server.api })
    await store.loadConversations()
    expect(store.getState().conversations).toEqual([])

    expect(await store.openDirect(PEER)).toBe('c1')
    expect(store.conversation('c1')?.peer?.user.nickname).toBe('小红')
    expect(store.getState().conversations).toEqual([])

    await store.ensureConversation('c1')
    expect(server.calls.filter((call) => call.startsWith('fetch'))).toEqual([])
    await expect(store.ensureConversation('nowhere')).rejects.toMatchObject({
      code: 'conversation_not_found',
    })
  })
})

describe('receiving', () => {
  it('appends a pushed message and updates the list', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    server.conversation('c2', 2)
    server.append('c2', ME, 'mine', 'x')
    const store = await opened(server)
    expect(store.getState().conversations?.map((item) => item.id)).toEqual(['c2', 'c1'])

    push(store, server.append('c1', PEER, 'hello', null))

    expect(texts(store)).toEqual(['old 1', 'old 2', 'hello'])
    const conversations = store.getState().conversations
    // 有新消息的会话排到最前面，未读数加一
    expect(conversations?.map((item) => item.id)).toEqual(['c1', 'c2'])
    expect(conversations?.[0]).toMatchObject({ last_seq: 3, unread: 1 })
    expect(conversations?.[0]?.last_message?.text).toBe('hello')
  })

  it('ignores a message it already has', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    const store = await opened(server)
    const message = server.append('c1', PEER, 'hello', null)

    push(store, message)
    push(store, message)

    expect(texts(store)).toEqual(['old 1', 'old 2', 'hello'])
    expect(store.conversation('c1')?.unread).toBe(1)
  })

  it('fills a gap instead of jumping over it', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    const store = await opened(server)
    // 第 3、4 条的推送丢了，只收到了第 5 条
    server.append('c1', PEER, 'three', null)
    server.append('c1', PEER, 'four', null)
    push(store, server.append('c1', PEER, 'five', null))
    await settle()

    expect(texts(store)).toEqual(['old 1', 'old 2', 'three', 'four', 'five'])
    expect(server.calls).toContain('messages c1 {"after":2,"limit":100}')
  })

  it('refetches the list when a message belongs to a conversation it does not know', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.conversation('c2', 0)

    push(store, server.append('c2', PEER, 'first ever', null))
    await settle()

    expect(store.getState().conversations?.map((item) => item.id)).toEqual(['c2', 'c1'])
  })

  it('only keeps the list up to date for a conversation that is not open', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    server.conversation('c2', 1)
    const store = await opened(server)

    push(store, server.append('c2', PEER, 'hello', null))

    expect(store.conversation('c2')).toMatchObject({ last_seq: 2, unread: 1 })
    expect(store.thread('c2').status).toBe('idle')
  })
})

describe('sending', () => {
  it('shows the message at once and confirms it when the server answers', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)

    store.send('c1', 'hello')
    expect(pending(store)).toEqual([['k1', 'sending']])
    expect(store.thread('c1').pending[0]).toMatchObject({ text: 'hello', createdAt: 5000 })
    await settle()

    expect(pending(store)).toEqual([])
    expect(texts(store)).toEqual(['old 1', 'hello'])
    // 自己发的不算未读，但成为会话的摘要
    expect(store.conversation('c1')).toMatchObject({ last_seq: 2, unread: 0 })
  })

  it('does not show the message twice when the push beats the reply', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    const send = server.api.sendMessage
    // 应答回来之前，同一条消息的推送先到了
    server.api.sendMessage = async (...args) => {
      const message = await send(...args)
      push(store, message)
      return message
    }

    store.send('c1', 'hello')
    await settle()

    expect(texts(store)).toEqual(['old 1', 'hello'])
    expect(pending(store)).toEqual([])
  })

  it('marks the message failed when it cannot be sent, and resends it on request', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.sending = 'fail'

    store.send('c1', 'hello')
    await settle()
    expect(pending(store)).toEqual([['k1', 'failed']])
    expect(store.thread('c1').pending[0]?.error).toBe('network_error')
    expect(texts(store)).toEqual(['old 1'])

    server.sending = 'ok'
    store.retry('c1', 'k1')
    expect(pending(store)).toEqual([['k1', 'sending']])
    await settle()

    expect(pending(store)).toEqual([])
    expect(texts(store)).toEqual(['old 1', 'hello'])
    // 重发用的是原来的编号
    expect(server.calls.filter((call) => call.startsWith('send'))).toEqual([
      'send c1 k1',
      'send c1 k1',
    ])
  })

  it('resending a message that did arrive does not create a second one', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    // 服务端存下了消息，但应答在路上丢了
    server.sending = 'lose-reply'

    store.send('c1', 'hello')
    await settle()
    expect(pending(store)).toEqual([['k1', 'failed']])
    expect(server.log.c1).toHaveLength(2)

    server.sending = 'ok'
    store.retry('c1', 'k1')
    await settle()

    expect(server.log.c1).toHaveLength(2)
    expect(texts(store)).toEqual(['old 1', 'hello'])
    expect(pending(store)).toEqual([])
  })

  it('gives up after the timeout and marks the message failed', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.sending = 'hang'
    vi.useFakeTimers()

    store.send('c1', 'hello')
    await vi.advanceTimersByTimeAsync(49)
    expect(pending(store)).toEqual([['k1', 'sending']])
    await vi.advanceTimersByTimeAsync(2)

    expect(pending(store)).toEqual([['k1', 'failed']])
  })

  it('a message confirmed by a push is no longer failed, even if its own request failed', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    const send = server.api.sendMessage
    server.api.sendMessage = async (...args) => {
      // 消息存下了，推送也到了，只有应答丢了
      push(store, await send(...args))
      throw new ApiError('network_error', null, 'reply lost')
    }

    store.send('c1', 'hello')
    await settle()

    expect(pending(store)).toEqual([])
    expect(texts(store)).toEqual(['old 1', 'hello'])
  })

  it('keeps messages that are still on their way after the confirmed ones, in order', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.sending = 'fail'

    store.send('c1', 'first')
    store.send('c1', 'second')
    await settle()
    push(store, server.append('c1', PEER, 'theirs', null))

    expect(texts(store)).toEqual(['old 1', 'theirs'])
    expect(store.thread('c1').pending.map((item) => item.text)).toEqual(['first', 'second'])
  })

  it('retrying does nothing for a message that is not failed', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)

    store.retry('c1', 'never sent')
    await settle()

    expect(server.calls.filter((call) => call.startsWith('send'))).toEqual([])
  })
})

describe('after reconnecting', () => {
  it('brings back everything that was missed, in order', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    server.conversation('c2', 1)
    const store = await opened(server)
    // 断线期间：打开着的会话来了 3 条，没打开的来了 1 条，还多了一个新会话
    for (const text of ['a', 'b', 'c']) server.append('c1', PEER, text, null)
    server.append('c2', PEER, 'x', null)
    server.conversation('c3', 0)
    server.append('c3', PEER, 'new', null)

    await store.resync()

    expect(texts(store)).toEqual(['old 1', 'old 2', 'a', 'b', 'c'])
    expect(store.getState().conversations?.map((item) => [item.id, item.unread])).toEqual([
      ['c3', 1],
      ['c2', 1],
      ['c1', 3],
    ])
    // 没打开过的会话不去取消息
    expect(server.calls.filter((call) => call.startsWith('messages c2'))).toEqual([])
  })

  it('catches up in batches when a lot was missed', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    for (let n = 0; n < 250; n++) server.append('c1', PEER, `m${n}`, null)

    await store.resync()

    expect(store.thread('c1').messages).toHaveLength(251)
    expect(store.thread('c1').messages.at(-1)?.seq).toBe(251)
    expect(server.calls.filter((call) => call.includes('"after"'))).toHaveLength(3)
  })

  it('confirms a message whose reply was lost in the disconnect', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.sending = 'lose-reply'
    store.send('c1', 'hello')
    await settle()
    expect(pending(store)).toEqual([['k1', 'failed']])

    await store.resync()

    expect(pending(store)).toEqual([])
    expect(texts(store)).toEqual(['old 1', 'hello'])
  })
})

describe('reading', () => {
  it('reports what is on screen as read when the user is looking at it', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    server.append('c1', PEER, 'unread', null)
    const store = await opened(server)
    expect(store.conversation('c1')?.unread).toBe(1)

    store.setViewing('c1')

    expect(store.conversation('c1')).toMatchObject({ unread: 0, read_seq: 3 })
    expect(server.calls).toContain('read c1 3')

    // 已经报过的不再报
    store.setViewing('c1')
    expect(server.calls.filter((call) => call.startsWith('read'))).toHaveLength(1)
  })

  it('a message that arrives while the user is looking is read at once', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    const store = await opened(server)
    store.setViewing('c1')

    push(store, server.append('c1', PEER, 'seen at once', null))

    expect(store.conversation('c1')).toMatchObject({ unread: 0, read_seq: 3 })
    expect(server.calls).toContain('read c1 3')
  })

  it('a message that arrives while the user looks elsewhere stays unread', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    const store = await opened(server)
    store.setViewing('c1')
    store.setViewing(null)

    push(store, server.append('c1', PEER, 'not seen', null))

    expect(store.conversation('c1')).toMatchObject({ unread: 1, read_seq: 2 })
    expect(server.calls.filter((call) => call.startsWith('read'))).toEqual([])
  })

  it('follows read positions pushed by the server', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    server.append('c1', PEER, 'unread', null)
    const store = await opened(server)
    const read = (userId: string, seq: number) =>
      store.handleEvent({
        type: 'conv.read',
        data: { conversation_id: 'c1', user_id: userId, read_seq: seq },
      })

    // 对方看到了第 2 条
    read(PEER, 2)
    expect(store.conversation('c1')?.peer?.read_seq).toBe(2)
    // 我在别处看完了
    read(ME, 3)
    expect(store.conversation('c1')).toMatchObject({ unread: 0, read_seq: 3 })
    // 不认识的会话：不出错
    store.handleEvent({
      type: 'conv.read',
      data: { conversation_id: 'nowhere', user_id: ME, read_seq: 1 },
    })
  })
})

describe('removing from the list', () => {
  it('takes the conversation out, and the next message brings it back', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    const store = await opened(server)

    await store.hide('c1')
    expect(server.calls).toContain('hide c1')
    expect(store.getState().conversations).toEqual([])
    // 正打开着的页面仍然知道它是和谁的会话，消息也还在
    expect(store.conversation('c1')?.peer?.user.nickname).toBe('小红')
    expect(texts(store)).toEqual(['old 1', 'old 2'])

    push(store, server.append('c1', PEER, 'back', null))
    expect(store.getState().conversations?.map((item) => item.id)).toEqual(['c1'])
    expect(texts(store)).toEqual(['old 1', 'old 2', 'back'])
  })

  it('follows a removal made in another window', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    const store = await opened(server)

    store.handleEvent({ type: 'conv.hidden', data: { conversation_id: 'c1' } })

    expect(store.getState().conversations).toEqual([])
  })
})

describe('a list fetched before I read a conversation', () => {
  it('does not bring the unread count and the mention back', async () => {
    const server = new FakeServer()
    const group = server.group('g1', 3)
    const mention = server.append('g1', PEER, '@我 看一下', null)
    mention.mentions = [ME]
    if (group.group) group.group.mentioned = true
    const store = new ChatStore({ me: ME, api: server.api })
    await store.loadConversations()
    expect(store.conversation('g1')).toMatchObject({ unread: 1, read_seq: 1 })

    // 重新取列表的请求已经发出，服务端按当时的样子生成了应答：还没读
    const list = server.api.listConversations
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.api.listConversations = async () => {
      const snapshot = structuredClone(await list())
      await held
      return snapshot
    }
    const refreshing = store.loadConversations()

    // 这时我打开会话读完了
    await store.openThread('g1')
    store.setViewing('g1')
    expect(store.conversation('g1')).toMatchObject({ unread: 0, read_seq: 2 })
    expect(store.conversation('g1')?.group?.mentioned).toBe(false)

    // 之前那份过时的列表这才到
    release()
    await refreshing
    expect(store.conversation('g1')).toMatchObject({ unread: 0, read_seq: 2 })
    expect(store.conversation('g1')?.group?.mentioned).toBe(false)
  })
})

describe('sending before the conversation finished loading', () => {
  it('does not leave the message stuck as sending', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = new ChatStore({ me: ME, api: server.api, newClientId: () => 'early' })
    await store.loadConversations()
    // 最新一段还在路上，消息就发出去了：应答到的时候会话还没有准备好
    const list = server.api.listMessages
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.api.listMessages = async (id, range) => {
      await held
      return list(id, range)
    }

    const opening = store.openThread('c1')
    store.send('c1', 'too eager')
    await settle()
    expect(pending(store)).toEqual([['early', 'sending']])
    release()
    await opening

    // 取回来的那一段里已经有它了
    expect(texts(store)).toEqual(['old 1', 'too eager'])
    expect(pending(store)).toEqual([])
  })
})

describe('subscribers', () => {
  it('are told about every change until they unsubscribe', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    let notified = 0
    const unsubscribe = store.subscribe(() => {
      notified += 1
    })
    const before = store.getState()

    push(store, server.append('c1', PEER, 'hello', null))
    expect(notified).toBeGreaterThan(0)
    // 每次变化都是一个新的状态对象，旧的不被改动
    expect(store.getState()).not.toBe(before)
    expect(before.threads.c1?.messages).toHaveLength(1)

    unsubscribe()
    const count = notified
    push(store, server.append('c1', PEER, 'again', null))
    expect(notified).toBe(count)
  })
})

describe('groups', () => {
  it('creating a group lists it at once and returns its id', async () => {
    const server = new FakeServer()
    const store = new ChatStore({ me: ME, api: server.api })
    await store.loadConversations()

    const id = await store.createGroup('项目组', ['a', 'b'])

    expect(id).toBe('g-new')
    expect(store.getState().conversations?.map((item) => item.id)).toEqual(['g-new'])
    expect(server.calls).toContain('create 项目组 a,b')
  })

  it('opening a group also loads its members, and read positions follow the pushes', async () => {
    const server = new FakeServer()
    server.group('g1', 3)
    const store = await opened(server, 'g1')
    await settle()

    expect(store.getState().members.g1?.map((item) => item.user.nickname)).toEqual([
      '我',
      '小红',
      '小刚',
    ])
    store.handleEvent({
      type: 'conv.read',
      data: { conversation_id: 'g1', user_id: 'third', read_seq: 1 },
    })
    const third = store.getState().members.g1?.find((item) => item.user.id === 'third')
    expect(third?.read_seq).toBe(1)
    // 单聊不取成员名单
    server.conversation('c1', 1)
    await store.loadConversations()
    await store.openThread('c1')
    expect(server.calls.filter((call) => call.startsWith('members'))).toEqual(['members g1'])
  })

  it('an event that changes the group refreshes it and its members', async () => {
    const server = new FakeServer()
    const group = server.group('g1', 3)
    const store = await opened(server, 'g1')
    await settle()
    // 群主把群名改了，又进来一个人
    if (group.group) Object.assign(group.group, { name: '周末爬山', member_count: 4 })
    server.members.g1?.push(member('fourth', '小李'))

    push(store, server.event('g1', 'renamed', { name: '周末爬山' }))
    await settle()

    expect(store.conversation('g1')?.group).toMatchObject({ name: '周末爬山', member_count: 4 })
    expect(store.getState().members.g1).toHaveLength(4)
    expect(store.thread('g1').messages.map((item) => item.kind)).toEqual([
      'group_created',
      'renamed',
    ])
    // 普通消息不会触发重新取
    const fetches = server.calls.filter((call) => call.startsWith('fetch')).length
    push(store, server.append('g1', PEER, 'hello', null))
    await settle()
    expect(server.calls.filter((call) => call.startsWith('fetch'))).toHaveLength(fetches)
  })

  it('the notice banner goes away when seen, here and in my other windows', async () => {
    const server = new FakeServer()
    const notice = { text: '群规', by_id: PEER, by_name: '小红', at: 1, seq: 1 }
    const created = server.group('g1', 3)
    created.group = { ...(created.group as GroupView), notice, notice_unseen: true }
    const store = await opened(server, 'g1')
    expect(store.conversation('g1')?.group?.notice_unseen).toBe(true)

    store.markNoticeSeen('g1')
    expect(store.conversation('g1')?.group?.notice_unseen).toBe(false)
    expect(server.calls).toContain('notice-seen g1')
    // 已经看过了：不再报
    store.markNoticeSeen('g1')
    expect(server.calls.filter((call) => call === 'notice-seen g1')).toHaveLength(1)

    // 另一个窗口：收到"在别处看过了"
    const other = await opened(server, 'g1')
    const elsewhere = other.conversation('g1')
    if (elsewhere?.group) {
      other.handleEvent({ type: 'conv.notice_seen', data: { conversation_id: 'g1', seq: 99 } })
      expect(other.conversation('g1')?.group?.notice_unseen).toBe(true)
      other.handleEvent({ type: 'conv.notice_seen', data: { conversation_id: 'g1', seq: 1 } })
      expect(other.conversation('g1')?.group?.notice_unseen).toBe(false)
    }
  })

  it('join requests that change elsewhere refresh the group and its list', async () => {
    const server = new FakeServer()
    server.group('g1', 1)
    const store = await opened(server, 'g1')
    expect(store.getState().joinRequests.g1 ?? 0).toBe(0)
    server.calls.length = 0
    store.handleEvent({ type: 'conv.join_requests', data: { conversation_id: 'g1' } })
    expect(store.getState().joinRequests.g1).toBe(1)
    await settle()
    // 待处理的数目在会话信息里：重新取一遍
    expect(server.calls).toContain('fetch g1')
    // 自己处理了一条：也要重新取列表
    await store.handleJoinRequest('g1', 'r1', true)
    expect(server.calls).toContain('join-request g1 r1 true')
    expect(store.getState().joinRequests.g1).toBe(2)
  })

  it('a mention marks the group until it is read', async () => {
    const server = new FakeServer()
    server.group('g1', 3)
    server.conversation('c1', 1)
    const store = await opened(server, 'c1')

    const mention = server.append('g1', PEER, '@我 看一下', null)
    mention.mentions = [ME]
    push(store, mention)
    expect(store.conversation('g1')?.group?.mentioned).toBe(true)
    expect(store.conversation('g1')?.unread).toBe(1)

    // 打开并看到最新一条：提示消失
    await store.openThread('g1')
    store.setViewing('g1')
    expect(store.conversation('g1')?.group?.mentioned).toBe(false)

    // @ 所有人也算；我自己发的不算
    store.setViewing(null)
    const all = server.append('g1', PEER, '@所有人', null)
    all.mention_all = true
    push(store, all)
    expect(store.conversation('g1')?.group?.mentioned).toBe(true)
  })

  it('carries the mentions along when sending and when resending', async () => {
    const server = new FakeServer()
    server.group('g1', 3)
    const store = await opened(server, 'g1')
    const sent: unknown[] = []
    const send = server.api.sendMessage
    server.api.sendMessage = async (id, clientId, content, options) => {
      sent.push(content.mentions)
      return send(id, clientId, content, options)
    }
    server.sending = 'fail'

    store.send('g1', '@小红 看一下', { mentions: { users: [PEER], all: false } })
    await settle()
    server.sending = 'ok'
    store.retry('g1', 'k1')
    await settle()

    expect(sent).toEqual([
      { users: [PEER], all: false },
      { users: [PEER], all: false },
    ])
  })

  it('leaving takes the group off the list, here and in my other windows', async () => {
    const server = new FakeServer()
    server.group('g1', 3)
    server.group('g2', 3)
    const store = await opened(server, 'g1')

    await store.leave('g1')
    expect(server.calls).toContain('leave g1')
    expect(store.getState().conversations?.map((item) => item.id)).toEqual(['g2'])

    // 在别处退了另一个群：这里收到"我退出了"的事件，它同样不留在列表里
    push(store, server.event('g2', 'member_left', { actor: { id: ME, nickname: '我' } }))
    expect(store.getState().conversations).toEqual([])
  })

  it('being brought back to a group starts its history over', async () => {
    const server = new FakeServer()
    server.group('g1', 3)
    const store = await opened(server, 'g1')
    push(store, server.append('g1', PEER, '我还在的时候', null))
    expect(store.thread('g1').messages).toHaveLength(2)

    // 离开过又被拉回来：服务端只交出这一次入群之后的
    const rejoin = server.event('g1', 'member_joined', {
      targets: [{ id: ME, nickname: '我' }],
    })
    server.log.g1 = [rejoin]
    push(store, rejoin)
    await settle()

    expect(store.thread('g1').messages.map((item) => item.kind)).toEqual(['member_joined'])
  })

  it('a jump in what the server hands back means the visible range changed', async () => {
    const server = new FakeServer()
    const group = server.group('g1', 3)
    const store = await opened(server, 'g1')
    // 断线期间：我被移出又被拉回，中间那几条我看不到
    const hidden = [2, 3, 4].map((n) => server.append('g1', PEER, `hidden ${n}`, null))
    const rejoin = server.event('g1', 'member_joined', {
      targets: [{ id: ME, nickname: '我' }],
    })
    server.log.g1 = (server.log.g1 ?? []).filter((item) => !hidden.includes(item) && item.seq !== 1)
    group.last_seq = rejoin.seq

    await store.resync()
    await settle()

    expect(store.thread('g1').messages).toEqual([rejoin])
  })
})

describe('sending files', () => {
  const blob = (text: string) => new Blob([text])

  it('uploads first, shows the progress, then sends what was uploaded', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    const progress: (number | undefined)[] = []
    store.subscribe(() => progress.push(store.thread('c1').pending[0]?.attachment?.progress))

    store.sendFile('c1', blob('pixels'), 'photo.png')
    expect(pending(store)).toEqual([['k1', 'uploading']])
    await settle()

    // 传了一半，传完，然后发出去、被确认
    expect(progress).toContain(0.5)
    expect(progress).toContain(1)
    expect(pending(store)).toEqual([])
    const sent = store.thread('c1').messages.at(-1)
    expect(sent?.kind).toBe('image')
    expect(sent?.file?.name).toBe('photo.png')
    expect(server.sent).toEqual([{ fileId: 'f-photo.png', voiceDurationMs: undefined }])
  })

  it('sends several files one after another, in the order they were picked', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)

    store.sendFile('c1', blob('a'), 'a.txt')
    store.sendFile('c1', blob('b'), 'b.txt')
    store.sendFile('c1', blob('c'), 'voice.webm', { voiceDurationMs: 3000 })
    // 三条都立即出现在会话里
    expect(pending(store).map(([, status]) => status)).toEqual([
      'uploading',
      'uploading',
      'uploading',
    ])
    await settle()

    const order = server.calls.filter((call) => /^(upload|send) /.test(call))
    expect(order).toEqual([
      'upload a.txt',
      'send c1 k1',
      'upload b.txt',
      'send c1 k2',
      'upload voice.webm',
      'send c1 k3',
    ])
    const kinds = store
      .thread('c1')
      .messages.slice(1)
      .map((item) => item.kind)
    expect(kinds).toEqual(['file', 'file', 'voice'])
    expect(server.sent[2]).toEqual({ fileId: 'f-voice.webm', voiceDurationMs: 3000 })
  })

  it('text sent together with files goes out after them', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)

    store.sendFile('c1', blob('pixels'), 'shot.png')
    store.sendFile('c1', blob('a'), 'a.txt')
    store.send('c1', 'here they are', { afterFiles: true })
    // 三条都立即出现在会话里，顺序就是发的顺序
    expect(pending(store)).toEqual([
      ['k1', 'uploading'],
      ['k2', 'uploading'],
      ['k3', 'sending'],
    ])
    await settle()

    const order = server.calls.filter((call) => /^(upload|send) /.test(call))
    expect(order).toEqual([
      'upload shot.png',
      'send c1 k1',
      'upload a.txt',
      'send c1 k2',
      'send c1 k3',
    ])
    expect(
      store
        .thread('c1')
        .messages.slice(1)
        .map((item) => item.kind),
    ).toEqual(['image', 'file', 'text'])
    expect(pending(store)).toEqual([])
  })

  it('text sent on its own does not wait for a file that is still uploading', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.uploading = 'hang'

    store.sendFile('c1', blob('huge'), 'huge.bin')
    store.send('c1', 'meanwhile')
    await settle()
    expect(texts(store).at(-1)).toBe('meanwhile')
    expect(pending(store)).toEqual([['k1', 'uploading']])
  })

  it('text behind a file that failed or was cancelled still goes out', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.uploading = 'fail'
    store.sendFile('c1', blob('big'), 'big.bin')
    store.send('c1', 'see attached', { afterFiles: true })
    await settle()
    expect(pending(store)).toEqual([['k1', 'failed']])
    expect(texts(store).at(-1)).toBe('see attached')

    server.uploading = 'hang'
    const stuck = store.sendFile('c1', blob('slow'), 'slow.bin')
    store.send('c1', 'never mind', { afterFiles: true })
    await settle()
    expect(texts(store).at(-1)).toBe('see attached')
    store.cancelUpload('c1', stuck)
    await settle()
    expect(texts(store).at(-1)).toBe('never mind')
  })

  it('a failed upload can be retried, and uploads again', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.uploading = 'fail'

    store.sendFile('c1', blob('big'), 'big.bin')
    await settle()
    expect(pending(store)).toEqual([['k1', 'failed']])
    expect(store.thread('c1').pending[0]?.error).toBe('file_too_large')
    // 一个失败不挡住后面的
    server.uploading = 'ok'
    store.sendFile('c1', blob('ok'), 'ok.txt')
    await settle()
    expect(pending(store)).toEqual([['k1', 'failed']])

    store.retry('c1', 'k1')
    await settle()
    expect(pending(store)).toEqual([])
    expect(server.calls.filter((call) => call === 'upload big.bin')).toHaveLength(2)
  })

  it('a file that uploaded but did not send is resent without uploading again', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.sending = 'fail'

    store.sendFile('c1', blob('doc'), 'doc.txt')
    await settle()
    expect(pending(store)).toEqual([['k1', 'failed']])
    expect(store.thread('c1').pending[0]?.attachment?.file?.id).toBe('f-doc.txt')

    server.sending = 'ok'
    store.retry('c1', 'k1')
    await settle()
    expect(pending(store)).toEqual([])
    expect(server.calls.filter((call) => call.startsWith('upload'))).toHaveLength(1)
  })

  it('cancelling an upload removes it and lets the next one start', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    server.uploading = 'hang'

    store.sendFile('c1', blob('slow'), 'slow.bin')
    store.sendFile('c1', blob('queued'), 'queued.bin')
    await settle()
    expect(server.calls).toContain('upload slow.bin')
    expect(server.calls).not.toContain('upload queued.bin')

    // 取消排着队的那个：轮到它时什么也不做
    store.cancelUpload('c1', 'k2')
    server.uploading = 'ok'
    store.cancelUpload('c1', 'k1')
    await settle()
    expect(pending(store)).toEqual([])
    expect(server.calls).not.toContain('upload queued.bin')
    expect(server.sent).toEqual([])

    store.sendFile('c1', blob('next'), 'next.txt')
    await settle()
    expect(store.thread('c1').messages.at(-1)?.file?.name).toBe('next.txt')
  })
})

describe('captions and replies on files', () => {
  const blob = (text: string) => new Blob([text])

  it('an image goes out as one message together with its caption, mentions and reply', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    const original = store.thread('c1').messages[0]
    if (!original) throw new Error('the conversation has messages')

    store.sendFile('c1', blob('pixels'), 'sea.png', {
      caption: '海边 @小红',
      mentions: { users: [PEER], all: false },
      replyTo: original,
    })
    // 还没发出去时就带着说明和引用
    const waiting = store.thread('c1').pending[0]
    expect(waiting?.text).toBe('海边 @小红')
    expect(waiting?.reply).toMatchObject({ seq: 1, state: 'shown' })
    await settle()

    expect(server.sent).toEqual([
      {
        fileId: 'f-sea.png',
        text: '海边 @小红',
        mentions: { users: [PEER], all: false },
        replyTo: 1,
      },
    ])
    const sent = store.thread('c1').messages.at(-1)
    expect([sent?.kind, sent?.text]).toEqual(['image', '海边 @小红'])
  })

  it('a caption on something the server does not take as an image follows it as its own message', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)

    store.sendFile('c1', blob('heic'), 'photo.heic', { caption: '看看这张' })
    await settle()

    expect(server.sent).toEqual([{ fileId: 'f-photo.heic' }, { text: '看看这张' }])
    const kinds = store
      .thread('c1')
      .messages.slice(1)
      .map((item) => [item.kind, item.text])
    expect(kinds).toEqual([
      ['file', null],
      ['text', '看看这张'],
    ])
  })

  it('a file and a voice message can carry a reply', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    const original = store.thread('c1').messages[0]
    if (!original) throw new Error('the conversation has messages')

    store.sendFile('c1', blob('doc'), 'notes.txt', { replyTo: original })
    store.sendFile('c1', blob('voice'), 'voice.webm', { voiceDurationMs: 1500, replyTo: original })
    await settle()

    expect(server.sent).toEqual([
      { fileId: 'f-notes.txt', replyTo: 1 },
      { fileId: 'f-voice.webm', voiceDurationMs: 1500, replyTo: 1 },
    ])
  })
})

describe('replying, recalling and listening', () => {
  it('a reply carries the quoted message while pending and its number when sent', async () => {
    const server = new FakeServer()
    server.conversation('c1', 2)
    const store = await opened(server)
    const original = store.thread('c1').messages[0]
    if (!original) throw new Error('the conversation has messages')

    store.send('c1', '好的', { replyTo: original })

    // 还没有确认时，会话里就显示着被引用的那一条
    const waiting = store.thread('c1').pending[0]
    expect(waiting?.reply).toMatchObject({ seq: 1, state: 'shown', text: 'old 1' })
    await settle()
    expect(server.sent).toEqual([{ text: '好的', mentions: undefined, replyTo: 1 }])
  })

  it('recalling my message replaces it and the replies that quote it', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    store.send('c1', '说错了')
    await settle()
    const wrong = store.thread('c1').messages.at(-1)
    if (!wrong) throw new Error('the message was sent')
    // 对方引用了它
    const reply = server.append('c1', PEER, '什么？', null)
    reply.reply = {
      seq: wrong.seq,
      state: 'shown',
      sender_id: ME,
      sender_name: null,
      kind: 'text',
      text: '说错了',
      file_name: null,
    }
    push(store, reply)

    await store.recall('c1', wrong.seq)

    const messages = store.thread('c1').messages
    const gone = messages.find((item) => item.seq === wrong.seq)
    expect(gone).toMatchObject({ recalled: true, text: null, sender_id: ME })
    expect(messages.find((item) => item.seq === reply.seq)?.reply).toMatchObject({
      state: 'recalled',
      text: null,
    })
    // 撤回的事件本身也在会话日志里，占一个序号
    expect(messages.at(-1)).toMatchObject({ kind: 'recalled', target_seq: wrong.seq })
    expect(store.conversation('c1')?.last_message?.kind).toBe('recalled')
  })

  it('a message recalled by the other side no longer counts as unread', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    server.conversation('c2', 1)
    const store = await opened(server, 'c2')
    const first = server.append('c1', PEER, '第一条', null)
    const wrong = server.append('c1', PEER, '说错了', null)
    push(store, first)
    push(store, wrong)
    expect(store.conversation('c1')?.unread).toBe(2)

    const event = await server.api.recallMessage('c1', wrong.seq)
    Object.assign(event, { actor: { id: PEER, nickname: '小红' } })
    push(store, event)

    expect(store.conversation('c1')?.unread).toBe(1)
    // 已经读过的被撤回，未读数不变
    await store.openThread('c1')
    store.setViewing('c1')
    expect(store.conversation('c1')?.unread).toBe(0)
    const again = await server.api.recallMessage('c1', first.seq)
    Object.assign(again, { actor: { id: PEER, nickname: '小红' } })
    push(store, again)
    expect(store.conversation('c1')?.unread).toBe(0)
    expect(store.thread('c1').messages.find((item) => item.seq === first.seq)?.recalled).toBe(true)
  })

  it('an edit changes the message, the replies that quote it and the summary, here and elsewhere', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const mine = server.append('c1', ME, '明天三点见', 'k-mine')
    const quoting = server.append('c1', PEER, '好的', null)
    Object.assign(quoting, {
      reply: {
        seq: mine.seq,
        state: 'shown',
        sender_id: ME,
        sender_name: null,
        kind: 'text',
        text: '明天三点见',
        file_name: null,
      },
    })
    const last = server.append('c1', ME, '最后一条', 'k-last')
    const store = await opened(server, 'c1')
    const message = (seq: number) => store.thread('c1').messages.find((item) => item.seq === seq)

    const unread = store.conversation('c1')?.unread
    await store.edit('c1', mine.seq, '明天四点见')
    expect(server.calls).toContain(`edit c1 ${mine.seq} 明天四点见`)
    expect(message(mine.seq)).toMatchObject({ text: '明天四点见' })
    expect(message(mine.seq)?.edited_at).not.toBeNull()
    expect(message(quoting.seq)?.reply?.text).toBe('明天四点见')
    // 摘要还是最后那一条，未读不变
    expect(store.conversation('c1')?.last_message?.seq).toBe(last.seq)
    expect(store.conversation('c1')?.unread).toBe(unread)

    // 在别处改了最后一条：推送过来，摘要也换成新的内容
    const event = await server.api.editMessage('c1', last.seq, { text: '最后一条（改）' })
    push(store, event)
    expect(message(last.seq)?.text).toBe('最后一条（改）')
    expect(store.conversation('c1')?.last_message?.text).toBe('最后一条（改）')
    // 推送晚到一次也没事
    push(store, event)
    expect(message(last.seq)?.text).toBe('最后一条（改）')
  })

  it('being mentioned by an edit flags the group for me', async () => {
    const server = new FakeServer()
    server.group('g1', 3)
    const said = server.append('g1', PEER, '看一下', null)
    const store = await opened(server)
    push(store, said)
    expect(store.conversation('g1')?.group?.mentioned).toBe(false)
    const event = server.event('g1', 'edited', {
      actor: { id: PEER, nickname: '小红' },
      target_seq: said.seq,
      text: '@我 看一下',
      mentions: [ME],
    })
    push(store, event)
    expect(store.conversation('g1')?.group?.mentioned).toBe(true)
  })

  it('a voice message is marked played here and in my other windows', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const voice = server.append('c1', PEER, '', null)
    Object.assign(voice, { kind: 'voice', text: null, duration_ms: 2000 })
    const store = await opened(server)
    const played = () => store.thread('c1').messages.find((item) => item.seq === voice.seq)?.played

    store.markPlayed('c1', voice.seq)
    expect(played()).toBe(true)
    expect(server.calls).toContain(`played c1 ${voice.seq}`)
    // 再听一遍不再上报
    store.markPlayed('c1', voice.seq)
    expect(server.calls.filter((call) => call.startsWith('played'))).toHaveLength(1)

    // 另一个窗口：收到推送后标记消失
    const other = await opened(server)
    expect(other.thread('c1').messages.find((item) => item.seq === voice.seq)?.played).toBe(false)
    other.handleEvent({ type: 'msg.played', data: { conversation_id: 'c1', seq: voice.seq } })
    expect(other.thread('c1').messages.find((item) => item.seq === voice.seq)?.played).toBe(true)
  })
})

describe('jumping to a message', () => {
  const seqs = (store: ChatStore) => store.thread('c1').messages.map((item) => item.seq)

  it('does not fetch anything when the message is already loaded', async () => {
    const server = new FakeServer()
    server.conversation('c1', 30)
    const store = await opened(server)
    const fetches = server.calls.length

    expect(await store.jumpTo('c1', 12)).toBe('ready')

    expect(server.calls).toHaveLength(fetches)
    expect(store.thread('c1').hasNewer).toBe(false)
  })

  it('loads a window around a message from long ago, and new messages do not join it', async () => {
    const server = new FakeServer()
    server.conversation('c1', 300)
    const store = await opened(server)
    expect(seqs(store)[0]).toBe(251)

    expect(await store.jumpTo('c1', 100)).toBe('ready')

    expect(seqs(store)).toEqual(Array.from({ length: 50 }, (_, index) => 76 + index))
    expect(store.thread('c1')).toMatchObject({ hasOlder: true, hasNewer: true })

    // 这时来了新消息：不接在这一段后面，但会话的摘要和未读数照常更新
    store.setViewing('c1')
    push(store, server.append('c1', PEER, 'brand new', null))
    await settle()
    expect(seqs(store).at(-1)).toBe(125)
    expect(store.conversation('c1')?.last_message?.text).toBe('brand new')
    expect(store.conversation('c1')?.unread).toBe(1)
    expect(server.calls.filter((call) => call.startsWith('read'))).toEqual([])

    // 可以从这一段往上翻
    await store.loadOlder('c1')
    expect(seqs(store)[0]).toBe(26)
  })

  it('scrolling down from the window reaches the latest and rejoins the live conversation', async () => {
    const server = new FakeServer()
    server.conversation('c1', 120)
    const store = await opened(server)
    await store.jumpTo('c1', 10)
    expect(seqs(store).at(-1)).toBe(35)

    await store.loadNewer('c1')
    expect(seqs(store).at(-1)).toBe(85)
    expect(store.thread('c1').hasNewer).toBe(true)
    await store.loadNewer('c1')
    expect(seqs(store).at(-1)).toBe(120)
    expect(store.thread('c1').hasNewer).toBe(false)

    // 接上了：新消息照常往后接
    push(store, server.append('c1', PEER, 'live again', null))
    expect(texts(store).at(-1)).toBe('live again')
  })

  it('going back to the latest, or sending, leaves the window', async () => {
    const server = new FakeServer()
    server.conversation('c1', 200)
    const store = await opened(server)
    await store.jumpTo('c1', 20)

    await store.jumpToLatest('c1')
    expect(store.thread('c1')).toMatchObject({ hasNewer: false, status: 'ready' })
    expect(seqs(store).at(-1)).toBe(200)

    await store.jumpTo('c1', 20)
    store.send('c1', 'from the past')
    await settle()
    expect(store.thread('c1').hasNewer).toBe(false)
    expect(texts(store).at(-1)).toBe('from the past')
    expect(pending(store)).toEqual([])
  })

  it('says so when the message cannot be seen', async () => {
    const server = new FakeServer()
    server.conversation('c1', 300)
    const store = await opened(server)
    // 这一条我看不到：服务端交出来的里面没有它
    server.log.c1 = (server.log.c1 ?? []).filter((item) => item.seq !== 40)
    const before = seqs(store)

    expect(await store.jumpTo('c1', 40)).toBe('unavailable')
    expect(await store.jumpTo('c1', 9999)).toBe('unavailable')
    expect(seqs(store)).toEqual(before)
  })
})

describe('muting a conversation', () => {
  it('changes at once, follows my other windows, and reverts if it could not be saved', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const store = await opened(server)
    const muted = () => store.conversation('c1')?.muted

    await store.mute('c1', true)
    expect(muted()).toBe(true)
    expect(server.calls).toContain('mute c1 true')

    // 在别处取消了
    store.handleEvent({ type: 'conv.muted', data: { conversation_id: 'c1', muted: false } })
    expect(muted()).toBe(false)

    // 没有存上：变回去，并且把错误交给界面
    server.muting = 'fail'
    await expect(store.mute('c1', true)).rejects.toThrow()
    expect(muted()).toBe(false)
  })

  it('still receives messages and counts them as unread', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    server.conversation('c2', 1)
    const store = await opened(server, 'c2')
    await store.mute('c1', true)

    push(store, server.append('c1', PEER, 'quiet', null))

    expect(store.conversation('c1')).toMatchObject({ unread: 1, muted: true })
  })
})

describe('pinning a conversation', () => {
  it('moves it to the top at once, follows my other windows, and reverts if not saved', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    server.conversation('c2', 1)
    // c2 里后来又有了一条：它排在前面
    server.append('c2', PEER, 'later', null)
    const store = await opened(server)
    const order = () => store.getState().conversations?.map((item) => item.id)
    expect(order()).toEqual(['c2', 'c1'])

    await store.pin('c1', true)
    expect(order()).toEqual(['c1', 'c2'])
    expect(server.calls).toContain('pin c1 true')
    expect(store.conversation('c1')?.pinned_at).toBe(9_000)

    // 在别处取消了
    store.handleEvent({ type: 'conv.pinned', data: { conversation_id: 'c1', pinned_at: null } })
    expect(order()).toEqual(['c2', 'c1'])

    // 没有存上：挪回去，并且把错误交给界面
    server.pinning = 'fail'
    await expect(store.pin('c1', true)).rejects.toThrow()
    expect(order()).toEqual(['c2', 'c1'])
    expect(store.conversation('c1')?.pinned_at).toBeNull()
  })
})

describe('deleting and clearing for myself', () => {
  it('deleted messages leave the thread and the list shows what is left', async () => {
    const server = new FakeServer()
    server.conversation('c1', 3)
    const store = await opened(server, 'c1')
    const seqs = () => store.thread('c1').messages.map((message) => message.seq)
    expect(seqs()).toEqual([1, 2, 3])

    await store.deleteForMe('c1', [3, 2])
    expect(server.calls).toContain('delete c1 3,2')
    expect(seqs()).toEqual([1])
    expect(store.conversation('c1')?.last_message?.seq).toBe(1)

    // 在别处删的：推送过来，这里也去掉
    server.append('c1', PEER, 'later', null)
    store.handleEvent({ type: 'msg.deleted', data: { conversation_id: 'c1', seqs: [1] } })
    expect(seqs()).not.toContain(1)
  })

  it('clearing empties the thread but keeps the conversation listed', async () => {
    const server = new FakeServer()
    server.conversation('c1', 3)
    const store = await opened(server, 'c1')
    await store.clearForMe('c1')
    expect(store.thread('c1').messages).toEqual([])
    expect(store.thread('c1').hasOlder).toBe(false)
    expect(store.conversation('c1')).toMatchObject({ last_message: null, unread: 0 })

    // 在别处清空的：推送过来
    push(store, server.append('c1', PEER, 'new', null))
    store.handleEvent({ type: 'conv.cleared', data: { conversation_id: 'c1', cleared_seq: 4 } })
    expect(store.thread('c1').messages).toEqual([])
  })

  it('a thread whose last messages I deleted is not fetched again and again', async () => {
    const server = new FakeServer()
    server.conversation('c1', 3)
    const store = await opened(server, 'c1')
    await store.deleteForMe('c1', [3])
    const catchUps = () => server.calls.filter((call) => call.startsWith('messages c1 {"after"'))
    const before = catchUps().length
    await store.resync()
    // 服务端的最后一条（3）我删了；我看得到的最新一条（2）已经在了：不用去补
    expect(catchUps().length).toBe(before)
  })

  it('a new message after the ones I deleted or cleared joins on without fetching again', async () => {
    const server = new FakeServer()
    server.conversation('c1', 3)
    const store = await opened(server, 'c1')
    const seqs = () => store.thread('c1').messages.map((message) => message.seq)
    const fetches = () => server.calls.filter((call) => call.startsWith('messages c1')).length

    await store.deleteForMe('c1', [3])
    let before = fetches()
    push(store, server.append('c1', PEER, 'after the deleted one', null))
    await settle()
    expect(seqs()).toEqual([1, 2, 4])
    expect(fetches()).toBe(before)

    await store.clearForMe('c1')
    before = fetches()
    push(store, server.append('c1', PEER, 'after clearing', null))
    await settle()
    expect(seqs()).toEqual([5])
    expect(fetches()).toBe(before)
  })
})

describe('messages that did not go out survive a reload', () => {
  const blob = (text: string, type = '') => new Blob([text], { type })
  /** 同一台设备上重新打开页面：新的一份状态，同一个 outbox。 */
  const reopened = (server: FakeServer, outbox: Outbox) => opened(server, 'c1', outbox, 'r')

  it('a failed message comes back as failed and can be resent', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const outbox = new MemoryOutbox()
    const before = await opened(server, 'c1', outbox)
    server.sending = 'fail'
    before.send('c1', '在吗', { replyTo: before.thread('c1').messages[0] })
    await settle()
    expect(pending(before)).toEqual([['k1', 'failed']])
    expect(outbox.entries.size).toBe(1)

    server.sending = 'ok'
    const after = await reopened(server, outbox)
    const restored = after.thread('c1').pending
    expect(restored.map((item) => [item.clientId, item.status, item.text])).toEqual([
      ['k1', 'failed', '在吗'],
    ])
    expect(restored[0]?.reply).toMatchObject({ seq: 1 })
    // 不会自己重发
    expect(server.calls.filter((call) => call.startsWith('send'))).toHaveLength(1)

    after.retry('c1', 'k1')
    await settle()
    expect(pending(after)).toEqual([])
    expect(texts(after).at(-1)).toBe('在吗')
    expect(server.sent.at(-1)).toEqual({ text: '在吗', replyTo: 1 })
    expect(outbox.entries.size).toBe(0)
  })

  it('a message that did arrive before the page went away is not shown again', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const outbox = new MemoryOutbox()
    const before = await opened(server, 'c1', outbox)
    // 存下了，应答却丢了：页面以为没发出去
    server.sending = 'lose-reply'
    before.send('c1', '收到了吗')
    await settle()
    expect(outbox.entries.size).toBe(1)

    server.sending = 'ok'
    const after = await reopened(server, outbox)
    expect(pending(after)).toEqual([])
    expect(texts(after).filter((text) => text === '收到了吗')).toHaveLength(1)
    expect(outbox.entries.size).toBe(0)
  })

  it('a message that is deleted is gone, here and after a reload', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const outbox = new MemoryOutbox()
    const before = await opened(server, 'c1', outbox)
    server.sending = 'fail'
    before.send('c1', '不发了')
    await settle()

    before.discard('c1', 'k1')
    expect(pending(before)).toEqual([])
    await settle()
    expect(outbox.entries.size).toBe(0)
    const after = await reopened(server, outbox)
    expect(pending(after)).toEqual([])
  })

  it('a file comes back with its content, and is uploaded again if the upload had expired', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const outbox = new MemoryOutbox()
    const before = await opened(server, 'c1', outbox)
    // 传上去了，发送却失败了
    server.sending = 'fail'
    before.sendFile('c1', blob('pixels', 'image/png'), 'photo.png', { caption: '看' })
    await settle()
    expect(pending(before)).toEqual([['k1', 'failed']])
    const saved = [...outbox.entries.values()][0]
    expect(saved?.attachment?.file?.id).toBe('f-photo.png')

    const after = await reopened(server, outbox)
    const restored = after.thread('c1').pending[0]
    expect(restored?.attachment?.content).toBeInstanceOf(Blob)
    expect(restored?.text).toBe('看')

    // 隔了很久才重发：服务端已经把那个文件清理掉了。先失败，再点一次就用保存着的文件重新上传
    server.sending = 'ok'
    server.expired.add('f-photo.png')
    after.retry('c1', 'k1')
    await settle()
    expect(after.thread('c1').pending[0]).toMatchObject({
      status: 'failed',
      error: 'file_unavailable',
    })
    server.expired.clear()
    after.retry('c1', 'k1')
    await settle()
    expect(server.calls.filter((call) => call === 'upload photo.png')).toHaveLength(2)
    expect(pending(after)).toEqual([])
    expect(texts(after).at(-1)).toBe('看')
  })

  it('a file that could not be kept can only be deleted', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const outbox = new MemoryOutbox()
    await outbox.put({
      userId: ME,
      conversationId: 'c1',
      clientId: 'gone',
      text: '',
      createdAt: 100,
      attachment: { content: null, name: 'big.mov', size: 10 },
    })

    const store = await reopened(server, outbox)
    expect(store.thread('c1').pending[0]).toMatchObject({
      status: 'failed',
      error: 'file_not_saved',
    })
    store.retry('c1', 'gone')
    await settle()
    expect(server.calls.filter((call) => /^(upload|send) /.test(call))).toEqual([])
    store.discard('c1', 'gone')
    await settle()
    expect(outbox.entries.size).toBe(0)
  })

  it('only gives back what this user left behind', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    const outbox = new MemoryOutbox()
    await outbox.put({
      userId: 'someone-else',
      conversationId: 'c1',
      clientId: 'theirs',
      text: '别人的',
      createdAt: 100,
    })
    const store = await reopened(server, outbox)
    expect(pending(store)).toEqual([])
  })
})

describe('forwarding', () => {
  it('sends the chosen messages to each target in their original order', async () => {
    const server = new FakeServer()
    server.conversation('c1', 3)
    server.conversation('c2', 0)
    server.group('g1', 3)
    const store = await opened(server)
    const [first, second, third] = store.thread('c1').messages
    if (!first || !second || !third) throw new Error('three messages')
    // 第二条已经撤回了：跳过
    Object.assign(second, { recalled: true })

    // 选的顺序和原来的不一样：照原来的先后发
    store.forward(['c2', 'g1'], [third, second, first])
    expect(store.thread('c2').pending.map((item) => [item.text, item.status])).toEqual([
      ['old 1', 'sending'],
      ['old 3', 'sending'],
    ])
    expect(store.thread('c2').pending[0]?.forward).toMatchObject({
      conversationId: 'c1',
      seq: 1,
      kind: 'text',
    })
    await settle()

    // 每个会话里按原来的先后；几个会话之间互不等待
    expect(server.sent).toHaveLength(4)
    expect(server.log.c2?.map((item) => item.text)).toEqual(['old 1', 'old 3'])
    expect(server.log.g1?.slice(1).map((item) => item.text)).toEqual(['old 1', 'old 3'])
    // 这两个会话还没有打开过：确认了的就不再显示为没发出去
    expect(store.thread('c2').pending).toEqual([])
    expect(store.thread('g1').pending).toEqual([])
  })

  it('a forward that failed is kept like any other unsent message and can be resent', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    server.conversation('c2', 0)
    const outbox = new MemoryOutbox()
    const store = await opened(server, 'c1', outbox)
    const [original] = store.thread('c1').messages
    if (!original) throw new Error('a message')
    server.sending = 'fail'
    store.forward(['c2'], [original])
    await settle()
    expect(store.thread('c2').pending.map((item) => item.status)).toEqual(['failed'])
    expect([...outbox.entries.values()][0]?.forward).toMatchObject({ seq: 1 })

    server.sending = 'ok'
    const clientId = store.thread('c2').pending[0]?.clientId ?? ''
    store.retry('c2', clientId)
    await settle()
    expect(store.thread('c2').pending).toEqual([])
    expect(server.log.c2?.map((item) => item.text)).toEqual(['old 1'])
  })

  it('a merged forward sends one chat record to each target and shows it right away', async () => {
    const server = new FakeServer()
    server.conversation('c1', 3)
    server.conversation('c2', 0)
    server.group('g1', 1)
    const outbox = new MemoryOutbox()
    const store = await opened(server, 'c1', outbox)
    const [first, second, third] = store.thread('c1').messages
    if (!first || !second || !third) throw new Error('three messages')
    const record = { title: '甲和乙的聊天记录', items: [] }

    server.sending = 'fail'
    store.forwardMerged(['c2', 'g1'], [third, first], record)
    // 每个会话里一条，发送中先按拼好的样子显示
    for (const target of ['c2', 'g1']) {
      expect(store.thread(target).pending).toHaveLength(1)
      expect(store.thread(target).pending[0]?.merge).toEqual({
        conversationId: 'c1',
        seqs: [1, 3],
        record,
      })
    }
    await settle()
    // 没发出去的存在这台设备上，带着来源
    expect([...outbox.entries.values()].map((entry) => entry.merge?.seqs)).toEqual([
      [1, 3],
      [1, 3],
    ])

    server.sending = 'ok'
    store.retry('c2', store.thread('c2').pending[0]?.clientId ?? '')
    await settle()
    expect(server.sent.at(-1)).toEqual({
      merge: { conversationId: 'c1', seqs: [1, 3], title: '甲和乙的聊天记录' },
    })
    expect(store.thread('c2').pending).toEqual([])
    const sent = server.log.c2?.at(-1)
    expect(sent?.kind).toBe('chat_record')
    expect(sent?.record?.items.map((item) => item.text)).toEqual(['old 1', 'old 3'])
  })

  it('a chat record can be forwarded on its own and quoted by its title', async () => {
    const server = new FakeServer()
    server.conversation('c1', 1)
    server.conversation('c2', 0)
    const store = await opened(server)
    const [original] = store.thread('c1').messages
    if (!original) throw new Error('a message')
    const record = { title: '记录', items: [] }
    Object.assign(original, { kind: 'chat_record', text: null, record })
    expect(isForwardable(original)).toBe(true)

    store.forward(['c2'], [original])
    expect(store.thread('c2').pending[0]?.forward).toMatchObject({ kind: 'chat_record', record })
    // 引用它时摘要是标题
    store.send('c1', '收到', { replyTo: original })
    expect(store.thread('c1').pending[0]?.reply).toMatchObject({
      kind: 'chat_record',
      text: '记录',
    })
  })
})
