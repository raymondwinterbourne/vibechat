// 键盘、焦点，以及手机上的会话页和点头像看资料。

import type { Page } from '@playwright/test'
import { another, befriend, directWith, expect, makeGroup, say, test } from './support'

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const title = (page: Page) => page.getByTestId('conversation-title')
const texts = (page: Page) => page.getByTestId('message-text')

test.describe('with the keyboard only', () => {
  test('search for a conversation, open it, send a message, and switch conversations', async ({
    page,
    account,
  }) => {
    const bea = await another('Zelda')
    const cy = await another('Cy')
    const withBea = await befriend(account, bea)
    const withCy = await befriend(account, cy)
    // 让会话列表的顺序确定：Cy 的在上面
    await say(bea, withBea, 'older')
    await say(cy, withCy, 'newer')
    await page.goto('/chats')
    await expect(page.getByTestId('conversation')).toHaveCount(2)

    // 搜索并打开
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('zelda')
    await expect(page.getByTestId('search-item')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(title(page)).toHaveText(bea.nickname)

    // 进入会话后焦点已经在输入框里：直接打字，回车发送
    await expect(composer(page)).toBeFocused()
    await page.keyboard.type('sent without touching the mouse')
    await page.keyboard.press('Enter')
    await expect(texts(page).last()).toHaveText('sent without touching the mouse')

    // Alt 加方向键切换会话。刚发了消息，这个会话排到了最上面：等列表排好了再按
    await expect(page.getByTestId('conversation').first()).toContainText(bea.nickname)
    await page.keyboard.press('Alt+ArrowDown')
    await expect(title(page)).toHaveText(cy.nickname)
    await expect(composer(page)).toBeFocused()
    // 到头了不循环
    await page.keyboard.press('Alt+ArrowDown')
    await expect(title(page)).toHaveText(cy.nickname)
    await page.keyboard.press('Alt+ArrowUp')
    await expect(title(page)).toHaveText(bea.nickname)

    // Ctrl/⌘ 加逗号打开设置
    await page.keyboard.press('ControlOrMeta+,')
    await expect(page).toHaveURL(/\/settings$/)
  })

  test('Escape closes one layer at a time and focus goes back where it came from', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Layers')
    await say(bea, group, 'reply to me')
    await page.goto(`/chats/${group}`)
    const message = page.getByTestId('message').filter({ hasText: 'reply to me' })
    await expect(message).toBeVisible()

    // 三层：正在引用、群信息开着、消息菜单开着
    await message.hover()
    await message.getByRole('button', { name: 'Reply' }).click()
    await expect(page.getByTestId('replying')).toBeVisible()
    const info = page.getByRole('button', { name: 'Group info' })
    await info.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('group-panel')).toBeFocused()
    await message.hover()
    await message.getByRole('button', { name: 'Message options' }).click()
    await expect(page.getByTestId('message-menu')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('message-menu')).toHaveCount(0)
    await expect(page.getByTestId('group-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('group-panel')).toHaveCount(0)
    await expect(page.getByTestId('replying')).toBeVisible()
    // 面板关掉之后焦点先回到打开它的按钮：等它回去了再去点输入框，免得被它抢走
    await expect(info).toBeFocused()
    // 都关了，再按才是取消引用
    await composer(page).focus()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('replying')).toHaveCount(0)

    // 面板关掉之后焦点回到打开它的按钮
    await info.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('group-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(info).toBeFocused()

    // 对话框开着时，Esc 只关对话框，下面的面板不动
    await page.keyboard.press('Enter')
    await page.getByTestId('group-panel').getByRole('button', { name: 'Invite friends' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('group-panel')).toBeVisible()
  })

  test('the buttons that appear on hover can be reached with Tab', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await say(bea, conversation, 'tab to me')
    await page.goto(`/chats/${conversation}`)
    const reply = page
      .getByTestId('message')
      .filter({ hasText: 'tab to me' })
      .getByRole('button', { name: 'Reply' })

    // 往回走：从输入框按 Shift+Tab，会经过消息旁边的按钮，走到时它看得见、有焦点框
    await composer(page).focus()
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press('Shift+Tab')
      if (await reply.evaluate((element) => element === document.activeElement)) break
    }
    await expect(reply).toBeFocused()
    const outline = await reply.evaluate((element) => getComputedStyle(element).outlineStyle)
    expect(outline).not.toBe('none')
    // 它是渐渐显出来的，等它显完
    const opacity = () =>
      reply.evaluate((element) =>
        Number(getComputedStyle(element.parentElement as Element).opacity),
      )
    await expect.poll(opacity).toBe(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('replying')).toContainText('tab to me')
  })
})

