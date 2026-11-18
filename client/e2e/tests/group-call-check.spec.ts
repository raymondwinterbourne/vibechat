// 群通话的技术验证页面（F10 第一段）：三个窗口进同一个验证用的房间，互相听得到。
//
// 测试环境里有一个临时的媒体转发服务（LiveKit，scripts/test-all 启动，
// 配置见 dev/livekit/livekit-test.yaml）。页面连网页地址下的 /livekit，由前端的服务器转过去。
// Chrome 内核用假的麦克风（会发出一段提示音）；Safari 内核没有假的麦克风，和通话的其他测试一样跳过。
//
// F11 第一段加上了画面：每个人同时发"清楚的、小的"两档，看的人指定要哪一档。假的摄像头同样只有
// Chrome 内核有。
//
// F12 第一段加上了共享屏幕：只发一档，别人收到的和发出去的一样大。"共享屏幕"不弹选择框，
// 直接拿到一段 1280×720 的假画面（support.ts 的 fakeScreen）。

import { mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import type { Browser, Locator, Page } from '@playwright/test'
import { type Account, another, expect, fakeScreen, test } from './support'

interface Probe {
  __iceServers?: string[]
  __connections?: number
}

/** 这个测试打开过的窗口。结束时要让它们好好离开房间，见 afterEach。 */
const opened: Page[] = []

async function open(browser: Browser, account: Account): Promise<Page> {
  const context = await browser.newContext({ storageState: account.storageState })
  // 记下页面建立了几条通话连接、用了哪些找路服务器
  await context.addInitScript(() => {
    const probe = window as unknown as Probe
    probe.__iceServers = []
    probe.__connections = 0
    const Original = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        super(config)
        probe.__connections = (probe.__connections ?? 0) + 1
        for (const server of config?.iceServers ?? []) {
          probe.__iceServers?.push(...[server.urls].flat())
        }
      }
    }
  })
  const page = await context.newPage()
  opened.push(page)
  await page.addInitScript(fakeScreen)
  await page.goto('/group-call-check')
  await expect(page.getByTestId('group-check-state')).toHaveText('idle')
  return page
}

async function join(page: Page) {
  await page.getByRole('button', { name: 'Join' }).click()
  // 没进去的话页面上会写原因：直接把它报出来，不用等到超时
  const state = page.getByTestId('group-check-state')
  const problem = page.getByRole('alert')
  await expect(state.getByText('connected').or(problem)).toBeVisible({ timeout: 20_000 })
  expect(await problem.allTextContents()).toEqual([])
}

const members = (page: Page) => page.getByTestId('group-check-member')

/** 收到的声音在涨：听得到别人。 */
async function hears(page: Page) {
  const received = page.getByTestId('group-check-received')
  const bytes = async () => Number(await received.getAttribute('data-bytes'))
  await expect.poll(bytes, { timeout: 20_000 }).toBeGreaterThan(0)
  const before = await bytes()
  await expect.poll(bytes, { timeout: 20_000 }).toBeGreaterThan(before)
}

/** `page` 里显示 `other` 这个窗口的那一行。 */
async function rowOf(page: Page, other: Page) {
  const identity = (await other.getByTestId('group-check-me').textContent()) ?? ''
  return members(page).filter({ hasText: identity })
}

const number = async (locator: Locator, attribute: string) =>
  Number(await locator.getAttribute(attribute))

/** 这个数在涨。 */
async function grows(locator: Locator, attribute = 'data-bytes') {
  const before = await number(locator, attribute)
  await expect.poll(() => number(locator, attribute), { timeout: 30_000 }).toBeGreaterThan(before)
}

/** 这个数不涨了：隔 4 秒看两次，一样。 */
async function stops(locator: Locator, attribute = 'data-bytes') {
  await expect
    .poll(
      async () => {
        const before = await number(locator, attribute)
        await locator.page().waitForTimeout(4000)
        return (await number(locator, attribute)) - before
      },
      { timeout: 60_000 },
    )
    .toBe(0)
}

const sentLayer = (page: Page, rid: 'q' | 'h') =>
  page.locator(`[data-testid="group-check-sent-layer"][data-rid="${rid}"]`)

// 验证用的房间只有一个，所有的窗口都进它。这个文件里的测试要数房间里有几个人，所以一个接一个跑：
// 不同内核的测试在不同的进程里，用一个目录当锁（建目录是原子的）。
const ROOM_LOCK = joinPath(tmpdir(), 'vc-e2e-group-check-room.lock')
/** 锁放了这么久还没还：拿着它的那个测试多半已经崩了，直接收回。 */
const ROOM_LOCK_STALE_MS = 6 * 60_000

