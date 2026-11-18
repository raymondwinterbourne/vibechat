// 群聊：建群、群里聊天、已读人数、@、成员进出、群主的管理。

import type { Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  expect,
  makeGroup,
  newApi,
  openAs,
  pngImage,
  say,
  test,
} from './support'

// 每个测试都是好几个人各开一个窗口，步骤也多：全量测试时机器很忙，会超过默认的 30 秒
test.describe.configure({ timeout: 60_000 })

const messages = (page: Page) => page.getByTestId('message-text')
const events = (page: Page) => page.getByTestId('message-event')
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const title = (page: Page) => page.getByTestId('conversation-title')
/** 会话列表里名称含某段文字的那一行。 */
const row = (page: Page, name: string) => page.getByTestId('conversation').filter({ hasText: name })
const panel = (page: Page) => page.getByTestId('group-panel')
const dialog = (page: Page) => page.getByRole('dialog')

async function send(page: Page, text: string) {
  await composer(page).fill(text)
  await composer(page).press('Enter')
}

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Group info' }).click()
  await expect(panel(page)).toBeVisible()
}

/** 在群信息里点开一个成员。 */
async function openMember(page: Page, who: Account) {
  await panel(page).getByTestId('member').filter({ hasText: who.nickname }).click()
  await expect(dialog(page).getByTestId('member-profile-name')).toHaveText(who.nickname)
}

/** 三个人和他们的群：`account` 是群主。另外两人各开一个窗口，停在这个群里。 */
async function trio(browser: import('@playwright/test').Browser, account: Account, name: string) {
  const bea = await another('Bea')
  const cy = await another('Cy')
  const group = await makeGroup(account, [bea, cy], name)
  const b = await openAs(browser, bea, `/chats/${group}`)
  const c = await openAs(browser, cy, `/chats/${group}`)
  return { bea, cy, group, beaPage: b.page, cyPage: c.page, contexts: [b.context, c.context] }
}

