// 走查：把每个页面在手机宽度和英文下各打开一遍，检查布局和文案的通病。
//
// 以后新加的页面漏了翻译、撑破了布局、按钮做得太小，会在这里被发现。

import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test'
import {
  type Account,
  anonymousTest,
  another,
  befriend,
  createAccount,
  directWith,
  expect,
  fakeScreen,
  gotoConnected,
  makeGroup,
  newApi,
  openAsAdmin,
  pngImage,
  post,
  requestFriend,
  say,
  test,
  uploadAs,
  voiceSample,
} from './support'

/** 手机上可以点的地方不小于这么大。 */
const TOUCH_MIN = 44

interface Finding {
  what: string
  where: string
}

/** 页面此刻的通病：横向滚动、太小的按钮、被截断的按钮、伸到屏幕外的按钮、残留的中文。 */
async function inspect(page: Page, options: { touch: boolean }): Promise<Finding[]> {
  return page.evaluate(
    ({ touch, min }) => {
      const findings: { what: string; where: string }[] = []
      const describe = (element: Element) => {
        const label =
          element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          (element.textContent ?? '').trim().slice(0, 40) ||
          element.getAttribute('data-testid') ||
          // 没有名字的输入框：用它的标签上的字
          (element.id && document.querySelector(`label[for="${element.id}"]`)?.textContent) ||
          element.getAttribute('type') ||
          ''
        return `<${element.tagName.toLowerCase()}> ${label}`
      }
      const visible = (element: Element) => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity) > 0 &&
          box.width > 0 &&
          box.height > 0
        )
      }

      const root = document.documentElement
      if (root.scrollWidth > root.clientWidth) {
        findings.push({ what: 'the page scrolls sideways', where: `${root.scrollWidth}px wide` })
      }

      const controls = document.querySelectorAll(
        'button, a[href], [role="button"], [role="switch"], [role="radio"], [role="menuitem"], [role="option"], input:not([type="hidden"]):not([type="file"]), textarea, select',
      )
      for (const control of controls) {
        if (!visible(control)) continue
        // 被盖在下面的东西（对话框后面的页面）点不到，不用查
        if (control.closest('[aria-hidden="true"], [inert]')) continue
        const box = control.getBoundingClientRect()
        // 被别的东西整个盖住的也点不到：例如通话界面下面的聊天页面。只看在屏幕里的
        const cx = box.left + box.width / 2
        const cy = box.top + box.height / 2
        if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
          const top = document.elementFromPoint(cx, cy)
          const own = control.closest('label') ?? control
          if (top && !own.contains(top) && !top.contains(own)) continue
        }
        // 滚出去的部分不算"伸到屏幕外"，只看左右
        if (box.left < -1 || box.right > window.innerWidth + 1) {
          findings.push({ what: 'reaches outside the screen', where: describe(control) })
        }
        // 故意做成放不下就省略的（很长的群名）不算
        const clipped = getComputedStyle(control).textOverflow === 'ellipsis'
        if (
          control instanceof HTMLButtonElement &&
          !clipped &&
          control.scrollWidth > control.clientWidth + 1
        ) {
          findings.push({ what: 'button text is cut off', where: describe(control) })
        }
        if (touch) {
          // 勾选框外面包着更大的 label，点 label 也算
          const target = control.closest('label') ?? control
          const area = target.getBoundingClientRect()
          // 一段文字里的链接不算按钮
          const inline = getComputedStyle(control).display === 'inline'
          if (!inline && (area.width < min - 0.5 || area.height < min - 0.5)) {
            findings.push({
              what: `too small to tap (${Math.round(area.width)}x${Math.round(area.height)})`,
              where: describe(control),
            })
          }
        }
      }

      // 界面文字里不应该有汉字。测试数据全部是英文，所以页面上出现的汉字一定是漏翻的。
      // 只有一处例外：语言的名称不翻译，每种语言都用它自己的文字显示
      const han = /[㐀-鿿]/
      const texts = [document.body.innerText.replaceAll('简体中文', '')]
      for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
        texts.push(
          element.getAttribute('aria-label') ?? '',
          element.getAttribute('title') ?? '',
          element.getAttribute('placeholder') ?? '',
        )
      }
      for (const text of texts) {
        const at = text.search(han)
        if (at >= 0) {
          findings.push({
            what: 'untranslated text',
            where: text.slice(Math.max(0, at - 20), at + 20),
          })
        }
      }
      if (han.test(document.title))
        findings.push({ what: 'untranslated title', where: document.title })
      return findings
    },
    { touch: options.touch, min: TOUCH_MIN },
  )
}

