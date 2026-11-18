// 账号相关的接口调用。

import type {
  CreateInviteCodesRequest,
  DeleteInviteCodesResponse,
  InviteCodeList,
  InviteCodeOrder,
  InviteCodePage,
  InviteCodeStatus,
  InviteCodeView,
  Me,
  RegisterRequest,
  RevokeInviteCodesResponse,
  SessionList,
  SignedOutOthers,
  UpdateProfileRequest,
} from '@vibechat/protocol'
import { ApiError, apiRequest } from './api'

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

/** 当前登录的用户；没有登录时返回 null。 */
export async function fetchMe(options: Options = {}): Promise<Me | null> {
  try {
    return await apiRequest<Me>('/api/me', options)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'unauthorized') return null
    throw error
  }
}

export function login(handle: string, password: string, options?: Options): Promise<Me> {
  return apiRequest('/api/auth/login', json('POST', { handle, password }, options))
}

export function register(request: RegisterRequest, options?: Options): Promise<Me> {
  return apiRequest('/api/auth/register', json('POST', request, options))
}

export function logout(options: Options = {}): Promise<void> {
  return apiRequest('/api/auth/logout', { method: 'POST', ...options })
}

/** 我正在哪几台设备上登录着（F9）：本机在最前面。 */
export function listSessions(options: Options = {}): Promise<SessionList> {
  return apiRequest('/api/me/sessions', options)
}

/** 让我的另一台设备退出登录（F9）。 */
export function signOutSession(id: string, options: Options = {}): Promise<void> {
  return apiRequest(`/api/me/sessions/${id}`, { method: 'DELETE', ...options })
}

/** 让除本机以外的全部设备退出登录（F9）。交回退出了几台。 */
export function signOutOtherSessions(options: Options = {}): Promise<SignedOutOthers> {
  return apiRequest('/api/me/sessions/sign-out-others', { method: 'POST', ...options })
}

export function updateProfile(changes: UpdateProfileRequest, options?: Options): Promise<Me> {
  return apiRequest('/api/me', json('PATCH', changes, options))
}

export function changeHandle(handle: string, options?: Options): Promise<Me> {
  return apiRequest('/api/me/handle', json('PUT', { handle }, options))
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
  options?: Options,
): Promise<void> {
  return apiRequest(
    '/api/me/password',
    json('PUT', { current_password: currentPassword, new_password: newPassword }, options),
  )
}

/** 上传头像。服务端会校验它确实是图片并重新编码。 */
export function uploadAvatar(file: Blob, options: Options = {}): Promise<Me> {
  return apiRequest('/api/me/avatar', { method: 'PUT', body: file, ...options })
}

interface ListInviteCodesOptions extends Options {
  /** 第几页，从 1 开始。 */
  page?: number
  /** 每页几个；不写用服务端的默认值。 */
  pageSize?: number
  /** 只看某种状态的；不写则全部。 */
  status?: InviteCodeStatus
  /** 按生成时间排序的方向；不写则最新的在前。 */
  order?: InviteCodeOrder
}

/** 邀请码列表的一页，可以按状态筛选、按生成时间排序。 */
export function listInviteCodes({
  page = 1,
  pageSize,
  status,
  order,
  ...options
}: ListInviteCodesOptions = {}): Promise<InviteCodePage> {
  const query = new URLSearchParams({ page: String(page) })
  if (pageSize) query.set('page_size', String(pageSize))
  if (status) query.set('status', status)
  if (order) query.set('order', order)
  return apiRequest(`/api/admin/invite-codes?${query}`, options)
}

export function createInviteCodes(
  request: CreateInviteCodesRequest,
  options?: Options,
): Promise<InviteCodeList> {
  return apiRequest('/api/admin/invite-codes', json('POST', request, options))
}

/** 作废一个还没有使用的邀请码。 */
export function revokeInviteCode(id: string, options: Options = {}): Promise<InviteCodeView> {
  return apiRequest(`/api/admin/invite-codes/${id}/revoke`, { method: 'POST', ...options })
}

/** 一次作废多个邀请码，返回实际作废了几个：其中已经使用或作废的会被跳过。 */
export function revokeInviteCodes(
  ids: string[],
  options?: Options,
): Promise<RevokeInviteCodesResponse> {
  return apiRequest('/api/admin/invite-codes/revoke', json('POST', { ids }, options))
}

/** 删除已经作废或已经过期的邀请码，返回实际删除了几个：其余的会被跳过。 */
export function deleteInviteCodes(
  ids: string[],
  options?: Options,
): Promise<DeleteInviteCodesResponse> {
  return apiRequest('/api/admin/invite-codes/delete', json('POST', { ids }, options))
}

/** 一个已上传文件的地址。访问时浏览器会带上登录的 Cookie。 */
export function fileUrl(id: string): string {
  return `/api/files/${id}`
}