test.describe('starting a group', () => {
  test('the group shows up for everyone at once', async ({ page, account, browser }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    await befriend(account, bea)
    await befriend(account, cy)
    const b = await openAs(browser, bea, '/chats')
    const c = await openAs(browser, cy, '/chats')
    await expect(b.page.getByTestId('conversation')).toHaveCount(1)
    await expect(c.page.getByTestId('conversation')).toHaveCount(1)

    await page.goto('/chats')
    await page.getByRole('button', { name: 'New group' }).click()
    const create = dialog(page).getByRole('button', { name: 'Create' })
    await dialog(page).getByLabel('Group name').fill('Weekend hike')
    // 选满两人才能创建
    await expect(create).toBeDisabled()
    await dialog(page).getByTestId('pick-friend').filter({ hasText: bea.nickname }).click()
    await expect(create).toBeDisabled()
    await dialog(page).getByTestId('pick-friend').filter({ hasText: cy.nickname }).click()
    await create.click()

    // 创建后直接进入这个群
    await expect(page).toHaveURL(/\/chats\/[0-9a-f-]{36}$/)
    await expect(title(page)).toHaveText('Weekend hike')
    await expect(page.getByTestId('member-count')).toHaveText('(3)')
    await expect(events(page)).toHaveText(
      `You created the group with ${bea.nickname}, ${cy.nickname}`,
    )

    // 另外两人没有刷新，列表里立即出现这个群
    for (const [other, peer] of [
      [b.page, cy],
      [c.page, bea],
    ] as const) {
      const group = row(other, 'Weekend hike')
      await expect(group).toBeVisible({ timeout: 2000 })
      await expect(group.getByTestId('conversation-summary')).toContainText(
        `${account.nickname} created the group with`,
      )
      await expect(group.getByTestId('conversation-summary')).toContainText('you')
      await expect(group.getByTestId('conversation-summary')).toContainText(peer.nickname)
    }
    // 建群的提示不算未读
    await expect(row(b.page, 'Weekend hike').getByTestId('badge')).toHaveCount(0)

    await b.context.close()
    await c.context.close()
  })

  test('from a chat with one friend, adding another starts a group of three', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const direct = await befriend(account, bea)
    await befriend(account, cy)
    await say(bea, direct, 'just the two of us')
    const b = await openAs(browser, bea, '/chats')
    const c = await openAs(browser, cy, '/chats')

    await page.goto(`/chats/${direct}`)
    await expect(messages(page)).toHaveText(['just the two of us'])
    await page.getByRole('button', { name: 'Add people' }).click()
    // 正在聊天的这一位已经勾上，不能去掉；再选一位才能创建
    const partner = dialog(page).getByTestId('pick-friend').filter({ hasText: bea.nickname })
    await expect(partner.getByRole('checkbox')).toBeChecked()
    await expect(partner.getByRole('checkbox')).toBeDisabled()
    await expect(partner).toContainText('In this chat')
    const create = dialog(page).getByRole('button', { name: 'Create' })
    await expect(create).toBeDisabled()
    await expect(dialog(page)).toContainText('Pick at least one more friend')
    await dialog(page).getByTestId('pick-friend').filter({ hasText: cy.nickname }).click()
    await create.click()

    // 进入新建的群：是另一个会话，里面没有单聊的消息
    await expect(page).not.toHaveURL(new RegExp(direct))
    await expect(page.getByTestId('member-count')).toHaveText('(3)')
    await expect(events(page)).toHaveText(
      `You created the group with ${bea.nickname}, ${cy.nickname}`,
    )
    await expect(messages(page)).toHaveCount(0)
    // 另外两人立即看到这个群；原来的单聊还在，内容没变
    await expect(b.page.getByTestId('conversation')).toHaveCount(2)
    await expect(c.page.getByTestId('conversation')).toHaveCount(2)
    await expect(page.getByTestId('conversation')).toHaveCount(3)
    await page.goto(`/chats/${direct}`)
    await expect(messages(page)).toHaveText(['just the two of us'])

    // 群里没有这个按钮（群里是"邀请好友"）；不再是好友的单聊里也没有
    await page.getByTestId('conversation').first().click()
    await expect(page.getByTestId('member-count')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add people' })).toHaveCount(0)
    const api = await newApi(bea.storageState)
    expect((await api.delete(`/api/friends/${account.id}`)).ok()).toBe(true)
    await api.dispose()
    await page.goto(`/chats/${direct}`)
    await expect(page.getByTestId('composer-closed')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add people' })).toHaveCount(0)

    await b.context.close()
    await c.context.close()
  })

  test('a group without a name is called after its members', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy])

    await page.goto(`/chats/${group}`)
    for (const who of [account, bea, cy]) await expect(title(page)).toContainText(who.nickname)
    await expect(
      page.getByTestId('conversation-name').filter({ hasText: account.nickname }),
    ).toContainText(`${bea.nickname}, ${cy.nickname}`)

    // 通讯录的"群聊"里也有它，点一下回到会话
    await page.goto('/contacts')
    await page.getByRole('link', { name: 'Groups' }).click()
    await expect(page.getByTestId('group')).toHaveCount(1)
    await expect(page.getByTestId('group')).toContainText('3 members')
    await page.getByTestId('group').click()
    await expect(page).toHaveURL(new RegExp(`/chats/${group}$`))
  })
})