/** 一个有内容的账号：有好友、有群、有各种消息、有好友申请。返回要走的地方。 */
async function populate(account: Account) {
  const bea = await another('Bea')
  const cy = await another('Cy')
  // 建群时已经和这两个人成为好友
  const group = await makeGroup(account, [bea, cy], 'Weekend hike')
  const direct = await directWith(account, bea)
  const stranger = await another('Dee')
  await requestFriend(stranger, account, 'hello, we met yesterday')
  await requestFriend(account, await another('Eve'))

  const plan = await post(bea, direct, { text: 'shall we go hiking on Saturday? '.repeat(3) })
  const photo = await uploadAs(bea, 'trail.png', 'image/png', pngImage(900, 600, [70, 130, 90]))
  const photoSeq = await post(bea, direct, { file_id: photo.id })
  const sheet = await uploadAs(
    bea,
    'a-very-long-file-name-for-the-route-and-gear-list-final-version.xlsx',
    '',
    Buffer.alloc(3456, 1),
  )
  await post(bea, direct, { file_id: sheet.id })
  const voice = await uploadAs(bea, 'voice.webm', 'audio/webm', voiceSample())
  const voiceSeq = await post(bea, direct, { file_id: voice.id, voice_duration_ms: 8000 })
  await post(account, direct, { text: 'yes, count me in', reply_to: plan })
  await say(account, direct, 'a-very-long-word-'.repeat(12))
  // 群里一条聊天记录：单聊里的一段合并转发过来
  await post(account, group, {
    merge: {
      conversation_id: direct,
      seqs: [plan, photoSeq, voiceSeq],
      title: `Chat history of ${account.nickname} and ${bea.nickname}`,
    },
  })
  await say(bea, group, 'who brings the water?')
  // 带说明的图片；群公告；另一个群里别人发的、我还没看过的公告
  const view = await uploadAs(bea, 'view.png', 'image/png', pngImage(600, 400, [200, 150, 60]))
  await post(bea, direct, { file_id: view.id, text: 'the view from the top of the hill' })
  await setNotice(account, group, 'Meet at the station at 7am. Bring water and a jacket.')
  await befriend(bea, cy)
  const club = await groupOf(bea, [account, cy], 'Book club')
  await setNotice(bea, club, 'This month we read a very long novel with a very long title indeed.')
  return { bea, direct, group, club }
}

async function setNotice(owner: Account, group: string, text: string) {
  const api = await newApi(owner.storageState)
  const reply = await api.put(`/api/conversations/${group}/notice`, { data: { text } })
  expect(reply.status(), 'set notice').toBe(200)
  await api.dispose()
}

async function groupOf(owner: Account, members: Account[], name: string): Promise<string> {
  const api = await newApi(owner.storageState)
  const created = await api.post('/api/conversations/group', {
    data: { name, member_ids: members.map((member) => member.id) },
  })
  expect(created.ok(), 'create group').toBe(true)
  const { id } = (await created.json()) as { id: string }
  await api.dispose()
  return id
}

/** 打开一条消息的菜单：电脑上点"更多"，手机上长按。 */
async function openMessageMenu(page: Page, text: string, phone: boolean) {
  const message = page.getByTestId('message').filter({ hasText: text }).first()
  if (!phone) {
    await message.hover()
    await message.getByRole('button', { name: 'Message options' }).click()
    return
  }
  const bubble = message.getByTestId('message-text')
  const box = await bubble.boundingBox()
  const touch = { identifier: 0, clientX: (box?.x ?? 0) + 10, clientY: (box?.y ?? 0) + 10 }
  await bubble.dispatchEvent('touchstart', {
    touches: [touch],
    changedTouches: [touch],
    targetTouches: [touch],
  })
  await expect(page.getByTestId('message-menu')).toBeVisible()
  await bubble.dispatchEvent('touchend', { touches: [], changedTouches: [touch] })
}

/** 电脑上右键，手机上长按 */
async function openRowMenu(page: Page, row: Locator, phone: boolean) {
  if (!phone) {
    await row.click({ button: 'right' })
    return
  }
  const box = await row.boundingBox()
  const touch = { identifier: 0, clientX: (box?.x ?? 0) + 40, clientY: (box?.y ?? 0) + 20 }
  await row.dispatchEvent('touchstart', {
    touches: [touch],
    changedTouches: [touch],
    targetTouches: [touch],
  })
  await expect(page.getByRole('menuitem').first()).toBeVisible()
  await row.dispatchEvent('touchend', { touches: [], changedTouches: [touch] })
}

