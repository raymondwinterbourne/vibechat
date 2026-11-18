// 群管理：群管理员、禁言、群内昵称、入群审批。

import type { Browser, Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  expect,
  makeGroup,
  newApi,
  openAs,
  say,
  test,
} from './support'

// 几个人各开一个窗口，步骤也多：全量测试时机器很忙，会超过默认的 30 秒
test.describe.configure({ timeout: 60_000 })

const events = (page: Page) => page.getByTestId('message-event')
const panel = (page: Page) => page.getByTestId('group-panel')
const dialog = (page: Page) => page.getByRole('dialog')
const memberRow = (page: Page, who: Account) =>
  panel(page).getByTestId('member').filter({ hasText: who.nickname })

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Group info' }).click()
  await expect(panel(page)).toBeVisible()
}

/** 在群信息里点开一个成员。 */
async function openMember(page: Page, who: Account) {
  await memberRow(page, who).click()
  await expect(dialog(page).getByTestId('member-profile-name')).toHaveText(who.nickname)
}

/** 我（群主）和另外三个人的群，三个人各自开着这个群。 */
async function quartet(browser: Browser, account: Account, name: string) {
  const bea = await another('Bea')
  const cy = await another('Cy')
  const dee = await another('Dee')
  const group = await makeGroup(account, [bea, cy, dee], name)
  const b = await openAs(browser, bea, `/chats/${group}`)
  const c = await openAs(browser, cy, `/chats/${group}`)
  return { bea, cy, dee, group, beaPage: b.page, cyPage: c.page, contexts: [b.context, c.context] }
}

test.describe('group admins', () => {
  test('the owner makes someone an admin, who can then manage ordinary members only', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, cy, dee, group, beaPage, cyPage, contexts } = await quartet(
      browser,
      account,
      'Admins',
    )
    await page.goto(`/chats/${group}`)
    await openPanel(page)
    await openMember(page, bea)
    await dialog(page).getByRole('button', { name: 'Make admin' }).click()
    await expect(page.getByTestId('toast')).toHaveText('Now an admin')

    // 群里所有人看到一行提示；名单上标着
    await expect(events(page).last()).toHaveText(`You made ${bea.nickname} an admin`)
    await expect(events(cyPage).last()).toHaveText(
      `${account.nickname} made ${bea.nickname} an admin`,
    )
    await expect(events(beaPage).last()).toHaveText(`${account.nickname} made you an admin`)
    await expect(memberRow(page, bea).getByTestId('admin-tag')).toHaveText('Admin')
    // 群主在最前，管理员接着
    await expect(panel(page).getByTestId('member-name')).toHaveText([
      account.nickname,
      bea.nickname,
      cy.nickname,
      dee.nickname,
    ])

    // 管理员不刷新就能改群名、编辑公告
    await openPanel(beaPage)
    await panel(beaPage).getByTestId('group-name').getByRole('button').click()
    const input = panel(beaPage).getByTestId('group-name-input')
    await input.fill('Admins rule')
    await input.press('Enter')
    await expect(events(cyPage).last()).toHaveText(
      `${bea.nickname} renamed the group to “Admins rule”`,
    )
    await expect(panel(beaPage).getByTestId('group-notice')).toBeVisible()
    // 不能动群主；没有转让、设置管理员、解散
    await openMember(beaPage, account)
    await expect(dialog(beaPage).getByRole('button', { name: 'Remove from group' })).toHaveCount(0)
    await expect(dialog(beaPage).getByRole('button', { name: 'Make admin' })).toHaveCount(0)
    await expect(dialog(beaPage).getByRole('button', { name: 'Make owner' })).toHaveCount(0)
    await beaPage.keyboard.press('Escape')
    await expect(panel(beaPage).getByRole('button', { name: 'Dissolve group' })).toHaveCount(0)
    // 能移出普通成员
    await openMember(beaPage, dee)
    await dialog(beaPage).getByRole('button', { name: 'Remove from group' }).click()
    await dialog(beaPage).getByRole('button', { name: 'Confirm' }).click()
    await expect(events(page).last()).toHaveText(
      `${bea.nickname} removed ${dee.nickname} from the group`,
    )

    // 普通成员仍然什么都管不了
    await openPanel(cyPage)
    await expect(panel(cyPage).getByTestId('group-name').getByRole('button')).toHaveCount(0)
    await openMember(cyPage, bea)
    await expect(dialog(cyPage).getByRole('button', { name: 'Remove from group' })).toHaveCount(0)
    await cyPage.keyboard.press('Escape')

    // 群主取消管理员：她的管理入口跟着消失
    await openMember(page, bea)
    await dialog(page).getByRole('button', { name: 'Remove as admin' }).click()
    await expect(events(beaPage).last()).toHaveText(`${account.nickname} removed you as admin`)
    await expect(panel(beaPage).getByTestId('group-name').getByRole('button')).toHaveCount(0)
    await expect(memberRow(page, bea).getByTestId('admin-tag')).toHaveCount(0)

    for (const context of contexts) await context.close()
  })
})

