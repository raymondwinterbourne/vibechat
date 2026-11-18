// 单聊：发消息、实时收到、未读和已读、离线和断线之后补齐、失败重发、翻历史。

import type { Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  controlConnection,
  expect,
  logIn,
  logInElsewhere,
  newApi,
  openAs,
  say,
  test,
} from './support'

const messages = (page: Page) => page.getByTestId('message-text')
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const railBadge = (page: Page) =>
  page.getByTestId('nav-rail').getByRole('link', { name: 'Chats' }).getByTestId('badge')
/** 会话列表里和某个人的那一行。 */
const row = (page: Page, who: Account) =>
  page.getByTestId('conversation').filter({ hasText: who.nickname })

async function send(page: Page, text: string) {
  await composer(page).fill(text)
  await composer(page).press('Enter')
}

/** 对方收到的全部文本消息，按顺序。直接问服务端，不经过页面。 */
async function received(account: Account, conversationId: string): Promise<string[]> {
  const api = await newApi(account.storageState)
  const reply = await api.get(`/api/conversations/${conversationId}/messages?limit=100`)
  const body = (await reply.json()) as { items: { kind: string; text: string | null }[] }
  await api.dispose()
  return body.items.filter((item) => item.kind === 'text').map((item) => item.text ?? '')
}

test.describe('sending and receiving', () => {
  test('a message arrives at once, counts as unread, and shows as read once opened', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    await befriend(account, bea)
    const { context, page: beaPage } = await openAs(browser, bea, '/chats')
    // 成为好友时，会话已经出现在聊天列表里
    await expect(row(beaPage, account).getByTestId('conversation-summary')).toHaveText(
      'You are now friends. Say hello!',
    )
    await expect(railBadge(beaPage)).toHaveCount(0)

    // 从通讯录里点"发消息"进入会话
    await page.goto('/contacts')
    await page.getByTestId('friend-label').click()
    await page.getByRole('button', { name: 'Message' }).click()
    await expect(page.getByTestId('conversation-title')).toHaveText(bea.nickname)
    await expect(page.getByTestId('message-event')).toHaveText('You are now friends. Say hello!')

    await send(page, 'Hello Bea')
    const mine = page.getByTestId('message').filter({ hasText: 'Hello Bea' })
    await expect(mine).toHaveAttribute('data-mine', 'true')
    await expect(mine.getByTestId('message-status')).toHaveText('Sent')
    await expect(composer(page)).toHaveValue('')

    // 对方没有刷新，一秒之内看到：摘要换成了这条消息，未读数加一
    const beaRow = row(beaPage, account)
    await expect(beaRow.getByTestId('conversation-summary')).toHaveText('Hello Bea', {
      timeout: 1000,
    })
    await expect(beaRow.getByTestId('badge')).toHaveText('1')
    await expect(railBadge(beaPage)).toHaveText('1')

    // 对方打开会话：未读数清零，发送方看到"已读"
    await beaRow.click()
    await expect(messages(beaPage)).toHaveText(['Hello Bea'])
    await expect(beaPage.getByTestId('message').last()).toHaveAttribute('data-mine', 'false')
    await expect(beaPage.getByTestId('badge')).toHaveCount(0)
    await expect(mine.getByTestId('message-status')).toHaveText('Read')

    // 对方回一条：发送方正看着这个会话，直接算已读，不出现未读数
    await send(beaPage, 'Hi there')
    await expect(messages(page)).toHaveText(['Hello Bea', 'Hi there'])
    await expect(page.getByTestId('badge')).toHaveCount(0)
    await expect(
      beaPage.getByTestId('message').filter({ hasText: 'Hi there' }).getByTestId('message-status'),
    ).toHaveText('Read')
    await context.close()
  })

  test('Enter sends, Shift+Enter breaks the line, and picking a word does not send', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto(`/chats/${conversation}`)

    const input = composer(page)
    await input.fill('first line')
    await input.press('Shift+Enter')
    await input.pressSequentially('second line')
    // 用输入法打字时按回车是在选字：不发送
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await expect(input).toHaveValue('first line\nsecond line')
    await expect(messages(page)).toHaveCount(0)

    await input.press('Enter')
    await expect(messages(page)).toHaveText(['first line\nsecond line'])
    expect(await received(bea, conversation)).toEqual(['first line\nsecond line'])

    // 只有空白的内容发不出去
    await input.fill('   ')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()
    await expect(messages(page)).toHaveCount(1)
  })

  test('an emoji is inserted where the cursor is', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto(`/chats/${conversation}`)

    const input = composer(page)
    await input.fill('ab')
    await input.press('ArrowLeft')
    await page.getByRole('button', { name: 'Emoji' }).click()
    await page.getByTestId('emoji-panel').getByRole('button', { name: '😀' }).click()
    await expect(input).toHaveValue('a😀b')

    // 点面板外面关闭
    await page.getByTestId('conversation-title').click()
    await expect(page.getByTestId('emoji-panel')).toHaveCount(0)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(messages(page)).toHaveText(['a😀b'])

    // 和好友可以语音通话、视频通话
    await expect(page.getByRole('button', { name: 'Voice call' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Video call' })).toBeEnabled()
  })
})

