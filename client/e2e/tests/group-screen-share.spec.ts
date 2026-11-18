// 群通话中共享屏幕（F12）：语音通话、视频通话里都可以；同一时间只有一个人共享；
// 别人那里屏幕自动占大块，可以放大别人再回来；共享的人离开，共享随之结束。
//
// 测试环境里有一个临时的媒体转发服务（LiveKit，scripts/test-all 启动）。
// "共享屏幕"不弹选择框，直接拿到一段 1280×720 的假画面（support.ts 的 fakeScreen）。
// Chrome 内核用假的麦克风和假的摄像头；Safari 内核没有，和通话的其他测试一样跳过。

import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test'
import {
  type Account,
  another,
  expect,
  fakeScreen,
  gotoConnected,
  makeGroup,
  newApi,
  test,
} from './support'

async function open(
  browser: Browser,
  account: Account,
  group: string,
  options: BrowserContextOptions = {},
  before?: (page: Page) => Promise<unknown>,
): Promise<Page> {
  const context = await browser.newContext({ storageState: account.storageState, ...options })
  const page = await context.newPage()
  await page.addInitScript(fakeScreen)
  await before?.(page)
  await gotoConnected(page, `/chats/${group}`)
  return page
}

const screen = (page: Page) => page.getByTestId('group-call-screen')
const people = (page: Page) => page.getByTestId('group-call-member')
const banner = (page: Page) => page.getByTestId('group-call-banner')
const tile = (page: Page, account: Account) =>
  page.locator(`[data-testid="group-call-member"][data-user="${account.id}"]`)
const screenTile = (page: Page) => page.getByTestId('group-call-screen-tile')
const share = (page: Page) => page.getByTestId('group-call-share')
const layout = (page: Page) => page.getByTestId('group-call-members')

async function inCall(page: Page) {
  await expect(screen(page)).toHaveAttribute('data-phase', 'active', { timeout: 20_000 })
}

const width = (video: Locator) =>
  video.evaluate((element) => (element as HTMLVideoElement).videoWidth).catch(() => 0)

/** 这个窗口看到了共享的屏幕：它是放大的那一格，画面是整个屏幕（1280 宽，没有被缩小）。 */
async function seesScreen(page: Page) {
  await expect(screenTile(page)).toHaveAttribute('data-enlarged', '')
  await expect(layout(page)).toHaveAttribute('data-layout', 'focus')
  const picture = page.getByTestId('group-call-shared-screen')
  await expect.poll(() => width(picture), { timeout: 60_000 }).toBe(1280)
  // 完整显示，不裁
  await expect(picture).toHaveClass(/object-contain/)
}

/** 发起一个通话，另外的人从邀请的卡片加入。 */
async function callOf(owner: Page, others: Page[], video: boolean) {
  await owner.getByTestId(video ? 'group-video-call' : 'group-voice-call').click()
  await owner.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
  await inCall(owner)
  for (const page of others) {
    await page.getByTestId('group-call-accept').click()
    await inCall(page)
  }
}

