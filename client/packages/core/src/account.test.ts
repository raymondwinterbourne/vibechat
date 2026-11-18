import { describe, expect, it } from 'vitest'
import {
  changePassword,
  createInviteCodes,
  deleteInviteCodes,
  fetchMe,
  fileUrl,
  listInviteCodes,
  login,
  logout,
  revokeInviteCode,
  revokeInviteCodes,
  uploadAvatar,
} from './account'
import { ApiError } from './api'

const ME = {
  id: '0190a000-0000-7000-8000-000000000001',
  handle: 'vmabc12345',
  nickname: '小明',
  signature: '',
  avatar_file_id: null,
  role: 'user',
  must_change_password: false,
  email: null,
  language: null,
  theme: null,
  created_at: 0,
}

interface Call {
  path: string
  init: RequestInit
}

/** 记录请求并按给定的状态码和内容应答。 */
function server(status: number, body?: unknown) {
  const calls: Call[] = []
  const fetchImpl = async (path: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ path: String(path), init })
    return new Response(body === undefined ? null : JSON.stringify(body), { status })
  }
  return { calls, fetchImpl: fetchImpl as typeof fetch }
}

describe('fetchMe', () => {
  it('returns the user when logged in', async () => {
    const { fetchImpl } = server(200, ME)
    expect(await fetchMe({ fetchImpl })).toEqual(ME)
  })

  it('returns null when not logged in', async () => {
    const { fetchImpl } = server(401, { code: 'unauthorized', message: 'not logged in' })
    expect(await fetchMe({ fetchImpl })).toBeNull()
  })

  it('still fails for any other problem', async () => {
    const { fetchImpl } = server(503, { code: 'unavailable', message: 'storage is unavailable' })
    await expect(fetchMe({ fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })
})

describe('account requests', () => {
  it('login posts the id and password as json', async () => {
    const { calls, fetchImpl } = server(200, ME)
    await login('vmabc12345', 'correct-horse-1', { fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/api/auth/login')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      handle: 'vmabc12345',
      password: 'correct-horse-1',
    })
  })

  it('a failed login carries the wait time when the id is locked', async () => {
    const { fetchImpl } = server(429, {
      code: 'account_locked',
      message: 'locked',
      retry_after_secs: 900,
    })
    const error = await login('vmabc12345', 'x', { fetchImpl }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('account_locked')
    expect((error as ApiError).retryAfterSecs).toBe(900)
  })

  it('requests without a response body resolve to nothing', async () => {
    const { calls, fetchImpl } = server(204)
    await expect(logout({ fetchImpl })).resolves.toBeUndefined()
    await expect(changePassword('old-pass-1', 'new-pass-2', { fetchImpl })).resolves.toBeUndefined()
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      current_password: 'old-pass-1',
      new_password: 'new-pass-2',
    })
  })

  it('an avatar is uploaded as the raw file', async () => {
    const { calls, fetchImpl } = server(200, ME)
    const file = new Blob(['image-bytes'], { type: 'image/png' })
    await uploadAvatar(file, { fetchImpl })

    expect(calls[0]?.path).toBe('/api/me/avatar')
    expect(calls[0]?.init.method).toBe('PUT')
    expect(calls[0]?.init.body).toBe(file)
  })

  it('invite codes are created with an optional note and expiry, and revoked by id', async () => {
    const { calls, fetchImpl } = server(201, { items: [] })
    await createInviteCodes(
      { count: 3, note: 'for the new team', expires_in_days: 7 },
      { fetchImpl },
    )
    expect(calls[0]?.path).toBe('/api/admin/invite-codes')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      count: 3,
      note: 'for the new team',
      expires_in_days: 7,
    })

    await revokeInviteCode('abc', { fetchImpl })
    expect(calls[1]?.path).toBe('/api/admin/invite-codes/abc/revoke')
    expect(calls[1]?.init.method).toBe('POST')
  })

  it('invite codes are listed a page at a time, filtered and ordered', async () => {
    const { calls, fetchImpl } = server(200, { items: [], total: 0 })
    await listInviteCodes({ fetchImpl })
    await listInviteCodes({ page: 3, pageSize: 50, fetchImpl })

    await listInviteCodes({ page: 2, status: 'revoked', order: 'oldest', fetchImpl })

    expect(calls[0]?.path).toBe('/api/admin/invite-codes?page=1')
    expect(calls[1]?.path).toBe('/api/admin/invite-codes?page=3&page_size=50')
    expect(calls[2]?.path).toBe('/api/admin/invite-codes?page=2&status=revoked&order=oldest')
  })

  it('several invite codes are deleted in one request', async () => {
    const { calls, fetchImpl } = server(200, { deleted: 1 })
    const result = await deleteInviteCodes(['a', 'b'], { fetchImpl })

    expect(result.deleted).toBe(1)
    expect(calls[0]?.path).toBe('/api/admin/invite-codes/delete')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ids: ['a', 'b'] })
  })

  it('several invite codes are revoked in one request', async () => {
    const { calls, fetchImpl } = server(200, { revoked: 2 })
    const result = await revokeInviteCodes(['a', 'b', 'c'], { fetchImpl })

    expect(result.revoked).toBe(2)
    expect(calls[0]?.path).toBe('/api/admin/invite-codes/revoke')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ids: ['a', 'b', 'c'] })
  })

  it('file urls point at the files endpoint', () => {
    expect(fileUrl('abc')).toBe('/api/files/abc')
  })
})
