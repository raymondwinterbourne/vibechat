// 会改动全局状态的管理功能：系统设置、管理员找回密码、修改邮箱。
//
// 这些会影响同时在跑的别的测试（上限变小了、管理员的登录全部失效了），
// 所以这个文件等别的全部跑完再跑，里面的测试一个接一个（见 playwright.config.ts）。
// 每个测试结束时把改过的东西改回去。

import type { Page } from '@playwright/test'
import {
  ADMIN_PASSWORD,
  adminApi,
  anonymousTest,
  another,
  befriend,
  createAccount,
  expect,
  logIn,
  mailSnapshot,
  makeGroup,
  newApi,
  noMailSince,
  openAsAdmin,
  post,
  sendFiles,
  watchMail,
} from './support'

const ADMIN_EMAIL = 'admin@e2e.test'
const MB = 1024 * 1024

anonymousTest.describe.configure({ mode: 'serial' })

async function saveSettings(admin: Page) {
  await admin.getByRole('button', { name: 'Save' }).click()
  await expect(admin.getByTestId('toast')).toHaveText('Saved. The new settings are in effect.')
}

/** 操作记录里修改系统设置的那些。 */
async function settingChanges(admin: Page) {
  await admin.goto('/admin/audit')
  await admin.getByLabel('Filter by action').selectOption({ label: 'Changed a setting' })
  // 等筛过的列表换上来：换上来之前显示的还是没有筛过的
  await expect(admin.getByTestId('audit-entry').first()).toBeVisible()
  await expect(
    admin.locator('[data-testid="audit-entry"]:not([data-action="setting_changed"])'),
  ).toHaveCount(0)
  return admin.getByTestId('audit-entry-text')
}

