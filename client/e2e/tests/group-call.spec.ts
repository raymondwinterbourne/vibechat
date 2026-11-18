// 群语音通话（F10）：在群里发起、选人邀请、加入、离开，"通话进行中"的横条，通话记录。
//
// 测试环境里有一个临时的媒体转发服务（LiveKit，scripts/test-all 启动）。
// Chrome 内核用假的麦克风（会发出一段提示音）；Safari 内核没有假的麦克风，和通话的其他测试一样跳过。

import type { Browser, Page } from '@playwright/test'
import {
  type Account,
  another,
  controlConnection,
  expect,
  gotoConnected,
  makeGroup,
  newApi,
  notices,
  openAsAdmin,
  setForeground,
  takeOverNotifications,
  test,
} from './support'

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
/** 选人的对话框里某个人的那一行：点它就是选中、取消选中。 */
const pick = (page: Page, account: Account) =>
  page.getByTestId('group-call-pick').filter({ hasText: account.nickname })
const tile = (page: Page, account: Account) =>
  page.locator(`[data-testid="group-call-member"][data-user="${account.id}"]`)

/** 这个窗口在通话里，声音连上了。 */
async function inCall(page: Page) {
  await expect(screen(page)).toHaveAttribute('data-phase', 'active', { timeout: 20_000 })
}

