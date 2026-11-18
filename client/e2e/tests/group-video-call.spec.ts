// 群视频通话（F11）：在群里发起视频通话、开关摄像头、格子和放大、缩小后的小窗、通话记录。
//
// 测试环境里有一个临时的媒体转发服务（LiveKit，scripts/test-all 启动）。
// Chrome 内核用假的麦克风和假的摄像头；Safari 内核没有，和通话的其他测试一样跳过。

import type { Browser, Locator, Page } from '@playwright/test'
import { type Account, another, expect, gotoConnected, makeGroup, newApi, test } from './support'

async function open(
  browser: Browser,
  account: Account,
  group: string,
  before?: (page: Page) => Promise<unknown>,
): Promise<Page> {
  const context = await browser.newContext({ storageState: account.storageState })
  const page = await context.newPage()
  await before?.(page)
  await gotoConnected(page, `/chats/${group}`)
  return page
}

const screen = (page: Page) => page.getByTestId('group-call-screen')
const people = (page: Page) => page.getByTestId('group-call-member')
const banner = (page: Page) => page.getByTestId('group-call-banner')
const pick = (page: Page, account: Account) =>
  page.getByTestId('group-call-pick').filter({ hasText: account.nickname })
const tile = (page: Page, account: Account) =>
  page.locator(`[data-testid="group-call-member"][data-user="${account.id}"]`)
const picture = (page: Page, account: Account) =>
  tile(page, account).getByTestId('group-call-picture')

async function inCall(page: Page) {
  await expect(screen(page)).toHaveAttribute('data-phase', 'active', { timeout: 20_000 })
}

/** 这一路画面现在有多宽。还没有画面时是 0。 */
const width = (video: Locator) =>
  video.evaluate((element) => (element as HTMLVideoElement).videoWidth).catch(() => 0)

/** 画面真的出来了，并且是清楚的那一档（640 宽）或者小的那一档（320 宽）。 */
async function shows(video: Locator, tier: 'clear' | 'small') {
  const check = expect.poll(() => width(video), { timeout: 60_000 })
  if (tier === 'clear') await check.toBeGreaterThanOrEqual(600)
  else {
    await check.toBeGreaterThan(0)
    await expect.poll(() => width(video), { timeout: 60_000 }).toBeLessThanOrEqual(360)
  }
}

/** 记下这个页面拿到过的每一路麦克风、摄像头，之后好查它们放掉了没有。 */
const recordDevices = (page: Page) =>
  page.addInitScript(() => {
    const taken: MediaStreamTrack[] = []
    ;(window as unknown as { __taken: MediaStreamTrack[] }).__taken = taken
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints)
      taken.push(...stream.getTracks())
      return stream
    }
  })

/** 这个页面现在还占着几路摄像头、几路麦克风。 */
const inUse = (page: Page) =>
  page.evaluate(() => {
    const taken = (window as unknown as { __taken?: MediaStreamTrack[] }).__taken ?? []
    const live = taken.filter((track) => track.readyState === 'live')
    return {
      cameras: live.filter((track) => track.kind === 'video').length,
      microphones: live.filter((track) => track.kind === 'audio').length,
    }
  })