/** 把登录后的每个页面、每个面板走一遍，每到一处调用一次 `check`。 */
async function visitAll(
  page: Page,
  account: Account,
  check: (name: string) => Promise<void>,
  phone: boolean,
) {
  const { bea, direct, group, club } = await populate(account)
  const closeTop = () => page.keyboard.press('Escape')

  await page.goto('/chats')
  await expect(page.getByTestId('conversation')).toHaveCount(4)
  await check('chat list')
  await page.getByRole('button', { name: 'New group' }).click()
  await expect(page.getByTestId('pick-friend').first()).toBeVisible()
  await check('new group dialog')
  await closeTop()
  await page.getByTestId('open-search').click()
  await page.getByRole('searchbox').fill('hik')
  await expect(page.getByTestId('search-item').first()).toBeVisible()
  await check('search panel')
  await closeTop()
  // 会话的右键、长按菜单；置顶和单聊
  const directRow = page
    .getByTestId('conversation')
    .filter({ has: page.getByTestId('conversation-name').getByText(bea.nickname, { exact: true }) })
  await openRowMenu(page, directRow, phone)
  await check('chat menu')
  await page.getByRole('menuitem', { name: 'Pin to top' }).click()
  await expect(directRow.getByTestId('pinned')).toBeVisible()
  await check('chat list with a pinned chat')

  await page.goto(`/chats/${direct}`)
  await expect(page.getByTestId('message-image').first()).toBeVisible()
  await check('direct conversation')
  await page.getByTestId('message-image').first().click()
  await expect(page.getByTestId('lightbox-image')).toBeVisible()
  await check('full-size picture')
  await closeTop()
  await page.getByRole('button', { name: 'Record a voice message' }).click()
  await expect(page.getByTestId('voice-recorder')).toBeVisible()
  await check('voice recorder')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('menuitem').first()).toBeVisible()
  await check('conversation menu')
  await page.getByRole('menuitem', { name: 'Find in conversation' }).click()
  await page.getByTestId('conversation-search').getByRole('searchbox').fill('hiking')
  await expect(page.getByTestId('search-hit').first()).toBeVisible()
  await check('find in conversation')
  await page
    .getByTestId('conversation-search')
    .getByRole('button', { name: 'Close find' })
    .first()
    .click()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Photos and files' }).click()
  const media = page.getByTestId('media-panel')
  await expect(media.getByTestId('media-image').first()).toBeVisible()
  await check('photos in a chat')
  await media.getByRole('radio', { name: 'Files' }).click()
  await expect(media.getByTestId('media-file').first()).toBeVisible()
  await check('files in a chat')
  await closeTop()
  await expect(media).toHaveCount(0)
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Clear chat history' }).click()
  await expect(page.getByTestId('clear-confirm')).toBeVisible()
  await check('clear dialog')
  await closeTop()
  await expect(page.getByTestId('clear-confirm')).toHaveCount(0)
  if (!phone) {
    // 电脑上鼠标移到消息上出现的操作
    const message = page.getByTestId('message').filter({ hasText: 'count me in' })
    await message.hover()
    await message.getByRole('button', { name: 'Message options' }).click()
    await expect(page.getByTestId('message-menu')).toBeVisible()
    await check('message menu')
    await closeTop()
  }
  await page.getByRole('button', { name: 'Add people' }).click()
  await expect(page.getByTestId('pick-friend').first()).toBeVisible()
  await check('add people dialog')
  await closeTop()
  // 多选和转发
  await openMessageMenu(page, 'count me in', phone)
  await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Select' }).click()
  await expect(page.getByTestId('selection-bar')).toBeVisible()
  await check('selecting messages')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('delete-confirm')).toBeVisible()
  await check('delete dialog')
  await closeTop()
  await expect(page.getByTestId('delete-confirm')).toHaveCount(0)
  await page
    .getByTestId('selection-bar')
    .getByRole('button', { name: 'Forward one by one' })
    .click()
  await expect(page.getByTestId('forward-target').first()).toBeVisible()
  await check('forward dialog')
  await closeTop()
  await closeTop()
  await expect(page.getByTestId('selection-bar')).toHaveCount(0)

  // 编辑自己的一条（F8）：输入框上方的提示，改完之后的"已编辑"
  await openMessageMenu(page, 'count me in', phone)
  await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Edit' }).click()
  await expect(page.getByTestId('editing')).toBeVisible()
  await check('editing a message')
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('yes, count me in, see you there')
  if (phone) await page.getByRole('button', { name: 'Save' }).click()
  else await box.press('Enter')
  await expect(page.getByTestId('message-edited').first()).toBeVisible()
  await check('an edited message')
  // 对方正在输入（F8）：Bea 在她那边打字
  const browser = page.context().browser()
  if (browser) {
    const beaContext = await browser.newContext({ storageState: bea.storageState })
    const beaPage = await beaContext.newPage()
    await gotoConnected(beaPage, `/chats/${direct}`)
    await beaPage.getByRole('textbox', { name: 'Message' }).pressSequentially('on my way')
    await expect(page.getByTestId('typing')).toBeVisible()
    await check('someone typing')
    await beaContext.close()
  }

  await page.goto(`/chats/${group}`)
  await expect(page.getByTestId('message-text').last()).toBeVisible()
  await check('group conversation')
  await page.getByTestId('chat-record').click()
  await expect(page.getByTestId('record-item')).toHaveCount(3)
  await check('chat record')
  await closeTop()
  await page.getByRole('button', { name: 'Group info' }).click()
  await expect(page.getByTestId('member')).toHaveCount(3)
  await check('group info')
  await page.getByTestId('member').filter({ hasText: bea.nickname }).click()
  await expect(page.getByTestId('member-profile')).toBeVisible()
  await check('member profile')
  await page.getByRole('button', { name: 'Mute in group' }).click()
  await expect(page.getByTestId('mute-durations')).toBeVisible()
  await check('mute durations')
  await closeTop()
  await page.getByTestId('open-join-requests').click()
  await expect(page.getByRole('dialog', { name: 'Join requests' })).toBeVisible()
  await check('join requests')
  await closeTop()
  await page.getByTestId('group-panel').getByRole('button', { name: 'Invite friends' }).click()
  await expect(page.getByTestId('pick-friend').first()).toBeVisible()
  await check('invite dialog')
  await closeTop()
  await page.getByTestId('group-avatar').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await check('group photo')
  await closeTop()
  await page.getByTestId('group-notice').click()
  await expect(page.getByTestId('notice-text')).toBeVisible()
  await check('group notice')
  await page.getByRole('dialog').getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByTestId('notice-input')).toBeVisible()
  await check('group notice editor')
  await closeTop()

  // 别人发的、还没看过的公告：顶部的公告条
  await page.goto(`/chats/${club}`)
  await expect(page.getByTestId('notice-banner')).toBeVisible()
  await check('notice banner')

  await page.goto('/contacts')
  await expect(page.getByTestId('friend')).toHaveCount(2)
  await check('contacts')
  await page.getByRole('button', { name: 'Add a friend' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await check('add friend dialog')
  await closeTop()
  await page.goto('/contacts/new')
  await expect(page.getByRole('button', { name: /^Accept/ })).toBeVisible()
  await check('friend requests')
  await page.goto('/contacts/groups')
  await expect(page.getByTestId('group')).toHaveCount(2)
  await check('my groups')
  await page.goto('/contacts')
  await page.getByTestId('friend').first().click()
  await expect(page.getByTestId('friend-profile')).toBeVisible()
  await check('friend profile')

  // 另一台设备上也登录着（F9）：登录设备里有它，可以让它退出
  const elsewhere = await newApi()
  await elsewhere.post('/api/auth/login', {
    data: { handle: account.handle, password: account.password },
  })
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByTestId('device')).toHaveCount(2)
  await check('settings')
  await page.getByTestId('device').nth(1).getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByTestId('devices-confirm')).toBeVisible()
  await check('sign out a device')
  await closeTop()
  await elsewhere.dispose()
  await page.getByRole('button', { name: "What's new" }).click()
  await expect(page.getByTestId('release-notes')).toBeVisible()
  await check('release notes')
  await page.getByRole('button', { name: 'Got it' }).click()

  // 服务器上换了新页面：顶部的"点这里刷新"
  await page.route('**/version.json*', (route) => route.fulfill({ json: { build: 'newer' } }))
  await page.goto('/chats')
  await expect(page.getByTestId('update-banner')).toBeVisible()
  await check('update banner')
  await page.unroute('**/version.json*')
}

