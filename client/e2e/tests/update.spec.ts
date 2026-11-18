// 页面的更新（U1）：服务器上的页面换了，已经开着的页面提示刷新。
//
// 端到端测试跑的是构建结果，页面里带着构建编号，旁边有 version.json。
// "服务器上换了新页面"用拦下 version.json、交出另一个编号来扮演。

import type { Page } from '@playwright/test'
import { RELEASE_NOTES } from '../../packages/ui/src/releaseNotes'
import { type Account, controlConnection, expect, gotoConnected, test } from './support'

const banner = (page: Page) => page.getByTestId('update-banner')

/** 让服务器看起来已经换上了另一个构建的页面。 */
async function serveNewerPage(page: Page) {
  await page.route('**/version.json*', (route) => route.fulfill({ json: { build: 'newer-build' } }))
}

test.describe('page updates', () => {
  test('the page knows its own build, and says nothing while the server has the same one', async ({
    page,
  }) => {
    const checked = page.waitForResponse('**/version.json*')
    await gotoConnected(page, '/chats')
    const served = await (await checked).json()
    const own = await page.locator('meta[name="vc-build"]').getAttribute('content')
    expect(own).toMatch(/^[0-9a-f]{16}$/)
    expect(served).toEqual({ build: own })
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(banner(page)).toHaveCount(0)
  })

  test('settings show which build of the page this is', async ({ page }) => {
    await gotoConnected(page, '/settings')
    const own = await page.locator('meta[name="vc-build"]').getAttribute('content')
    await expect(page.getByTestId('page-build')).toHaveText(
      `Page build ${own?.slice(0, 8)} · What's new`,
    )
  })

  test('a new page on the server is offered, and reloading gets it', async ({ page }) => {
    await serveNewerPage(page)
    await gotoConnected(page, '/chats')
    await expect(banner(page)).toContainText('VibeChat has been updated. Click to reload')
    // 服务器上换回了这个页面的构建：点了之后重新载入，不再提示
    await page.unroute('**/version.json*')
    await banner(page)
      .getByRole('button', { name: /has been updated/ })
      .click()
    await expect(page.locator('[data-connection="open"]')).toBeVisible()
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(banner(page)).toHaveCount(0)
  })

  test('once dismissed, the same update is not offered again, but the next one is', async ({
    page,
  }) => {
    const connection = await controlConnection(page)
    await serveNewerPage(page)
    await gotoConnected(page, '/chats')
    await banner(page).getByRole('button', { name: 'Dismiss' }).click()
    await expect(banner(page)).toHaveCount(0)

    // 断开再连上（同步代码时服务端会重启）：又查了一次，还是同一个新页面，不再提示
    let checked = page.waitForRequest('**/version.json*')
    await connection.cut()
    connection.restore()
    await checked
    await expect(page.locator('[data-connection="open"]')).toBeVisible()
    await expect(banner(page)).toHaveCount(0)

    // 服务器上又换了一次
    await page.unroute('**/version.json*')
    await page.route('**/version.json*', (route) =>
      route.fulfill({ json: { build: 'newest-build' } }),
    )
    checked = page.waitForRequest('**/version.json*')
    await connection.cut()
    connection.restore()
    await checked
    await expect(banner(page)).toBeVisible()
  })
})

test.describe('what changed', () => {
  const notes = (page: Page) => page.getByTestId('release-notes')
  const seenKey = (account: Account) => `vc.releases-seen.${account.id}`
  // 最新一条更新说明里的第一句的开头。加了新的说明不用改这里
  const latestFirstLine = (RELEASE_NOTES[0]?.items[0]?.en ?? '').slice(0, 20)

  test('someone opening the app for the first time is not shown old notes', async ({ page }) => {
    await gotoConnected(page, '/chats')
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(notes(page)).toHaveCount(0)
  })

  test('notes not seen yet are shown once after reopening', async ({ page, account }) => {
    await gotoConnected(page, '/chats')
    // 扮演一个只看过很早的说明的人
    await page.evaluate((key) => localStorage.setItem(key, '2000-01-01'), seenKey(account))
    await page.reload()
    const dialog = page.getByRole('dialog', { name: 'VibeChat has been updated' })
    await expect(dialog.getByTestId('release').first()).toContainText(latestFirstLine)
    await dialog.getByRole('button', { name: 'Got it' }).click()
    await expect(dialog).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(notes(page)).toHaveCount(0)
  })

  test('reloading from the banner says the update worked', async ({ page }) => {
    await serveNewerPage(page)
    await gotoConnected(page, '/chats')
    await page.unroute('**/version.json*')
    await banner(page)
      .getByRole('button', { name: /has been updated/ })
      .click()
    // 说明都看过了：只是一个小提示
    await expect(page.getByTestId('toast')).toHaveText('Updated to the latest version')
    await expect(notes(page)).toHaveCount(0)
  })

  test('someone who registered before the latest notes sees them once in a browser new to them', async ({
    page,
  }) => {
    // 扮演一个早就注册了的人：这个浏览器里没有他看过哪一条的记录
    await page.route('**/api/me', async (route) => {
      const response = await route.fetch()
      const me = await response.json()
      await route.fulfill({ response, json: { ...me, created_at: Date.UTC(2026, 0, 1) } })
    })
    await gotoConnected(page, '/chats')
    const dialog = page.getByRole('dialog', { name: 'VibeChat has been updated' })
    await expect(dialog.getByTestId('release')).toHaveCount(1)
    await expect(dialog).toContainText(latestFirstLine)
    await dialog.getByRole('button', { name: 'Got it' }).click()
    await page.reload()
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(notes(page)).toHaveCount(0)
  })

  test('all notes can be read again from the settings', async ({ page }) => {
    await gotoConnected(page, '/settings')
    await page.getByRole('button', { name: "What's new" }).click()
    const dialog = page.getByRole('dialog', { name: "What's new" })
    await expect(dialog.getByTestId('release').first()).toContainText(latestFirstLine)
    // 只有底部的"知道了"，右上角没有关闭按钮
    await expect(dialog.getByRole('button')).toHaveText(['Got it'])
    await dialog.getByRole('button', { name: 'Got it' }).click()
    await expect(dialog).toHaveCount(0)
  })
})
