// 通讯录：按 ID 找人、好友申请、好友列表、备注、删除，以及这些变化的实时同步。

import type { Page, WebSocketRoute } from '@playwright/test'
import {
  another,
  befriend,
  expect,
  logInElsewhere,
  newApi,
  openAs,
  requestFriend,
  test,
} from './support'

/** 打开"添加好友"，按 ID 查找。 */
async function lookUp(page: Page, handle: string) {
  await page.getByRole('button', { name: 'Add a friend' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a friend' })
  await dialog.getByLabel('Their ID').fill(handle)
  await dialog.getByRole('button', { name: 'Find' }).click()
  return dialog
}

/** 好友列表里每一行显示的名字。点它就是点这一行。 */
const friends = (page: Page) => page.getByTestId('friend-label')
const railBadge = (page: Page) => page.getByTestId('nav-rail').getByTestId('badge')

test.describe('myself', () => {
  test('I am at the top of my contacts, and can talk to myself', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    await befriend(account, bea)
    const myLabel = `${account.nickname} (me)`
    await page.goto('/contacts')
    const myself = page.getByTestId('friend-me')
    await expect(myself.getByTestId('friend-me-label')).toHaveText(myLabel)
    await expect(friends(page)).toHaveText([bea.nickname])
    // 我在好友的上面
    const listIsBelowMe = await page.evaluate(() => {
      const me = document.querySelector('[data-testid="friend-me"]')
      const list = document.querySelector('[data-testid="friend-list"]')
      // 列表在"我"的后面
      return Boolean(
        me && list && me.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
    })
    expect(listIsBelowMe).toBe(true)

    // 筛选时和好友一样：按我的名字筛得到我，按别人的名字筛不到
    const filter = page.getByRole('searchbox', { name: 'Filter contacts' })
    await filter.fill(bea.nickname.slice(0, 6).toLowerCase())
    await expect(friends(page)).toHaveText([bea.nickname])
    await expect(myself).toHaveCount(0)
    await filter.fill(account.nickname.slice(0, 6).toLowerCase())
    await expect(myself).toBeVisible()
    await expect(page.getByText('No matching contacts')).toBeVisible()
    await filter.fill('')

    // 点"我"：打开和自己的对话
    await page.getByTestId('friend-me').click()
    await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+$/)
    await expect(page.getByTestId('conversation-title')).toHaveText(myLabel)
    // 没有"拉人建群"：没有对方可以一起拉
    await expect(page.getByRole('button', { name: 'Add people' })).toHaveCount(0)

    // 发给自己：状态是"已发送"，没有"已读"这回事；会话出现在列表里
    const composer = page.getByRole('textbox', { name: 'Message' })
    await composer.fill('note to self')
    await composer.press('Enter')
    const mine = page.getByTestId('message').last()
    await expect(mine.getByTestId('message-text')).toHaveText('note to self')
    await expect(mine.getByTestId('message-status')).toHaveText('Sent')
    await page.waitForTimeout(500)
    await expect(mine.getByTestId('message-status')).toHaveText('Sent')
    const row = page.getByTestId('conversation').filter({ hasText: myLabel })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('badge')).toHaveCount(0)

    // 另一处登录看到的是同一个对话；它不出现在别人的列表里
    const elsewhere = await logInElsewhere(browser, account)
    const there = elsewhere.page.getByTestId('conversation').filter({ hasText: myLabel })
    await expect(there).toBeVisible()
    await there.click()
    await expect(elsewhere.page.getByTestId('message-text').last()).toHaveText('note to self')
    await expect(elsewhere.page.getByTestId('conversation-title')).toHaveText(myLabel)
    await elsewhere.context.close()
    const b = await openAs(browser, bea, '/chats')
    await expect(b.page.getByTestId('conversation').filter({ hasText: bea.nickname })).toHaveCount(
      0,
    )
    await expect(b.page.getByTestId('conversation')).toHaveCount(1)
    await b.context.close()

    // 从通讯录再点一次还是同一个对话
    const url = page.url()
    await page.goto('/contacts')
    await page.getByTestId('friend-me').click()
    await expect(page).toHaveURL(url)
    await expect(page.getByTestId('message-text').last()).toHaveText('note to self')
  })
})