function report(findings: Record<string, Finding[]>): string {
  return Object.entries(findings)
    .filter(([, list]) => list.length > 0)
    .map(([name, list]) => {
      const lines = [...new Set(list.map((item) => `    ${item.what}: ${item.where}`))]
      return `  ${name}\n${lines.join('\n')}`
    })
    .join('\n')
}

test.describe('on a phone, in English', () => {
  test.use({ viewport: { width: 375, height: 700 }, hasTouch: true })

  test('every page fits the screen, has tappable controls and no leftover Chinese', async ({
    page,
    account,
  }) => {
    test.setTimeout(90_000)
    const findings: Record<string, Finding[]> = {}
    await visitAll(
      page,
      account,
      async (name) => {
        findings[name] = await inspect(page, { touch: true })
      },
      true,
    )
    expect(report(findings), 'problems found while walking through the pages').toBe('')
  })
})

test.describe('on a computer, in English', () => {
  test('no page has leftover Chinese or cut-off buttons', async ({ page, account }) => {
    test.setTimeout(90_000)
    const findings: Record<string, Finding[]> = {}
    await visitAll(
      page,
      account,
      async (name) => {
        findings[name] = await inspect(page, { touch: false })
      },
      false,
    )
    expect(report(findings), 'problems found while walking through the pages').toBe('')
  })
})

/**
 * 通话和共享屏幕（F7）：`watcher` 在电脑上或手机上看，`sharer` 一直在电脑上。
 * 每到一处调用一次 `check`，带上要检查的那个窗口。
 */
async function visitCall(
  browser: Browser,
  account: Account,
  watcherOptions: BrowserContextOptions,
  check: (name: string, page: Page) => Promise<void>,
  phone: boolean,
) {
  const friend = await another('Walk')
  const conversation = await befriend(account, friend)
  const open = async (who: Account, options: BrowserContextOptions) => {
    const context = await browser.newContext({ storageState: who.storageState, ...options })
    const page = await context.newPage()
    await page.addInitScript(fakeScreen)
    await gotoConnected(page, `/chats/${conversation}`)
    return page
  }
  const sharer = await open(account, {})
  const watcher = await open(friend, watcherOptions)
  await sharer.getByTestId('voice-call').click()
  await watcher.getByTestId('call-incoming').getByTestId('call-accept').click()
  await expect(watcher.getByTestId('call-path')).toBeVisible({ timeout: 20_000 })
  await check('voice call', watcher)
  await sharer.getByTestId('call-share').click()
  await expect(sharer.getByTestId('call-sharing-bar')).toBeVisible()
  if (!phone) await check('sharing my screen', sharer)
  await expect(watcher.getByTestId('call-shared-screen')).toBeVisible({ timeout: 20_000 })
  await check('watching a shared screen', watcher)
  await sharer.getByTestId('call-stop-sharing').click()
  await expect(watcher.getByTestId('call-shared-screen')).toHaveCount(0)
  if (!phone) {
    await watcher.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        throw new DOMException('Permission denied by system', 'NotAllowedError')
      }
    })
    await watcher.getByTestId('call-share').click()
    await expect(watcher.getByTestId('call-screen-problem')).toBeVisible()
    await check('cannot share the screen', watcher)
    await watcher.keyboard.press('Escape')
  }
  await watcher.getByTestId('call-hangup').click()
  await sharer.context().close()
  await watcher.context().close()
}