test.describe('group voice calls', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')

  test('start with picked people, join, invite again, leave, and the record', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const two = await another('two')
    const group = await makeGroup(owner, [one, two], 'Call group')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    const twoPage = await open(browser, two, group)

    // 发起：先选要邀请谁，默认全选
    await ownerPage.getByTestId('group-voice-call').click()
    const picker = ownerPage.getByTestId('group-call-picker')
    await expect(picker.getByTestId('group-call-pick')).toHaveCount(2)
    await expect(picker.getByTestId('group-call-picked')).toHaveText('2 picked')
    await expect(picker.getByRole('checkbox', { name: one.nickname })).toBeChecked()
    // 这一次不邀请第二个人
    await pick(ownerPage, two).click()
    await expect(picker.getByRole('checkbox', { name: two.nickname })).not.toBeChecked()
    await expect(picker.getByTestId('group-call-picked')).toHaveText('1 picked')
    await picker.getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    await expect(people(ownerPage)).toHaveCount(1)
    await expect(ownerPage.getByTestId('group-call-status')).toContainText('1 person')

    // 被邀请的人响铃，看到是谁邀请的；没被邀请的人不响，但看得到"通话进行中"
    const invitation = onePage.getByTestId('group-call-incoming')
    await expect(invitation).toContainText('Call group')
    await expect(invitation).toContainText(`${owner.nickname} invites you to a group voice call`)
    await expect(onePage.getByTestId('group-call-tone')).toHaveAttribute('data-tone', 'ring')
    await expect(banner(twoPage)).toContainText('Voice call in progress · 1 person')
    await expect(twoPage.getByTestId('group-call-incoming')).toHaveCount(0)
    await expect(twoPage.getByTestId('group-call-tone')).toHaveAttribute('data-tone', '')
    // 会话列表里这个群也有标记
    await expect(twoPage.getByTestId('call-flag')).toHaveText('[In call]')

    // 被邀请的人加入：两边都看到两个人，看得到对方在说话
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    await expect(invitation).toHaveCount(0)
    await expect(onePage.getByTestId('group-call-tone')).toHaveAttribute('data-tone', '')
    for (const page of [ownerPage, onePage]) await expect(people(page)).toHaveCount(2)
    await expect(tile(ownerPage, one)).toHaveAttribute('data-speaking', '', { timeout: 20_000 })
    await expect(tile(onePage, owner)).toHaveAttribute('data-speaking', '', { timeout: 20_000 })
    await expect(banner(twoPage)).toContainText('2 people')

    // 没被邀请的人从横条加入
    await banner(twoPage).getByRole('button', { name: 'Join' }).click()
    await inCall(twoPage)
    for (const page of [ownerPage, onePage, twoPage]) await expect(people(page)).toHaveCount(3)
    await expect(tile(twoPage, two)).toHaveAttribute('data-me', '')
    await expect(tile(twoPage, two)).toContainText('(me)')

    // 静音：别人看得到
    await onePage.getByTestId('group-call-mute').click()
    await expect(tile(onePage, one)).toHaveAttribute('data-muted', '')
    await expect(tile(ownerPage, one)).toHaveAttribute('data-muted', '')
    await onePage.getByTestId('group-call-mute').click()
    await expect(tile(ownerPage, one)).not.toHaveAttribute('data-muted')

    // 缩成小条，回到聊天界面照常发消息；再展开
    await ownerPage.getByTestId('group-call-minimize').click()
    await expect(screen(ownerPage)).toHaveCount(0)
    await expect(ownerPage.getByTestId('group-call-mini')).toContainText('3 people')
    await expect(banner(ownerPage)).toContainText("You're in the call · 3 people")
    await ownerPage.getByRole('textbox', { name: 'Message' }).fill('still here')
    await ownerPage.getByRole('textbox', { name: 'Message' }).press('Enter')
    // 消息流里和会话列表的摘要里都有这句话
    await expect(ownerPage.getByText('still here').first()).toBeVisible()
    await ownerPage.getByTestId('group-call-mini').click()
    await inCall(ownerPage)

    // 一个人离开，另外两个人不受影响；他那里又是"通话进行中 · 加入"
    await twoPage.getByTestId('group-call-leave').click()
    await expect(screen(twoPage)).toHaveCount(0)
    for (const page of [ownerPage, onePage]) await expect(people(page)).toHaveCount(2)
    await expect(banner(twoPage)).toContainText('Voice call in progress · 2 people')

    // 通话里的人再邀请他：只列出不在通话里的人，默认不选；他的设备响铃，这次他不理会
    await ownerPage.getByTestId('group-call-invite').click()
    const again = ownerPage.getByTestId('group-call-picker')
    await expect(again.getByTestId('group-call-pick')).toHaveCount(1)
    await expect(again.getByRole('button', { name: 'Invite' })).toBeDisabled()
    await pick(ownerPage, two).click()
    await again.getByRole('button', { name: 'Invite' }).click()
    await expect(twoPage.getByTestId('group-call-incoming')).toContainText(
      `${owner.nickname} invites you`,
    )
    await twoPage.getByTestId('group-call-ignore').click()
    await expect(twoPage.getByTestId('group-call-incoming')).toHaveCount(0)
    // 不理会之后仍然可以加入
    await expect(banner(twoPage).getByRole('button', { name: 'Join' })).toBeEnabled()

    // 最后一个人离开：通话结束，横条和列表上的标记都没了，群里留下通话记录
    await onePage.getByTestId('group-call-leave').click()
    await expect(people(ownerPage)).toHaveCount(1)
    await ownerPage.getByTestId('group-call-leave').click()
    for (const page of [ownerPage, onePage, twoPage]) {
      await expect(banner(page)).toHaveCount(0)
      await expect(page.getByTestId('call-flag')).toHaveCount(0)
      await expect(page.getByTestId('call-record').last()).toHaveText(
        /^Voice call \d+:\d\d · 3 people joined$/,
      )
    }
    // 自己离开的不提示"通话已结束"
    await expect(ownerPage.getByTestId('toast')).toHaveCount(0)
    // 通话结束后可以再发起
    await expect(ownerPage.getByTestId('group-voice-call')).toBeEnabled()
  })

  test('one device at a time, and a reloaded page can join again', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Reload group')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)

    // 一个人都不邀请也可以发起
    await ownerPage.getByTestId('group-voice-call').click()
    const picker = ownerPage.getByTestId('group-call-picker')
    await picker.getByRole('button', { name: 'Select none' }).click()
    await expect(picker.getByTestId('group-call-picked')).toHaveText('0 picked')
    await picker.getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    await expect(onePage.getByTestId('group-call-incoming')).toHaveCount(0)
    await expect(banner(onePage)).toContainText('Voice call in progress · 1 person')

    // 我的另一台设备：看到"已在其他设备加入"，不能再加入一次
    const elsewhere = await open(browser, owner, group)
    await expect(banner(elsewhere)).toHaveAttribute('data-place', 'elsewhere')
    await expect(banner(elsewhere)).toContainText('You joined on another device · 1 person')
    await expect(elsewhere.getByTestId('group-voice-call')).toBeDisabled()
    await elsewhere.context().close()

    // 在通话里时，标题栏的按钮不能再点
    await ownerPage.getByTestId('group-call-minimize').click()
    await expect(ownerPage.getByTestId('group-voice-call')).toBeDisabled()

    // 刷新页面：算离开；通话还在（另一个人在里面），可以再加入
    await onePage.getByTestId('group-voice-call').click()
    await inCall(onePage)
    await ownerPage.reload()
    await expect(screen(ownerPage)).toHaveCount(0)
    await banner(ownerPage).getByRole('button', { name: 'Join' }).click()
    await inCall(ownerPage)
    await expect(people(ownerPage)).toHaveCount(2)
    await expect(people(onePage)).toHaveCount(2)

    // 都离开，记录里是两个人
    await ownerPage.getByTestId('group-call-leave').click()
    await onePage.getByTestId('group-call-leave').click()
    await expect(onePage.getByTestId('call-record').last()).toHaveText(
      /^Voice call \d+:\d\d · 2 people joined$/,
    )
  })

  test('a call nobody else joined says so', async ({ browser, account: owner }) => {
    const group = await makeGroup(owner, [await another('one'), await another('two')], 'Quiet')
    const page = await open(browser, owner, group)
    await page.getByTestId('group-voice-call').click()
    await page.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(page)
    await page.getByTestId('group-call-leave').click()
    await expect(page.getByTestId('call-record').last()).toHaveText('Voice call · nobody joined')
  })

  test('someone removed from the group is out of its call at once', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Strict group')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group)
    await ownerPage.getByTestId('group-voice-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    await expect(people(ownerPage)).toHaveCount(2)

    // 群主把他移出群：他的通话界面马上收起来，说明原因，"通话进行中"也不再显示
    const api = await newApi(owner.storageState)
    const removed = await api.delete(`/api/conversations/${group}/members/${one.id}`)
    expect(removed.status(), 'remove member').toBe(200)
    await api.dispose()
    await expect(screen(onePage)).toHaveCount(0)
    await expect(onePage.getByTestId('toast')).toHaveText("You're no longer in this call")
    await expect(banner(onePage)).toHaveCount(0)
    await expect(onePage.getByTestId('group-voice-call')).toBeDisabled()
    // 通话照常进行，只剩群主
    await expect(people(ownerPage)).toHaveCount(1)
    await ownerPage.getByTestId('group-call-leave').click()
    await expect(banner(ownerPage)).toHaveCount(0)
  })

  test('all my devices ring, and joining on one stops the others', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Devices group')
    const ownerPage = await open(browser, owner, group)
    const phone = await open(browser, one, group)
    const laptop = await open(browser, one, group)
    await ownerPage.getByTestId('group-voice-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    for (const page of [phone, laptop]) {
      await expect(page.getByTestId('group-call-incoming')).toBeVisible()
      await expect(page.getByTestId('group-call-tone')).toHaveAttribute('data-tone', 'ring')
    }

    // 在一台设备上加入：另一台不再响，写着"已在其他设备加入"
    await phone.getByTestId('group-call-accept').click()
    await inCall(phone)
    await expect(laptop.getByTestId('group-call-incoming')).toHaveCount(0)
    await expect(laptop.getByTestId('group-call-tone')).toHaveAttribute('data-tone', '')
    await expect(banner(laptop)).toContainText('You joined on another device · 2 people')
    await expect(banner(laptop).getByRole('button', { name: 'Join' })).toHaveCount(0)

    await phone.getByTestId('group-call-leave').click()
    await ownerPage.getByTestId('group-call-leave').click()
    await expect(banner(laptop)).toHaveCount(0)
  })

  test('a device away from the server for too long has left, and can come back', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Offline group')
    const ownerPage = await open(browser, owner, group)
    let connection: Awaited<ReturnType<typeof controlConnection>> | undefined
    const onePage = await open(browser, one, group, async (page) => {
      connection = await controlConnection(page)
    })
    await ownerPage.getByTestId('group-voice-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    await onePage.getByTestId('group-call-accept').click()
    await inCall(onePage)
    await expect(people(ownerPage)).toHaveCount(2)

    // 他和服务器断开了，一直没有回来（测试环境里 5 秒算断开太久）：算他离开了，
    // 服务端把他请出了房间，所以他自己那边通话界面也收起来了
    await connection?.cut()
    await expect(people(ownerPage)).toHaveCount(1, { timeout: 15_000 })
    await expect(screen(onePage)).toHaveCount(0, { timeout: 15_000 })
    await expect(onePage.getByTestId('toast')).toHaveText("You're no longer in this call")

    // 连回来之后：通话还在，可以再加入
    connection?.restore()
    await banner(onePage).getByRole('button', { name: 'Join' }).click({ timeout: 20_000 })
    await inCall(onePage)
    await expect(people(ownerPage)).toHaveCount(2)
    await onePage.getByTestId('group-call-leave').click()
    await ownerPage.getByTestId('group-call-leave').click()
  })

  test('an invitation shows a system notification while the page is in the background', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Notify group')
    const ownerPage = await open(browser, owner, group)
    const onePage = await open(browser, one, group, (page) =>
      takeOverNotifications(page, { permission: 'granted', choice: 'on' }),
    )
    await setForeground(onePage, false)
    await ownerPage.getByTestId('group-voice-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await inCall(ownerPage)
    await expect
      .poll(() => notices(onePage))
      .toEqual([
        expect.objectContaining({
          title: 'Notify group',
          body: 'Invites you to a group voice call',
          closed: false,
        }),
      ])

    // 通话结束（发起人离开）：铃声停，通知收起
    await ownerPage.getByTestId('group-call-leave').click()
    await expect(onePage.getByTestId('group-call-tone')).toHaveAttribute('data-tone', '')
    await expect.poll(async () => (await notices(onePage))[0]?.closed).toBe(true)
  })

  test('without the microphone no call is started and nobody rings', async ({
    browser,
    account: owner,
  }) => {
    const one = await another('one')
    const group = await makeGroup(owner, [one, await another('two')], 'Mic group')
    const ownerPage = await open(browser, owner, group, (page) =>
      page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
      }),
    )
    const onePage = await open(browser, one, group)
    await ownerPage.getByTestId('group-voice-call').click()
    await ownerPage.getByTestId('group-call-picker').getByRole('button', { name: 'Start' }).click()
    await expect(ownerPage.getByRole('dialog', { name: "Can't use the microphone" })).toBeVisible()
    await expect(ownerPage.getByTestId('group-call-microphone-problem')).toContainText(
      'allowed this page to use the microphone',
    )
    await ownerPage.getByRole('button', { name: 'OK' }).click()
    await expect(screen(ownerPage)).toHaveCount(0)
    // 没有发起：别人那里既不响铃，也没有"通话进行中"
    await expect(onePage.getByTestId('group-call-incoming')).toHaveCount(0)
    await expect(banner(onePage)).toHaveCount(0)
    // 可以再试
    await expect(ownerPage.getByTestId('group-voice-call')).toBeEnabled()
  })
})

