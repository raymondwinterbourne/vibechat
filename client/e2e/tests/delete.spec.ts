// 删除消息、清空聊天记录，都只对自己（F6）：自己这边不见了，自己的其他窗口跟着变；
// 对方照常看得到，管理员查看时也照常看得到。

import type { Page } from '@playwright/test'
import {
  another,
  befriend,
  expect,
  gotoConnected,
  logInElsewhere,
  openAs,
  openAsAdmin,
  say,
  test,
} from './support'

const texts = (page: Page) => page.getByTestId('message-text')

async function choose(page: Page, text: string, item: string) {
  const message = page.getByTestId('message').filter({ hasText: text }).first()
  await message.hover()
  await message.getByRole('button', { name: 'Message options' }).click()
  await page.getByTestId('message-menu').getByRole('menuitem', { name: item }).click()
}

test.describe('deleting for myself', () => {
  test('a deleted message is gone for me and my other windows, but not for the other side', async ({
    page,
    browser,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(bea, conversation, 'first', 'the code is 7788', 'last one')
    await gotoConnected(page, `/chats/${conversation}`)
    const { context, page: other } = await logInElsewhere(browser, account)
    await gotoConnected(other, `/chats/${conversation}`)
    await expect(texts(other)).toHaveText(['first', 'the code is 7788', 'last one'])

    await choose(page, 'last one', 'Delete')
    const dialog = page.getByRole('dialog', { name: 'Delete this message?' })
    await expect(dialog).toContainText('the others can still see it')
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(texts(page)).toHaveText(['first', 'the code is 7788'])
    // 会话列表的摘要换成还剩下的那一条
    await expect(
      page
        .getByTestId('conversation')
        .filter({ hasText: bea.nickname })
        .getByTestId('conversation-summary'),
    ).toHaveText('the code is 7788')
    // 我的另一个窗口跟着变
    await expect(texts(other)).toHaveText(['first', 'the code is 7788'])

    // 多选几条一起删
    await choose(page, 'first', 'Select')
    await page.getByTestId('message').filter({ hasText: 'the code is 7788' }).click()
    await page.getByTestId('selection-bar').getByRole('button', { name: 'Delete' }).click()
    await page
      .getByRole('dialog', { name: 'Delete these 2 messages?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(texts(page)).toHaveCount(0)
    await expect(page.getByTestId('selection-bar')).toHaveCount(0)

    // 对方一条都没少
    const { page: beaPage } = await openAs(browser, bea, `/chats/${conversation}`)
    await expect(texts(beaPage)).toHaveText(['first', 'the code is 7788', 'last one'])

    // 管理员查看时照常看得到
    const admin = await openAsAdmin(browser, `/admin/chats/${conversation}`)
    await expect(admin.page.getByTestId('message-text')).toHaveText([
      'first',
      'the code is 7788',
      'last one',
    ])
    await admin.context.close()
    await context.close()
  })

  test('clearing a chat empties it for me, keeps it listed, and new messages still come', async ({
    page,
    browser,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(bea, conversation, 'one', 'two')
    await gotoConnected(page, `/chats/${conversation}`)
    await expect(texts(page)).toHaveText(['one', 'two'])

    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Clear chat history' }).click()
    const dialog = page.getByRole('dialog', { name: 'Clear chat history' })
    await expect(dialog).toContainText('only for you')
    await dialog.getByRole('button', { name: 'Clear' }).click()
    await expect(texts(page)).toHaveCount(0)
    const row = page.getByTestId('conversation').filter({ hasText: bea.nickname })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('conversation-summary')).toHaveText('')

    await say(bea, conversation, 'three')
    await expect(texts(page)).toHaveText(['three'])

    // 对方照常
    const { page: beaPage } = await openAs(browser, bea, `/chats/${conversation}`)
    await expect(texts(beaPage)).toHaveText(['one', 'two', 'three'])
  })
})