test.describe('away and back', () => {
  test('messages sent while logged out are all there after logging in again, in order', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    // 对方先登录、再退出
    const { context, page: beaPage } = await logInElsewhere(browser, bea)
    await beaPage.goto('/settings')
    await beaPage.getByRole('button', { name: 'Log out' }).click()
    await expect(beaPage).toHaveURL(/\/login/)

    await page.goto(`/chats/${conversation}`)
    const sent = ['one', 'two', 'three', 'four', 'five']
    for (const text of sent) await send(page, text)
    await expect(messages(page)).toHaveText(sent)

    await logIn(beaPage, bea.handle, bea.password)
    await expect(beaPage).toHaveURL(/\/chats$/)
    const beaRow = row(beaPage, account)
    await expect(beaRow.getByTestId('badge')).toHaveText('5')
    await expect(beaRow.getByTestId('conversation-summary')).toHaveText('five')
    await beaRow.click()
    await expect(messages(beaPage)).toHaveText(sent)
    await context.close()
  })

  test('messages sent while the connection was down appear after reconnecting', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const cal = await another('Cal')
    const withBea = await befriend(account, bea)
    const withCal = await befriend(account, cal)
    const connection = await controlConnection(page)

    await page.goto(`/chats/${withBea}`)
    await say(bea, withBea, 'before')
    await expect(messages(page)).toHaveText(['before'])

    // 连接断了。从页面的角度看，这和服务端重启是同一件事
    await connection.cut()
    await expect(page.getByText('Reconnecting…')).toBeVisible()
    await say(bea, withBea, 'while down 1', 'while down 2')
    await say(cal, withCal, 'from cal')
    await expect(messages(page)).toHaveText(['before'])

    // 重新连上：打开着的会话补上了缺的消息，另一个会话的未读数也更新了，都没有刷新
    connection.restore()
    await expect(messages(page)).toHaveText(['before', 'while down 1', 'while down 2'])
    await expect(row(page, cal).getByTestId('badge')).toHaveText('1')
    await expect(row(page, cal).getByTestId('conversation-summary')).toHaveText('from cal')
    await expect(page.getByText('Reconnecting…')).toHaveCount(0)
    // 正看着的会话里补上的消息算已读
    await expect(row(page, bea).getByTestId('badge')).toHaveCount(0)
  })
})

test.describe('when sending fails', () => {
  test('a message that never left can be resent', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toBeVisible()

    // 网络断了：请求到不了服务端
    await page.route('**/api/conversations/*/messages', (route) =>
      route.request().method() === 'POST' ? route.abort() : route.continue(),
    )
    await send(page, 'lost on the way')
    const mine = page.getByTestId('message').filter({ hasText: 'lost on the way' })
    await expect(mine.getByTestId('message-status')).toContainText('Not sent')
    expect(await received(bea, conversation)).toEqual([])

    // 网络恢复，点重发
    await page.unroute('**/api/conversations/*/messages')
    await mine.getByRole('button', { name: 'Retry' }).click()
    await expect(mine.getByTestId('message-status')).toHaveText('Sent')
    expect(await received(bea, conversation)).toEqual(['lost on the way'])
  })

  test('resending a message that did arrive does not deliver it twice', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const connection = await controlConnection(page)
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toBeVisible()

    // 网络在最糟的时刻断掉：消息到了服务端，但应答和推送都没能回来
    await connection.cut()
    await page.route('**/api/conversations/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await route.fetch()
      await route.abort()
    })
    await send(page, 'did it arrive?')
    const mine = page.getByTestId('message').filter({ hasText: 'did it arrive?' })
    await expect(mine.getByTestId('message-status')).toContainText('Not sent')
    expect(await received(bea, conversation)).toEqual(['did it arrive?'])

    // 用户不知道它其实已经送达，点了重发：对方仍然只有一条
    await page.unroute('**/api/conversations/*/messages')
    await mine.getByRole('button', { name: 'Retry' }).click()
    await expect(mine.getByTestId('message-status')).toHaveText('Sent')
    expect(await received(bea, conversation)).toEqual(['did it arrive?'])
    await expect(messages(page)).toHaveText(['did it arrive?'])

    connection.restore()
    await expect(page.getByText('Reconnecting…')).toHaveCount(0)
    await expect(messages(page)).toHaveText(['did it arrive?'])
  })
})

