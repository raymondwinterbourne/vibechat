// 没有发出去的消息保存在这台设备上：刷新页面之后仍然在，可以重发或删掉；退出登录时清掉。

import type { Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  controlConnection,
  expect,
  logIn,
  newApi,
  pngImage,
  test,
} from './support'

const MESSAGES = '**/api/conversations/*/messages'
const messages = (page: Page) => page.getByTestId('message')
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const mine = (page: Page, text: string) => messages(page).filter({ hasText: text })

async function send(page: Page, text: string) {
  await composer(page).fill(text)
  await composer(page).press('Enter')
}

/** 对方那里收到的：文字消息的文字，图片写成"[picture]"。 */
async function received(who: Account, conversation: string): Promise<string[]> {
  const api = await newApi(who.storageState)
  const reply = await api.get(`/api/conversations/${conversation}/messages`)
  const body = (await reply.json()) as { items: { kind: string; text: string | null }[] }
  await api.dispose()
  return body.items
    .filter((item) => item.kind === 'text' || item.kind === 'image')
    .map((item) =>
      item.kind === 'image' ? `[picture] ${item.text ?? ''}`.trim() : (item.text ?? ''),
    )
}

/** 发消息的请求到不了服务端。 */
const goOffline = (page: Page) =>
  page.route(MESSAGES, (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  )

test.describe('messages that did not go out', () => {
  test('stay after a reload, and go out once when resent', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toBeVisible()

    await goOffline(page)
    await send(page, 'written offline')
    await page.getByTestId('file-input').setInputFiles({
      name: 'view.png',
      mimeType: 'image/png',
      buffer: pngImage(80, 60, [30, 120, 200]),
    })
    await composer(page).fill('the view')
    await composer(page).press('Enter')
    const picture = messages(page).filter({ has: page.getByTestId('message-image') })
    for (const message of [mine(page, 'written offline'), picture]) {
      await expect(message.getByTestId('message-status')).toContainText('Not sent')
    }

    // 刷新：两条都还在，仍然是发送失败，没有自己发出去
    await page.unroute(MESSAGES)
    await page.reload()
    await expect(page.getByTestId('message-event')).toBeVisible()
    await expect(mine(page, 'written offline').getByTestId('message-status')).toContainText(
      'Not sent',
    )
    await expect(picture.getByTestId('message-status')).toContainText('Not sent')
    await expect(picture.getByTestId('message-caption')).toHaveText('the view')
    expect(await received(bea, conversation)).toEqual([])

    // 重发：对方各收到一条
    await mine(page, 'written offline').getByRole('button', { name: 'Retry' }).click()
    await expect(mine(page, 'written offline').getByTestId('message-status')).toHaveText('Sent')
    await picture.getByRole('button', { name: 'Retry' }).click()
    await expect(picture.getByTestId('message-status')).toHaveText('Sent')
    expect(await received(bea, conversation)).toEqual(['written offline', '[picture] the view'])

    // 发出去了的不再留在这台设备上：再刷新，什么都不多
    await page.reload()
    await expect(messages(page)).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  })

  test('one that did arrive before the reload is not shown twice', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const connection = await controlConnection(page)
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toBeVisible()

    // 消息到了服务端，但应答和推送都没能回来
    await connection.cut()
    await page.route(MESSAGES, async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await route.fetch()
      await route.abort()
    })
    await send(page, 'did it arrive?')
    await expect(mine(page, 'did it arrive?').getByTestId('message-status')).toContainText(
      'Not sent',
    )

    await page.unroute(MESSAGES)
    connection.restore()
    await page.reload()
    await expect(mine(page, 'did it arrive?')).toHaveCount(1)
    await expect(mine(page, 'did it arrive?').getByTestId('message-status')).toHaveText(/Sent|Read/)
    expect(await received(bea, conversation)).toEqual(['did it arrive?'])
  })

  test('can be deleted, and stays deleted', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toBeVisible()

    await goOffline(page)
    await send(page, 'never mind')
    const message = mine(page, 'never mind')
    await expect(message.getByTestId('message-status')).toContainText('Not sent')

    await message.getByRole('button', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete this message?' })
    await expect(dialog).toContainText("It hasn't been sent yet")
    // 先取消一次：还在
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(message).toHaveCount(1)
    await message.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
    await expect(message).toHaveCount(0)

    await page.unroute(MESSAGES)
    await page.reload()
    await expect(page.getByTestId('message-event')).toBeVisible()
    await expect(message).toHaveCount(0)
    expect(await received(bea, conversation)).toEqual([])
  })

  test('are cleared on logging out, and nobody else sees them', async ({ page, account }) => {
    // 两次退出、两次登录，比一般的测试长
    test.slow()
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toBeVisible()
    await goOffline(page)
    await send(page, 'left behind')
    await expect(mine(page, 'left behind').getByTestId('message-status')).toContainText('Not sent')
    await page.unroute(MESSAGES)

    // 在同一个浏览器里退出，换 Bea 登录，再换回来：都看不到那条
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/\/login/)
    await logIn(page, bea.handle, bea.password)
    await expect(page).toHaveURL(/\/chats$/)
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toBeVisible()
    await expect(mine(page, 'left behind')).toHaveCount(0)

    await page.goto('/settings')
    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/\/login/)
    await logIn(page, account.handle, account.password)
    await expect(page).toHaveURL(/\/chats$/)
    await page.goto(`/chats/${conversation}`)
    await expect(page.getByTestId('message-event')).toBeVisible()
    await expect(mine(page, 'left behind')).toHaveCount(0)
  })
})
