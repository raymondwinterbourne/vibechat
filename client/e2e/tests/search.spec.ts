// 搜索：全部会话里搜、只在一个会话里搜、跳到搜到的那条消息。

import type { Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  expect,
  makeGroup,
  newApi,
  post,
  say,
  test,
  uploadAs,
} from './support'

const panel = (page: Page) => page.getByTestId('search-panel')
const input = (page: Page) => panel(page).getByRole('searchbox')
const items = (page: Page) => panel(page).getByTestId('search-item')
const hits = (page: Page) => panel(page).getByTestId('hit-text')
const message = (page: Page, seq: number) =>
  page.locator(`[data-testid="message"][data-seq="${seq}"]`)
const title = (page: Page) => page.getByTestId('conversation-title')

async function recall(from: Account, conversation: string, seq: number) {
  const api = await newApi(from.storageState)
  const reply = await api.post(`/api/conversations/${conversation}/messages/${seq}/recall`)
  expect(reply.status(), 'recall').toBe(200)
  await api.dispose()
}

test.describe('searching everything', () => {
  test('finds messages and file names across conversations and jumps to one', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Finance')
    // 建群时已经和 Bea 成为好友：取他们的单聊
    const withBea = await (async () => {
      const api = await newApi(account.storageState)
      const reply = await api.post('/api/conversations/direct', { data: { user_id: bea.id } })
      const body = (await reply.json()) as { id: string }
      await api.dispose()
      return body.id
    })()
    const first = await post(account, group, { text: 'the budget, first draft' })
    await say(cy, group, ...Array.from({ length: 90 }, (_, index) => `chatter ${index + 1}`))
    const sheet = await uploadAs(bea, 'budget-2026.xlsx', '', Buffer.from('numbers'))
    await post(bea, withBea, { file_id: sheet.id })
    const wrong = await post(account, group, { text: 'budget is cancelled' })
    await post(bea, group, { text: 'BUDGET approved' })
    await recall(account, group, wrong)

    await page.goto('/chats')
    await page.getByTestId('open-search').click()
    await expect(input(page)).toBeFocused()
    await expect(panel(page)).toContainText('Type to search')
    await input(page).fill('budget')

    // 按会话归类，从新到旧；不区分大小写；文件名也搜得到；撤回了的不在里面
    await expect(hits(page)).toHaveText([
      `${bea.nickname}: BUDGET approved`,
      'You: the budget, first draft',
      `${bea.nickname}: budget-2026.xlsx`,
    ])
    await expect(panel(page).getByTestId('hit-conversation')).toHaveText([
      'Finance',
      'Finance',
      bea.nickname,
    ])
    await expect(hits(page).first().locator('mark')).toHaveText('BUDGET')

    // 点很早的那一条：进入会话，跳到它并标出来
    await hits(page).nth(1).click()
    await expect(panel(page)).toHaveCount(0)
    await expect(title(page)).toHaveText('Finance')
    await expect(message(page, first)).toBeInViewport()
    await expect(message(page, first)).toHaveAttribute('data-highlighted', 'true')
    await expect(message(page, first)).toContainText('the budget, first draft')
    // 它在九十多条之前：看的是历史里的一段，可以回到最新
    await page.getByTestId('back-to-latest').click()
    await expect(page.getByTestId('message-text').last()).toHaveText('BUDGET approved')

    // 没有结果时说一声
    await page.getByTestId('open-search').click()
    await input(page).fill('no such thing anywhere')
    await expect(panel(page)).toContainText('Nothing found')
    await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
  })

  test('the shortcut opens it, names match friends and groups, and the keyboard picks one', async ({
    page,
    account,
  }) => {
    const bea = await another('Zelda')
    const cy = await another('Cy')
    await makeGroup(account, [bea, cy], 'Zelda fan club')
    await page.goto('/contacts')
    await expect(page.getByTestId('friend')).toHaveCount(2)

    // 在任何页面都能用快捷键打开
    await page.keyboard.press('ControlOrMeta+k')
    await expect(input(page)).toBeFocused()
    await input(page).fill('zelda')

    await expect(items(page)).toHaveCount(2)
    await expect(panel(page).getByRole('region', { name: 'Friends' })).toContainText(bea.nickname)
    await expect(panel(page).getByRole('region', { name: 'Groups' })).toContainText(
      'Zelda fan club',
    )
    // 第一项已经选中；向下一项，回车进入那个群
    await expect(items(page).first()).toHaveAttribute('data-active', 'true')
    await input(page).press('ArrowDown')
    await expect(items(page).nth(1)).toHaveAttribute('data-active', 'true')
    await input(page).press('Enter')
    await expect(title(page)).toHaveText('Zelda fan club')

    // 选好友：打开和他的会话
    await page.keyboard.press('ControlOrMeta+k')
    await input(page).fill('zelda')
    await items(page).first().click()
    await expect(title(page)).toHaveText(bea.nickname)
  })

  test('someone who joined later cannot find what was said before', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(bea, [cy, await another('Dee')])
    await post(bea, group, { text: 'the secret is 1234' })
    // 之后才被拉进来
    await befriend(bea, account)
    const api = await newApi(bea.storageState)
    const invited = await api.post(`/api/conversations/${group}/members`, {
      data: { user_ids: [account.id] },
    })
    expect(invited.status()).toBe(200)
    await api.dispose()
    await post(bea, group, { text: 'the secret has changed' })

    await page.goto('/chats')
    await page.getByTestId('open-search').click()
    await input(page).fill('secret')
    await expect(hits(page)).toHaveText([`${bea.nickname}: the secret has changed`])
  })
})

