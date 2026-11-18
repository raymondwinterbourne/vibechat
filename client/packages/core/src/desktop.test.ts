import { describe, expect, it, vi } from 'vitest'
import { desktopTooOld, downloadWithProgress, fetchDesktopLatest, isNewerVersion } from './desktop'

describe('comparing versions', () => {
  it('compares each part as a number', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true)
  })

  it('says no for the same or an older version', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '1.0.0')).toBe(false)
  })

  it('says no when either side is not a version', () => {
    for (const odd of ['', '1', '1.0', '1.0.0.0', 'v1.0.0', '1.0.x', '1.0.0-beta']) {
      expect(isNewerVersion(odd, '0.0.1'), odd).toBe(false)
      expect(isNewerVersion('9.9.9', odd), odd).toBe(false)
    }
  })
})

describe('asking what can be downloaded', () => {
  it('returns the release, or nothing when the server has none', async () => {
    const release = { version: '0.2.0', size: 1024, file_name: 'VibeChat-0.2.0-arm64.dmg' }
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ release }))
      .mockResolvedValueOnce(Response.json({ release: null }))
    expect(await fetchDesktopLatest({ fetchImpl })).toEqual({ release })
    expect(await fetchDesktopLatest({ fetchImpl })).toEqual({ release: null })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/desktop/latest')
  })
})

describe('a desktop client too old for something', () => {
  it('is too old only when it is a desktop client below the required version', () => {
    expect(desktopTooOld('0.1.0', '0.2.0')).toBe(true)
    expect(desktopTooOld('0.2.0', '0.2.0')).toBe(false)
    expect(desktopTooOld('0.10.0', '0.9.0')).toBe(false)
    // 浏览器里没有桌面客户端；没有要求；看不懂的版本号：都不拦
    expect(desktopTooOld(null, '0.2.0')).toBe(false)
    expect(desktopTooOld('0.1.0', null)).toBe(false)
    expect(desktopTooOld('dev', '0.2.0')).toBe(false)
  })
})

describe('downloading the installer with progress', () => {
  function streaming(parts: number[], headers: Record<string, string> = {}) {
    return async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const size of parts) controller.enqueue(new Uint8Array(size))
            controller.close()
          },
        }),
        { headers },
      )
  }

  it('reports each step and hands back the whole file', async () => {
    const seen: [number, number][] = []
    const blob = await downloadWithProgress('/api/desktop/download', {
      expectedSize: 1,
      onProgress: ({ received, total }) => seen.push([received, total]),
      fetchImpl: streaming([400, 600], { 'content-length': '1000' }),
    })
    expect(blob.size).toBe(1000)
    expect(seen).toEqual([
      [0, 1000],
      [400, 1000],
      [1000, 1000],
    ])
  })

  it('falls back to the expected size when the server does not say', async () => {
    const seen: number[] = []
    await downloadWithProgress('/x', {
      expectedSize: 500,
      onProgress: ({ total }) => seen.push(total),
      fetchImpl: streaming([300, 300]),
    })
    // 估计少了也不会超过 100%
    expect(seen).toEqual([500, 500, 600])
  })

  it('fails when the server refuses', async () => {
    await expect(
      downloadWithProgress('/x', {
        expectedSize: 1,
        onProgress: () => {},
        fetchImpl: async () => new Response('no', { status: 404 }),
      }),
    ).rejects.toThrow('404')
  })
})