test.describe('calls and a shared screen, in English', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')

  test('fit a phone screen and have tappable controls', async ({ browser, account }) => {
    const findings: Record<string, Finding[]> = {}
    await visitCall(
      browser,
      account,
      { viewport: { width: 375, height: 700 }, hasTouch: true },
      async (name, page) => {
        findings[name] = await inspect(page, { touch: true })
      },
      true,
    )
    expect(report(findings), 'problems found while walking through the call').toBe('')
  })

  test('have no leftover Chinese or cut-off buttons on a computer', async ({
    browser,
    account,
  }) => {
    const findings: Record<string, Finding[]> = {}
    await visitCall(
      browser,
      account,
      {},
      async (name, page) => {
        findings[name] = await inspect(page, { touch: false })
      },
      false,
    )
    expect(report(findings), 'problems found while walking through the call').toBe('')
  })
})

/**
 * 群语音通话（F10）：`watcher` 在电脑上或手机上，`starter` 一直在电脑上。
 * 每到一处调用一次 `check`，带上要检查的那个窗口。
 */
async function visitGroupCall(
  browser: Browser,
  account: Account,
  watcherOptions: BrowserContextOptions,
  check: (name: string, page: Page) => Promise<void>,
) {
  const friend = await another('Walk')
  const group = await makeGroup(account, [friend, await another('Walk')], 'Walk call group')
  const open = async (who: Account, options: BrowserContextOptions) => {
    const context = await browser.newContext({ storageState: who.storageState, ...options })
    const page = await context.newPage()
    await gotoConnected(page, `/chats/${group}`)
    return page
  }
  const starter = await open(account, {})
  const watcher = await open(friend, watcherOptions)
  const active = (page: Page) =>
    expect(page.getByTestId('group-call-screen')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })

  // 选人的对话框
  await watcher.getByTestId('group-voice-call').click()
  await expect(watcher.getByTestId('group-call-pick')).toHaveCount(2)
  await check('group call picker', watcher)
  await watcher.keyboard.press('Escape')
  await expect(watcher.getByTestId('group-call-picker')).toHaveCount(0)

  // 被邀请：卡片和"通话进行中"的横条
  await starter.getByTestId('group-voice-call').click()
  await starter.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
  await active(starter)
  await expect(watcher.getByTestId('group-call-incoming')).toBeVisible()
  await expect(watcher.getByTestId('group-call-banner')).toBeVisible()
  await check('group call invitation', watcher)

  // 通话中
  await watcher.getByTestId('group-call-accept').click()
  await active(watcher)
  await expect(watcher.getByTestId('group-call-member')).toHaveCount(2)
  await check('group call', watcher)
  await watcher.getByTestId('group-call-invite').click()
  await expect(watcher.getByTestId('group-call-pick')).toHaveCount(1)
  await check('group call invite picker', watcher)
  await watcher.keyboard.press('Escape')
  await expect(watcher.getByTestId('group-call-picker')).toHaveCount(0)

  // 缩小后的小条，和"你在通话中"的横条
  await watcher.getByTestId('group-call-minimize').click()
  await expect(watcher.getByTestId('group-call-mini')).toBeVisible()
  await check('group call minimized', watcher)
  await watcher.getByTestId('group-call-mini').click()
  await active(watcher)

  // 离开之后：横条上可以再加入；通话结束后的通话记录
  await watcher.getByTestId('group-call-leave').click()
  await expect(
    watcher.getByTestId('group-call-banner').getByRole('button', { name: 'Join' }),
  ).toBeVisible()
  await check('group call banner', watcher)
  await starter.getByTestId('group-call-leave').click()
  await expect(watcher.getByTestId('call-record').last()).toContainText('2 people joined')
  await check('group call record', watcher)
  await starter.context().close()
  await watcher.context().close()
}

test.describe('group calls, in English', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')

  test('fit a phone screen and have tappable controls', async ({ browser, account }) => {
    const findings: Record<string, Finding[]> = {}
    await visitGroupCall(
      browser,
      account,
      { viewport: { width: 375, height: 700 }, hasTouch: true },
      async (name, page) => {
        findings[name] = await inspect(page, { touch: true })
      },
    )
    expect(report(findings), 'problems found while walking through the group call').toBe('')
  })

  test('have no leftover Chinese or cut-off buttons on a computer', async ({
    browser,
    account,
  }) => {
    const findings: Record<string, Finding[]> = {}
    await visitGroupCall(browser, account, {}, async (name, page) => {
      findings[name] = await inspect(page, { touch: false })
    })
    expect(report(findings), 'problems found while walking through the group call').toBe('')
  })
})

/**
 * 群视频通话（F11）：`watcher` 在电脑上或手机上，`starter` 一直在电脑上。
 * 每到一处调用一次 `check`，带上要检查的那个窗口。
 */