test.describe('adding a friend', () => {
  test('a request shows up at once, and accepting it makes both friends', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    // 对方停在聊天页，什么也不做
    const { context, page: beaPage } = await openAs(browser, bea, '/chats')
    await expect(railBadge(beaPage)).toHaveCount(0)

    await page.goto('/contacts')
    await expect(page.getByText('No contacts yet')).toBeVisible()
    const dialog = await lookUp(page, bea.handle)
    const found = dialog.getByTestId('lookup-result')
    await expect(found).toContainText(bea.nickname)
    // 验证信息预先填了一句，可以改
    await expect(dialog.getByLabel('Message')).toHaveValue(`I'm ${account.nickname}`)
    await dialog.getByLabel('Message').fill('Hello from the test')
    await dialog.getByRole('button', { name: 'Send request' }).click()
    await expect(page.getByTestId('toast').filter({ hasText: 'Request sent' })).toBeVisible()
    await expect(dialog).toBeHidden()

    // 对方没有刷新页面，通讯录图标上出现了数字
    await expect(railBadge(beaPage)).toHaveText('1')
    await beaPage.getByTestId('nav-rail').getByRole('link', { name: 'Contacts' }).click()
    const newFriends = beaPage.getByRole('link', { name: /New friends/ })
    await expect(newFriends.getByTestId('badge')).toHaveText('1')
    await newFriends.click()
    const incoming = beaPage.getByTestId('friend-request')
    await expect(incoming).toContainText(account.nickname)
    await expect(incoming).toContainText('Hello from the test')

    await incoming.getByRole('button', { name: /^Accept/ }).click()
    await expect(
      beaPage.getByTestId('toast').filter({ hasText: `${account.nickname} is now your friend` }),
    ).toBeVisible()
    await expect(incoming).toHaveAttribute('data-status', 'accepted')
    await expect(incoming).toContainText('Accepted')
    await expect(beaPage.getByTestId('badge')).toHaveCount(0)

    // 双方的通讯录里立即出现对方，都没有刷新
    await expect(friends(beaPage)).toHaveText([account.nickname])
    await expect(friends(page)).toHaveText([bea.nickname])

    // 申请方在"发出的"里看到结果
    await page.getByRole('link', { name: /New friends/ }).click()
    await page.getByRole('radio', { name: 'Sent' }).click()
    await expect(page.getByTestId('friend-request')).toContainText('Accepted')

    // 刷新之后仍然是好友
    await page.reload()
    await expect(friends(page)).toHaveText([bea.nickname])
    await context.close()
  })

  test('looking up nobody, myself or a friend says so', async ({ page, account }) => {
    const bea = await another('Bea')
    await befriend(account, bea)
    await page.goto('/contacts')

    const dialog = await lookUp(page, 'nobody_has_this_id')
    await expect(dialog.getByRole('alert')).toHaveText(
      "No user with that ID. Check that it's typed correctly.",
    )
    await expect(dialog.getByTestId('lookup-result')).toHaveCount(0)

    // 不区分大小写，前后的空格也不碍事
    await dialog.getByLabel('Their ID').fill(`  ${account.handle.toUpperCase()} `)
    await dialog.getByRole('button', { name: 'Find' }).click()
    await expect(dialog.getByTestId('lookup-result')).toContainText('This is you')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Send request' })).toHaveCount(0)

    await dialog.getByLabel('Their ID').fill(bea.handle)
    await dialog.getByRole('button', { name: 'Find' }).click()
    await expect(dialog.getByTestId('lookup-result')).toContainText('You are already friends')
    await dialog.getByRole('button', { name: 'View profile' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('friend-name')).toHaveText(bea.nickname)
  })

  test('a declined request is shown as declined, and can be sent again', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    await requestFriend(account, bea, 'first try')
    await page.goto('/contacts/new')
    await page.getByRole('radio', { name: 'Sent' }).click()
    const outgoing = page.getByTestId('friend-request')
    await expect(outgoing).toContainText('Waiting for a reply')

    const { context, page: beaPage } = await openAs(browser, bea, '/contacts/new')
    await beaPage
      .getByTestId('friend-request')
      .getByRole('button', { name: /^Decline/ })
      .click()
    await expect(beaPage.getByTestId('friend-request')).toContainText('Declined')
    await expect(beaPage.getByTestId('badge')).toHaveCount(0)
    await expect(beaPage.getByText('No contacts yet')).toBeVisible()

    // 申请方不刷新就看到结果，没有成为好友
    await expect(outgoing).toHaveAttribute('data-status', 'rejected')
    await expect(outgoing).toContainText('Declined')
    await expect(page.getByText('No contacts yet')).toBeVisible()

    // 再次申请：还是那一条，回到等待处理，对方又收到提醒
    const dialog = await lookUp(page, bea.handle)
    await dialog.getByLabel('Message').fill('second try')
    await dialog.getByRole('button', { name: 'Send request' }).click()
    await expect(outgoing).toHaveCount(1)
    await expect(outgoing).toContainText('Waiting for a reply')
    await expect(beaPage.getByTestId('friend-request')).toHaveCount(1)
    await expect(beaPage.getByTestId('friend-request')).toContainText('second try')
    await expect(railBadge(beaPage)).toHaveText('1')
    await context.close()
  })

  test('looking up someone who already asked me offers to accept', async ({ page, account }) => {
    const bea = await another('Bea')
    await requestFriend(bea, account)
    await page.goto('/contacts')
    await expect(railBadge(page)).toHaveText('1')

    const dialog = await lookUp(page, bea.handle)
    await expect(dialog.getByTestId('lookup-result')).toContainText(
      'They have already sent you a friend request',
    )
    await dialog.getByRole('button', { name: 'Accept' }).click()
    await expect(dialog).toBeHidden()
    await expect(friends(page)).toHaveText([bea.nickname])
    await expect(railBadge(page)).toHaveCount(0)
  })

  test('a request that has not been answered can be sent again with a new message', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    await requestFriend(account, bea, 'first try')
    await page.goto('/contacts')

    const dialog = await lookUp(page, bea.handle)
    await expect(dialog.getByTestId('lookup-result')).toContainText("You've already sent a request")
    await dialog.getByLabel('Message').fill('second try')
    await dialog.getByRole('button', { name: 'Send again' }).click()
    await expect(dialog).toBeHidden()

    const api = await newApi(bea.storageState)
    const list = (await (await api.get('/api/friend-requests')).json()) as {
      items: { message: string }[]
    }
    await api.dispose()
    expect(list.items.map((item) => item.message)).toEqual(['second try'])
  })
})

