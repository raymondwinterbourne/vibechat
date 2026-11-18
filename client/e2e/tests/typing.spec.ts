// "正在输入"（F8）：对方打字时标题旁边显示提示；消息到了、停下几秒之后就消失；群里写明是谁。

import type { Browser, Page } from '@playwright/test'
import { type Account, another, befriend, expect, gotoConnected, makeGroup, test } from './support'

const input = (page: Page) => page.getByRole('textbox', { name: 'Message' })

async function window(browser: Browser, account: Account, conversation: string) {
  const context = await browser.newContext({ storageState: account.storageState })
  const page = await context.newPage()
  await gotoConnected(page, `/chats/${conversation}`)
  return page
}

test.describe('typing', () => {
  test('the other side sees it while I type, and it goes away when the message arrives or I stop', async ({
    page,
    browser,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await gotoConnected(page, `/chats/${conversation}`)
    const other = await window(browser, bea, conversation)
    await expect(other.getByTestId('typing')).toHaveCount(0)

    await input(page).pressSequentially('hel')
    await expect(other.getByTestId('typing')).toHaveText('Typing…')
    // 自己这边不显示
    await expect(page.getByTestId('typing')).toHaveCount(0)
    await input(page).pressSequentially('lo')
    await input(page).press('Enter')
    await expect(other.getByTestId('message-text').last()).toHaveText('hello')
    await expect(other.getByTestId('typing')).toHaveCount(0)

    // 打了几个字就停下：几秒之后自己消失。服务端 0.5 秒之内只转一次，先等一下
    await page.waitForTimeout(600)
    await input(page).pressSequentially('wait')
    await expect(other.getByTestId('typing')).toBeVisible()
    await expect(other.getByTestId('typing')).toHaveCount(0, { timeout: 10_000 })
    await other.context().close()
  })

  test('in a group it says who is typing', async ({ page, browser, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Weekend hike')
    await gotoConnected(page, `/chats/${group}`)
    const beaPage = await window(browser, bea, group)
    const cyPage = await window(browser, cy, group)

    await input(beaPage).pressSequentially('who')
    await expect(page.getByTestId('typing')).toHaveText(`${bea.nickname} is typing…`)
    await input(cyPage).pressSequentially('me')
    await expect(page.getByTestId('typing')).toHaveText(
      `${bea.nickname} and ${cy.nickname} are typing…`,
    )
    // Cy 看到的只有 Bea
    await expect(cyPage.getByTestId('typing')).toHaveText(`${bea.nickname} is typing…`)
    await beaPage.context().close()
    await cyPage.context().close()
  })
})
