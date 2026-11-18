// 编辑已发送的消息（F8）：从菜单、按 ↑ 开始编辑；改完所有人马上看到新的内容和"已编辑"，
// 引用了它的回复跟着变；打了一半的字编辑完还在；管理员看得到修改前的每一版。

import type { Page } from '@playwright/test'
import {
  another,
  befriend,
  expect,
  gotoConnected,
  openAs,
  openAsAdmin,
  post,
  say,
  test,
} from './support'

const texts = (page: Page) => page.getByTestId('message-text')
const input = (page: Page) => page.getByRole('textbox', { name: 'Message' })

async function choose(page: Page, text: string, item: string) {
  const message = page.getByTestId('message').filter({ hasText: text }).first()
  await message.hover()
  await message.getByRole('button', { name: 'Message options' }).click()
  await page.getByTestId('message-menu').getByRole('menuitem', { name: item }).click()
}

test.describe('editing a sent message', () => {
  test('the new text shows for everyone at once, marked as edited, and quotes follow', async ({
    page,
    browser,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const typo = await post(account, conversation, { text: 'see you at 3' })
    await post(bea, conversation, { text: 'ok, at 3', reply_to: typo })
    await gotoConnected(page, `/chats/${conversation}`)
    const { page: other } = await openAs(browser, bea, `/chats/${conversation}`)
    await expect(texts(other)).toHaveText(['see you at 3', 'ok, at 3'])

    // 打了一半的字：编辑完还在
    await input(page).fill('half a thought')
    await choose(page, 'see you at 3', 'Edit')
    await expect(page.getByTestId('editing')).toContainText('Editing message')
    await expect(input(page)).toHaveValue('see you at 3')
    // 编辑时不能加文件、录语音
    await expect(page.getByRole('button', { name: 'File', exact: true })).toHaveCount(0)
    await input(page).fill('see you at 4')
    await input(page).press('Enter')
    await expect(page.getByTestId('editing')).toHaveCount(0)
    await expect(input(page)).toHaveValue('half a thought')

    const edited = (on: Page) => on.getByTestId('message').filter({ hasText: 'see you at 4' })
    await expect(texts(page).first()).toHaveText('see you at 4')
    await expect(edited(page).getByTestId('message-edited')).toHaveText('Edited')
    // 对方不用刷新就看到，引用里的那一段也跟着变
    await expect(texts(other).first()).toHaveText('see you at 4')
    await expect(edited(other).getByTestId('message-edited')).toHaveText('Edited')
    await expect(other.getByTestId('quote').first()).toContainText('see you at 4')
    // 别人的消息菜单里没有"编辑"
    const theirs = other.getByTestId('message').filter({ hasText: 'see you at 4' }).first()
    await theirs.hover()
    await theirs.getByRole('button', { name: 'Message options' }).click()
    await expect(
      other.getByTestId('message-menu').getByRole('menuitem', { name: 'Copy' }),
    ).toBeVisible()
    await expect(
      other.getByTestId('message-menu').getByRole('menuitem', { name: 'Edit' }),
    ).toHaveCount(0)
    await other.keyboard.press('Escape')

    // 刷新之后还是新的内容
    await other.reload()
    await expect(texts(other).first()).toHaveText('see you at 4')
    await other.context().close()
  })

  test('pressing ↑ in an empty box edits my last message; Esc gives up', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(account, conversation, 'first try')
    await say(bea, conversation, 'their reply')
    await gotoConnected(page, `/chats/${conversation}`)
    await expect(texts(page)).toHaveText(['first try', 'their reply'])

    await input(page).press('ArrowUp')
    await expect(page.getByTestId('editing')).toContainText('first try')
    await expect(input(page)).toHaveValue('first try')
    await input(page).press('Escape')
    await expect(page.getByTestId('editing')).toHaveCount(0)
    await expect(input(page)).toHaveValue('')
    await expect(texts(page).first()).toHaveText('first try')

    // 再按 ↑，改完保存
    await input(page).press('ArrowUp')
    await input(page).fill('second try')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(texts(page).first()).toHaveText('second try')
    // 输入框里有字时，↑ 只是挪光标
    await input(page).fill('typing')
    await input(page).press('ArrowUp')
    await expect(page.getByTestId('editing')).toHaveCount(0)
  })

  test('the administrator sees every earlier version', async ({ page, browser, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(account, conversation, 'draft one')
    await gotoConnected(page, `/chats/${conversation}`)
    // 先等那一条显示出来：不然 ↑ 时还没有可以编辑的消息，输入的字会作为新消息发出去
    await expect(texts(page).first()).toHaveText('draft one')
    for (const text of ['draft two', 'draft three']) {
      await input(page).press('ArrowUp')
      await input(page).fill(text)
      await input(page).press('Enter')
      await expect(texts(page).first()).toHaveText(text)
    }

    const admin = await openAsAdmin(browser, `/admin/chats/${conversation}`)
    const message = admin.page.getByTestId('message').filter({ hasText: 'draft three' })
    await expect(message.getByTestId('message-edited')).toHaveText('Edited')
    await message.getByText('2 earlier versions').click()
    await expect(message.getByTestId('edit-version')).toHaveCount(2)
    await expect(message.getByTestId('edit-version').first()).toContainText('draft one')
    await expect(message.getByTestId('edit-version').last()).toContainText('draft two')
    await admin.context.close()
  })
})