test.describe('where the focus is', () => {
  const ACCENT = 'rgb(91, 91, 214)'
  const look = (page: Page, name: string | RegExp) =>
    page.getByRole('textbox', { name }).evaluate((element) => {
      const style = getComputedStyle(element)
      return { ring: style.outlineStyle, border: style.borderTopColor }
    })

  test('a text field shows it on its own border, without a second frame around it', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto(`/chats/${conversation}`)

    // 点进输入框和用键盘走到它，浏览器都算"要显示焦点"
    await composer(page).click()
    await expect(composer(page)).toBeFocused()
    expect(await look(page, 'Message')).toEqual({ ring: 'none', border: ACCENT })
    // 离开之后边框变回原来的颜色
    await page.keyboard.press('Shift+Tab')
    await expect(composer(page)).not.toBeFocused()
    expect((await look(page, 'Message')).border).not.toBe(ACCENT)

    // 带标签的单行输入框也一样
    await page.goto('/settings')
    const nickname = page.getByRole('textbox', { name: 'Nickname' })
    await nickname.focus()
    await expect(nickname).toBeFocused()
    expect(await look(page, 'Nickname')).toEqual({ ring: 'none', border: ACCENT })
  })
})

test.describe('profiles from the conversation', () => {
  test('clicking an avatar shows who it is', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Faces')
    await say(bea, group, 'hello everyone')
    await page.goto(`/chats/${group}`)

    // 群里：成员资料
    await page.getByTestId('message-avatar').click()
    const profile = page.getByRole('dialog').getByTestId('member-profile')
    await expect(profile.getByTestId('member-profile-name')).toHaveText(bea.nickname)
    await expect(profile).toContainText(bea.handle)
    await page.keyboard.press('Escape')

    // 单聊里：好友资料
    const direct = await directWith(account, bea)
    await say(bea, direct, 'just us')
    await page.goto(`/chats/${direct}`)
    await page.getByTestId('message-avatar').click()
    await expect(page).toHaveURL(new RegExp(`/contacts/${bea.id}$`))
    await expect(page.getByTestId('friend-name')).toHaveText(bea.nickname)
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 700 }, hasTouch: true })

  test('a conversation takes the whole screen, with the composer at the bottom', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await page.goto('/chats')
    await expect(page.getByTestId('tab-bar')).toBeVisible()

    await page.getByTestId('conversation').click()
    await expect(title(page)).toHaveText(bea.nickname)
    // 进入会话后没有底部的标签栏，输入区贴着屏幕底部
    await expect(page.getByTestId('tab-bar')).toHaveCount(0)
    const box = await composer(page).boundingBox()
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(700 - 24)
    // 手机上不自动聚焦：一聚焦键盘就弹出来
    await expect(composer(page)).not.toBeFocused()

    // 返回列表后标签栏回来
    await page.getByRole('link', { name: 'Back to conversations' }).click()
    await expect(page.getByTestId('tab-bar')).toBeVisible()
    await expect(page).toHaveURL(/\/chats$/)
    expect(conversation).toBeTruthy()
  })
})

test.describe('while loading and when loading fails', () => {
  test('lists show a placeholder first, and an error with a way to retry', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    await befriend(account, bea)

    // 会话列表迟迟不回来：显示占位，不是"还没有会话"
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/conversations', async (route) => {
      await held
      await route.continue()
    })
    await page.goto('/chats')
    await expect(page.getByTestId('loading')).toBeVisible()
    await expect(page.getByText('No conversations yet')).toHaveCount(0)
    release?.()
    await expect(page.getByTestId('conversation')).toHaveCount(1)
    await expect(page.getByTestId('loading')).toHaveCount(0)
    await page.unroute('**/api/conversations')

    // "群聊"取不到：原处说明原因，点"重试"之后正常
    await makeGroup(account, [await another('Cy'), await another('Dee')], 'Retry club')
    let failing = true
    await page.route('**/api/groups', (route) =>
      failing
        ? route.fulfill({ status: 503, json: { code: 'unavailable', message: '' } })
        : route.continue(),
    )
    await page.goto('/contacts/groups')
    await expect(page.getByRole('alert')).toContainText('temporarily unavailable')
    await expect(page.getByTestId('group')).toHaveCount(0)
    failing = false
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByTestId('group')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
