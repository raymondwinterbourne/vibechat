// 聊天相关的接口调用。

import type {
  ConversationCleared,
  ConversationList,
  ConversationPinned,
  ConversationRead,
  ConversationView,
  EditMessageRequest,
  ErrorResponse,
  FileView,
  InviteResult,
  JoinRequestList,
  JoinRequestView,
  LimitsView,
  MemberList,
  MemberProfile,
  MemberView,
  MessageList,
  MessagesDeleted,
  MessageView,
  SearchResult,
  SendMessageRequest,
} from '@vibechat/protocol'
import { ApiError, apiRequest } from '../api'

interface Options {
  signal?: AbortSignal
  /** 测试时替换掉全局的 fetch。 */
  fetchImpl?: typeof fetch
}

function json(method: string, body: unknown, options: Options = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  }
}

/** 我的会话列表，最新有动静的在前。只含有内容、并且没有被我移除的会话。 */
export async function listConversations(options: Options = {}): Promise<ConversationView[]> {
  const list = await apiRequest<ConversationList>('/api/conversations', options)
  return list.items
}

/** 一个会话在我这边的样子。它不必在我的列表里。 */
export function fetchConversation(id: string, options: Options = {}): Promise<ConversationView> {
  return apiRequest(`/api/conversations/${id}`, options)
}

/** 取得我和一个好友的单聊会话，没有就创建。 */
export function openDirectConversation(
  userId: string,
  options?: Options,
): Promise<ConversationView> {
  return apiRequest('/api/conversations/direct', json('POST', { user_id: userId }, options))
}

export interface MessageRange {
  /** 取这个序号之前的一段（向上翻阅）。 */
  before?: number
  /** 取这个序号之后的一段（补齐）。 */
  after?: number
  limit?: number
}

/** 会话里的一段消息，按序号从小到大。不指定范围时是最新的一段。 */
export function listMessages(
  conversationId: string,
  range: MessageRange = {},
  options: Options = {},
): Promise<MessageList> {
  const query = new URLSearchParams()
  if (range.before !== undefined) query.set('before', String(range.before))
  if (range.after !== undefined) query.set('after', String(range.after))
  if (range.limit !== undefined) query.set('limit', String(range.limit))
  const suffix = query.size > 0 ? `?${query}` : ''
  return apiRequest(`/api/conversations/${conversationId}/messages${suffix}`, options)
}

/** 一条消息 @ 了谁。只在群里有用。 */
export interface Mentions {
  /** 被 @ 的人的内部编号。 */
  users: string[]
  /** @ 所有人。只有群主可以。 */
  all: boolean
}

/** 要发的一条消息的内容。 */
export interface Outgoing {
  /** 文本消息的文字；图片的文字说明。文件和语音不带文字。 */
  text?: string
  mentions?: Mentions
  /** 所附的文件：先上传，再把得到的编号放在这里。 */
  fileId?: string
  /** 语音的时长，毫秒。给了它，所附的文件就按语音发。 */
  voiceDurationMs?: number
  /** 回复的是哪一条：被引用消息的序号。 */
  replyTo?: number
  /** 转发：内容从这一条复制过来。给了它就不用别的。 */
  forward?: { conversationId: string; seq: number }
  /** 合并转发：把这几条做成一条聊天记录。给了它就不用别的。 */
  merge?: { conversationId: string; seqs: number[]; title: string }
}

/**
 * 发一条消息。`clientId` 是这条消息在客户端的编号：
 * 没等到结果而重发时带同一个，服务端据此不会存成两条。
 */
export function sendMessage(
  conversationId: string,
  clientId: string,
  content: Outgoing,
  options?: Options,
): Promise<MessageView> {
  const body: SendMessageRequest = { client_id: clientId }
  if (content.text !== undefined) body.text = content.text
  if (content.mentions) {
    body.mentions = content.mentions.users
    body.mention_all = content.mentions.all
  }
  if (content.fileId !== undefined) body.file_id = content.fileId
  if (content.voiceDurationMs !== undefined) body.voice_duration_ms = content.voiceDurationMs
  if (content.replyTo !== undefined) body.reply_to = content.replyTo
  if (content.forward) {
    body.forward = { conversation_id: content.forward.conversationId, seq: content.forward.seq }
  }
  if (content.merge) {
    const { conversationId, seqs, title } = content.merge
    body.merge = { conversation_id: conversationId, seqs, title }
  }
  return apiRequest(`/api/conversations/${conversationId}/messages`, json('POST', body, options))
}

