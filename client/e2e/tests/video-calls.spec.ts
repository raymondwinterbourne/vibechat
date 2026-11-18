// 一对一视频通话（F5）：接通后双方都看得到画面、开关摄像头、语音接听、缩小，以及通话记录。
//
// Chrome 内核用假的摄像头（会动的测试画面）；Safari 内核没有假的摄像头，跳过。

import type { Browser, Page } from '@playwright/test'
import { type Account, another, befriend, expect, gotoConnected, test } from './support'

async function window(browser: Browser, account: Account, conversation: string): Promise<Page> {
  const context = await browser.newContext({ storageState: account.storageState })
  const page = await context.newPage()
  await gotoConnected(page, `/chats/${conversation}`)
  return page
}

async function pair(browser: Browser, account: Account) {
  const friend = await another('Video')
  const conversation = await befriend(account, friend)
  const caller = await window(browser, account, conversation)
  const callee = await window(browser, friend, conversation)
  return { friend, caller, callee }
}

/** 这一路画面真的在动：有宽度。 */
async function seesPicture(page: Page, testId: string) {
  await expect
    .poll(
      () =>
        page
          .getByTestId(testId)
          .evaluate((video) => (video as HTMLVideoElement).videoWidth)
          .catch(() => 0),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0)
}

async function connected(caller: Page, callee: Page) {
  for (const page of [caller, callee]) {
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })
  }
}

test.describe('video calls', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake camera in WebKit')
  // 每个测试两个窗口都在编码假的画面，很吃 CPU：一个接一个跑，免得把同时在跑的别的测试拖到超时
  test.describe.configure({ mode: 'serial' })

  test('both sides see each other, and the record says it was a video call', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await pair(browser, account)
    await caller.getByTestId('video-call').click()
    // 打出去时就看得到自己
    await seesPicture(caller, 'call-local-video')
    const card = callee.getByTestId('call-incoming')
    await expect(card).toContainText('is video calling you')
    await card.getByTestId('call-accept').click()

    await connected(caller, callee)
    for (const page of [caller, callee]) {
      await seesPicture(page, 'call-remote-video')
      await seesPicture(page, 'call-local-video')
    }
    // 自己的画面像照镜子
    await expect(caller.getByTestId('call-local-video')).toHaveClass(/-scale-x-100/)
    await expect(caller.getByTestId('call-remote-video')).not.toHaveClass(/-scale-x-100/)

    await caller.getByTestId('call-hangup').click()
    for (const page of [caller, callee]) {
      await expect(page.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 })
      await expect(page.getByTestId('call-record').last()).toHaveText(/^Video call 0:\d\d$/)
    }
    await expect(
      callee
        .getByTestId('conversation')
        .filter({ hasText: account.nickname })
        .getByTestId('conversation-summary'),
    ).toHaveText('[Video call]')
  })

  test('turning the camera off shows the other side who it is instead', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await pair(browser, account)
    await caller.getByTestId('video-call').click()
    await callee.getByTestId('call-accept').click()
    await connected(caller, callee)
    await seesPicture(callee, 'call-remote-video')

    await caller.getByTestId('call-camera').click()
    await expect(caller.getByTestId('call-camera')).toHaveAccessibleName('Camera on')
    await expect(caller.getByTestId('call-local-video')).toHaveCount(0)
    await expect(callee.getByTestId('call-peer-camera-off')).toHaveText('Their camera is off')
    await expect(callee.getByTestId('call-remote-video')).toHaveCount(0)

    await caller.getByTestId('call-camera').click()
    await seesPicture(callee, 'call-remote-video')
    await expect(callee.getByTestId('call-peer-camera-off')).toHaveCount(0)
  })

  test('a video call can be answered with voice only, and the camera turned on later', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await pair(browser, account)
    await caller.getByTestId('video-call').click()
    await callee.getByTestId('call-accept-voice').click()
    await connected(caller, callee)
    await expect(caller.getByTestId('call-peer-camera-off')).toBeVisible()
    await expect(callee.getByTestId('call-local-video')).toHaveCount(0)
    // 被叫照样看得到主叫
    await seesPicture(callee, 'call-remote-video')

    await callee.getByTestId('call-camera').click()
    await seesPicture(caller, 'call-remote-video')
  })

  test('a blocked camera is explained, and the call goes on without a picture', async ({
    browser,
    account,
  }) => {
    const friend = await another('Video')
    const conversation = await befriend(account, friend)
    const context = await browser.newContext({ storageState: account.storageState })
    const caller = await context.newPage()
    // 只拦摄像头，麦克风照常
    await caller.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = (constraints) =>
        constraints?.video
          ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
          : original(constraints)
    })
    await gotoConnected(caller, `/chats/${conversation}`)
    const callee = await window(browser, friend, conversation)

    await caller.getByTestId('video-call').click()
    await expect(caller.getByTestId('call-camera-problem')).toContainText(
      'allowed this page to use the camera',
    )
    await caller.getByRole('button', { name: 'OK' }).click()
    await callee.getByTestId('call-accept').click()
    await connected(caller, callee)
    // 主叫看得到被叫；被叫看到"对方已关闭摄像头"
    await seesPicture(caller, 'call-remote-video')
    await expect(callee.getByTestId('call-peer-camera-off')).toBeVisible()
    await expect(caller.getByTestId('call-camera')).toHaveAccessibleName('Camera on')
  })

  test('a minimized video call keeps a small picture of the other side', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await pair(browser, account)
    await caller.getByTestId('video-call').click()
    await callee.getByTestId('call-accept').click()
    await connected(caller, callee)
    await caller.getByTestId('call-minimize').click()
    await expect(caller.getByTestId('call-screen')).toBeHidden()
    await seesPicture(caller, 'call-mini-video')
    await caller.getByTestId('call-mini').click()
    await expect(caller.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active')
    await callee.getByTestId('call-hangup').click()
    await expect(caller.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 })
  })
})

test('an older desktop app is asked to update before a video call, and can still answer with voice', async ({
  browser,
  account,
}) => {
  const friend = await another('Video')
  const conversation = await befriend(account, friend)
  const context = await browser.newContext({ storageState: account.storageState })
  const page = await context.newPage()
  // 让页面以为自己在 0.2.0 的桌面端里：那个版本不放行摄像头
  await page.addInitScript(() => {
    Object.assign(window, {
      vibeDesktop: {
        version: '0.2.0',
        setUnreadCount() {},
        showWindow() {},
        setLanguage() {},
        callAlert() {},
        onCommand: () => () => {},
      },
    })
  })
  await gotoConnected(page, `/chats/${conversation}`)
  await page.getByTestId('video-call').click()
  await expect(page.getByTestId('desktop-too-old')).toContainText(
    'Video call needs version 0.3.0 or later',
  )
  await expect(page.getByTestId('call-screen')).toHaveCount(0)
  await context.close()
})