anonymousTest.describe('system settings', () => {
  anonymousTest.afterEach(async () => {
    // 不管测试成败，都改回默认值，免得影响后面的
    const admin = await adminApi()
    const reply = await admin.put('/api/admin/settings', {
      data: {
        file_max_bytes: 100 * MB,
        recall_window_seconds: 120,
        edit_window_seconds: 24 * 60 * 60,
        retention_days: 0,
        screen_max_width: 2560,
        screen_max_fps: 15,
        screen_direct_kbps: 6000,
        screen_relay_kbps: 1000,
        camera_relay_kbps: 500,
      },
    })
    expect(reply.status(), 'restore settings').toBe(200)
    await admin.dispose()
  })

  anonymousTest('a smaller file size limit refuses a bigger file at once', async ({ browser }) => {
    const account = await createAccount()
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    // 这个用户的页面在改设置之前就开着
    const user = await browser.newContext({ storageState: account.storageState })
    const page = await user.newPage()
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toHaveCount(1)
    const big = { name: 'big.bin', mimeType: '', buffer: Buffer.alloc(MB + 512, 7) }
    await sendFiles(page, big)
    await expect(page.getByTestId('message').last().getByTestId('message-status')).toHaveText(
      'Sent',
    )

    const admin = await openAsAdmin(browser, '/admin/settings')
    const size = admin.page.getByLabel('Maximum file size (MB)')
    await expect(size).toHaveValue('100')
    // 每一项旁边写着默认值和允许的范围
    await expect(admin.page.getByTestId('admin-settings')).toContainText(
      'Default 100; allowed 1 to 1024.',
    )
    // 超出范围的填不进去
    await size.fill('0')
    await admin.page.getByRole('button', { name: 'Save' }).click()
    await expect(admin.page.getByTestId('toast')).toHaveCount(0)
    await size.fill('1')
    await saveSettings(admin.page)

    // 不重启服务、不刷新页面：同样的文件现在发不出去了
    await sendFiles(page, big)
    // 这个页面记着的还是原来的上限，所以它去传了；服务端按新的上限拒绝，留下一条没发出去的
    await expect(page.getByTestId('message').last().getByTestId('message-status')).toContainText(
      'Not sent',
    )
    await expect(
      page.getByTestId('message').locator('[data-testid="message-status"]', { hasText: /^Sent$/ }),
    ).toHaveCount(1)
    // 服务端同样拒绝
    const api = await newApi(account.storageState)
    const reply = await api.post('/api/files', {
      headers: { 'content-type': '', 'x-file-name': 'big.bin' },
      data: big.buffer,
    })
    expect(reply.status()).toBe(413)
    expect(((await reply.json()) as { code: string }).code).toBe('file_too_large')
    await api.dispose()

    // 操作记录里写着从多少改成了多少
    const entries = await settingChanges(admin.page)
    await expect(entries.first()).toHaveText('Changed “Maximum file size” from 100 MB to 1 MB')
    await user.close()
    await admin.context.close()
  })

  anonymousTest(
    'recalling can be turned off, and retention carries a warning',
    async ({ browser }) => {
      const account = await createAccount()
      const bea = await another('Bea')
      const conversation = await befriend(account, bea)
      const admin = await openAsAdmin(browser, '/admin/settings')
      await admin.page.getByLabel('Recall window (seconds)').fill('0')
      // 选了"只保留一段时间"才出现天数和警告
      await expect(admin.page.getByTestId('retention-warning')).toHaveCount(0)
      await admin.page.getByRole('radio', { name: 'Keep for a limited time' }).click()
      await expect(admin.page.getByTestId('retention-warning')).toContainText('deleted permanently')
      await admin.page.getByLabel('Days to keep').fill('30')
      await saveSettings(admin.page)
      // 保存之后再打开，还是刚才填的
      await admin.page.reload()
      await expect(admin.page.getByLabel('Recall window (seconds)')).toHaveValue('0')
      await expect(admin.page.getByLabel('Days to keep')).toHaveValue('30')

      // 刚发的消息也撤回不了：菜单里没有"撤回"，接口也拒绝
      const seq = await post(account, conversation, { text: 'no way back' })
      const user = await browser.newContext({ storageState: account.storageState })
      const page = await user.newPage()
      await page.goto(`/chats/${conversation}`)
      const message = page.getByTestId('message').filter({ hasText: 'no way back' })
      await message.hover()
      await message.getByRole('button', { name: 'Message options' }).click()
      await expect(page.getByRole('menuitem', { name: 'Copy' })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Recall' })).toHaveCount(0)
      const reply = await page.request.post(
        `/api/conversations/${conversation}/messages/${seq}/recall`,
        { headers: { origin: new URL(page.url()).origin } },
      )
      expect(reply.status()).toBe(409)

      const entries = await settingChanges(admin.page)
      await expect(
        entries.filter({ hasText: 'Changed “Recall window” from 120 seconds to no recalling' }),
      ).not.toHaveCount(0)
      await expect(
        entries.filter({ hasText: 'Changed “Retention period” from forever to 30 days' }),
      ).not.toHaveCount(0)
      await user.close()
      await admin.context.close()
    },
  )
})

anonymousTest.describe('the edit window', () => {
  anonymousTest.afterEach(async () => {
    const admin = await adminApi()
    const reply = await admin.put('/api/admin/settings', {
      data: { edit_window_seconds: 24 * 60 * 60 },
    })
    expect(reply.status(), 'restore settings').toBe(200)
    await admin.dispose()
  })

  anonymousTest('set to 0 turns editing off for everyone', async ({ browser }) => {
    const account = await createAccount()
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await post(account, conversation, { text: 'cannot touch this' })
    const admin = await openAsAdmin(browser, '/admin/settings')
    const field = admin.page.getByLabel('Edit window (hours)')
    await expect(field).toHaveValue('24')
    await field.fill('0')
    await saveSettings(admin.page)

    const user = await browser.newContext({ storageState: account.storageState })
    const page = await user.newPage()
    await page.goto(`/chats/${conversation}`)
    const message = page.getByTestId('message').filter({ hasText: 'cannot touch this' })
    await message.hover()
    await message.getByRole('button', { name: 'Message options' }).click()
    await expect(page.getByRole('menuitem', { name: 'Copy' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toHaveCount(0)

    const entries = await settingChanges(admin.page)
    await expect(
      entries.filter({ hasText: 'Changed “Edit window” from 24 hours to no editing' }),
    ).not.toHaveCount(0)
    await user.close()
    await admin.context.close()
  })
})

anonymousTest.describe('call picture settings', () => {
  anonymousTest.afterEach(async () => {
    const admin = await adminApi()
    const reply = await admin.put('/api/admin/settings', {
      data: { screen_max_width: 2560, screen_direct_kbps: 6000, camera_relay_kbps: 500 },
    })
    expect(reply.status(), 'restore settings').toBe(200)
    await admin.dispose()
  })

  anonymousTest('are changed in Mbps and reach the next call', async ({ browser }) => {
    const account = await createAccount()
    const admin = await openAsAdmin(browser, '/admin/settings')
    const page = admin.page
    const direct = page.getByLabel('Shared screen, direct connection: maximum bitrate (Mbps)')
    await expect(direct).toHaveValue('6')
    await expect(page.getByTestId('call-video-settings')).toContainText(
      "uses this much of the server's outgoing bandwidth",
    )
    await direct.fill('8.5')
    await page.getByLabel('Shared screen: maximum width (pixels)').fill('3840')
    await page.getByLabel('Camera, through the relay: maximum bitrate (Mbps)').fill('0.8')
    await saveSettings(page)
    await page.reload()
    await expect(direct).toHaveValue('8.5')

    // 打电话前取到的就是新的
    const api = await newApi(account.storageState)
    const servers = await (await api.get('/api/calls/ice-servers')).json()
    expect(servers.video).toMatchObject({
      screen_max_width: 3840,
      screen_direct_kbps: 8500,
      camera_relay_kbps: 800,
    })
    await api.dispose()

    const entries = await settingChanges(page)
    await expect(
      entries.filter({
        hasText: 'Changed “Shared screen bitrate, direct” from 6 Mbps to 8.5 Mbps',
      }),
    ).not.toHaveCount(0)
    await expect(
      entries.filter({
        hasText: 'Changed “Shared screen maximum width” from 2560 pixels to 3840 pixels',
      }),
    ).not.toHaveCount(0)
    await admin.context.close()
  })
})

anonymousTest.describe('group video picture settings', () => {
  anonymousTest.afterEach(async () => {
    const admin = await adminApi()
    const reply = await admin.put('/api/admin/settings', {
      data: { group_camera_high_kbps: 400, group_camera_low_kbps: 120, group_screen_kbps: 1000 },
    })
    expect(reply.status(), 'restore settings').toBe(200)
    await admin.dispose()
  })

  anonymousTest(
    'show what they cost the server and reach whoever joins next',
    async ({ browser }) => {
      const account = await createAccount()
      const admin = await openAsAdmin(browser, '/admin/settings')
      const page = admin.page
      const clear = page.getByLabel('Clear tier: maximum bitrate (kbps)')
      const small = page.getByLabel('Small tier: maximum bitrate (kbps)')
      await expect(clear).toHaveValue('400')
      await expect(small).toHaveValue('120')
      // 按现在的数算给管理员看：6 个人都开摄像头，每人收 1 路清楚的加 4 路小的
      const estimate = page.getByTestId('group-video-estimate')
      await expect(estimate).toContainText('6 people')
      await expect(estimate).toContainText('about 5.3 Mbps')
      // 跟着填的数变，也跟着人数上限变
      await clear.fill('600')
      await small.fill('100')
      await expect(estimate).toContainText('about 6.0 Mbps')
      await page.getByLabel('Group call size limit (people)').fill('10')
      await expect(estimate).toContainText('10 people')
      await expect(estimate).toContainText('about 14.0 Mbps')
      await page.getByLabel('Group call size limit (people)').fill('6')

      // 共享屏幕的码率（F12）：同样算给管理员看，视频通话里共享和语音通话里共享各是多少。
      // 6 个人、屏幕 1000、小的一档 100：5 个人各收屏幕加 5 路小的，共享的人收 1 路小的
      const screen = page.getByLabel('Shared screen: maximum bitrate (kbps)')
      const sharing = page.getByTestId('group-screen-estimate')
      await expect(screen).toHaveValue('1000')
      await expect(sharing).toContainText('about 7.6 Mbps')
      await expect(sharing).toContainText('in a voice call, about 5.0 Mbps')
      await screen.fill('1500')
      await expect(sharing).toContainText('about 10.1 Mbps')
      await expect(sharing).toContainText('in a voice call, about 7.5 Mbps')

      await saveSettings(page)
      await page.reload()
      await expect(clear).toHaveValue('600')
      await expect(small).toHaveValue('100')
      await expect(screen).toHaveValue('1500')

      // 之后进视频通话的人取到的就是新的
      const api = await newApi(account.storageState)
      const servers = await (await api.get('/api/calls/ice-servers')).json()
      expect(servers.video).toMatchObject({
        group_camera_high_kbps: 600,
        group_camera_low_kbps: 100,
        group_screen_kbps: 1500,
      })
      await api.dispose()

      const entries = await settingChanges(page)
      await expect(
        entries.filter({
          hasText: 'Changed “Group video bitrate, clear tier” from 400 kbps to 600 kbps',
        }),
      ).not.toHaveCount(0)
      await expect(
        entries.filter({
          hasText: 'Changed “Group video bitrate, small tier” from 120 kbps to 100 kbps',
        }),
      ).not.toHaveCount(0)
      await expect(
        entries.filter({
          hasText: 'Changed “Shared screen bitrate in group calls” from 1000 kbps to 1500 kbps',
        }),
      ).not.toHaveCount(0)
      await admin.context.close()
    },
  )
})

anonymousTest.describe('group call size limit', () => {
  anonymousTest.afterEach(async () => {
    const admin = await adminApi()
    const reply = await admin.put('/api/admin/settings', { data: { group_call_max: 6 } })
    expect(reply.status(), 'restore settings').toBe(200)
    await admin.dispose()
  })

  anonymousTest('is set by the administrator and a full call says so', async ({ browser }) => {
    const owner = await createAccount()
    const one = await another('one')
    const two = await another('two')
    const group = await makeGroup(owner, [one, two], 'Small call')

    const admin = await openAsAdmin(browser, '/admin/settings')
    const limit = admin.page.getByLabel('Group call size limit (people)')
    await expect(limit).toHaveValue('6')
    await expect(admin.page.getByTestId('admin-settings')).toContainText(
      'check the server has enough before raising it',
    )
    await limit.fill('2')
    await saveSettings(admin.page)

    // 两个人通过接口进了通话（不用麦克风，三种浏览器内核都能测）：通话满了
    const ownerApi = await newApi(owner.storageState)
    const started = await ownerApi.post('/api/group-calls', {
      data: { conversation_id: group, device: 'e2e-owner-device', invite: [] },
    })
    expect(started.status(), 'start').toBe(201)
    const { call } = (await started.json()) as { call: { id: string; limit: number } }
    expect(call.limit).toBe(2)
    const oneApi = await newApi(one.storageState)
    const joined = await oneApi.post(`/api/group-calls/${call.id}/join`, {
      data: { device: 'e2e-one-device' },
    })
    expect(joined.status(), 'join').toBe(200)

    // 第三个人：看得到通话，但写着人数已满，没有"加入"，标题栏的按钮也不能点
    const context = await browser.newContext({ storageState: two.storageState })
    const page = await context.newPage()
    await page.goto(`/chats/${group}`)
    const banner = page.getByTestId('group-call-banner')
    await expect(banner).toContainText('Voice call in progress · 2 people')
    await expect(banner.getByTestId('group-call-full')).toHaveText('Call is full')
    await expect(banner.getByRole('button', { name: 'Join' })).toHaveCount(0)
    await expect(page.getByTestId('group-voice-call')).toBeDisabled()
    // 接口也不让进
    const twoApi = await newApi(two.storageState)
    const refused = await twoApi.post(`/api/group-calls/${call.id}/join`, {
      data: { device: 'e2e-two-device' },
    })
    expect(refused.status()).toBe(409)

    // 有人离开就又可以加入了
    await oneApi.post(`/api/group-calls/${call.id}/leave`, { data: { device: 'e2e-one-device' } })
    await expect(banner.getByRole('button', { name: 'Join' })).toBeVisible()
    await ownerApi.post(`/api/group-calls/${call.id}/leave`, {
      data: { device: 'e2e-owner-device' },
    })
    await expect(banner).toHaveCount(0)
    for (const api of [ownerApi, oneApi, twoApi]) await api.dispose()
    await context.close()

    const entries = await settingChanges(admin.page)
    await expect(
      entries.filter({ hasText: 'Changed “Group call size limit” from 6 people to 2 people' }),
    ).not.toHaveCount(0)
    await admin.context.close()
  })
})

anonymousTest.describe('the administrator recovers the password by email', () => {
  const RECOVERED = 'recovered-pass-9'

  anonymousTest.afterEach(async () => {
    // 把密码改回去：后面的测试、下一种内核、下一次运行都还要用原来的密码登录
    const api = await newApi()
    const login = await api.post('/api/auth/login', {
      data: { handle: 'admin', password: RECOVERED },
    })
    if (login.status() === 200) {
      const changed = await api.put('/api/me/password', {
        data: { current_password: RECOVERED, new_password: ADMIN_PASSWORD },
      })
      expect(changed.status(), 'restore the admin password').toBe(204)
    }
    await api.dispose()
  })

  anonymousTest(
    'the link in the mail sets a new password and works once',
    async ({ page, browser }) => {
      // 管理员在别处登录着
      const elsewhere = await openAsAdmin(browser, '/admin/overview')
      await expect(elsewhere.page.getByTestId('stat-users')).toBeVisible()

      await page.goto('/login')
      await page.getByRole('link', { name: 'Administrator forgot the password?' }).click()
      await expect(page).toHaveURL(/\/forgot-password$/)

      // 邮箱不对：页面上的话一样，但没有邮件发出去
      const before = mailSnapshot()
      await page.getByLabel('Email').fill('someone-else@e2e.test')
      await page.getByRole('button', { name: 'Send email' }).click()
      const said = await page.getByTestId('reset-requested').innerText()
      expect(said).toContain('Open the link in it within 30 minutes')
      expect(await noMailSince(before, 'someone-else@e2e.test')).toBe(true)
      expect(await noMailSince(before, ADMIN_EMAIL)).toBe(true)

      // 邮箱对了：页面上的话一模一样，邮箱收到一封带链接的邮件
      await page.goto('/forgot-password')
      const mail = watchMail(ADMIN_EMAIL)
      await page.getByLabel('Email').fill(ADMIN_EMAIL)
      await page.getByRole('button', { name: 'Send email' }).click()
      await expect(page.getByTestId('reset-requested')).toHaveText(said)
      const link = await mail()
      expect(link).toMatch(/\/reset-password\?token=[0-9a-f]{64}$/)

      await page.goto(link)
      await page.getByLabel('New password', { exact: true }).fill(RECOVERED)
      await page.getByLabel('Confirm new password').fill('something-else-1')
      await page.getByRole('button', { name: 'Save new password' }).click()
      await expect(page.getByRole('alert')).toHaveText("The two passwords don't match")
      await page.getByLabel('Confirm new password').fill(RECOVERED)
      await page.getByRole('button', { name: 'Save new password' }).click()
      await expect(page.getByTestId('reset-done')).toContainText('The password has been reset')

      // 以前的登录全部失效：别处开着的页面回到登录页
      await expect(elsewhere.page).toHaveURL(/\/login/, { timeout: 15_000 })
      await elsewhere.context.close()

      // 旧密码不能用了，新密码可以，并且不用再改一次
      await page.getByRole('link', { name: 'Log in' }).click()
      await page.getByLabel('ID').fill('admin')
      await page.getByLabel('Password').fill(ADMIN_PASSWORD)
      await page.getByRole('button', { name: 'Log in' }).click()
      await expect(page.getByRole('alert')).toHaveText('Incorrect ID or password.')
      await page.getByLabel('Password').fill(RECOVERED)
      await page.getByRole('button', { name: 'Log in' }).click()
      await expect(page).toHaveURL(/\/chats$/)

      // 同一个链接再用一次：被拒绝
      const again = await browser.newContext({ storageState: { cookies: [], origins: [] } })
      const second = await again.newPage()
      await second.goto(link)
      await second.getByLabel('New password', { exact: true }).fill('another-pass-7')
      await second.getByLabel('Confirm new password').fill('another-pass-7')
      await second.getByRole('button', { name: 'Save new password' }).click()
      await expect(second.getByRole('alert')).toHaveText(
        'This link is invalid or has expired. Please request a new one.',
      )
      // 链接不完整的也说得清楚
      await second.goto('/reset-password')
      await expect(second.getByRole('alert')).toContainText('This link is incomplete')
      await again.close()
    },
  )
})

anonymousTest.describe('the administrator changes the email address', () => {
  const NEW_EMAIL = 'new-admin@e2e.test'

  /** 通过接口把邮箱改成 `email`：请求、从邮件里取出令牌、确认。 */
  async function setEmail(email: string) {
    const admin = await adminApi()
    const me = (await (await admin.get('/api/me')).json()) as { email: string }
    if (me.email !== email) {
      const mail = watchMail(email)
      const asked = await admin.put('/api/me/email', {
        data: { current_password: ADMIN_PASSWORD, email },
      })
      expect(asked.status(), 'ask to change the email').toBe(204)
      const token = new URL(await mail()).searchParams.get('token')
      const confirmed = await admin.post('/api/auth/email-confirm', { data: { token } })
      expect(confirmed.status(), 'confirm the email').toBe(200)
    }
    await admin.dispose()
  }

  anonymousTest.afterEach(async () => {
    await setEmail(ADMIN_EMAIL)
  })

  anonymousTest(
    'the new address takes effect only after its link is opened',
    async ({ page, browser }) => {
      await logIn(page, 'admin', ADMIN_PASSWORD)
      await expect(page).toHaveURL(/\/chats$/)
      await page.goto('/settings')
      await expect(page.getByTestId('admin-email')).toHaveText(ADMIN_EMAIL)

      const open = () => page.getByRole('button', { name: 'Change', exact: true }).last().click()
      await open()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('New email address').fill(NEW_EMAIL)
      await dialog.getByLabel('Current password').fill('not-the-password-1')
      await dialog.getByRole('button', { name: 'Send confirmation email' }).click()
      await expect(dialog.getByRole('alert')).toHaveText('The current password is incorrect.')

      const mail = watchMail(NEW_EMAIL)
      await dialog.getByLabel('Current password').fill(ADMIN_PASSWORD)
      await dialog.getByRole('button', { name: 'Send confirmation email' }).click()
      await expect(page.getByTestId('toast')).toContainText(
        `A confirmation email was sent to ${NEW_EMAIL}`,
      )
      const link = await mail()
      expect(link).toMatch(/\/confirm-email\?token=[0-9a-f]{64}$/)

      // 没有点确认之前，旧邮箱照常有效：找回密码的邮件仍然发到旧邮箱
      await expect(page.getByTestId('admin-email')).toHaveText(ADMIN_EMAIL)
      const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } })
      const other = await visitor.newPage()
      const before = mailSnapshot()
      const toOld = watchMail(ADMIN_EMAIL)
      await other.goto('/forgot-password')
      await other.getByLabel('Email').fill(NEW_EMAIL)
      await other.getByRole('button', { name: 'Send email' }).click()
      await expect(other.getByTestId('reset-requested')).toBeVisible()
      expect(await noMailSince(before, NEW_EMAIL)).toBe(true)
      await other.goto('/forgot-password')
      await other.getByLabel('Email').fill(ADMIN_EMAIL)
      await other.getByRole('button', { name: 'Send email' }).click()
      await expect(other.getByTestId('reset-requested')).toBeVisible()
      expect(await toOld()).toContain('/reset-password?token=')

      // 打开确认的链接（不要求登录），点"确认"才生效
      await other.goto(link)
      await expect(other.getByTestId('email-confirmed')).toHaveCount(0)
      await other.getByRole('button', { name: 'Confirm' }).click()
      await expect(other.getByTestId('email-confirmed')).toHaveText(
        `The email address is now ${NEW_EMAIL}`,
      )
      // 管理员开着的设置页上，邮箱跟着变了，不用刷新
      await expect(page.getByTestId('admin-email')).toHaveText(NEW_EMAIL)

      // 链接只能用一次
      await other.goto(link)
      await other.getByRole('button', { name: 'Confirm' }).click()
      await expect(other.getByRole('alert')).toHaveText(
        'This link is invalid or has expired. Please request a new one.',
      )
      await visitor.close()
    },
  )
})
