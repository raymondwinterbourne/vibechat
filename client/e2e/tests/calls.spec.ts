// 一对一语音通话（F3）：打出去、接听、挂断、拒绝、取消、没人接、缩小后继续聊天，以及会话里的通话记录。
//
// 两个人各开一个窗口。Chrome 内核用假的麦克风（会发出一段提示音）；
// Safari 内核没有假的麦克风，和语音消息一样跳过。测试环境的响铃时间调成了 10 秒（scripts/e2e-stack）。

import type { Browser, Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  controlConnection,
  expect,
  gotoConnected,
  newApi,
  notices,
  openAsAdmin,
  setForeground,
  takeOverNotifications,
  test,
} from './support'

async function window(
  browser: Browser,
  account: Account,
  conversation: string,
  /** 页面打开之前要做的事：接管系统通知、让麦克风不可用等。 */
  prepare?: (page: Page) => Promise<unknown>,
): Promise<Page> {
  const context = await browser.newContext({ storageState: account.storageState })
  const page = await context.newPage()
  await prepare?.(page)
  await gotoConnected(page, `/chats/${conversation}`)
  return page
}

/** 让这个页面拿不到麦克风，像用户没有授权一样。 */
function noMicrophone(page: Page) {
  return page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
  })
}

/** 两个好友各开一个窗口，停在他们的单聊里。 */
async function pair(browser: Browser, account: Account) {
  const friend = await another('Callee')
  const conversation = await befriend(account, friend)
  const caller = await window(browser, account, conversation)
  const callee = await window(browser, friend, conversation)
  return { friend, conversation, caller, callee }
}

/** 收到的声音在涨：真的听得到对方。 */
async function hears(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const audio = document.querySelector<HTMLAudioElement>('[data-testid="call-audio"]')
          const stream = audio?.srcObject as MediaStream | null
          return stream?.getAudioTracks().length ?? 0
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0)
}

