// 桌面客户端的安装包：服务器上现在可以下载哪个版本，以及版本号的比较。

import type { DesktopLatest } from '@vibechat/protocol'
import { apiRequest } from './api'

interface Options {
  signal?: AbortSignal
  /** 测试时替换掉全局的 fetch。 */
  fetchImpl?: typeof fetch
}

/** 下载安装包的地址。要登录；服务端交出的总是版本最高的那一个。 */
export const DESKTOP_DOWNLOAD_PATH = '/api/desktop/download'

/** 服务器上现在可以下载哪个版本。没有安装包时 `release` 为空。 */
export function fetchDesktopLatest(options: Options = {}): Promise<DesktopLatest> {
  return apiRequest('/api/desktop/latest', options)
}

function parse(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * `candidate` 是不是比 `current` 新。按数字比，不按文字比：0.10.0 比 0.9.0 新。
 * 任何一个看不懂时算"不是"，宁可不提示也不乱提示。
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parse(candidate)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number)
  }
  return false
}

/**
 * 这个桌面客户端是不是比要求的版本旧（U1）。浏览器里没有桌面客户端（`installed` 为空），
 * 不算旧：要求只针对桌面客户端。版本号看不懂时也不算旧，宁可放行也不误拦。
 */
export function desktopTooOld(installed: string | null, required: string | null): boolean {
  if (installed === null || required === null) return false
  return isNewerVersion(required, installed)
}

/** 下载进行到哪里了。 */
export interface DownloadProgress {
  received: number
  /** 一共多少字节。服务器没说时用调用方给的估计值。 */
  total: number
}

/**
 * 边下载边报告进度，下载完交回整个文件。桌面端里用：那里没有浏览器自带的下载栏，
 * 用户看不出下载到哪里、什么时候下完。被取消时抛出 AbortError。
 */
export async function downloadWithProgress(
  url: string,
  options: {
    /** 服务器没有给出大小时，按这个算百分比。 */
    expectedSize: number
    onProgress: (progress: DownloadProgress) => void
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  },
): Promise<Blob> {
  const { expectedSize, onProgress, signal, fetchImpl = fetch } = options
  const response = await fetchImpl(url, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`download failed with status ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  const total = Number.isFinite(declared) && declared > 0 ? declared : expectedSize
  const type = response.headers.get('content-type') ?? 'application/octet-stream'
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  onProgress({ received, total })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    onProgress({ received, total: Math.max(total, received) })
  }
  return new Blob(chunks as BlobPart[], { type })
}