// ---------- 文件 ----------

export interface UploadOptions {
  signal?: AbortSignal
  /** 传了多少，0 到 1。 */
  onProgress?: (fraction: number) => void
}

/**
 * 上传一个要随消息发出去的文件。应答里说明服务端把它认成了什么：图片、音频，还是普通文件。
 * 被取消时抛出 AbortError。
 */
export function uploadFile(
  content: Blob,
  name: string,
  { signal, onProgress }: UploadOptions = {},
): Promise<FileView> {
  // 上传的进度只有这种老式的请求方式报得出来
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/files')
    // 请求头里不能直接写中文，文件名按 UTF-8 做百分号编码
    request.setRequestHeader('X-File-Name', encodeURIComponent(name))
    request.setRequestHeader('Content-Type', content.type || 'application/octet-stream')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total)
    }
    request.onload = () => {
      let body: unknown
      try {
        body = JSON.parse(request.responseText)
      } catch {
        body = undefined
      }
      if (request.status >= 200 && request.status < 300 && body) {
        resolve(body as FileView)
        return
      }
      const error = body as Partial<ErrorResponse> | undefined
      reject(
        typeof error?.code === 'string'
          ? new ApiError(error.code, request.status, error.message ?? '')
          : new ApiError('invalid_response', request.status, 'unexpected upload response'),
      )
    }
    request.onerror = () => reject(new ApiError('network_error', null, 'upload failed'))
    request.onabort = () => reject(new DOMException('upload cancelled', 'AbortError'))
    if (signal?.aborted) {
      reject(new DOMException('upload cancelled', 'AbortError'))
      return
    }
    signal?.addEventListener('abort', () => request.abort())
    request.send(content)
  })
}

/** 图片缩略图的地址。 */
export function thumbnailUrl(fileId: string): string {
  return `/api/files/${fileId}/thumbnail`
}

/** 把文件存到本地的地址：图片和音频也作为下载返回，而不是在页面里打开。 */
export function downloadUrl(fileId: string): string {
  return `/api/files/${fileId}?download=1`
}

/** 当前生效的几项上限：文件大小、语音时长、撤回时限。 */
export function fetchLimits(options: Options = {}): Promise<LimitsView> {
  return apiRequest('/api/limits', options)
}

// ---------- 撤回、语音、搜索 ----------

/** 撤回自己发的一条消息。应答是会话里新增的那条撤回事件。 */
export function recallMessage(
  conversationId: string,
  seq: number,
  options: Options = {},
): Promise<MessageView> {
  return apiRequest(`/api/conversations/${conversationId}/messages/${seq}/recall`, {
    method: 'POST',
    ...options,
  })
}

