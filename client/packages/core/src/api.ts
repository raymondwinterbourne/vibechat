// 接口调用的基础：统一的请求方法，把各种失败都转成带错误码的 ApiError。
// 界面按错误码和当前语言决定显示什么文字。

import type { ErrorCode, ErrorResponse, HealthResponse } from '@vibechat/protocol'

/** 服务端返回的错误码，加上只在客户端才会出现的两种情况。 */
export type ClientErrorCode =
  | ErrorCode
  /** 请求没有发出去，或没有收到任何响应。 */
  | 'network_error'
  /** 收到了响应，但内容不是约定的格式。 */
  | 'invalid_response'

export class ApiError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    /** HTTP 状态码；请求没有到达服务端时为 null。 */
    readonly status: number | null,
    message: string,
    /** 服务端日志里可以用来查这次请求的编号。 */
    readonly requestId: string | null = null,
    /** 被锁定或被限速时，还要等多少秒才能再试。 */
    readonly retryAfterSecs: number | null = null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type Fetch = typeof fetch

interface RequestOptions extends RequestInit {
  /** 测试时替换掉全局的 fetch。 */
  fetchImpl?: Fetch
}

/** 发出请求并返回解析后的 JSON。任何失败都抛出 ApiError；被主动取消时原样抛出。 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options)
  if (!response.ok) throw await errorFrom(response)
  // 204 表示成功但没有内容
  if (response.status === 204) return undefined as T
  return (await parseJson(response)) as T
}

/**
 * 健康检查。数据库不可用时服务端返回 503，但响应体仍然是健康状态，
 * 所以这里不把 503 当作错误。
 */
export async function fetchHealth(options: RequestOptions = {}): Promise<HealthResponse> {
  const response = await send('/api/health', options)
  if (response.ok || response.status === 503) {
    // 503 也可能来自反向代理，那时响应体不是健康状态，按普通错误处理
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => undefined)
    if (isHealthResponse(body)) return body
  }
  throw await errorFrom(response)
}

async function send(path: string, { fetchImpl = fetch, ...init }: RequestOptions) {
  try {
    return await fetchImpl(path, init)
  } catch (cause) {
    if (isAbort(cause)) throw cause
    throw new ApiError('network_error', null, String(cause))
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new ApiError(
      'invalid_response',
      response.status,
      'response is not json',
      requestId(response),
    )
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  const id = requestId(response)
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    body = undefined
  }
  if (isErrorResponse(body)) {
    return new ApiError(body.code, response.status, body.message, id, body.retry_after_secs ?? null)
  }
  // 不是服务端的错误结构，多半来自反向代理。按状态码归类
  const code: ClientErrorCode = [502, 503, 504].includes(response.status)
    ? 'unavailable'
    : 'invalid_response'
  return new ApiError(code, response.status, `unexpected response (${response.status})`, id)
}

function requestId(response: Response): string | null {
  return response.headers.get('x-request-id')
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

function isErrorResponse(body: unknown): body is ErrorResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as ErrorResponse).code === 'string' &&
    typeof (body as ErrorResponse).message === 'string'
  )
}

function isHealthResponse(body: unknown): body is HealthResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as HealthResponse).status === 'string' &&
    typeof (body as HealthResponse).database === 'boolean'
  )
}