test.describe('talking in a group', () => {
  test('everyone sees the same messages in the same order, with who said what', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, beaPage, cyPage, group, contexts } = await trio(browser, account, 'Order')
    await page.goto(`/chats/${group}`)
    await expect(events(page)).toHaveCount(1)
    await expect(events(beaPage)).toHaveCount(1)
    await expect(events(cyPage)).toHaveCount(1)

    // 三个人轮流发
    const pages = [page, beaPage, cyPage]
    const expected: string[] = []
    for (let round = 0; round < 3; round++) {
      for (const [index, sender] of pages.entries()) {
        const text = `m${round}-${index}`
        expected.push(text)
        await send(sender, text)
        // 等发出去了再让下一个人发：顺序由服务端定，这里只是让期望的顺序是确定的
        await expect(messages(sender).last()).toHaveText(text)
      }
    }
    for (const each of pages) await expect(messages(each)).toHaveText(expected)

    // 同时发的几条，三个人看到的顺序也完全一样
    await Promise.all(pages.map((each, index) => send(each, `burst-${index}`)))
    for (const each of pages) await expect(messages(each)).toHaveCount(expected.length + 3)
    const seen = await Promise.all(pages.map((each) => messages(each).allTextContents()))
    expect(seen[1]).toEqual(seen[0])
    expect(seen[2]).toEqual(seen[0])

    // 别人的消息带名称；同一个人连续的几条只显示一次
    await send(beaPage, 'one more')
    await send(beaPage, 'and another')
    await expect(messages(page).last()).toHaveText('and another')
    const fromBea = page.getByTestId('message').filter({ hasText: 'one more' })
    const next = page.getByTestId('message').filter({ hasText: 'and another' })
    await expect(next.getByTestId('message-sender')).toHaveCount(0)
    // "one more"前面那条可能也是她发的（上面同时发的那一轮里她排在最后），这时名称在更前面
    const named = await fromBea.getByTestId('message-sender').count()
    if (named > 0) await expect(fromBea.getByTestId('message-sender')).toHaveText(bea.nickname)
    await expect(
      page.getByTestId('message-sender').filter({ hasText: bea.nickname }).first(),
    ).toBeVisible()

    // 会话列表的摘要：别人发的带名称，自己发的不带
    await expect(row(page, 'Order').getByTestId('conversation-summary')).toHaveText(
      `${bea.nickname}: and another`,
    )
    await expect(row(beaPage, 'Order').getByTestId('conversation-summary')).toHaveText(
      'and another',
    )
    for (const context of contexts) await context.close()
  })

  test('the read count climbs as others open the group, and lists who', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Readers')
    const b = await openAs(browser, bea, '/chats')
    const c = await openAs(browser, cy, '/chats')

    await page.goto(`/chats/${group}`)
    await send(page, 'who has read this?')
    const status = page
      .getByTestId('message')
      .filter({ hasText: 'who has read this?' })
      .getByTestId('message-status')
    await expect(status).toHaveText('Read by 0')

    // 一个人打开了：数字不用刷新就变
    await row(b.page, 'Readers').click()
    await expect(status).toHaveText('Read by 1')
    await status.getByRole('button').click()
    await expect(dialog(page).getByTestId('readers-read')).toContainText('Read (1)')
    await expect(dialog(page).getByTestId('readers-read')).toContainText(bea.nickname)
    await expect(dialog(page).getByTestId('readers-unread')).toContainText('Not yet (1)')
    await expect(dialog(page).getByTestId('readers-unread')).toContainText(cy.nickname)

    // 另一个人也打开了：开着的名单跟着变
    await row(c.page, 'Readers').click()
    await expect(dialog(page).getByTestId('readers-read')).toContainText('Read (2)')
    await expect(dialog(page).getByTestId('readers-read')).toContainText(cy.nickname)
    await expect(dialog(page).getByTestId('readers-unread')).toContainText('No one')
    await page.keyboard.press('Escape')
    await expect(status).toHaveText('Read by all')

    await b.context.close()
    await c.context.close()
  })

  test('mentioning someone flags the group for them, and only for them', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Mentions')
    const b = await openAs(browser, bea, `/chats/${group}`)
    const c = await openAs(browser, cy, '/chats')
    await page.goto('/chats')
    await expect(row(page, 'Mentions')).toBeVisible()
    await expect(row(c.page, 'Mentions')).toBeVisible()

    // 输入"@"弹出成员列表：有另外两人，没有自己；不是群主，没有"所有人"
    await expect(events(b.page)).toHaveCount(1)
    await composer(b.page).pressSequentially('look ')
    await composer(b.page).pressSequentially('@')
    const options = b.page.getByTestId('mention-option')
    await expect(options).toHaveCount(2)
    await expect(b.page.getByTestId('mention-list')).not.toContainText(bea.nickname)
    await expect(b.page.getByTestId('mention-list')).not.toContainText('All')
    // 继续打字筛选，回车选中
    await composer(b.page).pressSequentially('cy')
    await expect(b.page.getByTestId('mention-name')).toHaveText([cy.nickname])
    await composer(b.page).press('Enter')
    await expect(composer(b.page)).toHaveValue(`look @${cy.nickname} `)
    await expect(b.page.getByTestId('mention-list')).toHaveCount(0)
    await composer(b.page).pressSequentially('at this')
    await composer(b.page).press('Enter')
    await expect(messages(b.page)).toHaveText([`look @${cy.nickname} at this`])

    // 被 @ 的人：列表里有醒目的提示；没有被 @ 的人没有
    const cyRow = row(c.page, 'Mentions')
    await expect(cyRow.getByTestId('mention-flag')).toHaveText('[Mentioned you]')
    await expect(cyRow.getByTestId('badge')).toHaveText('1')
    await expect(row(page, 'Mentions').getByTestId('badge')).toHaveText('1')
    await expect(row(page, 'Mentions').getByTestId('mention-flag')).toHaveCount(0)

    // 刷新之后提示还在；看过那条消息就没有了
    await c.page.reload()
    await expect(cyRow.getByTestId('mention-flag')).toBeVisible()
    await cyRow.click()
    await expect(c.page.getByTestId('mention')).toHaveText(`@${cy.nickname}`)
    await expect(cyRow.getByTestId('mention-flag')).toHaveCount(0)

    // 群主可以 @ 所有人：用方向键选
    await row(page, 'Mentions').click()
    await expect(messages(page)).toHaveCount(1)
    await c.page.goto('/contacts')
    await composer(page).pressSequentially('@')
    await expect(page.getByTestId('mention-name')).toHaveText(['All', bea.nickname, cy.nickname])
    await composer(page).press('ArrowDown')
    await composer(page).press('ArrowUp')
    await composer(page).press('Enter')
    await expect(composer(page)).toHaveValue('@All ')
    await composer(page).pressSequentially('lunch?')
    await composer(page).press('Enter')
    await c.page.goto('/chats')
    await expect(row(c.page, 'Mentions').getByTestId('mention-flag')).toBeVisible()
    await expect(b.page.getByTestId('mention').last()).toHaveText('@All')

    await b.context.close()
    await c.context.close()
  })

  test('Escape closes the member list and a plain @ sends as text', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Plain')
    await page.goto(`/chats/${group}`)
    await expect(events(page)).toHaveCount(1)

    await composer(page).pressSequentially('mail me @')
    await expect(page.getByTestId('mention-list')).toBeVisible()
    await composer(page).press('Escape')
    await expect(page.getByTestId('mention-list')).toHaveCount(0)
    await composer(page).pressSequentially('home')
    await composer(page).press('Enter')
    await expect(messages(page)).toHaveText(['mail me @home'])
    await expect(page.getByTestId('mention')).toHaveCount(0)

    // 点击也能选
    await composer(page).pressSequentially('@')
    await page.getByTestId('mention-option').filter({ hasText: bea.nickname }).click()
    await expect(composer(page)).toHaveValue(`@${bea.nickname} `)
    await expect(composer(page)).toBeFocused()
  })
})

