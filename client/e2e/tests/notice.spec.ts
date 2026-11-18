// 群公告：群主发布、修改、清空；成员收到提醒，打开群时顶部有公告条。

import type { Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  expect,
  logInElsewhere,
  makeGroup,
  newApi,
  notices,
  openAs,
  setForeground,
  takeOverNotifications,
  test,
} from './support'

// 几个人、几个窗口，机器很忙时会超过 30 秒
test.describe.configure({ timeout: 60_000 })

const panel = (page: Page) => page.getByTestId('group-panel')
const banner = (page: Page) => page.getByTestId('notice-banner')
const events = (page: Page) => page.getByTestId('message-event')
const row = (page: Page, name: string) => page.getByTestId('conversation').filter({ hasText: name })
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Group notice' })

/** 群主在群信息里发布一则公告。 */
async function publish(page: Page, text: string) {
  await page.getByRole('button', { name: 'Group info', exact: true }).click()
  await panel(page).getByTestId('group-notice').click()
  const editor = dialog(page)
  if (await editor.getByRole('button', { name: 'Edit' }).isVisible()) {
    await editor.getByRole('button', { name: 'Edit' }).click()
  }
  await editor.getByTestId('notice-input').fill(text)
  await editor.getByRole('button', { name: 'Post' }).click()
  await expect(page.getByTestId('toast')).toHaveText('Group notice posted')
  await page.getByRole('button', { name: 'Group info', exact: true }).click()
}

async function setNotice(owner: Account, group: string, text: string) {
  const api = await newApi(owner.storageState)
  const reply = await api.put(`/api/conversations/${group}/notice`, { data: { text } })
  expect(reply.status(), 'set notice').toBe(200)
  await api.dispose()
}

