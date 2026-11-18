// 登录设备（F9）：设置里列出我正在哪几台设备上登录着；让另一台退出登录时，它马上回到登录页并看到原因；
// 也可以一次让其他全部退出。

import { expect, gotoConnected, logInElsewhere, newApi, test } from './support'

test.describe('signed-in devices', () => {
  test('another device can be signed out, and it learns why at once', async ({
    page,
    browser,
    account,
  }) => {
    const { context, page: other } = await logInElsewhere(browser, account)
    await gotoConnected(other, '/chats')
    await gotoConnected(page, '/settings')

    const devices = page.getByTestId('device')
    await expect(devices).toHaveCount(2)
    // 本机在最前面，另一台在线
    await expect(devices.first()).toHaveAttribute('data-current', '')
    await expect(devices.first()).toContainText('This device')
    await expect(devices.nth(1).getByTestId('device-online')).toHaveText('Online')
    // 测试里本机的登录是通过接口建的，认不出是什么设备；另一台是真的浏览器
    await expect(devices.nth(1).getByTestId('device-name')).toHaveText(
      /^(Chrome|Firefox|Safari|Edge) · (Windows|macOS|Linux)$/,
    )
    await expect(devices.first()).toContainText('Active just now')
    // 本机没有"退出登录"按钮：用账号里的那个
    await expect(devices.first().getByRole('button', { name: 'Sign out' })).toHaveCount(0)

    await devices.nth(1).getByRole('button', { name: 'Sign out' }).click()
    const dialog = page.getByRole('dialog', { name: 'Sign out this device?' })
    await expect(dialog).toContainText('will need to sign in again')
    await dialog.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByTestId('toast')).toHaveText('That device has been signed out')
    await expect(devices).toHaveCount(1)
    await expect(page.getByTestId('devices')).toContainText("You're only signed in on this device.")

    // 被退出的那一台：马上回到登录页，说明原因
    await expect(other).toHaveURL(/\/login/)
    await expect(other.getByTestId('signed-out-notice')).toContainText(
      'signed out from another of your devices',
    )
    // 本机照常
    await page.reload()
    await expect(devices).toHaveCount(1)
    await context.close()
  })

  test('all other devices can be signed out at once', async ({ page, account }) => {
    // 另外登录两次
    for (let n = 0; n < 2; n++) {
      const api = await newApi()
      const reply = await api.post('/api/auth/login', {
        data: { handle: account.handle, password: account.password },
      })
      expect(reply.status()).toBe(200)
      await api.dispose()
    }
    await gotoConnected(page, '/settings')
    await expect(page.getByTestId('device')).toHaveCount(3)
    await page.getByRole('button', { name: 'Sign out all other devices' }).click()
    await page
      .getByRole('dialog', { name: 'Sign out all other devices?' })
      .getByRole('button', { name: 'Sign out' })
      .click()
    await expect(page.getByTestId('toast')).toHaveText('Signed out 2 devices')
    await expect(page.getByTestId('device')).toHaveCount(1)
  })
})
