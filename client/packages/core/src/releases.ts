// 更新说明（U1 第 7 章）：每次更新给用户看的几句话，以及"哪些他还没看过"。
// 说明本身放在 ui 包的 releaseNotes.ts 里，随页面一起构建。

/** 更新说明里的一句话，中文和英文各一份。 */
export interface ReleaseItem {
  zh: string
  en: string
  /** 只和管理员有关，只给管理员看。 */
  adminOnly?: boolean
}

/** 一次更新的说明。`id` 是日期，同一天有几次时加序号：`2026-10-15`、`2026-10-15.2`。 */
export interface Release {
  id: string
  items: ReleaseItem[]
}

/** 只留这个人看得到的条目；一条都不剩的那次更新也不要了。 */
export function visibleReleases(releases: readonly Release[], admin: boolean): Release[] {
  return releases
    .map((release) => ({
      ...release,
      items: release.items.filter((item) => admin || !item.adminOnly),
    }))
    .filter((release) => release.items.length > 0)
}

/**
 * 还没看过的更新说明，新的在前。`releases` 本来就是新的在前；`seen` 是看过的最新一条的编号。
 * 看过的那一条已经不在列表里（被删掉了）时，按编号比，比它新的算没看过。
 */
export function unseenReleases(
  releases: readonly Release[],
  seen: string,
  admin: boolean,
): Release[] {
  const index = releases.findIndex((release) => release.id === seen)
  const newer = index >= 0 ? releases.slice(0, index) : releases.filter((r) => r.id > seen)
  return visibleReleases(newer, admin)
}

/** 本地时间的日期，写成 `2026-10-15`，和更新说明的编号一样的格式。 */
export function localDay(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 这个浏览器里还没有记下他看过哪一条时（第一次在这里打开，或者有更新说明之前就在用）该弹什么：
 * 最新的那一次说明在他注册的那天之后，就弹它这一次；注册当天和之前的说明对他来说不新，不弹。
 */
export function firstReleases(
  releases: readonly Release[],
  registeredAt: number,
  admin: boolean,
): Release[] {
  const latest = releases[0]
  if (!latest || latest.id.slice(0, 10) <= localDay(registeredAt)) return []
  return visibleReleases([latest], admin)
}
