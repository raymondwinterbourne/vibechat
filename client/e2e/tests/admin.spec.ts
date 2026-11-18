// 管理：用户、查看聊天内容、群、概况、操作记录。
//
// 会改动全局状态的（系统设置、管理员的密码和邮箱）在 admin-global.spec.ts 里，等别的都跑完再跑。

import type { Locator, Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  expect,
  makeGroup,
  newApi,
  openAsAdmin,
  pngImage,
  post,
  say,
  test,
  uploadAs,
  voiceSample,
} from './support'

/** 在用户页面上按 ID 找到一个用户所在的那一行。ID 是唯一的。 */
async function userRow(admin: Page, account: Account): Promise<Locator> {
  await admin.getByRole('searchbox', { name: 'Find by ID or nickname' }).fill(account.handle)
  const row = admin.getByTestId('admin-user').filter({ hasText: account.handle })
  await expect(row).toHaveCount(1)
  return row
}

/** 在对话框里点确认。 */
async function confirm(admin: Page, name: string) {
  await admin.getByRole('dialog').getByRole('button', { name, exact: true }).click()
}

/** 操作记录里只看某一种操作。别的测试也在同时留记录，筛过之后才找得到自己的。 */
async function auditEntries(admin: Page, action: string): Promise<Locator> {
  await admin.goto('/admin/audit')
  const filter = admin.getByLabel('Filter by action')
  await filter.selectOption({ label: action })
  // 等筛过的列表换上来：换上来之前显示的还是没有筛过的
  const kind = await filter.inputValue()
  await expect(admin.getByTestId('audit-entry').first()).toBeVisible()
  await expect(
    admin.locator(`[data-testid="audit-entry"]:not([data-action="${kind}"])`),
  ).toHaveCount(0)
  return admin.getByTestId('audit-entry-text')
}

async function recall(account: Account, conversation: string, seq: number) {
  const api = await newApi(account.storageState)
  const reply = await api.post(`/api/conversations/${conversation}/messages/${seq}/recall`)
  expect(reply.status(), 'recall').toBe(200)
  await api.dispose()
}