/** 编辑自己发的一条消息（F8）：新的文字，和改完之后 @ 了谁。应答是会话里新增的那条编辑事件。 */
export function editMessage(
  conversationId: string,
  seq: number,
  edit: EditMessageRequest,
  options: Options = {},
): Promise<MessageView> {
  return apiRequest(`/api/conversations/${conversationId}/messages/${seq}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
    ...options,
  })
}

/** 记下我听过了一条语音。 */
export function markVoicePlayed(
  conversationId: string,
  seq: number,
  options: Options = {},
): Promise<void> {
  return apiRequest(`/api/conversations/${conversationId}/messages/${seq}/played`, {
    method: 'POST',
    ...options,
  })
}

/** 在我的全部会话里搜索，从新到旧。 */
export function searchMessages(query: string, options: Options = {}): Promise<SearchResult> {
  return apiRequest(`/api/search?${new URLSearchParams({ q: query })}`, options)
}

/** 只在一个会话里搜索。`before` 是上一页最后一条的序号，用来往更早的翻。 */
export function searchConversation(
  conversationId: string,
  query: string,
  page: { before?: number; limit?: number } = {},
  options: Options = {},
): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query })
  if (page.before !== undefined) params.set('before', String(page.before))
  if (page.limit !== undefined) params.set('limit', String(page.limit))
  return apiRequest(`/api/conversations/${conversationId}/search?${params}`, options)
}

/**
 * 会话里的图片或文件（F6），从新到旧一页一页地取：`before` 是上一页里最早那一条的序号。
 * 一页里按序号从小到大。
 */
export function listMedia(
  conversationId: string,
  kind: 'image' | 'file',
  page: { before?: number; limit?: number } = {},
  options: Options = {},
): Promise<MessageList> {
  const params = new URLSearchParams({ kind })
  if (page.before !== undefined) params.set('before', String(page.before))
  if (page.limit !== undefined) params.set('limit', String(page.limit))
  return apiRequest(`/api/conversations/${conversationId}/media?${params}`, options)
}

/** 上报已读位置：序号不大于 `seq` 的我都看过了。 */
export function markConversationRead(
  conversationId: string,
  seq: number,
  options?: Options,
): Promise<ConversationRead> {
  return apiRequest(`/api/conversations/${conversationId}/read`, json('POST', { seq }, options))
}

/** 把会话从我的列表里移除。有新消息时它会重新出现。 */
export function hideConversation(conversationId: string, options: Options = {}): Promise<void> {
  return apiRequest(`/api/conversations/${conversationId}/hide`, { method: 'POST', ...options })
}

/** 把会话设为免打扰，或者取消。消息照常收，只是不提醒。 */
/** 把几条从自己这边删掉（F6）：对方照常看得到。交回删掉的序号。 */
export async function deleteForMe(
  conversationId: string,
  seqs: readonly number[],
  options?: Options,
): Promise<number[]> {
  const result = await apiRequest<MessagesDeleted>(
    `/api/conversations/${conversationId}/messages/delete`,
    json('POST', { seqs }, options),
  )
  return result.seqs
}

/** 清空这个会话到现在为止的记录，只对自己（F6）。交回清空到了第几条。 */
export async function clearForMe(conversationId: string, options?: Options): Promise<number> {
  const result = await apiRequest<ConversationCleared>(
    `/api/conversations/${conversationId}/clear`,
    json('POST', {}, options),
  )
  return result.cleared_seq
}

/** 把会话置顶，或者取消。交回置顶的时间（取消了为空）。 */
export async function pinConversation(
  conversationId: string,
  pinned: boolean,
  options?: Options,
): Promise<number | null> {
  const result = await apiRequest<ConversationPinned>(
    `/api/conversations/${conversationId}/pin`,
    json('PUT', { pinned }, options),
  )
  return result.pinned_at
}

export function muteConversation(
  conversationId: string,
  muted: boolean,
  options?: Options,
): Promise<void> {
  return apiRequest(`/api/conversations/${conversationId}/mute`, json('PUT', { muted }, options))
}

// ---------- 群 ----------

/** 我现在所在的全部群，不管它们在不在我的会话列表里。 */
export async function listGroups(options: Options = {}): Promise<ConversationView[]> {
  const list = await apiRequest<ConversationList>('/api/groups', options)
  return list.items
}

/** 拉几个好友建一个群。`name` 可以留空。 */
export function createGroup(
  name: string,
  memberIds: string[],
  options?: Options,
): Promise<ConversationView> {
  return apiRequest(
    '/api/conversations/group',
    json('POST', { name, member_ids: memberIds }, options),
  )
}

/** 群主修改群名称；留空即去掉群名。 */
export function renameGroup(
  conversationId: string,
  name: string,
  options?: Options,
): Promise<ConversationView> {
  return apiRequest(`/api/conversations/${conversationId}`, json('PATCH', { name }, options))
}

/** 群主发布、修改或清空群公告（只有空白就是清空）。应答是群现在的样子。 */
export function setGroupNotice(
  conversationId: string,
  text: string,
  options?: Options,
): Promise<ConversationView> {
  return apiRequest(`/api/conversations/${conversationId}/notice`, json('PUT', { text }, options))
}

/** 我看过了这个群现在的公告。 */
export function markNoticeSeen(conversationId: string, options: Options = {}): Promise<void> {
  return apiRequest(`/api/conversations/${conversationId}/notice/seen`, {
    method: 'POST',
    ...options,
  })
}

/** 群主更换群头像。 */
export function uploadGroupAvatar(
  conversationId: string,
  file: Blob,
  options: Options = {},
): Promise<ConversationView> {
  return apiRequest(`/api/conversations/${conversationId}/avatar`, {
    method: 'PUT',
    body: file,
    ...options,
  })
}

/** 群主解散群。 */
export function dissolveGroup(
  conversationId: string,
  options: Options = {},
): Promise<ConversationView> {
  return apiRequest(`/api/conversations/${conversationId}/dissolve`, {
    method: 'POST',
    ...options,
  })
}

/** 群的全部成员，包括已经离开的。 */
export async function listMembers(
  conversationId: string,
  options: Options = {},
): Promise<MemberView[]> {
  const list = await apiRequest<MemberList>(`/api/conversations/${conversationId}/members`, options)
  return list.items
}

/** 邀请几个好友入群。 */
export function inviteMembers(
  conversationId: string,
  userIds: string[],
  options?: Options,
): Promise<InviteResult> {
  return apiRequest(
    `/api/conversations/${conversationId}/members`,
    json('POST', { user_ids: userIds }, options),
  )
}

/** 同一个群的成员的资料。 */
export function fetchMemberProfile(
  conversationId: string,
  userId: string,
  options: Options = {},
): Promise<MemberProfile> {
  return apiRequest(`/api/conversations/${conversationId}/members/${userId}`, options)
}

/** 群主或管理员把一个成员移出群。 */
export function removeMember(
  conversationId: string,
  userId: string,
  options: Options = {},
): Promise<ConversationView> {
  return apiRequest(`/api/conversations/${conversationId}/members/${userId}`, {
    method: 'DELETE',
    ...options,
  })
}

/** 群主把一名成员设为群管理员（`admin` 为真），或者取消。 */
export function setGroupAdmin(
  conversationId: string,
  userId: string,
  admin: boolean,
  options: Options = {},
): Promise<ConversationView> {
  return apiRequest(`/api/conversations/${conversationId}/admins/${userId}`, {
    method: admin ? 'PUT' : 'DELETE',
    ...options,
  })
}

/** 群主或管理员禁言一名成员 `minutes` 分钟（10、60、720、1440），为空是直到解除。 */
export function muteMember(
  conversationId: string,
  userId: string,
  minutes: number | null,
  options?: Options,
): Promise<ConversationView> {
  return apiRequest(
    `/api/conversations/${conversationId}/muted-members/${userId}`,
    json('PUT', { minutes }, options),
  )
}

/** 群主或管理员提前解除一名成员的禁言。 */
export function unmuteMember(
  conversationId: string,
  userId: string,
  options: Options = {},
): Promise<ConversationView> {
  return apiRequest(`/api/conversations/${conversationId}/muted-members/${userId}`, {
    method: 'DELETE',
    ...options,
  })
}

/** 群主或管理员开关全员禁言。 */
export function setAllMuted(
  conversationId: string,
  muted: boolean,
  options?: Options,
): Promise<ConversationView> {
  return apiRequest(
    `/api/conversations/${conversationId}/all-muted`,
    json('PUT', { muted }, options),
  )
}

/** 改我在一个群里的昵称。只有空白就是去掉。 */
export function setGroupNickname(
  conversationId: string,
  nickname: string,
  options?: Options,
): Promise<void> {
  return apiRequest(
    `/api/conversations/${conversationId}/nickname`,
    json('PUT', { nickname }, options),
  )
}

/** 群主或管理员开关入群审批。 */
export function setJoinApproval(
  conversationId: string,
  enabled: boolean,
  options?: Options,
): Promise<ConversationView> {
  return apiRequest(
    `/api/conversations/${conversationId}/join-approval`,
    json('PUT', { enabled }, options),
  )
}

/** 一个群的入群申请：群主和管理员看全部，其他人只看自己发出的。 */
export async function listJoinRequests(
  conversationId: string,
  options: Options = {},
): Promise<JoinRequestView[]> {
  const list: JoinRequestList = await apiRequest(
    `/api/conversations/${conversationId}/join-requests`,
    options,
  )
  return list.items
}

/** 群主或管理员同意（`approve` 为真）或拒绝一条入群申请。 */
export function handleJoinRequest(
  conversationId: string,
  requestId: string,
  approve: boolean,
  options: Options = {},
): Promise<ConversationView> {
  const action = approve ? 'approve' : 'reject'
  return apiRequest(`/api/conversations/${conversationId}/join-requests/${requestId}/${action}`, {
    method: 'POST',
    ...options,
  })
}

/** 退出一个群。 */
export function leaveGroup(conversationId: string, options: Options = {}): Promise<void> {
  return apiRequest(`/api/conversations/${conversationId}/leave`, { method: 'POST', ...options })
}

/** 群主把群主的身份转让给另一名成员。 */
export function transferOwner(
  conversationId: string,
  userId: string,
  options?: Options,
): Promise<ConversationView> {
  return apiRequest(
    `/api/conversations/${conversationId}/owner`,
    json('PUT', { user_id: userId }, options),
  )
}
