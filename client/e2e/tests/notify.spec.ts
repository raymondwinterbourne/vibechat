// 提醒：系统通知、页面标题上的未读数、免打扰。

import type { Page } from '@playwright/test'
import {
  another,
  befriend,
  clickNotice,
  expect,
  gotoConnected,
  logInElsewhere,
  makeGroup,
  newApi,
  notices,
  openAs,
  post,
  requestFriend,
  say,
  setForeground,
  takeOverNotifications,
  test,
} from './support'

const row = (page: Page, name: string) => page.getByTestId('conversation').filter({ hasText: name })

test.describe('system notifications', () => {
  test('a message that arrives in the background raises one, and clicking it opens the conversation', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const conversation = await befriend(account, bea)
    const other = await befriend(account, cy)
    await takeOverNotifications(page, { permission: 'granted', choice: 'on' })
    await page.goto(`/chats/${other}`)
    await expect(page.getByTestId('message-event')).toHaveCount(1)

    // 页面在前台：不弹
    await say(bea, conversation, 'while you are looking')
    await expect(row(page, bea.nickname).getByTestId('badge')).toHaveText('1')
    expect(await notices(page)).toEqual([])

    await setForeground(page, false)
    await say(bea, conversation, 'are you there?')
    await expect.poll(() => notices(page)).toHaveLength(1)
    const [first] = await notices(page)
    expect(first).toMatchObject({ title: bea.nickname, body: 'are you there?', closed: false })
    // 同一个会话的下一条用同一个标识：浏览器只留下最新的
    await say(bea, conversation, 'hello?')
    await expect.poll(() => notices(page)).toHaveLength(2)
    const shown = await notices(page)
    expect(shown[1]).toMatchObject({ body: 'hello?', tag: first?.tag })
    // 自己在别处发的不弹
    await say(account, conversation, 'from my phone')
    await expect(row(page, bea.nickname).getByTestId('conversation-summary')).toHaveText(
      'from my phone',
    )
    expect(await notices(page)).toHaveLength(2)

    // 点通知：回到那个会话；读过之后通知收起
    await setForeground(page, true)
    await clickNotice(page, 1)
    await expect(page).toHaveURL(new RegExp(`/chats/${conversation}$`))
    await expect(page.getByTestId('conversation-title')).toHaveText(bea.nickname)
    await expect.poll(async () => (await notices(page))[1]?.closed).toBe(true)
  })

  test('a muted conversation stays quiet unless I am mentioned', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Chatter')
    await takeOverNotifications(page, { permission: 'granted', choice: 'on' })
    await page.goto(`/chats/${group}`)
    await expect(page.getByTestId('message-event')).toHaveCount(1)

    // 在会话的"更多"里设为免打扰
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Mute notifications' }).click()
    await expect(page.getByTestId('toast')).toHaveText('Notifications muted')
    await expect(row(page, 'Chatter').getByTestId('muted')).toBeVisible()
    await page.goto('/contacts')
    await setForeground(page, false)

    // 普通消息：不弹，未读只是一个小圆点，不计入图标和标题上的数字
    await say(bea, group, 'just chatting', 'still chatting')
    // 后面那条 @ 我的消息要靠推送才会弹通知：等连接好了再发
    await gotoConnected(page, '/chats')
    await setForeground(page, false)
    await expect(row(page, 'Chatter').getByTestId('badge-dot')).toBeVisible()
    await expect(row(page, 'Chatter').getByTestId('badge')).toHaveCount(0)
    await expect(page.getByTestId('nav-rail').getByTestId('badge')).toHaveCount(0)
    await expect(page).toHaveTitle('VibeChat')
    expect(await notices(page)).toEqual([])

    // @ 我的：照常弹，未读数也算进去
    await post(bea, group, { text: `@${account.nickname} wake up`, mentions: [account.id] })
    await expect.poll(() => notices(page)).toHaveLength(1)
    expect((await notices(page))[0]).toMatchObject({
      title: 'Chatter',
      body: `${bea.nickname}: @${account.nickname} wake up`,
    })
    await expect(row(page, 'Chatter').getByTestId('mention-flag')).toBeVisible()
    await expect(row(page, 'Chatter').getByTestId('badge')).toHaveText('3')
    await expect(page).toHaveTitle('(3) VibeChat')

    // 取消免打扰
    await setForeground(page, true)
    await row(page, 'Chatter').click()
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Unmute notifications' }).click()
    await expect(row(page, 'Chatter').getByTestId('muted')).toHaveCount(0)
  })

  test('group events and recalls do not raise one, a friend request does', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(bea, [account, cy], 'Events')
    await takeOverNotifications(page, { permission: 'granted', choice: 'on' })
    await page.goto('/chats')
    await expect(row(page, 'Events')).toBeVisible()
    await setForeground(page, false)

    // 改群名是一条系统提示：不弹
    const api = await newApi(bea.storageState)
    await api.patch(`/api/conversations/${group}`, { data: { name: 'Renamed' } })
    await expect(row(page, 'Renamed')).toBeVisible()
    // 发了又撤回：发的时候弹一条，撤回不再弹
    const seq = await post(bea, group, { text: 'oops' })
    await expect.poll(() => notices(page)).toHaveLength(1)
    await api.post(`/api/conversations/${group}/messages/${seq}/recall`)
    await api.dispose()
    await expect(row(page, 'Renamed').getByTestId('conversation-summary')).toContainText(
      'recalled a message',
    )
    expect(await notices(page)).toHaveLength(1)

    // 好友申请
    const dee = await another('Dee')
    await requestFriend(dee, account, 'we met at the hike')
    await expect.poll(() => notices(page)).toHaveLength(2)
    expect((await notices(page))[1]).toMatchObject({
      title: dee.nickname,
      body: 'wants to be your friend: we met at the hike',
    })
    await clickNotice(page, 1)
    await expect(page).toHaveURL(/\/contacts\/new$/)
  })

  test('nothing is raised until I turn them on, and I am asked only once', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await takeOverNotifications(page, { permission: 'default', answer: 'granted' })
    await page.goto('/chats')
    const prompt = page.getByTestId('notice-prompt')
    await expect(prompt).toContainText("Turn on notifications so you don't miss new messages")

    // 还没有开启：在后台收到消息也不弹
    await setForeground(page, false)
    await say(bea, conversation, 'one')
    await expect(row(page, bea.nickname).getByTestId('badge')).toHaveText('1')
    expect(await notices(page)).toEqual([])

    // 点"开启"才向浏览器请求授权
    await prompt.getByRole('button', { name: 'Turn on' }).click()
    await expect(prompt).toHaveCount(0)
    await say(bea, conversation, 'two')
    await expect.poll(() => notices(page)).toHaveLength(1)

    // 设置里可以关掉；关了就不弹
    await setForeground(page, true)
    await page.goto('/settings')
    const toggle = page.getByRole('radiogroup', { name: 'System notifications' })
    await expect(toggle.getByRole('radio', { name: 'On' })).toBeChecked()
    await toggle.getByRole('radio', { name: 'Off' }).click()
    await setForeground(page, false)
    await say(bea, conversation, 'three')
    await page.goto('/chats')
    await expect(row(page, bea.nickname).getByTestId('badge')).toHaveText('3')
    expect(await notices(page)).toEqual([])
    // 选过一次之后，提示不再出现
    await expect(page.getByTestId('notice-prompt')).toHaveCount(0)
  })

  test('saying "no thanks" hides the prompt for good, and a blocked browser is explained', async ({
    page,
    account,
    browser,
  }) => {
    await takeOverNotifications(page, { permission: 'default' })
    await page.goto('/chats')
    await page.getByTestId('notice-prompt').getByRole('button', { name: 'No thanks' }).click()
    await expect(page.getByTestId('notice-prompt')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(page.getByTestId('notice-prompt')).toHaveCount(0)

    // 浏览器已经拒绝了授权：不出现提示，设置里说明怎么改回来
    const blocked = await openAs(browser, account, '/login')
    await takeOverNotifications(blocked.page, { permission: 'denied' })
    await blocked.page.goto('/chats')
    await expect(blocked.page.getByTestId('open-search')).toBeVisible()
    await expect(blocked.page.getByTestId('notice-prompt')).toHaveCount(0)
    await blocked.page.goto('/settings')
    await expect(blocked.page.getByTestId('notice-denied')).toContainText(
      'The browser has blocked notifications',
    )
    await blocked.context.close()
  })
})