test.describe('muting', () => {
  test('a muted member sees why and for how long, and speaks again once unmuted', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, cy, group, beaPage, cyPage, contexts } = await quartet(browser, account, 'Quiet')
    await page.goto(`/chats/${group}`)
    await openPanel(page)
    await openMember(page, cy)
    await dialog(page).getByRole('button', { name: 'Mute in group' }).click()
    await dialog(page).getByRole('button', { name: '10 minutes' }).click()
    await expect(page.getByTestId('toast')).toHaveText('Muted in the group')

    // 所有人看到一行提示；名单上标着
    await expect(events(beaPage).last()).toHaveText(
      `${account.nickname} muted ${cy.nickname} for 10 minutes`,
    )
    await expect(events(cyPage).last()).toHaveText(`${account.nickname} muted you for 10 minutes`)
    await expect(memberRow(page, cy).getByTestId('muted-tag')).toHaveText('Muted')
    // 被禁言的人不刷新就看到输入区换成说明
    await expect(cyPage.getByTestId('composer-closed')).toHaveText(
      "You're muted in this group for 10 minutes",
    )
    await expect(cyPage.getByRole('textbox', { name: 'Message' })).toHaveCount(0)

    // 管理员不能被禁言：群主看不到这个按钮
    await openMember(page, bea)
    await dialog(page).getByRole('button', { name: 'Make admin' }).click()
    await openMember(page, bea)
    await expect(dialog(page).getByRole('button', { name: 'Mute in group' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // 解除
    await openMember(page, cy)
    await dialog(page).getByRole('button', { name: 'Unmute' }).click()
    await expect(events(cyPage).last()).toHaveText(`${account.nickname} unmuted you`)
    await expect(cyPage.getByRole('textbox', { name: 'Message' })).toBeVisible()

    for (const context of contexts) await context.close()
  })

  test('muting everyone leaves only the owner and admins able to speak', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, group, beaPage, cyPage, contexts } = await quartet(browser, account, 'Hush')
    await page.goto(`/chats/${group}`)
    await openPanel(page)
    await openMember(page, bea)
    await dialog(page).getByRole('button', { name: 'Make admin' }).click()
    await expect(events(page).last()).toHaveText(`You made ${bea.nickname} an admin`)

    // 管理员打开全员禁言
    await openPanel(beaPage)
    await panel(beaPage).getByRole('switch', { name: 'Mute everyone' }).click()
    await expect(events(page).last()).toHaveText(`${bea.nickname} muted everyone`)
    await expect(cyPage.getByTestId('composer-closed')).toHaveText(
      'Everyone is muted. Only the owner and admins can send messages',
    )
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()
    await expect(beaPage.getByRole('textbox', { name: 'Message' })).toBeVisible()
    // 普通成员看不到这个开关
    await openPanel(cyPage)
    await expect(panel(cyPage).getByRole('switch', { name: 'Mute everyone' })).toHaveCount(0)

    // 群主关掉
    await panel(page).getByRole('switch', { name: 'Mute everyone' }).click()
    await expect(events(cyPage).last()).toHaveText(`${account.nickname} unmuted everyone`)
    await expect(cyPage.getByRole('textbox', { name: 'Message' })).toBeVisible()

    for (const context of contexts) await context.close()
  })
})