test.describe('group notice', () => {
  test('the owner posts it, and every member is reminded and sees it at the top', async ({
    page,
    account,
    browser,
  }) => {
    // 三个人、三个窗口
    test.slow()
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Weekly')
    const b = await openAs(browser, bea, '/chats')
    // Cy 把群设成了免打扰，页面在后台：公告照样弹通知
    const c = await browser.newContext({ storageState: cy.storageState })
    const cyPage = await c.newPage()
    await takeOverNotifications(cyPage, { permission: 'granted', choice: 'on' })
    const api = await newApi(cy.storageState)
    await api.put(`/api/conversations/${group}/mute`, { data: { muted: true } })
    await api.dispose()
    await cyPage.goto('/chats')
    await expect(row(cyPage, 'Weekly').getByTestId('muted')).toBeVisible()
    await setForeground(cyPage, false)

    await page.goto(`/chats/${group}`)
    await expect(events(page)).toHaveCount(1)
    await publish(page, 'Meeting on Friday at 3pm.\nBring your laptop.')

    // 群主自己：消息流里一张卡片，带着公告的内容；没有公告条
    const mine = page.getByTestId('notice-card').last()
    await expect(mine).toContainText('You posted a group notice')
    await expect(mine.getByTestId('notice-card-text')).toHaveText(
      'Meeting on Friday at 3pm.\nBring your laptop.',
    )
    await expect(banner(page)).toHaveCount(0)

    // Bea：会话列表里是"有人 @ 我"，摘要是公告的开头
    const beaRow = row(b.page, 'Weekly')
    await expect(beaRow.getByTestId('mention-flag')).toBeVisible()
    await expect(beaRow.getByTestId('conversation-summary')).toContainText(
      '[Notice] Meeting on Friday at 3pm. Bring your laptop.',
    )
    // 打开群：顶部有公告条；点开看全文、发布人
    await beaRow.click()
    await expect(banner(b.page)).toContainText('Meeting on Friday at 3pm.')
    await expect(b.page.getByTestId('notice-card').last()).toContainText(
      `${account.nickname} posted a group notice`,
    )
    await expect(b.page.getByTestId('notice-card-text').last()).toContainText('Bring your laptop.')
    await banner(b.page)
      .getByRole('button', { name: /Meeting on Friday/ })
      .click()
    await expect(dialog(b.page).getByTestId('notice-text')).toHaveText(
      'Meeting on Friday at 3pm.\nBring your laptop.',
    )
    await expect(dialog(b.page)).toContainText(`Posted by ${account.nickname}`)
    // 不是群主：没有编辑
    await expect(dialog(b.page).getByRole('button', { name: 'Edit' })).toHaveCount(0)
    await b.page.keyboard.press('Escape')
    // 看过了：公告条不再出现
    await expect(banner(b.page)).toHaveCount(0)

    // Cy：免打扰的群也弹了通知
    await expect.poll(() => notices(cyPage)).toHaveLength(1)
    const [shown] = await notices(cyPage)
    expect(shown).toMatchObject({ title: 'Weekly' })
    expect(shown?.body).toContain('Meeting on Friday at 3pm.')
    await b.context.close()
    await c.close()
  })

  test('closing the banner in one window closes it everywhere; newcomers see the notice', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Rules')
    await setNotice(account, group, 'Be kind.')
    const first = await openAs(browser, bea, `/chats/${group}`)
    const second = await logInElsewhere(browser, bea)
    await second.page.goto(`/chats/${group}`)
    await expect(banner(first.page)).toContainText('Be kind.')
    await expect(banner(second.page)).toContainText('Be kind.')

    await banner(first.page).getByRole('button', { name: 'Dismiss notice' }).click()
    await expect(banner(first.page)).toHaveCount(0)
    await expect(banner(second.page)).toHaveCount(0)
    // 刷新也不再出现
    await first.page.reload()
    await expect(first.page.getByTestId('notice-card').last()).toBeVisible()
    await expect(banner(first.page)).toHaveCount(0)

    // 改了之后又出现
    await setNotice(account, group, 'Be kind. No spam.')
    await expect(banner(first.page)).toContainText('No spam.')

    // 后来入群的人：看得到当前的公告
    const dan = await another('Dan')
    await befriend(account, dan)
    const api = await newApi(account.storageState)
    await api.post(`/api/conversations/${group}/members`, { data: { user_ids: [dan.id] } })
    await api.dispose()
    const d = await openAs(browser, dan, `/chats/${group}`)
    await expect(banner(d.page)).toContainText('Be kind. No spam.')
    await page.goto('/chats')
    await first.context.close()
    await second.context.close()
    await d.context.close()
  })

  test('the owner can edit and remove it; removing does not remind anyone', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Club')
    await setNotice(account, group, 'Old rules')
    const b = await openAs(browser, bea, `/chats/${group}`)
    await banner(b.page).getByRole('button', { name: 'Dismiss notice' }).click()
    await b.page.goto('/chats')
    await row(b.page, 'Club').click()
    await b.page.goto('/chats')
    await expect(row(b.page, 'Club').getByTestId('mention-flag')).toHaveCount(0)

    await page.goto(`/chats/${group}`)
    await page.getByRole('button', { name: 'Group info', exact: true }).click()
    await expect(panel(page).getByTestId('group-notice-text')).toHaveText('Old rules')
    await panel(page).getByTestId('group-notice').click()
    await dialog(page).getByRole('button', { name: 'Edit' }).click()
    await expect(dialog(page).getByTestId('notice-input')).toHaveValue('Old rules')
    await dialog(page).getByRole('button', { name: 'Remove notice' }).click()
    await expect(dialog(page)).toContainText('Members are not alerted.')
    await dialog(page).getByRole('button', { name: 'Remove notice' }).click()
    await expect(page.getByTestId('toast')).toHaveText('Group notice removed')
    await expect(events(page).last()).toHaveText('You removed the group notice')
    // 群主还能再发布；面板里写着"发布群公告"
    await expect(panel(page).getByTestId('group-notice-text')).toHaveText('Post a group notice')

    // Bea：多了一行提示，但没有被提醒，也没有公告条
    await expect(row(b.page, 'Club').getByTestId('conversation-summary')).toHaveText(
      `${account.nickname} removed the group notice`,
    )
    await expect(row(b.page, 'Club').getByTestId('mention-flag')).toHaveCount(0)
    await row(b.page, 'Club').click()
    await expect(banner(b.page)).toHaveCount(0)
    // 不是群主、又没有公告：群信息里没有这一栏
    await b.page.getByRole('button', { name: 'Group info', exact: true }).click()
    await expect(panel(b.page).getByTestId('group-notice')).toHaveCount(0)
    await b.context.close()
  })
})

test('a long notice in the conversation shows its first lines and can be expanded', async ({
  page,
  account,
}) => {
  const bea = await another('Bea')
  const cy = await another('Cy')
  const group = await makeGroup(account, [bea, cy], 'Long')
  const lines = Array.from({ length: 12 }, (_, index) => `Rule ${index + 1}`)
  await setNotice(account, group, lines.join('\n'))
  await page.goto(`/chats/${group}`)
  const card = page.getByTestId('notice-card')
  const text = card.getByTestId('notice-card-text')
  await expect(text).toContainText('Rule 1')
  const folded = await text.evaluate((element) => element.clientHeight)
  await card.getByRole('button', { name: 'Show all' }).click()
  await expect(card.getByRole('button', { name: 'Show less' })).toBeVisible()
  expect(await text.evaluate((element) => element.clientHeight)).toBeGreaterThan(folded)
  await expect(text).toBeInViewport()
})