test.describe('the friend list', () => {
  test('a remark is shown only to the one who set it', async ({ page, account, browser }) => {
    const bea = await another('Bea')
    await befriend(account, bea)
    const { context, page: beaPage } = await openAs(browser, bea, '/contacts')
    await expect(friends(beaPage)).toHaveText([account.nickname])

    await page.goto('/contacts')
    await friends(page).click()
    const profile = page.getByTestId('friend-profile')
    await expect(profile.getByTestId('friend-name')).toHaveText(bea.nickname)
    await expect(profile).toContainText(bea.handle)

    await profile.getByRole('button', { name: 'Set remark' }).click()
    const dialog = page.getByRole('dialog', { name: 'Set remark' })
    await dialog.getByLabel('Remark').fill('Boss Bea')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // 自己这边：列表和资料都显示备注，原来的昵称另外列出
    await expect(friends(page)).toHaveText(['Boss Bea'])
    await expect(profile.getByTestId('friend-name')).toHaveText('Boss Bea')
    await expect(profile).toContainText(bea.nickname)

    // 对方那边什么也没变，接口里也取不到这个备注
    await expect(friends(beaPage)).toHaveText([account.nickname])
    const api = await newApi(bea.storageState)
    expect(await (await api.get('/api/friends')).text()).not.toContain('Boss Bea')
    await api.dispose()

    // 清掉备注，恢复显示昵称
    await profile.getByRole('button', { name: 'Set remark' }).click()
    await dialog.getByLabel('Remark').fill('')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(friends(page)).toHaveText([bea.nickname])
    await context.close()
  })

  test('removing a friend removes each from the other at once', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cal = await another('Cal')
    await befriend(account, bea)
    await befriend(account, cal)
    // 对方正开着我的资料
    const { context, page: beaPage } = await openAs(browser, bea, '/contacts')
    await friends(beaPage).click()
    await expect(beaPage.getByTestId('friend-name')).toHaveText(account.nickname)

    await page.goto('/contacts')
    await friends(page).filter({ hasText: bea.nickname }).click()
    const profile = page.getByTestId('friend-profile')

    // 先取消一次：什么也不发生
    await profile.getByRole('button', { name: 'Remove friend' }).click()
    const dialog = page.getByRole('dialog', { name: 'Remove this friend?' })
    await expect(dialog).toContainText(bea.nickname)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(friends(page)).toHaveCount(2)

    await profile.getByRole('button', { name: 'Remove friend' }).click()
    await dialog.getByRole('button', { name: 'Remove friend' }).click()
    await expect(page.getByTestId('toast').filter({ hasText: 'Friend removed' })).toBeVisible()

    // 自己这边只剩另一位好友；对方那边我消失了，他正看着的资料也关掉了
    await expect(friends(page)).toHaveText([cal.nickname])
    await expect(page).toHaveURL(/\/contacts$/)
    await expect(beaPage.getByText('No contacts yet')).toBeVisible()
    await expect(beaPage.getByTestId('friend-profile')).toHaveCount(0)
    await expect(beaPage).toHaveURL(/\/contacts$/)

    // 刷新之后也是这样
    await beaPage.reload()
    await expect(beaPage.getByText('No contacts yet')).toBeVisible()
    await context.close()
  })

  test('friends are sorted by name and can be filtered', async ({ page, account }) => {
    const [zed, amy, bob] = await Promise.all([another('Zed'), another('amy'), another('Bob')])
    for (const friend of [zed, amy, bob]) await befriend(account, friend)

    await page.goto('/contacts')
    await expect(friends(page)).toHaveText([amy.nickname, bob.nickname, zed.nickname])

    const filter = page.getByRole('searchbox', { name: 'Filter contacts' })
    // 用带空格的一段来筛：随机生成的 ID 里没有空格，不会碰巧也对上
    await filter.fill(bob.nickname.slice(0, 6).toLowerCase())
    await expect(friends(page)).toHaveText([bob.nickname])
    // 按 ID 也能筛出来
    await filter.fill(zed.handle.toUpperCase())
    await expect(friends(page)).toHaveText([zed.nickname])
    await filter.fill('no such friend')
    await expect(page.getByText('No matching contacts')).toBeVisible()
    await filter.fill('')
    await expect(friends(page)).toHaveCount(3)
  })

  test("a friend's new nickname and signature show up at once", async ({ page, account }) => {
    const bea = await another('Bea')
    await befriend(account, bea)
    await page.goto('/contacts')
    await friends(page).click()
    const profile = page.getByTestId('friend-profile')
    await expect(profile).toContainText('Not set')

    const api = await newApi(bea.storageState)
    const renamed = await api.patch('/api/me', {
      data: { nickname: 'Beatrice Renamed', signature: 'Out of office' },
    })
    expect(renamed.status()).toBe(200)
    await api.dispose()

    await expect(friends(page)).toHaveText(['Beatrice Renamed'])
    await expect(profile.getByTestId('friend-name')).toHaveText('Beatrice Renamed')
    await expect(profile).toContainText('Out of office')
  })

  test('someone who is not a friend has no profile page', async ({ page }) => {
    await page.goto('/contacts/0190a000-0000-7000-8000-000000000000')
    await expect(page).toHaveURL(/\/contacts$/)
    await expect(page.getByText('Select a contact to view their profile')).toBeVisible()
  })
})