test.describe('two logins of one account', () => {
  test('stay in step: messages, unread counts and read state', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const { context, page: elsewhere } = await logInElsewhere(browser, account)
    await page.goto('/contacts')

    // 对方发来一条：两处的未读数一样
    await say(bea, conversation, 'to both')
    await expect(railBadge(page)).toHaveText('1')
    await expect(row(elsewhere, bea).getByTestId('badge')).toHaveText('1')

    // 在一处看过，另一处的未读数也清零
    await row(elsewhere, bea).click()
    await expect(messages(elsewhere)).toHaveText(['to both'])
    await expect(railBadge(page)).toHaveCount(0)

    // 在一处发的消息，另一处立即出现
    await page.goto(`/chats/${conversation}`)
    await expect(messages(page)).toHaveText(['to both'])
    await send(elsewhere, 'from my other login')
    await expect(messages(page)).toHaveText(['to both', 'from my other login'])
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-mine', 'true')
    await expect(page.getByTestId('badge')).toHaveCount(0)
    await context.close()
  })
})

test.describe('history', () => {
  test('two hundred messages can be scrolled back to the very first', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const all = Array.from({ length: 200 }, (_, index) => `message ${index + 1}`)
    await say(bea, conversation, ...all)

    await page.goto(`/chats/${conversation}`)
    // 打开时停在最新一条，只加载了最近的一段
    await expect(messages(page).last()).toHaveText('message 200')
    await expect(messages(page).last()).toBeInViewport()
    await expect(messages(page)).toHaveCount(50)

    // 往上翻一次：更早的一段接上了，原来看的那一条还在眼前，没有跳动
    const list = page.getByTestId('message-list')
    const anchor = messages(page).filter({ hasText: /^message 151$/ })
    await list.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect(messages(page)).toHaveCount(100)
    await expect(anchor).toBeInViewport()

    // 一直翻到头
    await expect(async () => {
      await list.evaluate((element) => {
        element.scrollTop = 0
      })
      await expect(page.getByTestId('message-event')).toBeInViewport({ timeout: 1000 })
    }).toPass()
    await expect(messages(page)).toHaveText(all)
  })

  test('a new message does not pull the page down while reading history', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(bea, conversation, ...Array.from({ length: 40 }, (_, index) => `old ${index + 1}`))
    await page.goto(`/chats/${conversation}`)
    await expect(messages(page).last()).toBeInViewport()

    // 往上翻一段
    const list = page.getByTestId('message-list')
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2 - element.clientHeight
    })
    const position = await list.evaluate((element) => element.scrollTop)
    const reading = messages(page)
      .filter({ hasText: /^old 2\d$/ })
      .first()
    await expect(reading).toBeInViewport()

    await say(bea, conversation, 'fresh')
    const jump = page.getByRole('button', { name: '1 new message' })
    await expect(jump).toBeVisible()
    // 页面没有动；没有回到底部，新消息就还是未读
    expect(await list.evaluate((element) => element.scrollTop)).toBe(position)
    await expect(row(page, bea).getByTestId('badge')).toHaveText('1')

    await jump.click()
    await expect(messages(page).last()).toHaveText('fresh')
    await expect(messages(page).last()).toBeInViewport()
    await expect(jump).toHaveCount(0)
    await expect(page.getByTestId('badge')).toHaveCount(0)
  })
})

