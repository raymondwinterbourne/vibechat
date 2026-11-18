// 权限：没有登录的人、普通用户各自能到哪里。

import { ADMIN_PASSWORD, anonymousTest, createAccount, expect, newApi, test } from './support'

anonymousTest.describe('without a login', () => {
  for (const path of ['/', '/chats', '/contacts', '/settings', '/admin', '/admin/users']) {
    anonymousTest(`${path} leads to the login page`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveURL(/\/login/)
      await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
    })
  }

  anonymousTest('after logging in, the page originally asked for opens', async ({ page }) => {
    const account = await createAccount()
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings$/)

    await page.getByLabel('ID').fill(account.handle)
    await page.getByLabel('Password').fill(account.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId('my-id')).toHaveText(account.handle)
  })

  anonymousTest('the login page cannot be used to jump to another site', async ({ page }) => {
    const account = await createAccount()
    await page.goto('/login?redirect=https://example.com/steal')
    await page.getByLabel('ID').fill(account.handle)
    await page.getByLabel('Password').fill(account.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page).toHaveURL(/\/chats$/)
  })

  anonymousTest('the api refuses requests without a login', async () => {
    const api = await newApi()
    for (const path of ['/api/me', '/api/admin/invite-codes', '/api/admin/users']) {
      const response = await api.get(path)
      expect(response.status(), path).toBe(401)
      expect(((await response.json()) as { code: string }).code).toBe('unauthorized')
    }
    await api.dispose()
  })
})

test.describe('an ordinary user', () => {
  test('sees no admin entry and cannot open any admin page', async ({ page, account }) => {
    await page.goto('/chats')
    await expect(page.getByTestId('nav-rail').getByRole('link', { name: 'Chats' })).toBeVisible()
    await expect(page.getByTestId('nav-rail').getByRole('link', { name: 'Admin' })).toHaveCount(0)

    // 直接输入地址：每一个管理页面都把他带回聊天页
    for (const path of [
      '/admin',
      '/admin/overview',
      '/admin/users',
      '/admin/invite-codes',
      '/admin/chats',
      `/admin/chats/${account.id}`,
      '/admin/groups',
      '/admin/settings',
      '/admin/audit',
    ]) {
      await page.goto(path)
      await expect(page, path).toHaveURL(/\/chats$/)
      await expect(page.getByTestId('admin-nav'), path).toHaveCount(0)
    }
    // 手机上"我"的页面里也没有管理的入口
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open administration' })).toHaveCount(0)
  })

  test('cannot call the admin api', async ({ account }) => {
    const api = await newApi(account.storageState)
    const id = account.id
    const reads = [
      '/api/admin/overview',
      '/api/admin/users',
      `/api/admin/users/${id}/conversations`,
      '/api/admin/groups',
      `/api/admin/conversations/${id}/members`,
      `/api/admin/conversations/${id}/messages`,
      `/api/admin/conversations/${id}/files/${id}`,
      '/api/admin/settings',
      '/api/admin/audit',
      '/api/admin/invite-codes',
    ]
    for (const path of reads) {
      const reply = await api.get(path)
      expect(reply.status(), path).toBe(403)
      expect(((await reply.json()) as { code: string }).code, path).toBe('forbidden')
    }
    const writes = [
      `/api/admin/users/${id}/disable`,
      `/api/admin/users/${id}/enable`,
      `/api/admin/users/${id}/reset-password`,
      `/api/admin/conversations/${id}/views`,
      `/api/admin/conversations/${id}/dissolve`,
      '/api/admin/invite-codes',
    ]
    for (const path of writes) {
      const reply = await api.post(path, { data: { count: 1 } })
      expect(reply.status(), path).toBe(403)
    }
    const settings = await api.put('/api/admin/settings', { data: { voice_max_seconds: 30 } })
    expect(settings.status()).toBe(403)
    const email = await api.put('/api/me/email', {
      data: { current_password: account.password, email: 'me@example.com' },
    })
    expect(email.status()).toBe(403)
    // 自己还是好好的：没有被禁用，密码也没有被重置
    expect((await api.get('/api/me')).status()).toBe(200)
    await api.dispose()
  })

  test('already logged in, the login and register pages lead back into the app', async ({
    page,
  }) => {
    await page.goto('/login')
    await expect(page).toHaveURL(/\/chats$/)
    await page.goto('/register')
    await expect(page).toHaveURL(/\/chats$/)
  })
})

anonymousTest.describe('the admin', () => {
  anonymousTest(
    'reaches the admin pages from the settings page on a phone',
    async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
      const page = await context.newPage()
      await page.goto('/login')
      await page.getByLabel('ID').fill('admin')
      await page.getByLabel('Password').fill(ADMIN_PASSWORD)
      await page.getByRole('button', { name: 'Log in' }).click()

      await page.getByTestId('tab-bar').getByRole('link', { name: 'Me' }).click()
      await page.getByRole('link', { name: 'Open administration' }).click()
      // 手机上先是管理的导航，点进去是那一页，页面上有返回的按钮
      await expect(page).toHaveURL(/\/admin$/)
      const nav = page.getByTestId('admin-nav')
      await expect(nav.getByRole('link')).toHaveText([
        'Overview',
        'Users',
        'Invite codes',
        'Chat records',
        'Groups',
        'System settings',
        'Audit log',
      ])
      await nav.getByRole('link', { name: 'Invite codes' }).click()
      await expect(page).toHaveURL(/\/admin\/invite-codes$/)
      await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible()
      await expect(nav).toBeHidden()
      await page.getByRole('link', { name: 'Back to administration' }).click()
      await expect(page).toHaveURL(/\/admin$/)
      await expect(nav).toBeVisible()
      await context.close()
    },
  )
})