async function visitGroupVideoCall(
  browser: Browser,
  account: Account,
  watcherOptions: BrowserContextOptions,
  check: (name: string, page: Page) => Promise<void>,
) {
  const friend = await another('Walk')
  const third = await another('Walk')
  const group = await makeGroup(account, [friend, third], 'Walk video group')
  const open = async (who: Account, options: BrowserContextOptions) => {
    const context = await browser.newContext({ storageState: who.storageState, ...options })
    const page = await context.newPage()
    await gotoConnected(page, `/chats/${group}`)
    return page
  }
  const starter = await open(account, {})
  const other = await open(third, {})
  const watcher = await open(friend, watcherOptions)
  const active = (page: Page) =>
    expect(page.getByTestId('group-call-screen')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })

  // 标题栏上的两个按钮，和选人的对话框
  await check('group header with both call buttons', watcher)
  await watcher.getByTestId('group-video-call').click()
  await expect(watcher.getByTestId('group-call-pick')).toHaveCount(2)
  await check('group video call picker', watcher)
  await watcher.keyboard.press('Escape')
  await expect(watcher.getByTestId('group-call-picker')).toHaveCount(0)

  // 被邀请：卡片和"视频通话进行中"的横条
  await starter.getByTestId('group-video-call').click()
  await starter.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
  await active(starter)
  await expect(watcher.getByTestId('group-call-incoming')).toBeVisible()
  await expect(watcher.getByTestId('group-call-banner')).toContainText('Video call in progress')
  await check('group video call invitation', watcher)

  // 通话中：三个人的格子，其中一个人没开摄像头
  await watcher.getByTestId('group-call-accept').click()
  await active(watcher)
  await other.getByTestId('group-call-ignore').click()
  await other.getByTestId('group-call-banner').getByRole('button', { name: 'Join' }).click()
  await active(other)
  await expect(watcher.getByTestId('group-call-member')).toHaveCount(3)
  await expect(watcher.getByTestId('group-call-picture')).toHaveCount(2)
  await check('group video call grid', watcher)

  // 放大一格
  await watcher
    .locator(`[data-testid="group-call-member"][data-user="${account.id}"]`)
    .getByTestId('group-call-enlarge')
    .click()
  await expect(watcher.getByTestId('group-call-members')).toHaveAttribute('data-layout', 'focus')
  await check('group video call with one enlarged', watcher)
  await watcher
    .locator(`[data-testid="group-call-member"][data-user="${account.id}"]`)
    .getByTestId('group-call-enlarge')
    .click()

  // 关掉自己的摄像头；再邀请的对话框
  await watcher.getByTestId('group-call-camera').click()
  await expect(watcher.getByTestId('group-call-camera')).toHaveAccessibleName('Camera on')
  await check('group video call with my camera off', watcher)
  await watcher.getByTestId('group-call-invite').click()
  await expect(watcher.getByTestId('group-call-picker')).toBeVisible()
  await check('group video call invite picker', watcher)
  await watcher.keyboard.press('Escape')
  await expect(watcher.getByTestId('group-call-picker')).toHaveCount(0)

  // 缩小后带画面的小窗
  await watcher.getByTestId('group-call-minimize').click()
  await expect(watcher.getByTestId('group-call-mini')).toHaveAttribute('data-video', '')
  await check('group video call minimized', watcher)
  await watcher.getByTestId('group-call-mini').click()
  await active(watcher)

  // 离开之后的横条；通话结束后的通话记录
  await watcher.getByTestId('group-call-leave').click()
  await expect(
    watcher.getByTestId('group-call-banner').getByRole('button', { name: 'Join' }),
  ).toBeVisible()
  await check('group video call banner', watcher)
  await other.getByTestId('group-call-leave').click()
  await starter.getByTestId('group-call-leave').click()
  await expect(watcher.getByTestId('call-record').last()).toContainText('Video call')
  await check('group video call record', watcher)
  for (const page of [starter, other, watcher]) await page.context().close()
}

/**
 * 群通话里共享屏幕（F12）：`sharer` 一直在电脑上共享，`watcher` 在电脑上或手机上看。
 * 每到一处调用一次 `check`，带上要检查的那个窗口。共享的人自己的界面只在电脑上有。
 */