test.describe('staying in sync', () => {
  test('a request that arrives while disconnected appears after reconnecting', async ({
    page,
    account,
  }) => {
    // 接管这个页面的 WebSocket：可以随时掐断，并且在放行之前不让它重新连上
    let blocked = false
    const open = new Set<WebSocketRoute>()
    await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
      if (blocked) {
        void socket.close()
        return
      }
      const server = socket.connectToServer()
      open.add(socket)
      socket.onClose(() => {
        open.delete(socket)
        void server.close()
      })
    })

    await page.goto('/contacts')
    await expect(page.getByText('No contacts yet')).toBeVisible()
    blocked = true
    for (const socket of open) await socket.close()
    await expect(page.getByText('Reconnecting…')).toBeVisible()

    // 断线期间有人发来申请：推送收不到，数字不会出现
    const bea = await another('Bea')
    await requestFriend(bea, account)
    await expect(page.getByText('Reconnecting…')).toBeVisible()
    await expect(railBadge(page)).toHaveCount(0)

    // 重新连上之后自动补齐
    blocked = false
    await expect(railBadge(page)).toHaveText('1')
    await expect(page.getByText('Reconnecting…')).toHaveCount(0)
  })

  test('another window of the same account follows along', async ({ page, account, browser }) => {
    const bea = await another('Bea')
    const { context, page: other } = await openAs(browser, account, '/contacts')
    await page.goto('/contacts')

    // 在一个窗口里发申请，另一个窗口的"发出的"里出现
    await other.getByRole('link', { name: /New friends/ }).click()
    await other.getByRole('radio', { name: 'Sent' }).click()
    await expect(other.getByText("You haven't sent any friend requests")).toBeVisible()
    const dialog = await lookUp(page, bea.handle)
    await dialog.getByRole('button', { name: 'Send request' }).click()
    await expect(other.getByTestId('friend-request')).toContainText(bea.nickname)
    await context.close()
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 700 } })

  test('the list and the profile are two screens', async ({ page, account }) => {
    const bea = await another('Bea')
    await befriend(account, bea)
    const cal = await another('Cal')
    await requestFriend(cal, account, 'Hi there')

    await page.goto('/chats')
    const tabs = page.getByTestId('tab-bar')
    await expect(tabs.getByTestId('badge')).toHaveText('1')
    await tabs.getByRole('link', { name: /Contacts/ }).click()
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()

    // 点一位好友：整屏换成他的资料，列表不见了
    await friends(page).click()
    await expect(page.getByTestId('friend-name')).toHaveText(bea.nickname)
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Set remark' })).toBeVisible()

    await page.getByRole('link', { name: 'Back to contacts' }).click()
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
    await expect(page.getByTestId('friend-profile')).toBeHidden()

    // "新的朋友"也是单独一屏，在这里同意申请
    await page.getByRole('link', { name: /New friends/ }).click()
    const incoming = page.getByTestId('friend-request')
    await expect(incoming).toContainText('Hi there')
    await incoming.getByRole('button', { name: /^Accept/ }).click()
    await expect(incoming).toContainText('Accepted')
    await page.getByRole('link', { name: 'Back to contacts' }).click()
    await expect(friends(page)).toHaveCount(2)
    await expect(tabs.getByTestId('badge')).toHaveCount(0)

    // 页面没有横向滚动
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })
})