test.describe('people coming and going', () => {
  test('someone invited later sees nothing from before they joined', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const dee = await another('Dee')
    const group = await makeGroup(account, [bea, cy], 'Latecomers')
    await befriend(account, dee)
    await say(bea, group, 'before Dee one', 'before Dee two')
    const d = await openAs(browser, dee, '/chats')
    await expect(d.page.getByTestId('conversation')).toHaveCount(1)

    await page.goto(`/chats/${group}`)
    await expect(messages(page)).toHaveCount(2)
    await openPanel(page)
    await panel(page).getByRole('button', { name: 'Invite friends' }).click()
    // 已经在群里的不能再选
    const taken = dialog(page).getByTestId('pick-friend').filter({ hasText: bea.nickname })
    await expect(taken).toContainText('Already in the group')
    await expect(taken.getByRole('checkbox')).toBeDisabled()
    await expect(dialog(page).getByTestId('invite-room')).toHaveText('You can invite 7 more')
    await dialog(page).getByTestId('pick-friend').filter({ hasText: dee.nickname }).click()
    await dialog(page).getByRole('button', { name: 'Invite', exact: true }).click()

    await expect(events(page).last()).toHaveText(`You added ${dee.nickname} to the group`)
    await expect(page.getByTestId('member-count')).toHaveText('(4)')
    await expect(panel(page).getByTestId('member')).toHaveCount(4)

    // 被邀请的人直接入群：列表里出现这个群，里面只有入群的提示和之后的消息
    await row(d.page, 'Latecomers').click()
    await expect(events(d.page)).toHaveText([`${account.nickname} added you to the group`])
    await send(page, 'welcome Dee')
    await expect(messages(d.page)).toHaveText(['welcome Dee'])
    await d.page.reload()
    await expect(messages(d.page)).toHaveText(['welcome Dee'])

    // 直接调接口也取不到之前的
    const api = await newApi(dee.storageState)
    const reply = await api.get(`/api/conversations/${group}/messages?limit=100`)
    const body = (await reply.json()) as { items: { text: string | null }[] }
    await api.dispose()
    expect(body.items.map((item) => item.text).filter(Boolean)).toEqual(['welcome Dee'])

    await d.context.close()
  })

  test('the owner removes a member, hands the group over, and the new owner dissolves it', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, cy, beaPage, cyPage, group, contexts } = await trio(browser, account, 'Owners')
    await page.goto(`/chats/${group}`)
    await expect(events(beaPage)).toHaveCount(1)
    await expect(events(cyPage)).toHaveCount(1)

    // 不是群主：看不到群主才能做的操作
    await openPanel(beaPage)
    await expect(panel(beaPage).getByRole('button', { name: 'Leave group' })).toBeVisible()
    await expect(panel(beaPage).getByRole('button', { name: 'Dissolve group' })).toHaveCount(0)
    // 群名点不了；头像能看大图，但没有更换的按钮
    await expect(panel(beaPage).getByTestId('group-name')).toHaveText('Owners')
    await expect(panel(beaPage).getByTestId('group-name').getByRole('button')).toHaveCount(0)
    await panel(beaPage).getByTestId('group-avatar').click()
    await expect(dialog(beaPage).getByRole('heading', { name: 'Group photo' })).toBeVisible()
    await expect(dialog(beaPage).getByRole('button', { name: 'Change group photo' })).toHaveCount(0)
    await beaPage.keyboard.press('Escape')
    await panel(beaPage).getByTestId('member').filter({ hasText: cy.nickname }).click()
    await expect(dialog(beaPage).getByTestId('member-profile')).toBeVisible()
    await expect(dialog(beaPage).getByRole('button', { name: 'Remove from group' })).toHaveCount(0)
    await beaPage.keyboard.press('Escape')

    // 群主移除一个成员，要确认
    await openPanel(page)
    // 群主要退出得先转让
    await expect(panel(page).getByRole('button', { name: 'Leave group' })).toHaveCount(0)
    await expect(panel(page)).toContainText('first hand the group over')
    await openMember(page, cy)
    await dialog(page).getByRole('button', { name: 'Remove from group' }).click()
    await expect(dialog(page)).toContainText(`Remove ${cy.nickname} from the group?`)
    await dialog(page).getByRole('button', { name: 'Confirm' }).click()

    await expect(events(page).last()).toHaveText(`You removed ${cy.nickname} from the group`)
    await expect(events(beaPage).last()).toHaveText(
      `${account.nickname} removed ${cy.nickname} from the group`,
    )
    await expect(page.getByTestId('member-count')).toHaveText('(2)')
    await expect(beaPage.getByTestId('member-count')).toHaveText('(2)')
    await expect(panel(beaPage).getByTestId('member')).toHaveCount(2)
    // 被移出的人：会话还在，能看历史，不能再发
    await expect(events(cyPage).last()).toHaveText(`${account.nickname} removed you from the group`)
    await expect(cyPage.getByTestId('composer-closed')).toContainText('no longer in this group')
    await expect(row(cyPage, 'Owners')).toBeVisible()
    // 之后的消息他收不到
    await send(page, 'after Cy left')
    await expect(messages(beaPage)).toHaveText(['after Cy left'])
    await expect(messages(cyPage)).toHaveCount(0)

    // 转让群主
    await openMember(page, bea)
    await dialog(page).getByRole('button', { name: 'Make owner' }).click()
    await dialog(page).getByRole('button', { name: 'Confirm' }).click()
    await expect(events(page).last()).toHaveText(`You made ${bea.nickname} the group owner`)
    await expect(events(beaPage).last()).toHaveText(`${account.nickname} made you the group owner`)
    const ownerRow = panel(beaPage).getByTestId('member').filter({ hasText: bea.nickname })
    await expect(ownerRow.getByTestId('owner-tag')).toBeVisible()
    // 原来的群主现在可以退了，也不再有群主的操作
    await expect(panel(page).getByRole('button', { name: 'Leave group' })).toBeVisible()
    await expect(panel(page).getByRole('button', { name: 'Dissolve group' })).toHaveCount(0)

    // 新群主解散群
    await panel(beaPage).getByRole('button', { name: 'Dissolve group' }).click()
    await dialog(beaPage).getByRole('button', { name: 'Dissolve group' }).click()
    await expect(events(beaPage).last()).toHaveText('You dissolved the group')
    await expect(events(page).last()).toHaveText(`${bea.nickname} dissolved the group`)
    await expect(page.getByTestId('composer-closed')).toContainText('has been dissolved')
    await expect(beaPage.getByTestId('composer-closed')).toContainText('has been dissolved')
    // 历史还在
    await expect(messages(page)).toHaveText(['after Cy left'])
    await page.reload()
    await expect(messages(page)).toHaveText(['after Cy left'])
    await expect(page.getByTestId('composer-closed')).toBeVisible()

    for (const context of contexts) await context.close()
  })

  test('leaving takes the group off my list and tells the others', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, beaPage, group, contexts } = await trio(browser, account, 'Leavers')
    await page.goto(`/chats/${group}`)
    await expect(events(page)).toHaveCount(1)

    await openPanel(beaPage)
    await panel(beaPage).getByRole('button', { name: 'Leave group' }).click()
    await dialog(beaPage).getByRole('button', { name: 'Leave group' }).click()

    await expect(beaPage).toHaveURL(/\/chats$/)
    await expect(row(beaPage, 'Leavers')).toHaveCount(0)
    await expect(events(page).last()).toHaveText(`${bea.nickname} left the group`)
    await expect(page.getByTestId('member-count')).toHaveText('(2)')
    // 刷新之后也不在
    await beaPage.reload()
    await expect(beaPage.getByTestId('conversation')).toHaveCount(1)
    await expect(row(beaPage, 'Leavers')).toHaveCount(0)

    for (const context of contexts) await context.close()
  })

  test('someone removed and invited back only sees what came after rejoining', async ({
    page,
    account,
    browser,
  }) => {
    const { cy, cyPage, group, contexts } = await trio(browser, account, 'Returners')
    await page.goto(`/chats/${group}`)
    await send(page, 'while Cy was here')
    await expect(messages(cyPage)).toHaveText(['while Cy was here'])

    await openPanel(page)
    await openMember(page, cy)
    await dialog(page).getByRole('button', { name: 'Remove from group' }).click()
    await dialog(page).getByRole('button', { name: 'Confirm' }).click()
    await expect(cyPage.getByTestId('composer-closed')).toBeVisible()
    await send(page, 'while Cy was away')
    await expect(messages(page)).toHaveCount(2)

    await panel(page).getByRole('button', { name: 'Invite friends' }).click()
    await dialog(page).getByTestId('pick-friend').filter({ hasText: cy.nickname }).click()
    await dialog(page).getByRole('button', { name: 'Invite', exact: true }).click()

    // 他一直开着这个会话：回来之后以前的消息不再显示，只有这一次入群之后的
    await expect(events(cyPage)).toHaveText([`${account.nickname} added you to the group`])
    await expect(messages(cyPage)).toHaveCount(0)
    await expect(composer(cyPage)).toBeVisible()
    await send(cyPage, 'back again')
    await expect(messages(page).last()).toHaveText('back again')
    await cyPage.reload()
    await expect(messages(cyPage)).toHaveText(['back again'])

    for (const context of contexts) await context.close()
  })
})