test.describe('the page title and muting across logins', () => {
  test('the title counts unread messages and clears when they are read', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto('/contacts')
    await expect(page).toHaveTitle('VibeChat')

    await say(bea, conversation, 'one', 'two')
    await expect(page).toHaveTitle('(2) VibeChat')
    await page.goto(`/chats/${conversation}`)
    await expect(page).toHaveTitle('VibeChat')
  })

  test('muting in one place shows in my other login, and the group info has a switch for it', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Synced')
    const elsewhere = await logInElsewhere(browser, account)
    await expect(row(elsewhere.page, 'Synced')).toBeVisible()

    await page.goto(`/chats/${group}`)
    await page.getByRole('button', { name: 'Group info' }).click()
    const mute = page.getByTestId('group-panel').getByRole('switch', { name: 'Mute notifications' })
    await expect(mute).toHaveAttribute('aria-checked', 'false')
    await mute.click()
    await expect(mute).toHaveAttribute('aria-checked', 'true')

    // 另一处登录不刷新就变
    await expect(row(elsewhere.page, 'Synced').getByTestId('muted')).toBeVisible()
    await elsewhere.page.reload()
    await expect(row(elsewhere.page, 'Synced').getByTestId('muted')).toBeVisible()
    // 刷新之后等它的实时连接建立好：取消免打扰是靠推送传过去的，连接还没好就点会错过
    await expect(elsewhere.page.locator('[data-connection="open"]')).toBeVisible()
    await mute.click()
    await expect(row(elsewhere.page, 'Synced').getByTestId('muted')).toHaveCount(0)
    await elsewhere.context.close()
  })
})