/** 索引里被别的东西盖住的字母。 */
function coveredLetters(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="alphabet-letter"]')]
      .filter((letter) => {
        const box = letter.getBoundingClientRect()
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return !(top && letter.contains(top))
      })
      .map((letter) => letter.textContent ?? ''),
  )
}

test.describe('grouped by initial', () => {
  test('friends are grouped A to Z by pinyin or first letter, with # last and an index on the side', async ({
    page,
    account,
  }) => {
    // 用备注定下名字：中文、英文、数字开头的混在一起
    const names = ['张伟', 'Zoe', '李娜', '安琪', 'Amy', '9号']
    const api = await newApi(account.storageState)
    for (const name of names) {
      const friend = await another('Friend')
      await befriend(account, friend)
      const set = await api.patch(`/api/friends/${friend.id}`, { data: { remark: name } })
      expect(set.ok(), 'set remark').toBe(true)
    }
    await api.dispose()

    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.goto('/contacts')
    await expect(page.getByTestId('friend-section')).toHaveText(['A', 'L', 'Z', '#'])
    await expect(friends(page)).toHaveText(['安琪', 'Amy', '李娜', '张伟', 'Zoe', '9号'])
    // 一屏放得下：用不着索引
    const index = page.getByTestId('alphabet-index')
    await expect(index).toHaveCount(0)

    // 窗口矮下来、列表要滚动了：右侧出现索引
    await page.setViewportSize({ width: 1280, height: 400 })
    await expect(index.getByTestId('alphabet-letter')).toHaveText(['A', 'L', 'Z', '#'])
    await expect.poll(() => coveredLetters(page)).toEqual([])

    // 点索引里的字母：那一组的标题出现在列表顶端
    await index.getByTestId('alphabet-letter').filter({ hasText: '#' }).click()
    await expect(page.getByTestId('friend-section').filter({ hasText: '#' })).toBeInViewport()

    // 筛选时不分组，也没有索引
    await page.getByRole('searchbox', { name: 'Filter contacts' }).fill('a')
    await expect(page.getByTestId('friend-section')).toHaveCount(0)
    await expect(index).toHaveCount(0)
  })

  test('on a phone, sliding along the index jumps through the groups', async ({
    page,
    account,
  }) => {
    test.setTimeout(60_000)
    const api = await newApi(account.storageState)
    // 每组几个人，让列表长过一屏
    const remarks: string[] = []
    for (const name of [
      '阿',
      '八',
      '陈',
      '丁',
      '方',
      '高',
      '黄',
      '金',
      '孔',
      '林',
      '马',
      '王',
      '徐',
      '杨',
      '张',
    ]) {
      for (const n of [1, 2]) remarks.push(`${name}${n}`)
    }
    // 三十个好友：一起建，免得在慢的内核上光准备就超时
    await Promise.all(
      remarks.map(async (remark) => {
        const friend = await another('Friend')
        await befriend(account, friend)
        await api.patch(`/api/friends/${friend.id}`, { data: { remark } })
      }),
    )
    await api.dispose()
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/contacts')
    const index = page.getByTestId('alphabet-index')
    await expect(index.getByTestId('alphabet-letter')).toHaveCount(15)
    // 每个字母都看得见：没有被分组标题盖住（以前标题压在索引上面，经过的字母看不见）
    await expect.poll(() => coveredLetters(page)).toEqual([])

    // 按住第一个字母，一直滑到最后一个
    const first = await index.getByTestId('alphabet-letter').first().boundingBox()
    const last = await index.getByTestId('alphabet-letter').last().boundingBox()
    if (!first || !last) throw new Error('the index is shown')
    const x = first.x + first.width / 2
    await page.mouse.move(x, first.y + first.height / 2)
    await page.mouse.down()
    await expect(page.getByTestId('alphabet-bubble')).toHaveText('A')
    await page.mouse.move(x, last.y + last.height / 2, { steps: 10 })
    await expect(page.getByTestId('alphabet-bubble')).toHaveText('Z')
    await page.mouse.up()
    await expect(page.getByTestId('alphabet-bubble')).toHaveCount(0)
    await expect(page.getByTestId('friend-section').filter({ hasText: 'Z' })).toBeInViewport()
  })
})