async function visitGroupScreenShare(
  browser: Browser,
  account: Account,
  watcherOptions: BrowserContextOptions,
  check: (name: string, page: Page) => Promise<void>,
  phone: boolean,
) {
  const friend = await another('Walk')
  const group = await makeGroup(account, [friend, await another('Walk')], 'Walk share group')
  const open = async (who: Account, options: BrowserContextOptions) => {
    const context = await browser.newContext({ storageState: who.storageState, ...options })
    const page = await context.newPage()
    await page.addInitScript(fakeScreen)
    await gotoConnected(page, `/chats/${group}`)
    return page
  }
  const sharer = await open(account, {})
  const watcher = await open(friend, watcherOptions)
  const active = (page: Page) =>
    expect(page.getByTestId('group-call-screen')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })
  const screenTile = watcher.getByTestId('group-call-screen-tile')

  await sharer.getByTestId('group-video-call').click()
  await sharer.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
  await active(sharer)
  await watcher.getByTestId('group-call-accept').click()
  await active(watcher)
  await expect(watcher.getByTestId('group-call-member')).toHaveCount(2)
  // 电脑上有"共享屏幕"按钮，手机上没有
  await expect(watcher.getByTestId('group-call-share')).toHaveCount(phone ? 0 : 1)
  await check('group call before anyone shares', watcher)

  // 开始共享：共享的人那里通话界面让开，屏幕上方一条"你正在共享屏幕"和诊断小字
  await sharer.getByTestId('group-call-share').click()
  await expect(sharer.getByTestId('group-call-sharing-bar')).toBeVisible()
  await expect(sharer.getByTestId('group-call-sent')).toBeVisible({ timeout: 30_000 })
  if (!phone) await check('group call while I share my screen', sharer)

  // 看的人：屏幕占大块，人排在旁边；按钮上写着谁在共享
  await expect(screenTile).toHaveAttribute('data-enlarged', '')
  await expect(watcher.getByTestId('group-call-screen-received')).toBeVisible({
    timeout: 30_000,
  })
  await check('group call watching a shared screen', watcher)

  // 放大一个人，屏幕排到旁边那一排
  await watcher
    .locator(`[data-testid="group-call-member"][data-user="${account.id}"]`)
    .getByTestId('group-call-enlarge')
    .click()
  await expect(screenTile).not.toHaveAttribute('data-enlarged')
  await check('group call with a person enlarged beside a shared screen', watcher)
  await screenTile.getByTestId('group-call-enlarge').click()
  await expect(screenTile).toHaveAttribute('data-enlarged', '')

  // 缩小后的小窗里是共享的屏幕
  await watcher.getByTestId('group-call-minimize').click()
  await expect(watcher.getByTestId('group-call-mini')).toBeVisible()
  await check('group call minimized while a screen is shared', watcher)
  await watcher.getByTestId('group-call-mini').click()
  await active(watcher)

  await sharer.getByTestId('group-call-stop-sharing').click()
  await expect(screenTile).toHaveCount(0)
  await watcher.getByTestId('group-call-leave').click()
  await sharer.getByTestId('group-call-mini').click()
  await sharer.getByTestId('group-call-leave').click()
  for (const page of [sharer, watcher]) await page.context().close()
}

test.describe('a screen shared in a group call, in English', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')
  // 每个测试几个窗口都在编码画面，很吃 CPU：一个接一个跑
  test.describe.configure({ mode: 'serial' })

  test('fits a phone screen and has tappable controls', async ({ browser, account }) => {
    const findings: Record<string, Finding[]> = {}
    await visitGroupScreenShare(
      browser,
      account,
      { viewport: { width: 375, height: 700 }, hasTouch: true },
      async (name, page) => {
        findings[name] = await inspect(page, { touch: true })
      },
      true,
    )
    expect(report(findings), 'problems found while walking through the shared screen').toBe('')
  })

  test('fits a phone turned sideways and has tappable controls', async ({ browser, account }) => {
    const findings: Record<string, Finding[]> = {}
    await visitGroupScreenShare(
      browser,
      account,
      // 横过来的 iPhone：比"电脑"那条线宽，但很矮（F12 第 11 章）
      { viewport: { width: 844, height: 390 }, hasTouch: true },
      async (name, page) => {
        // 只查通话界面。缩小之后露出来的聊天页面在横屏的手机上整体用的是电脑的尺寸，
        // 不在这一次的范围里（第 11 章的完成情况）
        if (name.includes('minimized')) return
        findings[name] = await inspect(page, { touch: true })
      },
      true,
    )
    expect(report(findings), 'problems found while walking through the shared screen').toBe('')
  })

  test('has no leftover Chinese or cut-off buttons on a computer', async ({ browser, account }) => {
    const findings: Record<string, Finding[]> = {}
    await visitGroupScreenShare(
      browser,
      account,
      {},
      async (name, page) => {
        findings[name] = await inspect(page, { touch: false })
      },
      false,
    )
    expect(report(findings), 'problems found while walking through the shared screen').toBe('')
  })
})

test.describe('group video calls, in English', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake camera in WebKit')
  // 每个测试几个窗口都在编码假的画面（每个人两档），很吃 CPU：一个接一个跑，免得把同时在跑的别的测试拖到超时
  test.describe.configure({ mode: 'serial' })

  test('fit a phone screen and have tappable controls', async ({ browser, account }) => {
    const findings: Record<string, Finding[]> = {}
    await visitGroupVideoCall(
      browser,
      account,
      { viewport: { width: 375, height: 700 }, hasTouch: true },
      async (name, page) => {
        findings[name] = await inspect(page, { touch: true })
      },
    )
    expect(report(findings), 'problems found while walking through the group video call').toBe('')
  })

  test('have no leftover Chinese or cut-off buttons on a computer', async ({
    browser,
    account,
  }) => {
    const findings: Record<string, Finding[]> = {}
    await visitGroupVideoCall(browser, account, {}, async (name, page) => {
      findings[name] = await inspect(page, { touch: false })
    })
    expect(report(findings), 'problems found while walking through the group video call').toBe('')
  })
})

