import { describe, expect, it } from 'vitest'
import { ApiError, apiRequest, fetchHealth } from './api'

function respondWith(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return async () => new Response(text, { status, headers })
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected the request to fail')
}

describe('apiRequest', () => {
  it('returns the parsed body on success', async () => {
    const result = await apiRequest<{ value: number }>('/api/thing', {
      fetchImpl: respondWith(200, { value: 42 }),
    })
    expect(result).toEqual({ value: 42 })
  })

  it('turns a server error into an ApiError with its code and request id', async () => {
    const error = await failure(
      apiRequest('/api/thing', {
        fetchImpl: respondWith(
          404,
          { code: 'not_found', message: 'no such path' },
          { 'x-request-id': 'req-1' },
        ),
      }),
    )
    expect(error.code).toBe('not_found')
    expect(error.status).toBe(404)
    expect(error.requestId).toBe('req-1')
  })

  it('reports a network failure when the request never gets an answer', async () => {
    const error = await failure(
      apiRequest('/api/thing', {
        fetchImpl: async () => {
          throw new TypeError('fetch failed')
        },
      }),
    )
    expect(error.code).toBe('network_error')
    expect(error.status).toBeNull()
  })

  it('treats a gateway error page from the proxy as unavailable', async () => {
    const error = await failure(
      apiRequest('/api/thing', { fetchImpl: respondWith(502, '<html>Bad Gateway</html>') }),
    )
    expect(error.code).toBe('unavailable')
  })

  it('reports an unexpected error body as an invalid response', async () => {
    const error = await failure(apiRequest('/api/thing', { fetchImpl: respondWith(500, 'oops') }))
    expect(error.code).toBe('invalid_response')
    expect(error.status).toBe(500)
  })

  it('reports a successful response that is not json as an invalid response', async () => {
    const error = await failure(
      apiRequest('/api/thing', { fetchImpl: respondWith(200, 'not json') }),
    )
    expect(error.code).toBe('invalid_response')
  })

  it('lets a cancelled request through unchanged', async () => {
    const abort = new DOMException('cancelled', 'AbortError')
    await expect(
      apiRequest('/api/thing', {
        fetchImpl: async () => {
          throw abort
        },
      }),
    ).rejects.toBe(abort)
  })
})

describe('fetchHealth', () => {
  it('returns the health body when everything is fine', async () => {
    const health = await fetchHealth({
      fetchImpl: respondWith(200, { status: 'ok', version: '0.1.0', database: true }),
    })
    expect(health.status).toBe('ok')
  })

  it('returns the health body when the server reports itself degraded', async () => {
    const health = await fetchHealth({
      fetchImpl: respondWith(503, { status: 'degraded', version: '0.1.0', database: false }),
    })
    expect(health).toEqual({ status: 'degraded', version: '0.1.0', database: false })
  })

  it('fails when the server cannot be reached through the proxy', async () => {
    const error = await failure(fetchHealth({ fetchImpl: respondWith(503, 'upstream down') }))
    expect(error.code).toBe('unavailable')
  })
})
