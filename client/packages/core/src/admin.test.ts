import { describe, expect, it } from 'vitest'
import {
  confirmEmail,
  confirmPasswordReset,
  disableUser,
  dissolveGroupAsAdmin,
  listAllGroups,
  listAudit,
  listUsers,
  requestEmailChange,
  requestPasswordReset,
  resetUserPassword,
  startView,
  updateSettings,
  viewFileUrls,
  viewMessages,
} from './admin'
import { ApiError } from './api'

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

const PAGE = { items: [], total: 0 }

describe('lists', () => {
  it('leave out the parameters that were not given', async () => {
    const { calls, fetchImpl } = server(200, PAGE)
    await listUsers({ fetchImpl })
    await listUsers({ search: '  ', fetchImpl })
    await listAllGroups({ fetchImpl })
    await listAudit({ fetchImpl })
    expect(calls.map((call) => call.path)).toEqual([
      '/api/admin/users',
      '/api/admin/users',
      '/api/admin/groups',
      '/api/admin/audit',
    ])
  })

  it('send search text, filters and paging in the address', async () => {
    const { calls, fetchImpl } = server(200, PAGE)
    await listUsers({ search: ' 小明 & co ', status: 'disabled', page: 2, pageSize: 20, fetchImpl })
    await listAllGroups({ search: 'alpha', page: 3, fetchImpl })
    await listAudit({ action: 'chat_viewed', page: 1, fetchImpl })
    expect(calls.map((call) => call.path)).toEqual([
      '/api/admin/users?search=%E5%B0%8F%E6%98%8E+%26+co&status=disabled&page=2&page_size=20',
      '/api/admin/groups?search=alpha&page=3',
      '/api/admin/audit?action=chat_viewed&page=1',
    ])
  })
})

describe('actions on a user or a group', () => {
  it('are posts to the address of that user or group', async () => {
    const { calls, fetchImpl } = server(200, {})
    await disableUser('u1', { fetchImpl })
    await resetUserPassword('u1', { fetchImpl })
    await dissolveGroupAsAdmin('c1', { fetchImpl })
    await startView('c1', { fetchImpl })
    expect(calls.map((call) => [call.init.method, call.path])).toEqual([
      ['POST', '/api/admin/users/u1/disable'],
      ['POST', '/api/admin/users/u1/reset-password'],
      ['POST', '/api/admin/conversations/c1/dissolve'],
      ['POST', '/api/admin/conversations/c1/views'],
    ])
  })

  it('report why they were refused', async () => {
    const { fetchImpl } = server(403, { code: 'cannot_target_self', message: 'no' })
    const refused = disableUser('me', { fetchImpl })
    await expect(refused).rejects.toBeInstanceOf(ApiError)
    await expect(refused).rejects.toMatchObject({ code: 'cannot_target_self', status: 403 })
  })
})

describe('viewing a conversation', () => {
  it('carries the view credential with every read', async () => {
    const { calls, fetchImpl } = server(200, { items: [], has_more: false })
    await viewMessages('c1', 'tok', {}, { fetchImpl })
    await viewMessages('c1', 'tok', { before: 120, limit: 50 }, { fetchImpl })
    expect(calls.map((call) => call.path)).toEqual([
      '/api/admin/conversations/c1/messages?view=tok',
      '/api/admin/conversations/c1/messages?view=tok&before=120&limit=50',
    ])
    expect(calls.every((call) => call.init.method === undefined)).toBe(true)
  })

  it('builds file addresses that carry the credential too', () => {
    const urls = viewFileUrls('c1', 'a/b')
    expect(urls.file('f1')).toBe('/api/admin/conversations/c1/files/f1?view=a%2Fb')
    expect(urls.thumbnail('f1')).toBe('/api/admin/conversations/c1/files/f1/thumbnail?view=a%2Fb')
    expect(urls.download('f1')).toBe('/api/admin/conversations/c1/files/f1?view=a%2Fb&download=1')
  })
})

describe('settings', () => {
  it('sends only the items that change', async () => {
    const { calls, fetchImpl } = server(200, {})
    await updateSettings({ file_max_bytes: 1048576, retention_days: 0 }, { fetchImpl })
    expect(calls[0]?.init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      file_max_bytes: 1048576,
      retention_days: 0,
    })
  })
})

describe('recovering the password and changing the email', () => {
  it('sends what each step needs', async () => {
    const { calls, fetchImpl } = server(204)
    await requestPasswordReset(' boss@example.com ', { fetchImpl })
    await confirmPasswordReset('tok', 'new-pass-1', { fetchImpl })
    await requestEmailChange('current-1', ' new@example.com ', { fetchImpl })
    const sent = calls.map((call) => [
      call.init.method,
      call.path,
      JSON.parse(String(call.init.body)),
    ])
    expect(sent).toEqual([
      ['POST', '/api/auth/password-reset', { email: 'boss@example.com' }],
      ['POST', '/api/auth/password-reset/confirm', { token: 'tok', new_password: 'new-pass-1' }],
      ['PUT', '/api/me/email', { current_password: 'current-1', email: 'new@example.com' }],
    ])
  })

  it('tells a used or expired link apart from success', async () => {
    const ok = server(200, { email: 'new@example.com' })
    expect(await confirmEmail('tok', { fetchImpl: ok.fetchImpl })).toEqual({
      email: 'new@example.com',
    })
    const bad = server(400, { code: 'link_invalid', message: 'no' })
    await expect(confirmEmail('tok', { fetchImpl: bad.fetchImpl })).rejects.toMatchObject({
      code: 'link_invalid',
    })
  })
})