test.describe('the group itself', () => {
  test('a new name and photo reach everyone at once', async ({ page, account, browser }) => {
    const { beaPage, group, contexts } = await trio(browser, account, 'Old name')
    await page.goto(`/chats/${group}`)
    await openPanel(page)

    // 群信息里的群名，点一下原地编辑
    await panel(page).getByTestId('group-name').getByRole('button').click()
    const input = page.getByTestId('group-name-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('Old name')
    await input.fill('New name')
    await input.press('Enter')
    await expect(panel(page).getByTestId('group-name')).toHaveText('New name')
    await expect(title(page)).toHaveText('New name')
    await expect(title(beaPage)).toHaveText('New name')
    await expect(row(beaPage, 'New name')).toBeVisible()
    await expect(events(beaPage).last()).toHaveText(
      `${account.nickname} renamed the group to “New name”`,
    )

    // 点头像看大图。没有头像时是群名的第一个字，群主可以在这里换
    await expect(row(beaPage, 'New name').locator('img')).toHaveCount(0)
    await panel(page).getByTestId('group-avatar').click()
    await expect(dialog(page).getByTestId('group-avatar-large')).toHaveCount(0)
    await expect(dialog(page).getByRole('button', { name: 'Change group photo' })).toBeVisible()
    await page.getByTestId('group-avatar-input').setInputFiles({
      name: 'group.png',
      mimeType: 'image/png',
      buffer: pngImage(64, 64, [40, 160, 90]),
    })
    // 换完之后大图就是新的，不用关了再开
    await expect(dialog(page).getByTestId('group-avatar-large')).toBeVisible()
    const shown = await dialog(page).getByTestId('group-avatar-large').boundingBox()
    expect(shown?.width).toBeGreaterThan(200)
    await page.keyboard.press('Escape')
    await expect(events(page).last()).toHaveText('You changed the group photo')
    await expect(row(beaPage, 'New name').locator('img')).toBeVisible()
    await expect(panel(page).getByTestId('group-avatar').locator('img')).toBeVisible()

    // 其他成员也能点开看大图
    await openPanel(beaPage)
    await panel(beaPage).getByTestId('group-avatar').click()
    await expect(dialog(beaPage).getByTestId('group-avatar-large')).toBeVisible()

    for (const context of contexts) await context.close()
  })

  test('the owner renames the group by clicking its name in the title bar', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy])
    const b = await openAs(browser, bea, `/chats/${group}`)
    await page.goto(`/chats/${group}`)
    await expect(events(page)).toHaveCount(1)
    const rename = title(page).getByRole('button')
    const input = page.getByTestId('title-input')

    // 还没有起名：输入框是空的，提示里是不起名时显示的成员名称
    await rename.click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')
    await expect(input).toHaveAttribute('placeholder', new RegExp(bea.nickname))
    await input.fill('Book club')
    await input.press('Enter')
    await expect(title(page)).toHaveText('Book club')
    // 名字完整地显示出来，没有被截成"Bo…"：文字所在的那一层装得下它的全部内容
    for (const who of [page, b.page]) {
      const clipped = await title(who).evaluate((element) => {
        const inner = element.querySelector('button') ?? element
        return inner.scrollWidth > inner.clientWidth
      })
      expect(clipped, 'the group name is clipped').toBe(false)
    }
    await expect(title(b.page)).toHaveText('Book club')
    await expect(row(b.page, 'Book club')).toBeVisible()
    await expect(events(b.page).last()).toHaveText(
      `${account.nickname} renamed the group to “Book club”`,
    )

    // Esc 放弃；没有改动就回车，不产生"改名"的提示
    await rename.click()
    await expect(input).toHaveValue('Book club')
    await input.fill('Never mind')
    await input.press('Escape')
    await expect(title(page)).toHaveText('Book club')
    await rename.click()
    await input.press('Enter')
    await expect(input).toHaveCount(0)
    // 点别处也是保存
    await rename.click()
    await input.fill('Film club')
    await composer(page).click()
    await expect(title(b.page)).toHaveText('Film club')
    await expect(events(page).filter({ hasText: 'renamed' })).toHaveCount(2)

    // 不是群主：名称点不了
    await expect(title(b.page).getByRole('button')).toHaveCount(0)
    await b.context.close()
  })

  test('two members who are not friends can become friends from the group', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Strangers')
    const b = await openAs(browser, bea, `/chats/${group}`)

    // 群主看成员：是好友，可以发消息
    await page.goto(`/chats/${group}`)
    await openPanel(page)
    await openMember(page, bea)
    await expect(dialog(page)).toContainText(bea.handle)
    await expect(dialog(page).getByRole('button', { name: 'Message' })).toBeVisible()
    await page.keyboard.press('Escape')

    // 两个不是好友的成员：能看资料，能发好友申请
    await openPanel(b.page)
    await openMember(b.page, cy)
    await expect(dialog(b.page).getByRole('button', { name: 'Message' })).toHaveCount(0)
    await dialog(b.page).getByRole('button', { name: 'Add friend' }).click()
    await expect(dialog(b.page)).toContainText('Friend request sent')
    await expect(dialog(b.page).getByRole('button', { name: 'Add friend' })).toHaveCount(0)
    await b.page.keyboard.press('Escape')

    // 对方同意之后，可以从群里直接去单聊
    const api = await newApi(cy.storageState)
    const list = await api.get('/api/friend-requests')
    const { items } = (await list.json()) as { items: { id: string; direction: string }[] }
    const incoming = items.find((item) => item.direction === 'received')
    const accepted = await api.post(`/api/friend-requests/${incoming?.id}/accept`)
    expect(accepted.status()).toBe(200)
    await api.dispose()

    await openMember(b.page, cy)
    await dialog(b.page).getByRole('button', { name: 'Message' }).click()
    await expect(title(b.page)).toHaveText(cy.nickname)
    await send(b.page, 'hi Cy')
    await expect(messages(b.page).last()).toHaveText('hi Cy')

    await b.context.close()
  })

  test('a full group cannot take anyone else', async ({ page, account }) => {
    // 上限默认是 10 人，包括群主
    const members: Account[] = []
    for (let index = 0; index < 9; index++) members.push(await another(`M${index}`))
    const group = await makeGroup(account, members, 'Full house')
    const extra = await another('Extra')
    await befriend(account, extra)

    await page.goto(`/chats/${group}`)
    await expect(page.getByTestId('member-count')).toHaveText('(10)')
    await openPanel(page)
    await expect(panel(page)).toContainText('Members (10/10)')
    await panel(page).getByRole('button', { name: 'Invite friends' }).click()
    await expect(dialog(page).getByTestId('invite-room')).toHaveText(
      'The group is full (10 members)',
    )
    const candidate = dialog(page).getByTestId('pick-friend').filter({ hasText: extra.nickname })
    await expect(candidate.getByRole('checkbox')).toBeDisabled()
    await expect(dialog(page).getByRole('button', { name: 'Invite', exact: true })).toBeDisabled()

    // 绕过界面直接调接口也不行
    const api = await newApi(account.storageState)
    const reply = await api.post(`/api/conversations/${group}/members`, {
      data: { user_ids: [extra.id] },
    })
    expect(reply.status()).toBe(409)
    expect(((await reply.json()) as { code: string }).code).toBe('group_full')
    await api.dispose()
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 700 } })

  test('starting a group, its info and a member all fit the screen', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    await befriend(account, bea)
    await befriend(account, cy)

    await page.goto('/chats')
    await page.getByRole('button', { name: 'New group' }).click()
    await dialog(page).getByTestId('pick-friend').filter({ hasText: bea.nickname }).click()
    await dialog(page).getByTestId('pick-friend').filter({ hasText: cy.nickname }).click()
    await dialog(page).getByRole('button', { name: 'Create' }).click()
    await expect(events(page)).toHaveCount(1)
    await send(page, 'a-very-long-word-'.repeat(12))

    const overflows = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
    expect(await overflows()).toBe(0)

    // 群信息盖住整个会话
    await openPanel(page)
    await expect(composer(page)).toBeHidden()
    await expect(panel(page).getByTestId('member')).toHaveCount(3)
    expect(await overflows()).toBe(0)
    await openMember(page, bea)
    await expect(dialog(page).getByRole('button', { name: 'Make owner' })).toBeInViewport()
    expect(await overflows()).toBe(0)
    await page.keyboard.press('Escape')
    await panel(page).getByRole('button', { name: 'Invite friends' }).click()
    await expect(dialog(page).getByRole('button', { name: 'Invite', exact: true })).toBeInViewport()
    await page.keyboard.press('Escape')

    // 返回会话
    await panel(page).getByRole('button', { name: 'Close group info' }).click()
    await expect(panel(page)).toHaveCount(0)
    await expect(composer(page)).toBeInViewport()
  })
})