async function takeRoom() {
  for (;;) {
    try {
      mkdirSync(ROOM_LOCK)
      return
    } catch {
      try {
        if (Date.now() - statSync(ROOM_LOCK).mtimeMs > ROOM_LOCK_STALE_MS)
          rmSync(ROOM_LOCK, { recursive: true })
      } catch {
        // 刚好被还回去了
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

test.describe('the group call check page', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')
  // 每个测试几个窗口都在编码假的画面（每个人两档），很吃 CPU：一个接一个跑，免得把同时在跑的别的测试拖到超时
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async () => {
    // 等房间的时间也算在测试的时限里：留够前面几个测试跑完的时间
    test.setTimeout(10 * 60_000)
    await takeRoom()
  })
  test.afterEach(async () => {
    // 让每个窗口像用户关掉页面那样离开：直接把窗口杀掉的话，媒体转发服务要过一会儿才发现人走了，
    // 下一个测试进房间时还会看到他们
    for (const page of opened.splice(0)) {
      await page.goto('about:blank').catch(() => {})
      await page
        .context()
        .close()
        .catch(() => {})
    }
    rmSync(ROOM_LOCK, { recursive: true, force: true })
  })

  test('three windows in the same room hear each other', async ({ browser, account }) => {
    // 同一个账号的两个窗口，加上另一个人
    const first = await open(browser, account)
    const second = await open(browser, account)
    const third = await open(browser, await another('room'))
    const all = [first, second, third]
    for (const page of all) await join(page)

    for (const page of all) {
      await expect(members(page)).toHaveCount(3)
      // 我在最前面
      await expect(members(page).first()).toHaveAttribute('data-me', '')
      await expect(members(page).first()).toContainText('Me')
      await expect(page.getByText('3 people in the room')).toBeVisible()
      await hears(page)
      // 自己的声音也在发出去
      await expect
        .poll(async () =>
          Number(await page.getByTestId('group-check-sent').getAttribute('data-bytes')),
        )
        .toBeGreaterThan(0)
    }
    // 同一个网络里：走 UDP，连的是媒体转发服务的声音端口
    await expect(first.getByTestId('group-check-protocol')).toHaveText('UDP')
    await expect(first.getByTestId('group-check-server')).toContainText(':7892')
    // 假的麦克风一直有声音：看得到别人在说话
    await expect(
      first.locator('[data-testid="group-check-member"][data-speaking]:not([data-me])').first(),
    ).toBeVisible({
      timeout: 20_000,
    })

    // 页面建立了通话连接，但没有用任何找路服务器（不向 Google 等外部服务发数据，NFR-PRI-04）
    for (const page of all) {
      const probe = await page.evaluate(() => {
        const { __connections, __iceServers } = window as unknown as Probe
        return { connections: __connections ?? 0, servers: __iceServers ?? [] }
      })
      expect(probe.connections).toBeGreaterThan(0)
      expect(probe.servers).toEqual([])
    }

    // 第一个人静音：自己和别人都看得到
    await first.getByRole('button', { name: 'Mute', exact: true }).click()
    await expect(members(first).first()).toHaveAttribute('data-muted', '')
    await expect(second.locator('[data-testid="group-check-member"][data-muted]')).toHaveCount(1)
    await expect(third.locator('[data-testid="group-check-member"][data-muted]')).toHaveCount(1)
    await first.getByRole('button', { name: 'Unmute' }).click()
    await expect(second.locator('[data-testid="group-check-member"][data-muted]')).toHaveCount(0)

    // 第三个人离开：另外两个人不受影响
    await third.getByRole('button', { name: 'Leave' }).click()
    await expect(third.getByTestId('group-check-state')).toHaveText('idle')
    await expect(members(first)).toHaveCount(2)
    await expect(members(second)).toHaveCount(2)
    await hears(first)
    await hears(second)
  })
  test('everyone sends two tiers and the viewer picks which one to get', async ({
    browser,
    account,
  }) => {
    const first = await open(browser, account)
    const second = await open(browser, account)
    const third = await open(browser, await another('picture'))
    const all = [first, second, third]
    for (const page of all) await join(page)
    for (const page of all) {
      await page.getByRole('button', { name: 'Turn camera on' }).click()
      await expect(page.getByRole('button', { name: 'Turn camera off' })).toBeVisible()
    }
    for (const page of all) {
      await expect(page.locator('[data-testid="group-check-member"][data-camera]')).toHaveCount(3)
      // 自己的画面和另外两个人的画面都显示出来了
      await expect(page.getByTestId('group-check-picture')).toHaveCount(3)
      // 发的是两档
      await expect(page.getByTestId('group-check-sent-layer')).toHaveCount(2)
      // 声音照常
      await hears(page)
    }

    // 没选过的按小的一档收
    const row = await rowOf(first, second)
    const received = row.getByTestId('group-check-received-video')
    await expect.poll(() => number(received, 'data-width'), { timeout: 30_000 }).toBeGreaterThan(0)
    await grows(received)
    const small = await number(received, 'data-width')
    // 小的那一档一直在发；清楚的那一档没有人要，停发
    await grows(sentLayer(second, 'q'))
    await stops(sentLayer(second, 'h'))

    // 第一个人要第二个人清楚的那一档：收到的变大，第二个人开始发清楚的
    await row.getByTestId('group-check-watch').selectOption('high')
    await expect
      .poll(() => number(received, 'data-width'), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(small * 1.5)
    const clear = await number(received, 'data-width')
    await grows(sentLayer(second, 'h'))
    console.log(`tiers received: small ${small} wide, clear ${clear} wide`)
    // 第三个人没有要清楚的：他收到的还是小的
    const seenByThird = (await rowOf(third, second)).getByTestId('group-check-received-video')
    expect(await number(seenByThird, 'data-width')).toBe(small)

    // 改回小的：收到的变小，清楚的那一档又停发
    await row.getByTestId('group-check-watch').selectOption('low')
    await expect.poll(() => number(received, 'data-width'), { timeout: 60_000 }).toBe(small)
    await stops(sentLayer(second, 'h'))

    // 不要：这一路不再收，画面也不显示了；别人的照常
    await row.getByTestId('group-check-watch').selectOption('off')
    await expect(row.getByText('No picture received')).toBeVisible({ timeout: 30_000 })
    await expect(row.getByTestId('group-check-picture')).toBeHidden()
    await grows(seenByThird)
    // 再要回来
    await row.getByTestId('group-check-watch').selectOption('low')
    await expect.poll(() => number(received, 'data-width'), { timeout: 60_000 }).toBe(small)

    // 第二个人关掉摄像头：别人那里他不再有画面
    await second.getByRole('button', { name: 'Turn camera off' }).click()
    await expect(first.locator('[data-testid="group-check-member"][data-camera]')).toHaveCount(2)
    await expect(third.locator('[data-testid="group-check-member"][data-camera]')).toHaveCount(2)
    await hears(first)
  })

  test('a ticket without the camera cannot send pictures', async ({ browser, account }) => {
    const first = await open(browser, account)
    const second = await open(browser, await another('voice-only'))
    // 第一个人要的是语音通话那样的凭证
    await first.getByLabel('Ticket allows the camera').uncheck()
    await join(first)
    await join(second)
    await expect(members(second)).toHaveCount(2)

    await first.getByRole('button', { name: 'Turn camera on' }).click()
    await expect(first.getByRole('alert')).toContainText("Couldn't turn the camera on")
    await expect(first.getByRole('button', { name: 'Turn camera on' })).toBeVisible()
    // 别人那里他没有画面；声音不受影响
    await expect(second.locator('[data-testid="group-check-member"][data-camera]')).toHaveCount(0)
    await hears(second)
    // 另一个人的凭证放行摄像头：他开得了，第一个人看得到
    await second.getByRole('button', { name: 'Turn camera on' }).click()
    await expect(first.locator('[data-testid="group-check-member"][data-camera]')).toHaveCount(1)
    const received = (await rowOf(first, second)).getByTestId('group-check-received-video')
    await grows(received)
  })

  test('a shared screen reaches everyone else whole, and goes away when sharing stops', async ({
    browser,
    account,
  }) => {
    const first = await open(browser, account)
    const second = await open(browser, account)
    const third = await open(browser, await another('screen'))
    const all = [first, second, third]
    for (const page of all) await join(page)

    await first.getByRole('button', { name: 'Share screen' }).click()
    await expect(first.getByRole('button', { name: 'Stop sharing' })).toBeVisible()
    // 共享的人：屏幕是 1280 宽，发出去的也是 1280 宽，没有被缩小
    const sent = first.getByTestId('group-check-sent-screen')
    await expect.poll(() => number(sent, 'data-width'), { timeout: 30_000 }).toBe(1280)
    expect(await number(sent, 'data-captured-width')).toBe(1280)
    await grows(sent)
    // 浏览器接受了"清晰度优先"（有的内核不说，那就是空的；说了就得是接受了）
    expect(['true', '']).toContain(await sent.getAttribute('data-resolution-first'))

    // 另外两个人：看得到是谁在共享，屏幕显示出来，收到的和发出去的一样大
    for (const page of [second, third]) {
      await expect((await rowOf(page, first)).first()).toHaveAttribute('data-screen', '')
      await expect(page.getByTestId('group-check-screen')).toBeVisible()
      const received = page.getByTestId('group-check-received-screen')
      await expect.poll(() => number(received, 'data-width'), { timeout: 30_000 }).toBe(1280)
      await grows(received)
      // 声音照常
      await hears(page)
    }
    // 按原始大小看：一个像素对一个像素，不缩小（判断字清不清楚要这样看）
    const shown = second.getByTestId('group-check-screen')
    const width = () => shown.evaluate((video: HTMLVideoElement) => video.clientWidth)
    expect(await width()).toBeLessThan(1280)
    await second.getByTestId('group-check-actual-size').click()
    await expect.poll(width).toBe(1280)
    await second.getByTestId('group-check-actual-size').click()
    await expect.poll(width).toBeLessThan(1280)
    // 屏幕的画面只发了一路，没有和摄像头混在一起：没有人开摄像头
    await expect(second.locator('[data-testid="group-check-member"][data-camera]')).toHaveCount(0)

    // 共享的同时打开摄像头：两路各走各的，别人两样都看得到
    await first.getByRole('button', { name: 'Turn camera on' }).click()
    await expect(second.locator('[data-testid="group-check-member"][data-camera]')).toHaveCount(1)
    await expect(second.getByTestId('group-check-screen')).toBeVisible()
    await grows(second.getByTestId('group-check-received-screen'))
    await grows((await rowOf(second, first)).getByTestId('group-check-received-video'))

    // 停止共享：别人那里屏幕没有了，摄像头还在
    await first.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(first.getByRole('button', { name: 'Share screen' })).toBeVisible()
    for (const page of [second, third]) {
      await expect(page.getByTestId('group-check-screen')).toHaveCount(0)
      await expect(page.locator('[data-testid="group-check-member"][data-screen]')).toHaveCount(0)
    }
    await expect(second.locator('[data-testid="group-check-member"][data-camera]')).toHaveCount(1)

    // 再共享一次，这回用浏览器自己的"停止共享"：一样算停止
    await first.getByRole('button', { name: 'Share screen' }).click()
    await expect(first.getByRole('button', { name: 'Stop sharing' })).toBeVisible()
    const again = second.getByTestId('group-check-screen')
    await expect(again).toBeVisible()
    // 新的一路真的到了对方那里：画面是 1280 宽。不拿"发出去的字节数在涨"来判断：
    // 页面上那个数可能还是上一次共享留下的，新的一路从零开始，要很久才追得上
    await expect
      .poll(() => again.evaluate((video: HTMLVideoElement) => video.videoWidth), {
        timeout: 30_000,
      })
      .toBe(1280)
    await first.evaluate(() => {
      const track = (globalThis as unknown as { sharedScreen: MediaStreamTrack }).sharedScreen
      track.stop()
      track.dispatchEvent(new Event('ended'))
    })
    await expect(first.getByRole('button', { name: 'Share screen' })).toBeVisible()
    await expect(second.getByTestId('group-check-screen')).toHaveCount(0)
  })

  test('a ticket without the screen cannot share one', async ({ browser, account }) => {
    const first = await open(browser, account)
    const second = await open(browser, await another('no-screen'))
    await first.getByLabel('Ticket allows sharing the screen').uncheck()
    await join(first)
    await join(second)
    await expect(members(second)).toHaveCount(2)

    await first.getByRole('button', { name: 'Share screen' }).click()
    await expect(first.getByRole('alert')).toContainText("Couldn't share the screen")
    await expect(first.getByRole('button', { name: 'Share screen' })).toBeVisible()
    await expect(second.locator('[data-testid="group-check-member"][data-screen]')).toHaveCount(0)
    await expect(second.getByTestId('group-check-screen')).toHaveCount(0)
    await hears(second)
  })
})