test.describe('group nicknames', () => {
  test('a group nickname shows up for everyone at once, except where they set a remark', async ({
    page,
    account,
    browser,
  }) => {
    const { cy, group, beaPage, cyPage, contexts } = await quartet(browser, account, 'Names')
    // 群主给 Cy 起了备注：他那里仍然看到备注
    const api = await newApi(account.storageState)
    const remarked = await api.patch(`/api/friends/${cy.id}`, { data: { remark: 'Cousin Cy' } })
    expect(remarked.ok(), 'set remark').toBe(true)
    await api.dispose()
    await page.goto(`/chats/${group}`)
    await openPanel(page)

    // Cy 设了群内昵称
    await openPanel(cyPage)
    await panel(cyPage).getByTestId('group-nickname').click()
    const input = panel(cyPage).getByTestId('group-nickname-input')
    await input.fill('Captain')
    await input.press('Enter')
    await expect(cyPage.getByTestId('toast')).toHaveText('Group nickname updated')
    await expect(panel(cyPage).getByTestId('group-nickname')).toHaveText('Captain')

    // 别人不刷新就看到新名字；群主那里是他起的备注；群里没有多出一行提示
    await openPanel(beaPage)
    await expect(memberRow(beaPage, cy)).toHaveCount(0)
    await expect(panel(beaPage).getByTestId('member-name')).toContainText(['Captain'])
    await expect(panel(page).getByTestId('member-name')).toContainText(['Cousin Cy'])
    await expect(events(beaPage)).toHaveCount(1)
    await say(cy, group, 'hello from the captain')
    await expect(beaPage.getByTestId('message-sender').last()).toHaveText('Captain')

    // @ 他时写进去的是群内昵称
    const composer = beaPage.getByRole('textbox', { name: 'Message' })
    await composer.fill('@Capt')
    await beaPage.getByTestId('mention-option').filter({ hasText: 'Captain' }).click()
    await expect(composer).toHaveValue('@Captain ')

    // 留空就是去掉
    await panel(cyPage).getByTestId('group-nickname').click()
    await panel(cyPage).getByTestId('group-nickname-input').fill('')
    await panel(cyPage).getByTestId('group-nickname-input').press('Enter')
    await expect(panel(beaPage).getByTestId('member-name')).toContainText([cy.nickname])

    for (const context of contexts) await context.close()
  })
})

test.describe('join approval', () => {
  test('with approval on, an ordinary member asks and the owner approves or declines', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, group, beaPage, contexts } = await quartet(browser, account, 'Gated')
    const eve = await another('Eve')
    const fay = await another('Fay')
    await befriend(bea, eve)
    await befriend(bea, fay)
    await page.goto(`/chats/${group}`)

    // 群主打开入群审批
    await openPanel(page)
    await panel(page).getByRole('switch', { name: 'Approve new members' }).click()
    await expect(panel(page).getByRole('switch', { name: 'Approve new members' })).toBeChecked()

    // Bea 邀请两个人：提示要等同意；她们没有进来
    await beaPage.reload()
    await openPanel(beaPage)
    await panel(beaPage).getByRole('button', { name: 'Invite friends' }).click()
    await expect(dialog(beaPage).getByTestId('invite-approval')).toBeVisible()
    await dialog(beaPage).getByTestId('pick-friend').filter({ hasText: eve.nickname }).click()
    await dialog(beaPage).getByTestId('pick-friend').filter({ hasText: fay.nickname }).click()
    await dialog(beaPage).getByRole('button', { name: 'Invite' }).click()
    await expect(beaPage.getByTestId('toast')).toHaveText(
      'Request sent. The owner or an admin needs to approve it',
    )
    await expect(panel(beaPage).getByTestId('member')).toHaveCount(4)

    // 群主不刷新就看到红点和待处理的数目
    await expect(page.getByTestId('requests-dot')).toBeVisible()
    await expect(panel(page).getByTestId('pending-requests')).toHaveText('2 pending')
    await panel(page).getByTestId('open-join-requests').click()
    const requests = dialog(page).getByTestId('join-request')
    await expect(requests).toHaveCount(2)
    await requests
      .filter({ hasText: eve.nickname })
      .getByRole('button', { name: 'Approve' })
      .click()
    await expect(events(page).last()).toHaveText(
      `${bea.nickname} invited ${eve.nickname} to the group, approved by you`,
    )
    await expect(events(beaPage).last()).toHaveText(
      `You invited ${eve.nickname} to the group, approved by ${account.nickname}`,
    )
    await requests
      .filter({ hasText: fay.nickname })
      .getByRole('button', { name: 'Decline' })
      .click()
    await expect(requests.filter({ hasText: fay.nickname })).toHaveAttribute(
      'data-status',
      'rejected',
    )
    await expect(page.getByTestId('requests-dot')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(panel(page).getByTestId('member')).toHaveCount(5)

    // 邀请人看得到自己发出的申请和结果
    await panel(beaPage).getByTestId('open-join-requests').click()
    const mine = dialog(beaPage).getByTestId('join-request')
    await expect(mine.filter({ hasText: eve.nickname })).toContainText(
      `Approved by ${account.nickname}`,
    )
    await expect(mine.filter({ hasText: fay.nickname })).toContainText(
      `Declined by ${account.nickname}`,
    )
    await expect(dialog(beaPage).getByRole('button', { name: 'Approve' })).toHaveCount(0)

    for (const context of contexts) await context.close()
  })
})
