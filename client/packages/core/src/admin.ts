// 管理功能的接口调用：用户、系统设置、概况、操作记录、查看聊天内容、群，
// 以及管理员找回密码和修改邮箱。

import type {
  AdminConversationList,
  AdminConversationView,
  AdminGroupPage,
  AdminMemberList,
  AdminUserPage,
  AdminUserView,
  AuditAction,
  AuditPage,
  EmailConfirmed,
  MessageList,
  OverviewView,
  ResetPasswordResponse,
  SettingsView,
  UpdateSettingsRequest,
  UserStatus,
  ViewStarted,
} from '@vibechat/protocol'
import { apiRequest } from './api'

type Fetch = typeof fetch

interface Options {
  signal?: AbortSignal
  /** 测试时替换掉全局的 fetch。 */
  fetchImpl?: Fetch
}

function json(method: string, body: unknown, options: Options = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...options,
  }
}

/** 地址里的参数。没有给的（空的）不写。 */
function queryOf(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(name, String(value))
  }
  return query.size > 0 ? `?${query}` : ''
}

interface Paged extends Options {
  /** 第几页，从 1 开始。 */
  page?: number
  /** 每页几个；不写用服务端的默认值。 */
  pageSize?: number
}

// ---------- 用户 ----------

interface ListUsersOptions extends Paged {
  /** 在 ID 和昵称里找。 */
  search?: string
  /** 只看某种状态的；不写则全部。 */
  status?: UserStatus
}

/** 用户列表的一页，注册晚的在前。 */
export function listUsers({
  search,
  status,
  page,
  pageSize,
  ...options
}: ListUsersOptions = {}): Promise<AdminUserPage> {
  const query = queryOf({ search: search?.trim(), status, page, page_size: pageSize })
  return apiRequest(`/api/admin/users${query}`, options)
}

/** 禁用一个用户：他立即下线，之后不能登录。 */
export function disableUser(id: string, options: Options = {}): Promise<AdminUserView> {
  return apiRequest(`/api/admin/users/${id}/disable`, { method: 'POST', ...options })
}

export function enableUser(id: string, options: Options = {}): Promise<AdminUserView> {
  return apiRequest(`/api/admin/users/${id}/enable`, { method: 'POST', ...options })
}

/** 重置一个用户的密码。应答里的临时密码只出现这一次。 */
export function resetUserPassword(
  id: string,
  options: Options = {},
): Promise<ResetPasswordResponse> {
  return apiRequest(`/api/admin/users/${id}/reset-password`, { method: 'POST', ...options })
}

// ---------- 系统设置、概况、操作记录 ----------

export function fetchOverview(options: Options = {}): Promise<OverviewView> {
  return apiRequest('/api/admin/overview', options)
}

export function fetchSettings(options: Options = {}): Promise<SettingsView> {
  return apiRequest('/api/admin/settings', options)
}

/** 修改系统设置。只带上要改的项；改完立即生效。 */
export function updateSettings(
  changes: UpdateSettingsRequest,
  options?: Options,
): Promise<SettingsView> {
  return apiRequest('/api/admin/settings', json('PUT', changes, options))
}

interface ListAuditOptions extends Paged {
  /** 只看某一种操作；不写则全部。 */
  action?: AuditAction
}

/** 操作记录的一页，从新到旧。 */
export function listAudit({
  action,
  page,
  pageSize,
  ...options
}: ListAuditOptions = {}): Promise<AuditPage> {
  const query = queryOf({ action, page, page_size: pageSize })
  return apiRequest(`/api/admin/audit${query}`, options)
}

// ---------- 聊天内容和群 ----------

/** 一个用户参与的全部会话。只是找会话，看不到内容。 */
export function listUserConversations(
  userId: string,
  options: Options = {},
): Promise<AdminConversationList> {
  return apiRequest(`/api/admin/users/${userId}/conversations`, options)
}

interface ListAllGroupsOptions extends Paged {
  /** 在群名里找。 */
  search?: string
}

/** 系统里的群的一页，新建的在前。 */
export function listAllGroups({
  search,
  page,
  pageSize,
  ...options
}: ListAllGroupsOptions = {}): Promise<AdminGroupPage> {
  const query = queryOf({ search: search?.trim(), page, page_size: pageSize })
  return apiRequest(`/api/admin/groups${query}`, options)
}

/** 一个会话和它的全部成员，包括已经离开的。 */
export function listConversationMembers(
  conversationId: string,
  options: Options = {},
): Promise<AdminMemberList> {
  return apiRequest(`/api/admin/conversations/${conversationId}/members`, options)
}

/**
 * 开始查看一个会话的内容。服务端写下一条操作记录，交回一个查看凭据；
 * 之后取这个会话的消息和文件都要带着它。凭据过一段时间失效。
 */
export function startView(conversationId: string, options: Options = {}): Promise<ViewStarted> {
  return apiRequest(`/api/admin/conversations/${conversationId}/views`, {
    method: 'POST',
    ...options,
  })
}

interface ViewRange {
  /** 只要序号小于它的。向上翻时用。 */
  before?: number
  limit?: number
}

/** 查看中的会话里的一段消息，按序号从小到大。已撤回的带着原内容。 */
export function viewMessages(
  conversationId: string,
  view: string,
  range: ViewRange = {},
  options: Options = {},
): Promise<MessageList> {
  const query = queryOf({ view, before: range.before, limit: range.limit })
  return apiRequest(`/api/admin/conversations/${conversationId}/messages${query}`, options)
}

/** 查看中的会话里一个文件的几种地址。凭据写在地址里：图片和语音是页面直接去取的。 */
export function viewFileUrls(conversationId: string, view: string) {
  const base = `/api/admin/conversations/${conversationId}/files`
  const token = encodeURIComponent(view)
  return {
    file: (fileId: string) => `${base}/${fileId}?view=${token}`,
    thumbnail: (fileId: string) => `${base}/${fileId}/thumbnail?view=${token}`,
    download: (fileId: string) => `${base}/${fileId}?view=${token}&download=1`,
  }
}

/** 管理员解散一个群。 */
export function dissolveGroupAsAdmin(
  conversationId: string,
  options: Options = {},
): Promise<AdminConversationView> {
  return apiRequest(`/api/admin/conversations/${conversationId}/dissolve`, {
    method: 'POST',
    ...options,
  })
}

// ---------- 管理员找回密码和修改邮箱 ----------

/** 请求找回密码。不管邮箱对不对，服务端的回答都一样。 */
export function requestPasswordReset(email: string, options?: Options): Promise<void> {
  return apiRequest('/api/auth/password-reset', json('POST', { email: email.trim() }, options))
}

/** 凭邮件里的链接设一个新密码。 */
export function confirmPasswordReset(
  token: string,
  newPassword: string,
  options?: Options,
): Promise<void> {
  return apiRequest(
    '/api/auth/password-reset/confirm',
    json('POST', { token, new_password: newPassword }, options),
  )
}

/** 修改绑定的邮箱：向新邮箱发一封确认邮件，点了里面的链接才生效。 */
export function requestEmailChange(
  currentPassword: string,
  email: string,
  options?: Options,
): Promise<void> {
  return apiRequest(
    '/api/me/email',
    json('PUT', { current_password: currentPassword, email: email.trim() }, options),
  )
}

/** 凭确认邮件里的链接让新邮箱生效。 */
export function confirmEmail(token: string, options?: Options): Promise<EmailConfirmed> {
  return apiRequest('/api/auth/email-confirm', json('POST', { token }, options))
}
