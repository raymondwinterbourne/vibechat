// 一对一共享屏幕（F7）：语音、视频通话里共享，对方完整地看到屏幕；摄像头暂停后恢复；
// 用浏览器自己的"停止共享"也算停止；同一时间只有一个人共享；手机上不能共享；旧版本的桌面端提示更新。
//
// 测试里没有真的屏幕：选择框换成一段程序画出来的品红色画面。Safari 内核没有假的麦克风，跳过。

import type { Browser, BrowserContextOptions, Page } from '@playwright/test'
import { type Account, another, befriend, expect, fakeScreen, gotoConnected, test } from './support'

async function window(
  browser: Browser,
  account: Account,
  conversation: string,
  options: BrowserContextOptions = {},
): Promise<Page> {
  const context = await browser.newContext({ storageState: account.storageState, ...options })
  const page = await context.newPage()
  await page.addInitScript(fakeScreen)
  await gotoConnected(page, `/chats/${conversation}`)
  return page
}

/** 打一通电话，接通。 */
async function inCall(
  browser: Browser,
  account: Account,
  options: { video?: boolean; callee?: BrowserContextOptions } = {},
) {
  const friend = await another('Share')
  const conversation = await befriend(account, friend)
  const caller = await window(browser, account, conversation)
  const callee = await window(browser, friend, conversation, options.callee)
  await caller.getByTestId(options.video ? 'video-call' : 'voice-call').click()
  await callee.getByTestId('call-incoming').getByTestId('call-accept').click()
  for (const page of [caller, callee]) {
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })
  }
  return { caller, callee }
}

/** 这一路画面中间偏上那一点的颜色。 */
function colorAt(page: Page, testId: string) {
  return page
    .getByTestId(testId)
    .evaluate((element) => {
      const video = element as HTMLVideoElement
      if (video.videoWidth === 0) return null
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const g = canvas.getContext('2d') as CanvasRenderingContext2D
      g.drawImage(video, 0, 0)
      const [r, gr, b] = g.getImageData(Math.floor(video.videoWidth / 2), 20, 1, 1).data
      return { r: r ?? 0, g: gr ?? 0, b: b ?? 0 }
    })
    .catch(() => null)
}

/** 看到的是品红色的那个屏幕。 */
async function seesScreen(page: Page) {
  await expect
    .poll(
      async () => {
        const color = await colorAt(page, 'call-shared-screen')
        return color !== null && color.r > 180 && color.g < 90 && color.b > 180
      },
      { timeout: 20_000 },
    )
    .toBe(true)
}