test.describe('voice calls', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')

  test('a call is answered, talked through and hung up, and both sides keep a record', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await pair(browser, account)

    await caller.getByTestId('voice-call').click()
    const screen = caller.getByTestId('call-screen')
    await expect(screen).toHaveAttribute('data-phase', 'outgoing')
    await expect(caller.getByTestId('call-status')).toHaveText('Calling…')

    const card = callee.getByTestId('call-incoming')
    await expect(card).toContainText(account.nickname)
    await card.getByTestId('call-accept').click()
    await expect(card).toBeHidden()

    // 两边都接通，时长在走
    for (const page of [caller, callee]) {
      await expect(page.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active', {
        timeout: 20_000,
      })
      await expect(page.getByTestId('call-status')).toHaveText(/^0:0\d$/)
    }
    await hears(caller)
    await hears(callee)

    // 静音
    await callee.getByTestId('call-mute').click()
    await expect(callee.getByTestId('call-mute')).toHaveAttribute('aria-pressed', 'true')

    await caller.getByTestId('call-hangup').click()
    await expect(caller.getByTestId('call-status')).toHaveText(/^Call ended 0:\d\d$/)
    for (const page of [caller, callee]) {
      await expect(page.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 })
      const record = page.getByTestId('call-record').last()
      await expect(record).toHaveAttribute('data-outcome', 'completed')
      await expect(record).toHaveText(/^Voice call 0:\d\d$/)
    }
    // 会话列表的摘要
    await expect(
      callee
        .getByTestId('conversation')
        .filter({ hasText: account.nickname })
        .getByTestId('conversation-summary'),
    ).toHaveText('[Voice call]')
  })

  test('a declined call tells the caller and leaves a record', async ({ browser, account }) => {
    const { caller, callee } = await pair(browser, account)
    await caller.getByTestId('voice-call').click()
    await callee.getByTestId('call-reject').click()
    await expect(caller.getByTestId('call-status')).toHaveText('Declined')
    await expect(caller.getByTestId('call-record').last()).toHaveText('Declined')
    await expect(callee.getByTestId('call-record').last()).toHaveAttribute(
      'data-outcome',
      'rejected',
    )
  })

  test('a cancelled call stops the ringing and is a missed call for the other side', async ({
    browser,
    account,
  }) => {
    const { caller, callee } = await pair(browser, account)
    await caller.getByTestId('voice-call').click()
    await expect(callee.getByTestId('call-incoming')).toBeVisible()
    await caller.getByTestId('call-hangup').click()
    await expect(caller.getByTestId('call-status')).toHaveText('Cancelled')
    await expect(callee.getByTestId('call-incoming')).toBeHidden()
    const missed = callee.getByTestId('call-record').last()
    await expect(missed).toHaveText('Missed call')
    await expect(missed).toHaveClass(/text-danger/)
    await expect(caller.getByTestId('call-record').last()).toHaveText('Cancelled')
  })

  test('nobody answering ends the call as unanswered', async ({ browser, account }) => {
    const { caller, callee } = await pair(browser, account)
    await caller.getByTestId('voice-call').click()
    await expect(callee.getByTestId('call-incoming')).toBeVisible()
    // 测试环境里响铃 10 秒
    await expect(caller.getByTestId('call-status')).toHaveText('No answer', { timeout: 20_000 })
    await expect(callee.getByTestId('call-incoming')).toBeHidden()
    await expect(callee.getByTestId('call-record').last()).toHaveText('Missed call')
  })

  test('a minimized call keeps going while messages are sent', async ({ browser, account }) => {
    const { caller, callee } = await pair(browser, account)
    await caller.getByTestId('voice-call').click()
    await callee.getByTestId('call-accept').click()
    await expect(caller.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })

    await caller.getByTestId('call-minimize').click()
    await expect(caller.getByTestId('call-screen')).toBeHidden()
    await expect(caller.getByTestId('call-mini')).toBeVisible()
    await caller.getByRole('textbox', { name: 'Message' }).fill('still on the call')
    await caller.getByRole('textbox', { name: 'Message' }).press('Enter')
    await expect(callee.getByTestId('message-text').last()).toHaveText('still on the call')

    await caller.getByTestId('call-mini').click()
    await expect(caller.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active')
    await callee.getByTestId('call-hangup').click()
    await expect(caller.getByTestId('call-screen')).toBeHidden({ timeout: 10_000 })
  })

  test('a call answered on one device stops ringing on the others', async ({
    browser,
    account,
  }) => {
    const { friend, conversation, caller, callee } = await pair(browser, account)
    const otherDevice = await window(browser, friend, conversation)
    await caller.getByTestId('voice-call').click()
    await expect(otherDevice.getByTestId('call-incoming')).toBeVisible()
    await callee.getByTestId('call-accept').click()
    await expect(otherDevice.getByTestId('call-incoming')).toBeHidden()
    await expect(otherDevice.getByTestId('call-elsewhere')).toHaveText('Answered on another device')
    await caller.getByTestId('call-hangup').click()
    await expect(otherDevice.getByTestId('call-elsewhere')).toBeHidden()
  })

  test("the caller's other devices show that a call is going on", async ({ browser, account }) => {
    const { conversation, caller, callee } = await pair(browser, account)
    const otherDevice = await window(browser, account, conversation)
    await caller.getByTestId('voice-call').click()
    await expect(otherDevice.getByTestId('call-elsewhere')).toHaveText(
      'In a call on another device',
    )
    // 那台设备上不能再打
    await expect(otherDevice.getByTestId('voice-call')).toBeDisabled()
    await callee.getByTestId('call-reject').click()
    await expect(otherDevice.getByTestId('call-elsewhere')).toBeHidden()
    await expect(otherDevice.getByTestId('voice-call')).toBeEnabled()
  })

  test('a side whose connection stays down ends the call as dropped', async ({
    browser,
    account,
  }) => {
    const friend = await another('Callee')
    const conversation = await befriend(account, friend)
    const caller = await window(browser, account, conversation)
    let cut: Awaited<ReturnType<typeof controlConnection>> | undefined
    const callee = await window(browser, friend, conversation, async (page) => {
      cut = await controlConnection(page)
    })
    await caller.getByTestId('voice-call').click()
    await callee.getByTestId('call-accept').click()
    await expect(caller.getByTestId('call-screen')).toHaveAttribute('data-phase', 'active', {
      timeout: 20_000,
    })

    // 被叫和服务器断开了，一直没有回来（测试环境里 5 秒算断开太久）
    await cut?.cut()
    await expect(caller.getByTestId('call-status')).toHaveText(/^Connection lost, call ended/, {
      timeout: 15_000,
    })
    await expect(caller.getByTestId('call-record').last()).toHaveAttribute(
      'data-outcome',
      'interrupted',
    )
    // 被叫重新连上之后知道通话已经没了
    cut?.restore()
    await expect(callee.getByTestId('call-screen')).toBeHidden({ timeout: 20_000 })
  })

  test('an incoming call rings, and raises a notification when the page is in the background', async ({
    browser,
    account,
  }) => {
    const friend = await another('Callee')
    const conversation = await befriend(account, friend)
    const caller = await window(browser, account, conversation)
    const callee = await window(browser, friend, conversation, (page) =>
      takeOverNotifications(page, { permission: 'granted', choice: 'on' }),
    )
    await setForeground(callee, false)

    await caller.getByTestId('voice-call').click()
    await expect(caller.getByTestId('call-tone')).toHaveAttribute('data-tone', 'ringback')
    await expect(callee.getByTestId('call-tone')).toHaveAttribute('data-tone', 'ring')
    await expect
      .poll(() => notices(callee))
      .toEqual([
        expect.objectContaining({ title: account.nickname, body: 'is calling you', closed: false }),
      ])

    // 对方取消：铃声停，通知收起
    await caller.getByTestId('call-hangup').click()
    await expect(callee.getByTestId('call-tone')).toHaveAttribute('data-tone', '')
    await expect(caller.getByTestId('call-tone')).toHaveAttribute('data-tone', '')
    await expect.poll(async () => (await notices(callee))[0]?.closed).toBe(true)
  })

  test('the desktop app brings its window up while a call rings', async ({ browser, account }) => {
    const friend = await another('Callee')
    const conversation = await befriend(account, friend)
    const caller = await window(browser, account, conversation)
    const callee = await window(browser, friend, conversation, (page) =>
      page.addInitScript(() => {
        const alerts: boolean[] = []
        Object.assign(window, {
          __alerts: alerts,
          vibeDesktop: {
            version: '0.2.0',
            setUnreadCount() {},
            showWindow() {},
            setLanguage() {},
            callAlert: (on: boolean) => alerts.push(on),
            onCommand: () => () => {},
          },
        })
      }),
    )
    const alerts = () =>
      callee.evaluate(() => (window as unknown as { __alerts: boolean[] }).__alerts)

    await caller.getByTestId('voice-call').click()
    await expect.poll(alerts).toEqual([true])
    await callee.getByTestId('call-reject').click()
    await expect.poll(alerts).toEqual([true, false])
  })

  test('a callee whose microphone is blocked learns how to allow it, and the caller learns why', async ({
    browser,
    account,
  }) => {
    const friend = await another('Callee')
    const conversation = await befriend(account, friend)
    const caller = await window(browser, account, conversation)
    const callee = await window(browser, friend, conversation, noMicrophone)

    await caller.getByTestId('voice-call').click()
    await callee.getByTestId('call-accept').click()
    await expect(callee.getByTestId('call-microphone-problem')).toContainText(
      'allowed this page to use the microphone',
    )
    await expect(callee.getByTestId('call-incoming')).toBeHidden()
    await expect(caller.getByTestId('call-status')).toHaveText(
      "The other side's microphone isn't working",
    )
    await expect(caller.getByTestId('call-record').last()).toHaveText(
      "Their microphone isn't working",
    )
  })

  test('a caller whose microphone is blocked does not start a call', async ({
    browser,
    account,
  }) => {
    const friend = await another('Callee')
    const conversation = await befriend(account, friend)
    const caller = await window(browser, account, conversation, noMicrophone)
    const callee = await window(browser, friend, conversation)
    await caller.getByTestId('voice-call').click()
    await expect(caller.getByRole('dialog', { name: "Can't use the microphone" })).toBeVisible()
    await caller.getByRole('button', { name: 'OK' }).click()
    await expect(caller.getByRole('dialog')).toHaveCount(0)
    await expect(callee.getByTestId('call-incoming')).toHaveCount(0)
    await expect(caller.getByTestId('call-screen')).toHaveCount(0)
  })

  test('calling someone who is in another call says they are busy', async ({
    browser,
    account,
  }) => {
    const { friend, caller, callee } = await pair(browser, account)
    await caller.getByTestId('voice-call').click()
    await callee.getByTestId('call-accept').click()

    const third = await another('Third')
    const withFriend = await befriend(third, friend)
    const page = await window(browser, third, withFriend)
    await page.getByTestId('voice-call').click()
    await expect(page.getByTestId('call-status')).toHaveText('Busy, please try again later')
    await expect(page.getByTestId('call-record').last()).toHaveText('Busy')
  })
})

test('the administrator sees call records like any member does', async ({ browser, account }) => {
  // 被叫不在线：通话马上结束，留下一条记录。这不需要麦克风，三种内核都能测
  const friend = await another('Callee')
  const conversation = await befriend(account, friend)
  const api = await newApi(account.storageState)
  const started = await api.post('/api/calls', {
    data: { conversation_id: conversation, device: 'tab-e2e-admin-view' },
  })
  expect(started.status(), 'start a call').toBe(201)
  await api.dispose()

  const { page, context } = await openAsAdmin(browser, `/admin/chats/${conversation}`)
  await expect(page.getByTestId('call-record')).toHaveText('Not online')
  await context.close()
})
