// 转发：单条转发、多选之后一起转发、一次发给几个会话。

import type { Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  directWith,
  expect,
  makeGroup,
  newApi,
  openAs,
  pngImage,
  post,
  test,
  uploadAs,
  voiceSample,
} from './support'

const messages = (page: Page) => page.getByTestId('message')
const selectable = (page: Page) => page.getByTestId('selectable')
const bar = (page: Page) => page.getByTestId('selection-bar')
const picker = (page: Page) => page.getByRole('dialog', { name: 'Forward to' })

/** 建一个群，成员都已经是群主的好友。 */
async function groupOf(owner: Account, members: Account[], name: string): Promise<string> {
  const api = await newApi(owner.storageState)
  const created = await api.post('/api/conversations/group', {
    data: { name, member_ids: members.map((member) => member.id) },
  })
  expect(created.ok(), 'create group').toBe(true)
  const group = (await created.json()) as { id: string }
  await api.dispose()
  return group.id
}

/** 打开一条消息的"更多"菜单，选其中一项。 */
async function choose(page: Page, text: string | RegExp, item: string) {
  const message = messages(page).filter({ hasText: text }).first()
  await message.hover()
  await message.getByRole('button', { name: 'Message options' }).click()
  await page.getByTestId('message-menu').getByRole('menuitem', { name: item }).click()
}

/** 在转发对话框里选几个目标，发出去。 */
async function sendTo(page: Page, names: string[], dialog = picker(page)) {
  for (const name of names) {
    await dialog.getByTestId('forward-target').filter({ hasText: name }).click()
  }
  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('toast').last()).toHaveText('Forwarded')
}

/** 某个人在某个会话里看到的消息：文字消息是文字，图片是"[picture] 说明"，文件是"[file] 名字"。 */
async function seen(who: Account, conversation: string): Promise<string[]> {
  const api = await newApi(who.storageState)
  const reply = await api.get(`/api/conversations/${conversation}/messages`)
  const body = (await reply.json()) as {
    items: {
      kind: string
      text: string | null
      sender_id: string | null
      file: { id: string; name: string } | null
    }[]
  }
  await api.dispose()
  return body.items
    .filter((item) => item.sender_id !== null)
    .map((item) =>
      item.kind === 'image'
        ? `[picture] ${item.text ?? ''}`.trim()
        : item.kind === 'file'
          ? `[file] ${item.file?.name}`
          : (item.text ?? ''),
    )
}