test.describe('sharing the screen', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')
  // 两个窗口都在编码画面，很吃 CPU：一个接一个跑
  test.describe.configure({ mode: 'serial' })

  test('in a voice call the other side sees the whole screen, and it ends when sharing stops', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await inCall(browser, account)
    // 两个窗口在同一台机器上：直连
    await expect(caller.getByTestId('call-path')).toHaveText('Direct', { timeout: 10_000 })
    await caller.getByTestId('call-share').click()

    // 共享的人：通话界面缩小，顶上一条提示
    await expect(caller.getByTestId('call-sharing-bar')).toContainText("You're sharing your screen")
    await expect(caller.getByTestId('call-screen')).toHaveCount(0)
    await expect(caller.getByTestId('call-mini')).toBeVisible()
    // 共享的一边的诊断小字：发出去多大、清晰度优先有没有被接受
    await expect(caller.getByTestId('call-sent')).toContainText(/sending \d+×\d+/, {
      timeout: 10_000,
    })
    await expect(caller.getByTestId('call-sent')).toContainText('sharpness first')

    // 看的人：屏幕完整显示，写明对方在共享；这时不能共享
    await seesScreen(callee)
    await expect(callee.getByTestId('call-shared-screen')).toHaveClass(/object-contain/)
    await expect(callee.getByTestId('call-status')).toContainText('Sharing their screen')
    await expect(callee.getByTestId('call-share')).toBeDisabled()
    await expect(callee.getByTestId('call-share')).toHaveAccessibleName("They're sharing")

    // 诊断小字：收到的画面多大、多少码率
    await expect(callee.getByTestId('call-received')).toHaveText(/^ · 1280×720 · \d+\.\d Mbps$/, {
      timeout: 10_000,
    })
    // 电脑上：原始大小和适应窗口来回切换；双击放大、再双击还原；滚轮放大
    const zoom = callee.getByTestId('call-screen-zoom')
    await callee.getByTestId('call-actual-size').click()
    await expect(zoom).not.toHaveAttribute('data-scale', '1.00')
    await expect(callee.getByTestId('call-actual-size')).toHaveText('Fit to window')
    await callee.getByTestId('call-actual-size').click()
    await expect(zoom).toHaveAttribute('data-scale', '1.00')
    await zoom.dblclick()
    await expect(zoom).toHaveAttribute('data-scale', '2.50')
    await zoom.dblclick()
    await expect(zoom).toHaveAttribute('data-scale', '1.00')
    await zoom.hover()
    await callee.mouse.wheel(0, -300)
    await expect(zoom).not.toHaveAttribute('data-scale', '1.00')

    await caller.getByTestId('call-stop-sharing').click()
    await expect(caller.getByTestId('call-sharing-bar')).toHaveCount(0)
    await expect(callee.getByTestId('call-shared-screen')).toHaveCount(0)
    // 回到语音通话的样子，通话照常
    await expect(callee.getByTestId('call-screen')).not.toHaveAttribute('data-video', '')
    await expect(callee.getByTestId('call-share')).toBeEnabled()
    await callee.getByTestId('call-hangup').click()
    await expect(caller.getByTestId('call-mini')).toBeHidden({ timeout: 10_000 })
  })

  test('in a video call the camera pauses while sharing and comes back afterwards', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await inCall(browser, account, { video: true })
    await expect(callee.getByTestId('call-remote-video')).toBeVisible({ timeout: 20_000 })
    await caller.getByTestId('call-share').click()
    await seesScreen(callee)
    await expect(callee.getByTestId('call-remote-video')).toHaveCount(0)

    // 展开通话界面：自己的摄像头小窗没有了，摄像头按钮是灰的；在这里也能停止
    await caller.getByTestId('call-mini').click()
    await expect(caller.getByTestId('call-local-video')).toHaveCount(0)
    await expect(caller.getByTestId('call-camera')).toBeDisabled()
    await caller.getByTestId('call-share').click()

    await expect(caller.getByTestId('call-local-video')).toBeVisible({ timeout: 10_000 })
    await expect(callee.getByTestId('call-shared-screen')).toHaveCount(0)
    await expect
      .poll(
        () =>
          callee
            .getByTestId('call-remote-video')
            .evaluate((v) => (v as HTMLVideoElement).videoWidth)
            .catch(() => 0),
        {
          timeout: 20_000,
        },
      )
      .toBeGreaterThan(0)
    await caller.getByTestId('call-hangup').click()
  })

  test("stopping from the browser's own bar stops sharing for both sides", async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await inCall(browser, account)
    await caller.getByTestId('call-share').click()
    await seesScreen(callee)
    // 浏览器那边停止了：这一路画面结束
    await caller.evaluate(() => {
      const track = (window as unknown as { sharedScreen: MediaStreamTrack }).sharedScreen
      track.stop()
      track.dispatchEvent(new Event('ended'))
    })
    await expect(caller.getByTestId('call-sharing-bar')).toHaveCount(0)
    await expect(callee.getByTestId('call-shared-screen')).toHaveCount(0)
    await caller.getByTestId('call-mini').click()
    await caller.getByTestId('call-hangup').click()
  })

  test('cancelling the picker says nothing; a refusal by the system is explained', async ({
    browser,
    account,
  }) => {
    const { caller } = await inCall(browser, account)
    const refuse = (message: string) =>
      caller.evaluate((text) => {
        navigator.mediaDevices.getDisplayMedia = async () => {
          throw new DOMException(text, 'NotAllowedError')
        }
      }, message)
    await refuse('Permission denied')
    await caller.getByTestId('call-share').click()
    await expect(caller.getByTestId('call-screen-problem')).toHaveCount(0)
    await expect(caller.getByTestId('call-sharing-bar')).toHaveCount(0)

    await refuse('Permission denied by system')
    await caller.getByTestId('call-share').click()
    await expect(caller.getByTestId('call-screen-problem')).toContainText(
      'Screen & System Audio Recording',
    )
    await caller.getByRole('button', { name: 'OK' }).click()
    // 通话照常
    await expect(caller.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active')
    await caller.getByTestId('call-hangup').click()
  })

  test('on a phone there is no share button, but a shared screen can be watched and zoomed', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await inCall(browser, account, {
      callee: { viewport: { width: 375, height: 700 }, hasTouch: true },
    })
    await expect(callee.getByTestId('call-mute')).toBeVisible()
    await expect(callee.getByTestId('call-share')).toHaveCount(0)
    await caller.getByTestId('call-share').click()
    await seesScreen(callee)

    // 双指张开放大，单指拖动，双击还原
    const zoom = callee.getByTestId('call-screen-zoom')
    const box = await zoom.boundingBox()
    const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2
    const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2
    const touch = (identifier: number, x: number, y: number) => ({
      identifier,
      clientX: x,
      clientY: y,
    })
    const fingers = async (
      type: string,
      points: { identifier: number; clientX: number; clientY: number }[],
    ) =>
      zoom.dispatchEvent(type, {
        touches: type === 'touchend' ? [] : points,
        changedTouches: points,
        targetTouches: type === 'touchend' ? [] : points,
      })
    await fingers('touchstart', [touch(0, cx - 20, cy), touch(1, cx + 20, cy)])
    await fingers('touchmove', [touch(0, cx - 80, cy), touch(1, cx + 80, cy)])
    await fingers('touchend', [touch(0, cx - 80, cy), touch(1, cx + 80, cy)])
    await expect(zoom).toHaveAttribute('data-scale', '4.00')
    for (let n = 0; n < 2; n++) {
      await fingers('touchstart', [touch(0, cx, cy)])
      await fingers('touchend', [touch(0, cx, cy)])
    }
    await expect(zoom).toHaveAttribute('data-scale', '1.00')

    await caller.getByTestId('call-stop-sharing').click()
    await expect(callee.getByTestId('call-shared-screen')).toHaveCount(0)
    await callee.getByTestId('call-hangup').click()
  })

  test('a phone turned sideways sees the whole call, and fills the page on demand', async ({
    browser,
    account,
  }, testInfo) => {
    // 横过来的 iPhone：宽 844、高 390，它的 Safari 不能把一块内容全屏
    const { caller, callee } = await inCall(browser, account, {
      video: true,
      callee: { viewport: { width: 844, height: 390 }, hasTouch: true },
    })
    await callee.addInitScript(() => {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false })
    })
    await callee.evaluate(() => {
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false })
    })
    await callee.screenshot({ path: testInfo.outputPath('video.png') })
    await caller.getByTestId('call-share').click()
    await seesScreen(callee)
    await callee.screenshot({ path: testInfo.outputPath('sharing.png') })
    // 通话界面盖住整个页面，左边的导航栏也盖住；按钮在画面里
    expect((await callee.getByTestId('call-screen').boundingBox())?.x).toBe(0)
    const hangUp = await callee.getByTestId('call-hangup').boundingBox()
    expect(hangUp && hangUp.y + hangUp.height <= 390).toBe(true)

    // "全屏"：页面内铺满，只留画面和退出
    await callee.getByTestId('call-full-screen').click()
    await expect(callee.getByTestId('call-screen')).toHaveAttribute('data-full-screen', '')
    await expect(callee.getByTestId('call-hangup')).toBeHidden()
    await callee.screenshot({ path: testInfo.outputPath('filled.png') })
    await expect(callee.getByTestId('call-exit-full-screen')).toHaveAccessibleName(
      'Exit full screen',
    )
    await callee.getByTestId('call-exit-full-screen').click()
    await expect(callee.getByTestId('call-screen')).not.toHaveAttribute('data-full-screen')
    await expect(callee.getByTestId('call-hangup')).toBeVisible()
    await caller.getByTestId('call-stop-sharing').click()
    await callee.getByTestId('call-hangup').click()
  })

  test('an older desktop app is asked to update before sharing the screen', async ({
    browser,
    account,
  }) => {
    const friend = await another('Share')
    const conversation = await befriend(account, friend)
    const context = await browser.newContext({ storageState: account.storageState })
    const page = await context.newPage()
    // 让页面以为自己在 0.3.0 的桌面端里：那个版本不放行屏幕的画面
    await page.addInitScript(() => {
      Object.assign(window, {
        vibeDesktop: {
          version: '0.3.0',
          setUnreadCount() {},
          showWindow() {},
          setLanguage() {},
          callAlert() {},
          onCommand: () => () => {},
        },
      })
    })
    await page.addInitScript(fakeScreen)
    await gotoConnected(page, `/chats/${conversation}`)
    const callee = await window(browser, friend, conversation)
    await page.getByTestId('voice-call').click()
    await callee.getByTestId('call-incoming').getByTestId('call-accept').click()
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })
    await page.getByTestId('call-share').click()
    await expect(page.getByTestId('desktop-too-old')).toContainText(
      'Share screen needs version 0.4.0 or later',
    )
    await expect(page.getByTestId('call-sharing-bar')).toHaveCount(0)
    await context.close()
  })
})
