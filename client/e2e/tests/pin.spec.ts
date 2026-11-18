// 会话置顶（F6）：右键、长按、标题栏的菜单里置顶；置顶的排在最上面，自己的其他窗口跟着变。

import type { Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  expect,
  gotoConnected,
  logInElsewhere,
  say,
  test,
} from './support'

const names = (page: Page) => page.getByTestId('conversation').getByTestId('conversation-name')
const row = (page: Page, who: Account) =>
  page.getByTestId('conversation').filter({ hasText: who.nickname })

/** 三个好友，各自发过一条：最新的是 cara，然后 bea，然后 amy。 */
async function threeFriends(account: Account) {
  const friends: { friend: Account; conversation: string }[] = []
  for (const name of ['Amy', 'Bea', 'Cara']) {
    const friend = await another(name)
    const conversation = await befriend(account, friend)
    await say(friend, conversation, `hi from ${name}`)
    friends.push({ friend, conversation })
  }
  const [amy, bea, cara] = friends as [
    (typeof friends)[number],
    (typeof friends)[number],
    (typeof friends)[number],
  ]
  return { amy: amy.friend, bea: bea.friend, cara: cara.friend, withBea: bea.conversation }
}

test.describe('pinning a conversation', () => {
  test('a pinned conversation stays on top, on every window of mine', async ({
    page,
    browser,
    account,
  }) => {
    const { amy, bea, cara, withBea } = await threeFriends(account)
    await gotoConnected(page, '/chats')
    await expect(names(page)).toHaveText([cara.nickname, bea.nickname, amy.nickname])
    const { context, page: other } = await logInElsewhere(browser, account)
    await gotoConnected(other, '/chats')

    // 右键 amy 那一行，置顶
    await row(page, amy).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Pin to top' }).click()
    await expect(names(page)).toHaveText([amy.nickname, cara.nickname, bea.nickname])
    await expect(row(page, amy).getByTestId('pinned')).toBeVisible()
    // 另一个窗口跟着变
    await expect(names(other)).toHaveText([amy.nickname, cara.nickname, bea.nickname])

    // 别人来了新消息：排到没置顶的最前面，但还在置顶的下面
    await say(bea, withBea, 'news')
    await expect(names(page)).toHaveText([amy.nickname, bea.nickname, cara.nickname])

    // 在会话标题栏的菜单里取消置顶
    await row(page, amy).click()
    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Unpin' }).click()
    await expect(names(page)).toHaveText([bea.nickname, cara.nickname, amy.nickname])
    await expect(row(page, amy).getByTestId('pinned')).toHaveCount(0)
    await expect(names(other)).toHaveText([bea.nickname, cara.nickname, amy.nickname])
    await context.close()
  })
})