test.describe('users', () => {
  test('a disabled user is logged out at once and comes back when enabled', async ({
    page,
    account,
    browser,
  }) => {
    const pal = await another('Pal')
    const conversation = await befriend(account, pal)
    await say(pal, conversation, 'see you tomorrow')
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-text')).toHaveText(['see you tomorrow'])

    const admin = await openAsAdmin(browser, '/admin/users')
    const row = await userRow(admin.page, account)
    await expect(row).toHaveAttribute('data-status', 'active')
    await expect(row).toContainText('Registered')
    await expect(row).toContainText('Invite code')
    await row.getByRole('button', { name: `Disable ${account.nickname}` }).click()
    await confirm(admin.page, 'Disable')
    await expect(row).toHaveAttribute('data-status', 'disabled')
    await expect(row).toContainText('Disabled')

    // 那个用户的页面不用刷新就回到了登录页；再登录被拒绝，并且说明了原因
    await expect(page).toHaveURL(/\/login/)
    await page.getByLabel('ID').fill(account.handle)
    await page.getByLabel('Password').fill(account.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'This account has been disabled. Please contact the administrator.',
    )
    // 只看"已禁用"的也找得到这个用户
    await admin.page.getByRole('radio', { name: 'Disabled' }).click()
    await expect(row).toHaveCount(1)
    // 期间别人发来的消息照常保存
    await say(pal, conversation, 'where did you go?')

    await row.getByRole('button', { name: `Enable ${account.nickname}` }).click()
    await confirm(admin.page, 'Enable')
    await admin.page.getByRole('radio', { name: 'All' }).click()
    await expect(row).toHaveAttribute('data-status', 'active')

    // 启用后恢复：能登录，好友和消息都在
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page).toHaveURL(new RegExp(`/chats/${conversation}$`))
    const texts = page.getByTestId('message-text')
    await expect(texts).toHaveText(['see you tomorrow', 'where did you go?'])
    await page.goto('/contacts')
    await expect(page.getByTestId('friend-label')).toHaveText([pal.nickname])

    const disabled = await auditEntries(admin.page, 'Disabled a user')
    await expect(
      disabled.filter({ hasText: `Disabled the user ${account.nickname} (${account.handle})` }),
    ).toHaveCount(1)
    await admin.context.close()
  })

  test('after a password reset the user must change the temporary password first', async ({
    page,
    account,
    browser,
  }) => {
    await page.goto('/chats')
    const admin = await openAsAdmin(browser, '/admin/users')
    const row = await userRow(admin.page, account)
    await row.getByRole('button', { name: `Reset the password of ${account.nickname}` }).click()
    await confirm(admin.page, 'Reset password')
    const shown = admin.page.getByTestId('temp-password')
    await expect(shown).toHaveText(/^\S{12}$/)
    const temporary = await shown.innerText()
    await admin.page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    // 关掉之后哪里都看不到这个密码了
    await expect(admin.page.getByText(temporary)).toHaveCount(0)

    // 他现在的登录失效了；原来的密码不能用了
    await expect(page).toHaveURL(/\/login/)
    await page.getByLabel('ID').fill(account.handle)
    await page.getByLabel('Password').fill(account.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page.getByRole('alert')).toHaveText('Incorrect ID or password.')

    // 用临时密码登录：只能看到修改密码的页面，改完才能进入
    await page.getByLabel('Password').fill(temporary)
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page).toHaveURL(/\/change-password$/)
    await page.goto('/chats')
    await expect(page).toHaveURL(/\/change-password$/)
    await page.getByLabel('Current password').fill(temporary)
    await page.getByLabel('New password', { exact: true }).fill('my-own-pass-3')
    await page.getByLabel('Confirm new password').fill('my-own-pass-3')
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(page).toHaveURL(/\/chats$/)

    const resets = await auditEntries(admin.page, 'Reset a password')
    await expect(resets.filter({ hasText: account.handle })).toHaveCount(1)
    await expect(admin.page.getByText(temporary)).toHaveCount(0)
    await admin.context.close()
  })

  test('the administrator has no disable or reset buttons on their own row', async ({
    browser,
  }) => {
    const admin = await openAsAdmin(browser, '/admin/users')
    await admin.page.getByRole('searchbox', { name: 'Find by ID or nickname' }).fill('admin')
    const row = admin.page.getByTestId('admin-user').filter({ hasText: 'Administrator' })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('button')).toHaveCount(0)
    // 接口同样拒绝
    const me = (await (await admin.page.request.get('/api/me')).json()) as { id: string }
    const reply = await admin.page.request.post(`/api/admin/users/${me.id}/disable`, {
      headers: { origin: new URL(admin.page.url()).origin },
    })
    expect(reply.status()).toBe(403)
    expect(((await reply.json()) as { code: string }).code).toBe('cannot_target_self')
    await admin.context.close()
  })
})