// 这一条不用麦克风（通话是通过接口发起、加入的），三种浏览器内核都测
test('the administrator sees group call records like any member does', async ({
  browser,
  account: owner,
}) => {
  const one = await another('one')
  const group = await makeGroup(owner, [one, await another('two')], 'Viewed group')
  const ownerApi = await newApi(owner.storageState)
  const started = await ownerApi.post('/api/group-calls', {
    data: { conversation_id: group, device: 'e2e-owner-device', invite: [] },
  })
  expect(started.status(), 'start').toBe(201)
  const { call } = (await started.json()) as { call: { id: string } }
  const oneApi = await newApi(one.storageState)
  await oneApi.post(`/api/group-calls/${call.id}/join`, { data: { device: 'e2e-one-device' } })
  await oneApi.post(`/api/group-calls/${call.id}/leave`, { data: { device: 'e2e-one-device' } })
  await ownerApi.post(`/api/group-calls/${call.id}/leave`, {
    data: { device: 'e2e-owner-device' },
  })
  // 再来一个视频通话（F11），这一次没有别人加入
  const video = await ownerApi.post('/api/group-calls', {
    data: { conversation_id: group, device: 'e2e-owner-device', invite: [], video: true },
  })
  expect(video.status(), 'start a video call').toBe(201)
  const second = (await video.json()) as { call: { id: string; video: boolean } }
  expect(second.call.video).toBe(true)
  await ownerApi.post(`/api/group-calls/${second.call.id}/leave`, {
    data: { device: 'e2e-owner-device' },
  })
  await ownerApi.dispose()
  await oneApi.dispose()

  const { page, context } = await openAsAdmin(browser, `/admin/chats/${group}`)
  const records = page.getByTestId('call-record')
  await expect(records).toHaveCount(2)
  await expect(records.first()).toHaveText(/^Voice call \d+:\d\d · 2 people joined$/)
  await expect(records.last()).toHaveText('Video call · nobody joined')
  await context.close()
})
