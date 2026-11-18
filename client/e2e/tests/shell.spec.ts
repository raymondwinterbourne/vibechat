// 页面框架：电脑和手机两种布局、外观和语言的切换与保持。

import type { Page } from '@playwright/test'
import { anonymousTest, expect, test } from './support'

const PHONE = { width: 375, height: 812 }

function theme(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.theme)
}

test.describe('desktop layout', () => {
  test('opens on the chats page with rail, list and content side by side', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/chats$/)

    await expect(page.getByTestId('nav-rail')).toBeVisible()
    await expect(page.getByTestId('tab-bar')).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible()
    await expect(page.getByText('No conversations yet')).toBeVisible()
    await expect(page.getByText('Select a conversation to start chatting')).toBeVisible()
  })

  test('the rail switches between chats, contacts and settings', async ({ page }) => {
    await page.goto('/')
    const rail = page.getByTestId('nav-rail')

    await rail.getByRole('link', { name: 'Contacts' }).click()
    await expect(page).toHaveURL(/\/contacts$/)
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()

    await rail.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

    await rail.getByRole('link', { name: 'Chats' }).click()
    await expect(page).toHaveURL(/\/chats$/)
  })

  test('a page address can be opened directly', async ({ page }) => {
    await page.goto('/contacts')
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
  })
})

test.describe('phone layout', () => {
  test.use({ viewport: PHONE })

  test('shows a single column with a tab bar at the bottom', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByTestId('tab-bar')).toBeVisible()
    await expect(page.getByTestId('nav-rail')).toBeHidden()
    await expect(page.getByText('No conversations yet')).toBeVisible()
    // 内容栏在手机上不显示
    await expect(page.getByText('Select a conversation to start chatting')).toBeHidden()

    // 页面不应该出现横向滚动
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })

  test('the tab bar switches pages, and settings is called Me', async ({ page }) => {
    await page.goto('/')
    const tabs = page.getByTestId('tab-bar')

    await tabs.getByRole('link', { name: 'Contacts' }).click()
    await expect(page).toHaveURL(/\/contacts$/)

    await tabs.getByRole('link', { name: 'Me' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible()
  })

  test('tab bar targets are big enough for a finger', async ({ page }) => {
    await page.goto('/')
    for (const link of await page.getByTestId('tab-bar').getByRole('link').all()) {
      const box = await link.boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
      expect(box?.width).toBeGreaterThanOrEqual(44)
    }
  })

  test('the settings page fits the screen without sideways scrolling', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })
})

test.describe('appearance', () => {
  test('follows the system until the user chooses', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/settings')
    expect(await theme(page)).toBe('dark')
    await expect(page.getByRole('radio', { name: 'System' })).toBeChecked()

    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => theme(page)).toBe('light')
  })

  test('a chosen appearance applies at once and survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/settings')

    // 选择同时保存到账号里。等它保存完再刷新：刷新之后以账号里的为准
    const saved = () =>
      page.waitForResponse(
        (reply) => reply.url().endsWith('/api/me') && reply.request().method() === 'PATCH',
      )
    let saving = saved()
    await page.getByRole('radio', { name: 'Dark' }).click()
    expect(await theme(page)).toBe('dark')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(15, 15, 17)')
    await saving

    await page.reload()
    expect(await theme(page)).toBe('dark')
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked()

    saving = saved()
    await page.getByRole('radio', { name: 'Light' }).click()
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await saving
    await page.reload()
    expect(await theme(page)).toBe('light')
  })

  test('a chosen appearance wins over the system setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/settings')
    await page.getByRole('radio', { name: 'Light' }).click()

    await page.reload()
    expect(await theme(page)).toBe('light')
  })
})

test.describe('language', () => {
  test('starts in English for a non-Chinese browser', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('a chosen language applies at once and survives a reload', async ({ page }) => {
    await page.goto('/settings')

    await page.getByRole('radio', { name: '简体中文' }).click()
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
    await expect(page.getByRole('radio', { name: '深色' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')

    await page.reload()
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
    await expect(page.getByRole('radio', { name: '简体中文' })).toBeChecked()

    await page.getByRole('radio', { name: 'English' }).click()
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  })

  test.describe('in a Chinese browser', () => {
    test.use({ locale: 'zh-CN' })

    test('starts in Chinese', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { name: '聊天' })).toBeVisible()
      await expect(page.getByText('还没有会话')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    })
  })
})

anonymousTest.describe('before logging in', () => {
  anonymousTest('the login page is in English for a non-Chinese browser', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
  })

  anonymousTest('the language can be switched on the login page', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('radio', { name: '简体中文' }).click()
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
  })

  anonymousTest.describe('in a Chinese browser', () => {
    anonymousTest.use({ locale: 'zh-CN' })

    anonymousTest('the login page is in Chinese', async ({ page }) => {
      await page.goto('/login')
      await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
    })
  })
})

test.describe('server', () => {
  test('the page reaches the api and keeps a live connection', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('server-status')).toContainText('Running, version')
    // 连接正常时不应该出现"正在重新连接"的提示
    await expect(page.getByTestId('connection-banner')).toBeHidden()
  })
})