test.describe('group video calls', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake camera in WebKit')
  // 每个测试几个窗口都在编码假的画面（每个人两档），很吃 CPU：一个接一个跑，免得把同时在跑的别的测试拖到超时
  test.describe.configure({ mode: 'serial' })

  test('start a video call, join with and without the camera, enlarge, minimise, the record', async ({
    browser,
    account: owner,
  }) => {
    test.setTimeout(240_000)
    const one = await another('one')
    const two = await another('two')
    const group = await makeGroup(owner, [one, two], 'Video group')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    const twoPage = await open(browser, two, group)

    // 群的标题栏上有"语音通话"和"视频通话"两个按钮
    await expect(ownerPage.getByTestId('group-voice-call')).toBeVisible()
    await ownerPage.getByTestId('group-video-call').click()
    const picker = ownerPage.getByTestId('group-call-picker')
    await expect(ownerPage.getByRole('dialog', { name: 'Start a video call' })).toBeVisible()
    await pick(ownerPage, two).click()
    await picker.getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    // 发起的人摄像头是开着的，看得到自己
    await expect(screen(ownerPage)).toHaveAttribute('data-video', '')
    await expect(tile(ownerPage, owner)).toHaveAttribute('data-camera', '')
    await expect
      .poll(() => width(picture(ownerPage, owner)), { timeout: 30_000 })
      .toBeGreaterThan(0)

    // 被邀请的人：卡片写明是视频通话，只有"加入"和"忽略"
    const invitation = onePage.getByTestId('group-call-incoming')
    await expect(invitation).toContainText(`${owner.nickname} invites you to a group video call`)
    await expect(invitation.getByRole('button')).toHaveCount(2)
    // 没被邀请的人：横条写明是视频通话；标题栏上只剩"加入视频通话"，不能另外发起语音通话
    await expect(banner(twoPage)).toContainText('Video call in progress · 1 person')
    await expect(twoPage.getByTestId('group-voice-call')).toHaveCount(0)
    await expect(twoPage.getByTestId('group-video-call')).toHaveAccessibleName(
      'Join the video call',
    )

    // 从卡片加入：摄像头开着，两边互相看得到。两个人时收的是清楚的一档
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    await expect(tile(onePage, one)).toHaveAttribute('data-camera', '')
    await expect(tile(ownerPage, one)).toHaveAttribute('data-camera', '')
    await shows(picture(ownerPage, one), 'clear')
    await shows(picture(onePage, owner), 'clear')
    // 声音照常：看得到对方在说话
    await expect(tile(ownerPage, one)).toHaveAttribute('data-speaking', '', { timeout: 20_000 })

    // 从横条加入：摄像头不开，别人看到的是头像；进去之后自己开
    await banner(twoPage).getByRole('button', { name: 'Join' }).click()
    await inCall(twoPage)
    for (const page of [ownerPage, onePage, twoPage]) await expect(people(page)).toHaveCount(3)
    await expect(tile(twoPage, two)).not.toHaveAttribute('data-camera')
    await expect(tile(ownerPage, two)).not.toHaveAttribute('data-camera')
    await expect(picture(ownerPage, two)).toHaveCount(0)
    await expect(twoPage.getByTestId('group-call-camera')).toHaveAccessibleName('Camera on')
    // 他看别的两个人：两路，都是清楚的
    await shows(picture(twoPage, owner), 'clear')
    await shows(picture(twoPage, one), 'clear')
    await twoPage.getByTestId('group-call-camera').click()
    await expect(twoPage.getByTestId('group-call-camera')).toHaveAccessibleName('Camera off')
    await expect(tile(ownerPage, two)).toHaveAttribute('data-camera', '')
    await shows(picture(ownerPage, two), 'clear')

    // 放大一个人：他那一路是清楚的，其余的变成小的；再点一次回到格子
    const grid = ownerPage.getByTestId('group-call-members')
    await expect(grid).toHaveAttribute('data-layout', 'grid')
    await tile(ownerPage, one).getByTestId('group-call-enlarge').click()
    await expect(grid).toHaveAttribute('data-layout', 'focus')
    await expect(tile(ownerPage, one)).toHaveAttribute('data-enlarged', '')
    await shows(picture(ownerPage, one), 'clear')
    await shows(picture(ownerPage, two), 'small')
    await tile(ownerPage, one).getByTestId('group-call-enlarge').click()
    await expect(grid).toHaveAttribute('data-layout', 'grid')
    await shows(picture(ownerPage, two), 'clear')

    // 关掉摄像头：别人那里换成头像；再打开又有画面
    await onePage.getByTestId('group-call-camera').click()
    await expect(tile(ownerPage, one)).not.toHaveAttribute('data-camera')
    await expect(picture(ownerPage, one)).toHaveCount(0)
    await expect(tile(onePage, one)).not.toHaveAttribute('data-camera')
    await onePage.getByTestId('group-call-camera').click()
    await shows(picture(ownerPage, one), 'clear')

    // 缩小：一个带画面的小窗，可以照常发消息；点它回到通话界面
    await ownerPage.getByTestId('group-call-minimize').click()
    await expect(screen(ownerPage)).toHaveCount(0)
    const mini = ownerPage.getByTestId('group-call-mini')
    await expect(mini).toHaveAttribute('data-video', '')
    await expect(mini).toContainText('3 people')
    await shows(mini.getByTestId('group-call-picture'), 'small')
    await ownerPage.getByRole('textbox', { name: 'Message' }).fill('watching')
    await ownerPage.getByRole('textbox', { name: 'Message' }).press('Enter')
    await expect(ownerPage.getByText('watching').first()).toBeVisible()
    await mini.click()
    await inCall(ownerPage)
    await shows(picture(ownerPage, one), 'clear')

    // 通话中再邀请、静音这些和语音通话一样的东西还在
    await expect(ownerPage.getByTestId('group-call-invite')).toBeVisible()
    await onePage.getByTestId('group-call-mute').click()
    await expect(tile(ownerPage, one)).toHaveAttribute('data-muted', '')

    // 都离开之后，群里的通话记录写明是视频
    for (const page of [twoPage, onePage, ownerPage]) {
      await page.getByTestId('group-call-leave').click()
      await expect(screen(page)).toHaveCount(0)
    }
    await expect(onePage.getByTestId('call-record').last()).toHaveText(
      /^Video call \d+:\d\d · 3 people joined$/,
    )
    await expect(banner(onePage)).toHaveCount(0)
    // 又可以发起语音通话了
    await expect(onePage.getByTestId('group-voice-call')).toBeEnabled()
  })

  test('a voice call has no camera, and no video call can be started beside it', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Voice only')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    await ownerPage.getByTestId('group-voice-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    await expect(screen(ownerPage)).not.toHaveAttribute('data-video')
    await expect(ownerPage.getByTestId('group-call-camera')).toHaveCount(0)
    // 别人那里：只能加入这个语音通话
    await expect(banner(onePage)).toContainText('Voice call in progress')
    await expect(onePage.getByTestId('group-video-call')).toHaveCount(0)
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    await expect(onePage.getByTestId('group-call-camera')).toHaveCount(0)
    await expect(onePage.getByTestId('group-call-picture')).toHaveCount(0)
  })

  test('a blocked camera is explained and the call goes on with sound', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'No camera')
    // 麦克风照常，摄像头不让用
    const ownerPage = await open(browser, owner, group, (page) =>
      page.addInitScript(() => {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = (constraints) =>
          constraints?.video
            ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
            : original(constraints)
      }),
    )
    const onePage = await open(browser, one, group)
    await ownerPage.getByTestId('group-video-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    // 通话照常发起，别人照常响铃
    await inCall(ownerPage)
    await expect(ownerPage.getByTestId('group-call-camera-problem')).toContainText(
      'allowed this page to use the camera',
    )
    await ownerPage.getByRole('button', { name: 'OK' }).click()
    await expect(ownerPage.getByTestId('group-call-camera')).toHaveAccessibleName('Camera on')
    await expect(tile(ownerPage, owner)).not.toHaveAttribute('data-camera')
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    // 别人看到的是头像，听得到他
    await expect(tile(onePage, owner)).not.toHaveAttribute('data-camera')
    await expect(tile(onePage, owner)).toHaveAttribute('data-speaking', '', { timeout: 20_000 })
    await shows(picture(ownerPage, one), 'clear')
  })

  test('leaving, in whatever way, lets go of the camera and the microphone', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Lights off')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group, recordDevices)
    await ownerPage.getByTestId('group-video-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)

    // 自己离开
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    await expect(tile(ownerPage, one)).toHaveAttribute('data-camera', '')
    expect(await inUse(onePage)).toEqual({ cameras: 1, microphones: 1 })
    await onePage.getByTestId('group-call-leave').click()
    await expect(screen(onePage)).toHaveCount(0)
    await expect.poll(() => inUse(onePage)).toEqual({ cameras: 0, microphones: 0 })

    // 关掉摄像头：摄像头放掉，麦克风还在用
    await banner(onePage).getByRole('button', { name: 'Join' }).click()
    await inCall(onePage)
    expect(await inUse(onePage)).toEqual({ cameras: 0, microphones: 1 })
    await onePage.getByTestId('group-call-camera').click()
    await expect(tile(ownerPage, one)).toHaveAttribute('data-camera', '')
    expect((await inUse(onePage)).cameras).toBe(1)
    await onePage.getByTestId('group-call-camera').click()
    await expect.poll(async () => (await inUse(onePage)).cameras).toBe(0)
    await onePage.getByTestId('group-call-camera').click()
    await expect.poll(async () => (await inUse(onePage)).cameras).toBe(1)

    // 被移出群：通话界面马上收起来，摄像头和麦克风都放掉
    const api = await newApi(owner.storageState)
    const removed = await api.delete(`/api/conversations/${group}/members/${one.id}`)
    expect(removed.status(), 'remove member').toBe(200)
    await api.dispose()
    await expect(screen(onePage)).toHaveCount(0)
    await expect.poll(() => inUse(onePage)).toEqual({ cameras: 0, microphones: 0 })
    await expect(people(ownerPage)).toHaveCount(1)
  })

  test('the call ending for everyone lets go of the camera too', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Dissolved')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group, recordDevices)
    await ownerPage.getByTestId('group-video-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    await expect.poll(async () => (await inUse(onePage)).cameras).toBe(1)
    // 群主解散了群：通话随之结束
    const api = await newApi(owner.storageState)
    const dissolved = await api.post(`/api/conversations/${group}/dissolve`)
    expect(dissolved.status(), 'dissolve group').toBeLessThan(300)
    await api.dispose()
    await expect(screen(onePage)).toHaveCount(0)
    await expect.poll(() => inUse(onePage)).toEqual({ cameras: 0, microphones: 0 })
  })

  test('after a reload the call can be joined again, with the camera off', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Reload video')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    await ownerPage.getByTestId('group-video-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    await expect(tile(ownerPage, one)).toHaveAttribute('data-camera', '')

    // 刷新算离开：别人那里他不在了
    await onePage.reload()
    await expect(people(ownerPage)).toHaveCount(1)
    await expect(banner(onePage)).toContainText('Video call in progress · 1 person')
    // 再加入：摄像头是关的，要自己再开
    await banner(onePage).getByRole('button', { name: 'Join' }).click()
    await inCall(onePage)
    await expect(people(ownerPage)).toHaveCount(2)
    await expect(tile(onePage, one)).not.toHaveAttribute('data-camera')
    await expect(tile(ownerPage, one)).not.toHaveAttribute('data-camera')
    await onePage.getByTestId('group-call-camera').click()
    await shows(picture(ownerPage, one), 'clear')
  })
})
