import { describe, expect, it } from 'vitest'
import { fetchBuildId, UpdateChecker } from './update'

function checker(current: string | null, served: () => string | null, start = 1000) {
  let now = start
  let fetched = 0
  const update = new UpdateChecker({
    current,
    fetchBuild: async () => {
      fetched += 1
      return served()
    },
    now: () => now,
    foregroundIntervalMs: 100,
  })
  return {
    update,
    advance: (ms: number) => {
      now += ms
    },
    fetched: () => fetched,
  }
}

describe('page updates', () => {
  it('says nothing while the server has the same page', async () => {
    const { update } = checker('a', () => 'a')
    await update.check('reconnected')
    expect(update.available).toBeNull()
  })

  it('notices a new page after reconnecting and tells its listeners once', async () => {
    let served = 'a'
    const { update } = checker('a', () => served)
    let told = 0
    update.subscribe(() => {
      told += 1
    })
    served = 'b'
    await update.check('reconnected')
    expect(update.available).toBe('b')
    await update.check('reconnected')
    expect(told).toBe(1)
  })

  it('checks on coming to the foreground at most every so often', async () => {
    const { update, advance, fetched } = checker('a', () => 'a')
    await update.check('foreground')
    await update.check('foreground')
    expect(fetched()).toBe(1)
    advance(100)
    await update.check('foreground')
    // 重连之后总是检查
    await update.check('reconnected')
    expect(fetched()).toBe(3)
  })

  it('once dismissed, the same update is not offered again, but the next one is', async () => {
    let served = 'b'
    const { update } = checker('a', () => served)
    await update.check('reconnected')
    update.dismiss()
    expect(update.available).toBeNull()
    await update.check('reconnected')
    expect(update.available).toBeNull()
    served = 'c'
    await update.check('reconnected')
    expect(update.available).toBe('c')
  })

  it('does nothing in development, where the page has no build number', async () => {
    const { update, fetched } = checker(null, () => 'b')
    await update.check('reconnected')
    expect(update.available).toBeNull()
    expect(fetched()).toBe(0)
  })

  it('ignores a missing or broken version file', async () => {
    const { update } = checker('a', () => null)
    await update.check('reconnected')
    expect(update.available).toBeNull()
  })
})

describe('reading the build number from the server', () => {
  it('asks past every cache and reads the number', async () => {
    let asked = ''
    const build = await fetchBuildId({
      now: () => 42,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        asked = `${url} ${init?.cache}`
        return new Response(JSON.stringify({ build: 'abc' }), { status: 200 })
      }) as typeof fetch,
    })
    expect(build).toBe('abc')
    expect(asked).toBe('/version.json?t=42 no-store')
  })

  it('is empty when the file is missing, not JSON, or the network fails', async () => {
    const reply = (body: string, status: number) =>
      (async () => new Response(body, { status })) as unknown as typeof fetch
    expect(await fetchBuildId({ fetchImpl: reply('', 404) })).toBeNull()
    expect(await fetchBuildId({ fetchImpl: reply('<html>', 200) })).toBeNull()
    expect(await fetchBuildId({ fetchImpl: reply('{"build":3}', 200) })).toBeNull()
    const broken = (async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    expect(await fetchBuildId({ fetchImpl: broken })).toBeNull()
  })
})