test.describe('searching one conversation', () => {
  test('lists the matches newest first, loads more, and jumps to the one picked', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const lines = Array.from({ length: 25 }, (_, index) => `progress report ${index + 1}`)
    const firstSeq = await post(bea, conversation, { text: lines[0] })
    await say(bea, conversation, ...lines.slice(1))
    await say(account, conversation, ...Array.from({ length: 60 }, (_, i) => `other ${i + 1}`))

    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-text').last()).toHaveText('other 60')
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Find in conversation' }).click()
    const search = page.getByTestId('conversation-search')
    await expect(search.getByRole('searchbox')).toBeFocused()
    await search.getByRole('searchbox').fill('PROGRESS')

    const found = search.getByTestId('search-hit')
    await expect(found).toHaveCount(20)
    await expect(found.first()).toContainText('progress report 25')
    await expect(found.first()).toContainText(bea.nickname)
    await search.getByRole('button', { name: 'Load more' }).click()
    await expect(found).toHaveCount(25)
    await expect(search.getByRole('button', { name: 'Load more' })).toHaveCount(0)

    // 点最早的那一条：会话跳过去，面板还开着（电脑上）
    await found.last().click()
    await expect(message(page, firstSeq)).toBeInViewport()
    await expect(message(page, firstSeq)).toHaveAttribute('data-highlighted', 'true')
    await expect(search).toBeVisible()
    // 再点另一条也跳得过去
    await found.nth(10).click()
    await expect(page.locator('[data-highlighted="true"]')).toContainText('progress report 15')

    await search.getByRole('button', { name: 'Close find' }).last().click()
    await expect(search).toHaveCount(0)
  })

  test('more than three matches in a conversation lead into searching just that one', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(bea, conversation, ...Array.from({ length: 5 }, (_, i) => `standup note ${i + 1}`))

    await page.goto('/chats')
    await page.getByTestId('open-search').click()
    await input(page).fill('standup')
    // 先只列最新的三条
    await expect(hits(page)).toHaveCount(3)
    await panel(page).getByText('See all in this conversation').click()

    await expect(title(page)).toHaveText(bea.nickname)
    const search = page.getByTestId('conversation-search')
    await expect(search.getByRole('searchbox')).toHaveValue('standup')
    await expect(search.getByTestId('search-hit')).toHaveCount(5)
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 700 } })

  test('search fills the screen and picking a result shows the conversation', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const seq = await post(bea, conversation, { text: 'where is the meeting room?' })
    await say(bea, conversation, ...Array.from({ length: 70 }, (_, i) => `noise ${i + 1}`))

    await page.goto('/chats')
    await page.getByTestId('open-search').click()
    const box = await panel(page).boundingBox()
    expect([box?.x, box?.y, box?.width, box?.height]).toEqual([0, 0, 375, 700])
    await input(page).fill('meeting')
    await hits(page).first().click()
    await expect(message(page, seq)).toBeInViewport()

    // 会话里的查找盖住整个会话；选了一条之后自己收起来
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Find in conversation' }).click()
    const search = page.getByTestId('conversation-search')
    await search.getByRole('searchbox').fill('noise 7')
    await expect(search.getByTestId('search-hit').first()).toBeVisible()
    await search.getByTestId('search-hit').last().click()
    await expect(search).toHaveCount(0)
    await expect(page.locator('[data-highlighted="true"]')).toContainText('noise 7')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })
})