test.describe('viewing chats', () => {
  test('a recalled message is shown in full and the view is recorded', async ({
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const secret = `the code is ${Date.now().toString(36)}`
    const wrong = await post(account, conversation, { text: secret })
    await say(bea, conversation, 'got it')
    await recall(account, conversation, wrong)

    // 按用户找到会话
    const admin = await openAsAdmin(browser, '/admin/chats')
    const { page } = admin
    await page
      .getByRole('searchbox', { name: 'Find a user by ID or nickname' })
      .fill(account.handle)
    await page.getByTestId('admin-user-candidate').click()
    await expect(page.getByTestId('admin-chats-user')).toContainText(account.nickname)
    const found = page.getByTestId('admin-conversation')
    await expect(found).toHaveCount(1)
    await expect(found).toHaveAttribute('data-kind', 'direct')
    await expect(found).toContainText(account.nickname)
    await expect(found).toContainText(bea.nickname)
    await found.click()

    // 查看页：醒目的提示，没有输入区，消息上没有任何操作
    await expect(page).toHaveURL(new RegExp(`/admin/chats/${conversation}$`))
    await expect(page.getByTestId('admin-viewer-banner')).toContainText('Administrator view')
    await expect(page.getByTestId('admin-viewer-banner')).toContainText('Read-only')
    const recalled = page.getByTestId('message').filter({ hasText: secret })
    await expect(recalled).toHaveCount(1)
    // 已撤回的消息显示原文，并标明"已撤回"
    await expect(recalled.getByTestId('message-note')).toHaveText('Recalled')
    await expect(recalled.getByTestId('message-sender')).toHaveText(account.nickname)
    const other = page.getByTestId('message').filter({ hasText: 'got it' })
    await expect(other.getByTestId('message-note')).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expect(page.getByTestId('message-list').getByRole('button')).toHaveCount(0)
    await recalled.hover()
    await expect(page.getByRole('button', { name: 'Message options' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reply' })).toHaveCount(0)

    // 成员自己看到的仍然是"撤回了一条消息"
    const member = await browser.newContext({ storageState: bea.storageState })
    const beaPage = await member.newPage()
    await beaPage.goto(`/chats/${conversation}`)
    await expect(beaPage.getByText('got it')).toBeVisible()
    await expect(beaPage.getByText(secret)).toHaveCount(0)
    await member.close()

    // 操作记录里多了一条，写着看的是哪个会话
    const views = await auditEntries(page, 'Viewed a chat')
    const mine = views.filter({ hasText: account.nickname }).filter({ hasText: bea.nickname })
    await expect(mine).toHaveCount(1)
    await expect(mine).toContainText('Viewed the direct chat of')
    await admin.context.close()
  })

  test('pictures open, files download and voice plays in the read-only view', async ({
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const photo = await uploadAs(
      account,
      'trail.png',
      'image/png',
      pngImage(320, 200, [70, 130, 90]),
    )
    const photoSeq = await post(account, conversation, { file_id: photo.id })
    const sheet = await uploadAs(account, 'plan.txt', '', Buffer.from('the plan'))
    await post(account, conversation, { file_id: sheet.id })
    const voice = await uploadAs(bea, 'voice.webm', 'audio/webm;codecs=opus', voiceSample())
    await post(bea, conversation, { file_id: voice.id, voice_duration_ms: 1500 })
    await post(bea, conversation, { text: 'nice picture', reply_to: photoSeq })
    // 图片撤回之后，管理员照样看得到
    await recall(account, conversation, photoSeq)

    const admin = await openAsAdmin(browser, `/admin/chats/${conversation}`)
    const { page } = admin
    const loaded = (image: Locator) =>
      image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)

    const image = page.getByTestId('message-image')
    await expect(image).toBeVisible()
    await expect.poll(() => loaded(image.locator('img'))).toBe(true)
    await expect(
      page.getByTestId('message').filter({ has: image }).getByTestId('message-note'),
    ).toHaveText('Recalled')
    await image.click()
    await expect(page.getByTestId('lightbox-image')).toBeVisible()
    await expect.poll(() => loaded(page.getByTestId('lightbox-image'))).toBe(true)
    await page.keyboard.press('Escape')
    // 引用了已撤回图片的回复，引用处照常显示
    await expect(page.getByTestId('quote')).toHaveAttribute('data-state', 'shown')

    const saving = page.waitForEvent('download')
    await page.getByTestId('message-file').click()
    expect((await saving).suggestedFilename()).toBe('plan.txt')

    const bubble = page.getByTestId('message-voice')
    // 管理员听不听都不算谁"听过"：没有未听的标记
    await expect(page.getByTestId('voice-unplayed')).toHaveCount(0)
    await bubble.click()
    await expect(bubble).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await expect(page.getByText("can't be played")).toHaveCount(0)

    // 这些文件只有带着这一次查看的凭据才取得到
    const plain = await page.request.get(`/api/files/${photo.id}`)
    expect(plain.status()).toBe(404)
    const bare = await page.request.get(
      `/api/admin/conversations/${conversation}/files/${photo.id}`,
    )
    expect(bare.status()).toBe(404)
    const messages = await page.request.get(`/api/admin/conversations/${conversation}/messages`)
    expect(messages.status()).toBe(403)
    await admin.context.close()
  })
})

test.describe('groups', () => {
  test('the administrator dissolves a group and every member sees it at once', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const name = `Hikers ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
    const group = await makeGroup(account, [bea, cy], name)
    await say(bea, group, 'who brings the water?')
    await page.goto(`/chats/${group}`)
    await expect(page.getByTestId('message-text')).toHaveText(['who brings the water?'])

    const admin = await openAsAdmin(browser, '/admin/groups')
    await admin.page.getByRole('searchbox', { name: 'Find by group name' }).fill(name)
    const row = admin.page.getByTestId('admin-group')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(`Owner ${account.nickname}`)
    await expect(row).toContainText('3 members')

    await row.getByRole('button', { name: `Show the members of “${name}”` }).click()
    const members = admin.page.getByTestId('admin-member')
    await expect(members).toHaveCount(3)
    await expect(members.first()).toContainText(account.nickname)
    await expect(members.first()).toContainText('Owner')
    await admin.page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

    // 从群的列表也能去看聊天记录
    await row.getByRole('link', { name: `View the chat of “${name}”` }).click()
    await expect(admin.page.getByTestId('admin-viewer-title')).toHaveText(name)
    await expect(admin.page.getByText('who brings the water?')).toBeVisible()
    await admin.page.getByRole('button', { name: 'Back' }).click()

    await admin.page.getByRole('searchbox', { name: 'Find by group name' }).fill(name)
    await row.getByRole('button', { name: `Dissolve “${name}”` }).click()
    await confirm(admin.page, 'Dissolve')
    await expect(row).toHaveAttribute('data-dissolved', 'true')
    // 已经解散的不能再解散
    await expect(row.getByRole('button', { name: `Dissolve “${name}”` })).toHaveCount(0)

    // 成员的页面不用刷新：出现提示，输入区换成了说明
    await expect(page.getByTestId('message-event').last()).toHaveText(
      'The group was dissolved by an administrator',
    )
    await expect(
      page.getByText("This group has been dissolved, so you can't send messages"),
    ).toBeVisible()

    const dissolved = await auditEntries(admin.page, 'Dissolved a group')
    await expect(dissolved.filter({ hasText: name })).toHaveText(`Dissolved the group “${name}”`)
    await admin.context.close()
  })
})

test.describe('overview and audit log', () => {
  test('the overview shows users, people online, groups and storage', async ({
    page,
    account,
    browser,
  }) => {
    // 自己开着页面，至少有一个人在线；传过一个文件，至少有一个文件
    await uploadAs(account, 'note.txt', '', Buffer.from('hello'))
    await page.goto('/chats')
    const admin = await openAsAdmin(browser, '/admin/overview')
    const value = (name: string) => admin.page.getByTestId(`stat-${name}`).getByTestId('stat-value')
    await expect(value('users')).toHaveText(/^[1-9]\d*$/)
    await expect(value('online')).toHaveText(/^[1-9]\d*$/)
    await expect(value('groups')).toHaveText(/^\d+$/)
    await expect(value('storage')).toHaveText(/^[\d.]+ (B|KB|MB|GB)$/)
    await expect(admin.page.getByTestId('stat-storage')).toContainText(/[1-9]\d* files?/)
    // 电脑上从左侧的"管理"进来就是概况；二级导航里概况是选中的
    await admin.page.getByTestId('nav-rail').getByRole('link', { name: 'Admin' }).click()
    await expect(admin.page).toHaveURL(/\/admin$/)
    await expect(value('users')).toBeVisible()
    await expect(
      admin.page.getByTestId('admin-nav').getByRole('link', { name: 'Overview' }),
    ).toHaveAttribute('aria-current', 'page')
    await admin.context.close()
  })

  test('the audit log can only be read', async ({ browser }) => {
    const admin = await openAsAdmin(browser, '/admin/audit')
    await expect(admin.page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
    // 页面上没有任何修改或删除的按钮
    const list = admin.page.getByTestId('audit-log')
    await expect(list.or(admin.page.getByText('Nothing has been recorded yet'))).toBeVisible()
    await expect(list.getByRole('button')).toHaveCount(0)
    // 接口上也没有
    const origin = new URL(admin.page.url()).origin
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const reply = await admin.page.request[method]('/api/admin/audit', { headers: { origin } })
      expect(reply.status(), method).toBe(405)
    }
    await admin.context.close()
  })
})