test.describe('forwarding', () => {
  test('several messages go to several chats, in their original order', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const dan = await another('Dan')
    const source = await makeGroup(account, [bea, cy], 'Hiking')
    await befriend(account, dan)
    const other = await groupOf(account, [cy, dan], 'Family')
    const withDan = await directWith(account, dan)
    // 群里的三条：一句话、一张带说明的图片、一个文件
    await post(bea, source, { text: 'route for Saturday' })
    const photo = await uploadAs(cy, 'peak.png', 'image/png', pngImage(90, 60, [90, 140, 60]))
    await post(cy, source, { file_id: photo.id, text: 'view from the top' })
    const map = await uploadAs(bea, 'map.pdf', 'application/pdf', Buffer.from('%PDF-1.7 map'))
    await post(bea, source, { file_id: map.id })

    await page.goto(`/chats/${source}`)
    await expect(messages(page)).toHaveCount(3)
    // 从第一条进入多选，再勾上另外两条（先勾后面那条：发出去仍按原来的先后）
    await choose(page, 'route for Saturday', 'Select')
    await expect(bar(page)).toContainText('1 message selected')
    await selectable(page).nth(2).click()
    await selectable(page).nth(1).click()
    await expect(bar(page)).toContainText('3 messages selected')
    // 系统提示没有勾选框
    await expect(selectable(page)).toHaveCount(3)
    await bar(page).getByRole('button', { name: 'Forward one by one' }).click()
    await sendTo(page, [dan.nickname, 'Family'])
    // 回到平时的样子
    await expect(bar(page)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()

    const expected = ['route for Saturday', '[picture] view from the top', '[file] map.pdf']
    await expect.poll(() => seen(dan, withDan)).toEqual(expected)
    await expect.poll(() => seen(cy, other)).toEqual(expected)

    // Dan 打开看：发送人是转发的人，图片能打开，文件能下载
    const d = await openAs(browser, dan, `/chats/${withDan}`)
    await expect(d.page.getByTestId('message-caption')).toHaveText('view from the top')
    await expect(d.page.getByTestId('message-image').locator('img')).toBeVisible()
    const download = d.page.waitForEvent('download')
    await d.page.getByTestId('message-file').click()
    const saved = await download
    expect(saved.suggestedFilename()).toBe('map.pdf')
    await d.context.close()
  })

  test('a forwarded copy stays after the original is recalled', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const source = await makeGroup(account, [bea, cy], 'Work')
    const withCy = await directWith(account, cy)
    const sheet = await uploadAs(account, 'plan.xlsx', '', Buffer.from('numbers'))
    const seq = await post(account, source, { file_id: sheet.id })

    await page.goto(`/chats/${source}`)
    await choose(page, 'plan.xlsx', 'Forward')
    await sendTo(page, [cy.nickname])
    await expect.poll(() => seen(cy, withCy)).toEqual(['[file] plan.xlsx'])

    // 撤回原消息
    const api = await newApi(account.storageState)
    await api.post(`/api/conversations/${source}/messages/${seq}/recall`)
    await api.dispose()
    // Cy 那里的仍然在，文件仍然能下载
    const cyApi = await newApi(cy.storageState)
    const list = await cyApi.get(`/api/conversations/${withCy}/messages`)
    const body = (await list.json()) as { items: { file: { id: string } | null }[] }
    const copy = body.items.find((item) => item.file)?.file?.id
    const file = await cyApi.get(`/api/files/${copy}`)
    expect(file.status()).toBe(200)
    expect((await file.body()).toString()).toBe('numbers')
    await cyApi.dispose()
  })

  test('a voice message forwards with its length and plays', async ({ page, account, browser }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Voices')
    const withCy = await directWith(account, cy)
    const voice = await uploadAs(bea, 'voice.webm', 'audio/webm;codecs=opus', voiceSample())
    await post(bea, group, { file_id: voice.id, voice_duration_ms: 1500 })

    await page.goto(`/chats/${group}`)
    const voiceMessage = messages(page).filter({ has: page.getByTestId('message-voice') })
    await voiceMessage.hover()
    await voiceMessage.getByRole('button', { name: 'Message options' }).click()
    await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Forward' }).click()
    await sendTo(page, [cy.nickname])

    // Cy 那里：一条语音，时长不变，能放
    const c = await openAs(browser, cy, `/chats/${withCy}`)
    await expect(c.page.getByTestId('voice-duration')).toHaveText('0:02')
    await c.page.getByTestId('message-voice').click()
    await expect(c.page.getByTestId('voice-unplayed')).toHaveCount(0)
    await expect(c.page.getByTestId('message-voice')).not.toHaveAttribute('data-state', 'failed')
    await c.context.close()

    // 多选时系统提示没有勾选框，语音可以勾
    await page.goto(`/chats/${group}`)
    await voiceMessage.hover()
    await voiceMessage.getByRole('button', { name: 'Message options' }).click()
    await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Select' }).click()
    await expect(bar(page)).toContainText('1 message selected')
    await expect(selectable(page)).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(bar(page)).toHaveCount(0)
  })

  test('several messages merge into one chat record that opens read-only', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const dan = await another('Dan')
    const source = await makeGroup(account, [bea, cy], 'Hiking')
    await befriend(account, dan)
    const withDan = await directWith(account, dan)
    // 群里的三条：一句话、一张带说明的图片、一段语音
    const route = await post(bea, source, { text: 'route for Saturday' })
    const photo = await uploadAs(cy, 'peak.png', 'image/png', pngImage(90, 60, [90, 140, 60]))
    await post(cy, source, { file_id: photo.id, text: 'view from the top' })
    const voice = await uploadAs(bea, 'voice.webm', 'audio/webm;codecs=opus', voiceSample())
    await post(bea, source, { file_id: voice.id, voice_duration_ms: 1500 })

    await page.goto(`/chats/${source}`)
    await expect(messages(page)).toHaveCount(3)
    await choose(page, 'route for Saturday', 'Select')
    await selectable(page).nth(1).click()
    await selectable(page).nth(2).click()
    await expect(bar(page)).toContainText('3 messages selected')
    await bar(page).getByRole('button', { name: 'Merge and forward' }).click()
    await sendTo(
      page,
      [dan.nickname],
      page.getByRole('dialog', { name: 'Forward as chat history to' }),
    )
    await expect(bar(page)).toHaveCount(0)
    // 之后原消息撤回：聊天记录里的不变
    await expect.poll(async () => (await seen(dan, withDan)).length).toBe(1)
    const api = await newApi(bea.storageState)
    await api.post(`/api/conversations/${source}/messages/${route}/recall`)
    await api.dispose()

    // Dan 那里：一张卡片，标题和前几条的摘要，带着原发送人的名字
    const d = await openAs(browser, dan, `/chats/${withDan}`)
    const card = d.page.getByTestId('chat-record')
    await expect(card.getByTestId('chat-record-title')).toHaveText('Chat history of Hiking')
    await expect(card.getByTestId('chat-record-line')).toHaveText([
      `${bea.nickname}: route for Saturday`,
      `${cy.nickname}: [Photo] view from the top`,
      `${bea.nickname}: [Voice message]`,
    ])
    // 会话列表里的摘要
    await expect(
      d.page
        .getByTestId('conversation')
        .filter({ hasText: account.nickname })
        .getByTestId('conversation-summary'),
    ).toHaveText('[Chat history] Chat history of Hiking')

    // 点开：只读的查看页，每一条带名字；图片能看大图，语音能放
    await card.click()
    const viewer = d.page.getByRole('dialog', { name: 'Chat history of Hiking' })
    await expect(viewer.getByTestId('record-item-name')).toHaveText([
      bea.nickname,
      cy.nickname,
      bea.nickname,
    ])
    await expect(viewer.getByTestId('record-item-text')).toHaveText('route for Saturday')
    await expect(viewer.getByTestId('message-image').locator('img')).toBeVisible()
    await viewer.getByTestId('message-voice').click()
    await expect(viewer.getByTestId('message-voice')).not.toHaveAttribute('data-state', 'failed')
    await expect(viewer.getByRole('button', { name: 'Message options' })).toHaveCount(0)
    await viewer.getByRole('button', { name: 'Close' }).click()
    await expect(viewer).toHaveCount(0)

    // 里面的内容搜得到：显示标题和对上的那一条
    await d.page.getByTestId('open-search').click()
    const panel = d.page.getByTestId('search-panel')
    await panel.getByRole('searchbox').fill('saturday')
    await expect(panel.getByTestId('hit-text')).toHaveText([
      `${account.nickname}: Chat history of Hiking · route for Saturday`,
    ])
    await d.context.close()
  })

  test('a chat record can be forwarded again and nests as one line', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const withBea = await befriend(account, bea)
    const withCy = await befriend(account, cy)
    const first = await post(bea, withBea, { text: 'see you at noon' })
    const second = await post(account, withBea, { text: 'deal' })
    const record = await post(account, withBea, {
      merge: { conversation_id: withBea, seqs: [first, second], title: 'Lunch plans' },
    })
    await post(account, withBea, { text: 'forwarding this' })

    await page.goto(`/chats/${withBea}`)
    const card = page.getByTestId('chat-record')
    await expect(card.getByTestId('chat-record-line')).toHaveText([
      `${bea.nickname}: see you at noon`,
      `${account.nickname}: deal`,
    ])
    // 逐条转发：整条原样过去
    await choose(page, 'Lunch plans', 'Forward')
    await sendTo(page, [cy.nickname])
    await expect.poll(async () => (await seen(cy, withCy)).length).toBe(1)

    // 和后面一句一起合并转发：里面的聊天记录只剩一行标题
    await choose(page, 'Lunch plans', 'Select')
    await selectable(page).filter({ hasText: 'forwarding this' }).click()
    await bar(page).getByRole('button', { name: 'Merge and forward' }).click()
    await sendTo(
      page,
      [cy.nickname],
      page.getByRole('dialog', { name: 'Forward as chat history to' }),
    )
    // 等它真的发出去了再离开这个页面：离开得太早，它会留在这台设备上成为"没发出去的"
    await expect.poll(async () => (await seen(cy, withCy)).length).toBe(2)
    await page.goto(`/chats/${withCy}`)
    const nested = page.getByTestId('chat-record').last()
    await expect(nested.getByTestId('chat-record-line')).toHaveText([
      `${account.nickname}: [Chat history] Lunch plans`,
      `${account.nickname}: forwarding this`,
    ])
    await nested.click()
    const viewer = page.getByRole('dialog', { name: /^Chat history of / })
    await expect(viewer.getByTestId('record-item')).toHaveCount(2)
    await expect(viewer.getByTestId('record-item').first()).toContainText(
      '[Chat history] Lunch plans',
    )
    // 嵌在里面的不能再点开
    await expect(viewer.getByTestId('chat-record')).toHaveCount(0)
    expect(record).toBeGreaterThan(second)
  })
})