/** 把每个管理页面、每个对话框走一遍，每到一处调用一次 `check`。 */
async function visitAdmin(page: Page, check: (name: string) => Promise<void>, phone: boolean) {
  const account = await createAccount()
  const { direct } = await populate(account)
  const loaded = () => expect(page.getByTestId('loading')).toHaveCount(0)
  const closeTop = () => page.keyboard.press('Escape')

  await page.goto('/admin')
  await expect(page.getByTestId('admin-nav')).toBeVisible()
  if (!phone) await expect(page.getByTestId('stat-users')).toBeVisible()
  await check('admin home')

  await page.goto('/admin/overview')
  await expect(page.getByTestId('stat-users')).toBeVisible()
  await check('overview')

  await page.goto('/admin/users')
  await expect(page.getByTestId('admin-user').first()).toBeVisible()
  await check('users')
  await page.getByRole('searchbox', { name: 'Find by ID or nickname' }).fill(account.handle)
  const row = page.getByTestId('admin-user').filter({ hasText: account.handle })
  await expect(page.getByTestId('admin-user')).toHaveCount(1)
  await row.getByRole('button', { name: `Disable ${account.nickname}` }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await check('disable dialog')
  await closeTop()
  await row.getByRole('button', { name: `Reset the password of ${account.nickname}` }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Reset password' }).click()
  await expect(page.getByTestId('temp-password')).toBeVisible()
  await check('temporary password')
  await closeTop()

  await page.goto('/admin/invite-codes')
  await expect(page.getByRole('heading', { name: 'Invite codes' })).toBeVisible()
  await loaded()
  await check('invite codes')

  await page.goto('/admin/chats')
  await page.getByRole('searchbox', { name: 'Find a user by ID or nickname' }).fill(account.handle)
  await expect(page.getByTestId('admin-user-candidate')).toHaveCount(1)
  await check('find a user')
  await page.getByTestId('admin-user-candidate').click()
  // 两个群，加上和两个群成员各自的单聊
  await expect(page.getByTestId('admin-conversation')).toHaveCount(4)
  await check('conversations of a user')

  await page.goto(`/admin/chats/${direct}`)
  await expect(page.getByTestId('message-image').first()).toBeVisible()
  await check('read-only chat')
  await page.getByTestId('message-image').first().click()
  await expect(page.getByTestId('lightbox-image')).toBeVisible()
  await check('picture in the read-only chat')
  await closeTop()

  await page.goto('/admin/groups')
  await page.getByRole('searchbox', { name: 'Find by group name' }).fill('Weekend hike')
  await expect(page.getByTestId('admin-group').first()).toBeVisible()
  await check('groups')
  await page
    .getByTestId('admin-group')
    .first()
    .getByRole('button', { name: /^Show the members/ })
    .click()
  await expect(page.getByTestId('admin-member')).toHaveCount(3)
  await check('group members')
  await closeTop()
  await page
    .getByTestId('admin-group')
    .first()
    .getByRole('button', { name: /^Dissolve/ })
    .click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await check('dissolve dialog')
  await closeTop()

  await page.goto('/admin/settings')
  await expect(page.getByTestId('admin-settings')).toBeVisible()
  await page.getByRole('radio', { name: 'Keep for a limited time' }).click()
  await expect(page.getByTestId('retention-warning')).toBeVisible()
  await check('system settings')

  await page.goto('/admin/audit')
  await expect(page.getByTestId('audit-entry').first()).toBeVisible()
  await check('audit log')

  await page.goto('/settings')
  await expect(page.getByTestId('admin-email')).toBeVisible()
  await page.getByRole('button', { name: 'Change', exact: true }).last().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await check('change email dialog')
}

anonymousTest.describe('the admin pages', () => {
  anonymousTest(
    'have no leftover Chinese or cut-off buttons on a computer',
    async ({ browser }) => {
      anonymousTest.setTimeout(90_000)
      const { context, page } = await openAsAdmin(browser, '/admin')
      const findings: Record<string, Finding[]> = {}
      await visitAdmin(
        page,
        async (name) => {
          findings[name] = await inspect(page, { touch: false })
        },
        false,
      )
      expect(report(findings), 'problems found while walking through the admin pages').toBe('')
      await context.close()
    },
  )

  anonymousTest('fit a phone screen and have tappable controls', async ({ browser }) => {
    anonymousTest.setTimeout(90_000)
    const { context, page } = await openAsAdmin(browser, '/admin', {
      viewport: { width: 375, height: 700 },
      hasTouch: true,
    })
    const findings: Record<string, Finding[]> = {}
    await visitAdmin(
      page,
      async (name) => {
        findings[name] = await inspect(page, { touch: true })
      },
      true,
    )
    expect(report(findings), 'problems found while walking through the admin pages').toBe('')
    await context.close()
  })
})

anonymousTest.describe('before logging in', () => {
  anonymousTest.use({ viewport: { width: 375, height: 700 }, hasTouch: true })

  anonymousTest('the login and register pages pass the same checks', async ({ page }) => {
    const findings: Record<string, Finding[]> = {}
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
    findings.login = await inspect(page, { touch: true })
    await page.goto('/register')
    await expect(page.getByLabel('Invite code')).toBeVisible()
    findings.register = await inspect(page, { touch: true })
    // 管理员找回密码的三个页面
    await page.goto('/forgot-password')
    await expect(page.getByRole('button', { name: 'Send email' })).toBeVisible()
    findings['forgot password'] = await inspect(page, { touch: true })
    await page.goto('/reset-password?token=not-a-real-token')
    await expect(page.getByRole('button', { name: 'Save new password' })).toBeVisible()
    findings['reset password'] = await inspect(page, { touch: true })
    await page.goto('/confirm-email?token=not-a-real-token')
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible()
    findings['confirm email'] = await inspect(page, { touch: true })
    expect(report(findings)).toBe('')
  })
})