test.describe('sharing the screen in a group call', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')
  // 每个测试几个窗口都在编码画面，很吃 CPU：一个接一个跑，免得把同时在跑的别的测试拖到超时
  test.describe.configure({ mode: 'serial' })

  test('in a video call the screen takes the big tile for everyone else, one sharer at a time', async ({
    browser,
    account: owner,
  }) => {
    test.setTimeout(240_000)
    const one = await another('one')
    const two = await another('two')
    const group = await makeGroup(owner, [one, two], 'Shared screen')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    const twoPage = await open(browser, two, group)
    await callOf(ownerPage, [onePage], true)

    // 开始共享：自己的通话界面让开，屏幕上方有一条可以随时停
    await expect(share(ownerPage)).toHaveAccessibleName('Share screen')
    await share(ownerPage).click()
    const bar = ownerPage.getByTestId('group-call-sharing-bar')
    await expect(bar).toContainText("You're sharing your screen")
    await expect(screen(ownerPage)).toHaveCount(0)

    // 别人那里屏幕自动占大块；共享的人摄像头照常，他那一格还是他的画面
    await seesScreen(onePage)
    await expect(screenTile(onePage)).toContainText(`${owner.nickname}'s screen`)
    await expect(tile(onePage, owner)).toHaveAttribute('data-camera', '')
    await expect
      .poll(() => width(tile(onePage, owner).getByTestId('group-call-picture')), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0)
    // 诊断小字（试用阶段一直显示）：共享的人看得到屏幕多大、发出去多大，没有被缩小；
    // 看的人看得到收到的大小
    await expect(ownerPage.getByTestId('group-call-sent')).toContainText(
      'Screen 1280×720 · sending 1280×720',
      { timeout: 30_000 },
    )
    await expect(onePage.getByTestId('group-call-screen-received')).toContainText('1280×720', {
      timeout: 30_000,
    })
    await expect(onePage.getByTestId('group-call-screen-paused')).toHaveCount(0)
    // 这时别人不能共享，按钮上写着是谁在共享
    await expect(share(onePage)).toBeDisabled()
    await expect(share(onePage)).toHaveAccessibleName(`${owner.nickname} is sharing`)

    // 中途从横条加入的人直接看到正在共享的屏幕
    await banner(twoPage).getByRole('button', { name: 'Join' }).click()
    await inCall(twoPage)
    await seesScreen(twoPage)
    await expect(people(twoPage)).toHaveCount(3)

    // 可以放大别人，屏幕排到旁边那一排；点它再回来
    await tile(onePage, owner).getByTestId('group-call-enlarge').click()
    await expect(tile(onePage, owner)).toHaveAttribute('data-enlarged', '')
    await expect(screenTile(onePage)).not.toHaveAttribute('data-enlarged')
    await screenTile(onePage).getByTestId('group-call-enlarge').click()
    await seesScreen(onePage)
    // "回到格子"：屏幕和人排在一起
    await screenTile(onePage).getByRole('button', { name: 'Back to the grid' }).click()
    await expect(layout(onePage)).toHaveAttribute('data-layout', 'grid')
    await expect(screenTile(onePage)).toBeVisible()
    await screenTile(onePage).getByTestId('group-call-enlarge').click()
    await seesScreen(onePage)

    // 放大着的屏幕可以按原始大小看
    const zoom = onePage.getByTestId('group-call-screen-zoom')
    await expect(zoom).toHaveAttribute('data-scale', '1.00')
    await onePage.getByTestId('group-call-actual-size').click()
    await expect(zoom).not.toHaveAttribute('data-scale', '1.00')
    await onePage.getByTestId('group-call-actual-size').click()
    await expect(zoom).toHaveAttribute('data-scale', '1.00')

    // 缩小后的小窗里是共享的屏幕
    await onePage.getByTestId('group-call-minimize').click()
    const mini = onePage.getByTestId('group-call-mini')
    await expect(mini).toHaveAttribute('data-screen', '')
    await expect
      .poll(() => width(mini.getByTestId('group-call-picture')), { timeout: 60_000 })
      .toBe(1280)
    await mini.click()
    await inCall(onePage)
    await seesScreen(onePage)

    // 停止共享：别人的界面回到格子，共享的人摄像头还开着
    await ownerPage.getByTestId('group-call-stop-sharing').click()
    await expect(bar).toHaveCount(0)
    for (const page of [onePage, twoPage]) {
      await expect(screenTile(page)).toHaveCount(0)
      await expect(layout(page)).toHaveAttribute('data-layout', 'grid')
      await expect(tile(page, owner)).toHaveAttribute('data-camera', '')
    }
    // 现在别人可以共享了
    await expect(share(onePage)).toBeEnabled()
    await share(onePage).click()
    await expect(onePage.getByTestId('group-call-sharing-bar')).toBeVisible()
    await ownerPage.getByTestId('group-call-mini').click()
    await inCall(ownerPage)
    await seesScreen(ownerPage)
    await expect(screenTile(ownerPage)).toContainText(`${one.nickname}'s screen`)
  })

  test('in a voice call too, with faces as avatars, and it stays a voice call', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Voice and screen')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    await callOf(ownerPage, [onePage], false)
    await expect(screen(onePage)).not.toHaveAttribute('data-tiles')

    await share(ownerPage).click()
    await expect(ownerPage.getByTestId('group-call-sharing-bar')).toBeVisible()
    // 看的人：屏幕占大块，人那几格是头像；仍然是语音通话，没有摄像头按钮
    await seesScreen(onePage)
    await expect(screen(onePage)).toHaveAttribute('data-tiles', '')
    await expect(screen(onePage)).not.toHaveAttribute('data-video')
    await expect(people(onePage)).toHaveCount(2)
    await expect(onePage.getByTestId('group-call-picture')).toHaveCount(0)
    await expect(onePage.getByTestId('group-call-camera')).toHaveCount(0)
    // 声音照常
    await expect(tile(onePage, owner)).toHaveAttribute('data-speaking', '', { timeout: 20_000 })

    // 用浏览器自己的"停止共享"也算停止：看的人回到语音通话原来的界面
    await ownerPage.evaluate(() => {
      const track = (globalThis as unknown as { sharedScreen: MediaStreamTrack }).sharedScreen
      track.stop()
      track.dispatchEvent(new Event('ended'))
    })
    await expect(ownerPage.getByTestId('group-call-sharing-bar')).toHaveCount(0)
    await expect(screenTile(onePage)).toHaveCount(0)
    await expect(screen(onePage)).not.toHaveAttribute('data-tiles')
    await expect(share(onePage)).toBeEnabled()
    // 通话记录还是语音通话
    await ownerPage.getByTestId('group-call-mini').click()
    for (const page of [onePage, ownerPage]) await page.getByTestId('group-call-leave').click()
    await expect(onePage.getByTestId('call-record').last()).toHaveText(
      /^Voice call \d+:\d\d · 2 people joined$/,
    )
  })

  test('the share ends when the sharer leaves, is removed, or reloads', async ({
    browser,
    account: owner,
  }) => {
    test.setTimeout(180_000)
    const one = await another('one')
    const two = await another('two')
    const group = await makeGroup(owner, [one, two], 'Leaving sharer')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    const twoPage = await open(browser, two, group)
    await callOf(ownerPage, [onePage, twoPage], false)

    // 共享的人自己离开
    await share(onePage).click()
    await seesScreen(ownerPage)
    await onePage.getByTestId('group-call-mini').click()
    await onePage.getByTestId('group-call-leave').click()
    await expect(screenTile(ownerPage)).toHaveCount(0)
    await expect(share(ownerPage)).toBeEnabled()
    await expect(onePage.getByTestId('group-call-sharing-bar')).toHaveCount(0)

    // 共享的人刷新了页面
    await share(twoPage).click()
    await seesScreen(ownerPage)
    await twoPage.reload()
    await expect(screenTile(ownerPage)).toHaveCount(0)
    await expect(people(ownerPage)).toHaveCount(1)

    // 共享的人被移出群
    await banner(onePage).getByRole('button', { name: 'Join' }).click()
    await inCall(onePage)
    await share(onePage).click()
    await seesScreen(ownerPage)
    const api = await newApi(owner.storageState)
    const removed = await api.delete(`/api/conversations/${group}/members/${one.id}`)
    expect(removed.status(), 'remove member').toBe(200)
    await api.dispose()
    await expect(screenTile(ownerPage)).toHaveCount(0)
    await expect(onePage.getByTestId('group-call-sharing-bar')).toHaveCount(0)
    await expect(share(ownerPage)).toBeEnabled()
  })

  test('cancelling the picker says nothing; a refusal by the system is explained', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'No screen')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    await callOf(ownerPage, [onePage], false)
    const refuse = (message: string) =>
      ownerPage.evaluate((text) => {
        navigator.mediaDevices.getDisplayMedia = () =>
          Promise.reject(new DOMException(text, 'NotAllowedError'))
      }, message)

    // 用户自己在选择框里点了取消：什么都不说，别人那里也没有变化
    await refuse('Permission denied')
    await share(ownerPage).click()
    await expect(ownerPage.getByTestId('group-call-screen-problem')).toHaveCount(0)
    await expect(share(ownerPage)).toHaveAccessibleName('Share screen')
    await expect(share(onePage)).toBeEnabled()

    // 系统没有授权：说明原因，通话照常
    await refuse('Permission denied by system')
    await share(ownerPage).click()
    await expect(ownerPage.getByTestId('group-call-screen-problem')).toContainText(
      'The call goes on',
    )
    await ownerPage.getByRole('button', { name: 'OK' }).click()
    await inCall(ownerPage)
    await expect(screenTile(onePage)).toHaveCount(0)
    // 没有占着"正在共享"：别人可以共享
    await share(onePage).click()
    await seesScreen(ownerPage)
  })

  test('on a phone there is no share button, but a shared screen can be watched', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Phone viewer')
    const ownerPage = await open(browser, owner, group)
    const phone = await open(browser, one, group, {
      viewport: { width: 375, height: 700 },
      hasTouch: true,
    })
    await callOf(ownerPage, [phone], true)
    await expect(share(phone)).toHaveCount(0)
    await share(ownerPage).click()
    await seesScreen(phone)
    // 屏幕这一格没有伸到屏幕外面
    const box = await screenTile(phone).boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true)
  })

  test('a phone turned sideways gives the screen the whole height, and fills the page on demand', async ({
    browser,
    account: owner,
  }, testInfo) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Sideways')
    const ownerPage = await open(browser, owner, group)
    // 横过来的 iPhone：宽 844、高 390。它的 Safari 不能把一块内容全屏
    const phone = await open(
      browser,
      one,
      group,
      { viewport: { width: 844, height: 390 }, hasTouch: true },
      (page) =>
        page.addInitScript(() => {
          Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false })
        }),
    )
    await callOf(ownerPage, [phone], true)
    await share(ownerPage).click()
    await seesScreen(phone)
    await phone.screenshot({ path: testInfo.outputPath('sideways.png') })

    // 通话界面盖住整个页面（左边的导航栏也盖住）；屏幕占满左边的整个高度，人和按钮在右边一条窄栏里
    const call = await screen(phone).boundingBox()
    expect(call?.x).toBe(0)
    const box = await screenTile(phone).boundingBox()
    expect(box && box.height > 390 * 0.85).toBe(true)
    expect(box && box.x + box.width < 844 - 100).toBe(true)
    const leave = await phone.getByTestId('group-call-leave').boundingBox()
    expect(leave && box && leave.x > box.x + box.width).toBe(true)
    // 按钮还点得到，名字在无障碍名称里
    await expect(phone.getByTestId('group-call-leave')).toHaveAccessibleName('Leave')

    // "全屏"：这里不能用浏览器的全屏，改成页面内铺满
    const toggle = screenTile(phone).locator('[data-full-screen-toggle]')
    await expect(toggle).toHaveAccessibleName('Full screen')
    await toggle.click()
    await expect(screenTile(phone)).toHaveAttribute('data-full-screen', '')
    const filled = await screenTile(phone).boundingBox()
    expect(filled).toEqual({ x: 0, y: 0, width: 844, height: 390 })
    await phone.screenshot({ path: testInfo.outputPath('filled.png') })
    // 放大照常能用
    const zoom = phone.getByTestId('group-call-screen-zoom')
    await expect(zoom).toHaveAttribute('data-scale', '1.00')
    await zoom.dblclick()
    await expect(zoom).not.toHaveAttribute('data-scale', '1.00')
    // 退出
    await expect(toggle).toHaveAccessibleName('Exit full screen')
    await toggle.click()
    await expect(screenTile(phone)).not.toHaveAttribute('data-full-screen')
    await expect(screenTile(phone)).toHaveAttribute('data-enlarged', '')
  })
})