test.describe('the conversation list', () => {
  test('puts the latest conversation first and shows whose it is', async ({ page, account }) => {
    const bea = await another('Bea')
    const cal = await another('Cal')
    const withBea = await befriend(account, bea)
    const withCal = await befriend(account, cal)
    await page.goto('/chats')
    const names = page.getByTestId('conversation-name')
    await expect(names).toHaveText([cal.nickname, bea.nickname])

    // 来了新消息的会话排到最前面，多行的消息在列表里并成一行
    await say(bea, withBea, 'two\nlines')
    await expect(names).toHaveText([bea.nickname, cal.nickname])
    await expect(row(page, bea).getByTestId('conversation-summary')).toHaveText('two lines')
    await say(cal, withCal, 'now me')
    await expect(names).toHaveText([cal.nickname, bea.nickname])

    // 给好友设了备注，会话里也显示备注
    const api = await newApi(account.storageState)
    const friends = (await (await api.get('/api/friends')).json()) as {
      items: { user: { id: string; nickname: string } }[]
    }
    const beaId = friends.items.find((item) => item.user.nickname === bea.nickname)?.user.id
    await api.patch(`/api/friends/${beaId}`, { data: { remark: 'Boss Bea' } })
    await api.dispose()
    await expect(names).toHaveText([cal.nickname, 'Boss Bea'])
    await names.filter({ hasText: 'Boss Bea' }).click()
    await expect(page.getByTestId('conversation-title')).toHaveText('Boss Bea')
  })

  test('a removed conversation comes back, history intact, with the next message', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(bea, conversation, 'before')
    await page.goto(`/chats/${conversation}`)
    await expect(messages(page)).toHaveText(['before'])

    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Remove from list' }).click()
    await expect(page).toHaveURL(/\/chats$/)
    await expect(page.getByText('No conversations yet')).toBeVisible()
    // 刷新之后也不在列表里
    await page.reload()
    await expect(page.getByText('No conversations yet')).toBeVisible()

    await say(bea, conversation, 'after')
    await expect(row(page, bea).getByTestId('badge')).toHaveText('1')
    await row(page, bea).click()
    await expect(messages(page)).toHaveText(['before', 'after'])
  })

  test('after unfriending, the history can be read but nothing more can be sent', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(bea, conversation, 'while friends')
    const { context, page: beaPage } = await openAs(browser, bea, `/chats/${conversation}`)
    await expect(composer(beaPage)).toBeVisible()
    await page.goto(`/chats/${conversation}`)

    // 在通讯录里删除好友
    const api = await newApi(account.storageState)
    const friends = (await (await api.get('/api/friends')).json()) as {
      items: { user: { id: string } }[]
    }
    await api.delete(`/api/friends/${friends.items[0]?.user.id}`)
    await api.dispose()

    // 双方都不用刷新：历史还在，输入区换成了一句说明
    for (const window of [page, beaPage]) {
      await expect(window.getByText('You are no longer friends')).toBeVisible()
      await expect(composer(window)).toHaveCount(0)
      await expect(messages(window)).toHaveText(['while friends'])
    }
    await context.close()
  })

  test('a conversation that is not mine cannot be opened', async ({ page }) => {
    const bea = await another('Bea')
    const cal = await another('Cal')
    const theirs = await befriend(bea, cal)
    await say(bea, theirs, 'private')

    for (const id of [theirs, '0190a000-0000-7000-8000-000000000000']) {
      await page.goto(`/chats/${id}`)
      await expect(page).toHaveURL(/\/chats$/)
      await expect(page.getByText('Select a conversation to start chatting')).toBeVisible()
    }
    await expect(page.getByText('private')).toHaveCount(0)
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 700 } })

  test('the list and the conversation are two screens', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(bea, conversation, 'hello', 'a-very-long-word-'.repeat(12))

    await page.goto('/contacts')
    const tabs = page.getByTestId('tab-bar')
    await expect(tabs.getByRole('link', { name: /Chats/ }).getByTestId('badge')).toHaveText('2')
    await tabs.getByRole('link', { name: /Chats/ }).click()
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible()

    // 点一个会话：整屏换成会话，列表不见了
    await row(page, bea).click()
    await expect(page.getByTestId('conversation-title')).toHaveText(bea.nickname)
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeHidden()
    await expect(messages(page)).toHaveCount(2)
    await expect(tabs.getByTestId('badge')).toHaveCount(0)

    // 很长的一串字符也折行，页面不会被撑宽
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
    const listOverflow = await page
      .getByTestId('message-list')
      .evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(listOverflow).toBe(0)

    // 点按钮发送
    await composer(page).fill('from my phone')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(messages(page).last()).toHaveText('from my phone')
    await expect(messages(page).last()).toBeInViewport()

    await page.getByRole('link', { name: 'Back to conversations' }).click()
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible()
    await expect(row(page, bea).getByTestId('conversation-summary')).toHaveText('from my phone')
  })
})
