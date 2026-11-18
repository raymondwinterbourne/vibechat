import { describe, expect, it } from 'vitest'
import { firstReleases, localDay, type Release, unseenReleases, visibleReleases } from './releases'

const releases: Release[] = [
  { id: '2026-10-20', items: [{ zh: '三', en: 'three' }] },
  {
    id: '2026-10-18',
    items: [
      { zh: '二', en: 'two' },
      { zh: '管理', en: 'admin', adminOnly: true },
    ],
  },
  { id: '2026-10-15', items: [{ zh: '只给管理员', en: 'admins only', adminOnly: true }] },
  { id: '2026-10-10', items: [{ zh: '一', en: 'one' }] },
]
const ids = (list: Release[]) => list.map((release) => release.id)

describe('release notes', () => {
  it('lists what came after the last one seen, newest first', () => {
    expect(ids(unseenReleases(releases, '2026-10-10', true))).toEqual([
      '2026-10-20',
      '2026-10-18',
      '2026-10-15',
    ])
    expect(unseenReleases(releases, '2026-10-20', true)).toEqual([])
  })

  it('leaves out what only admins should see', () => {
    const unseen = unseenReleases(releases, '2026-10-10', false)
    expect(ids(unseen)).toEqual(['2026-10-20', '2026-10-18'])
    expect(unseen[1]?.items.map((item) => item.en)).toEqual(['two'])
    expect(ids(visibleReleases(releases, false))).toEqual([
      '2026-10-20',
      '2026-10-18',
      '2026-10-10',
    ])
  })

  it('compares by date when the last one seen is no longer listed', () => {
    expect(ids(unseenReleases(releases, '2026-10-19', false))).toEqual(['2026-10-20'])
    expect(ids(unseenReleases(releases, '2026-10-01', false))).toEqual([
      '2026-10-20',
      '2026-10-18',
      '2026-10-10',
    ])
  })
})

describe('release notes for someone this browser has not seen before', () => {
  // 中午的时间：不管测试在哪个时区跑，本地日期都不变
  const noon = (day: string) => new Date(`${day}T12:00:00`).getTime()

  it('shows the latest notes once to someone who registered before them', () => {
    expect(ids(firstReleases(releases, noon('2026-10-14'), false))).toEqual(['2026-10-20'])
  })

  it('shows nothing to someone who registered on or after the day of the latest notes', () => {
    expect(firstReleases(releases, noon('2026-10-20'), false)).toEqual([])
    expect(firstReleases(releases, noon('2026-11-01'), false)).toEqual([])
  })

  it('writes local days the way release ids are written', () => {
    expect(localDay(noon('2026-01-05'))).toBe('2026-01-05')
  })
})
