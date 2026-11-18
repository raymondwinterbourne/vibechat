// 通话的技术验证页面（F3 第一段）：两个窗口互相通话，直连一次、只走中转一次。
//
// 测试环境里有一个临时的中转服务（scripts/test-all 启动，配置见 dev/coturn/turnserver-test.conf）。
// Chrome 内核用假的麦克风（会发出一段提示音）；Safari 内核没有假的麦克风，和语音消息一样跳过。

import type { Browser, Page } from '@playwright/test'
import { type Account, expect, test } from './support'

async function open(browser: Browser, account: Account): Promise<Page> {
  const context = await browser.newContext({ storageState: account.storageState })
  const page = await context.newPage()
  await page.goto('/call-check')
  await expect(page.getByTestId('call-check-relay')).toContainText('turn:127.0.0.1:3479')
  return page
}

/** 两个窗口照页面上说的步骤交换连接信息，直到双方都连上。 */
async function connect(caller: Page, callee: Page) {
  await caller.getByRole('button', { name: 'Start' }).click()
  const offer = caller.getByTestId('call-check-mine')
  await expect(offer).not.toHaveValue('')
  await expect(caller.getByTestId('call-check-next')).toContainText('send the details above to')
  await callee.getByTestId('call-check-theirs').fill(await offer.inputValue())
  await callee.getByRole('button', { name: 'Use' }).click()
  const answer = callee.getByTestId('call-check-mine')
  await expect(answer).not.toHaveValue('')
  await expect(callee.getByTestId('call-check-next')).toContainText('back to the other side')
  await caller.getByTestId('call-check-theirs').fill(await answer.inputValue())
  await caller.getByRole('button', { name: 'Use' }).click()
  for (const page of [caller, callee]) {
    await expect(page.getByTestId('call-check-state')).toHaveText('connected', { timeout: 20_000 })
    await expect(page.getByTestId('call-check-next')).toHaveCount(0)
  }
}

/** 这一端确实收到了对方的声音：收到的字节数在涨。 */
async function hears(page: Page) {
  const received = page.getByTestId('call-check-received')
  await expect
    .poll(async () => Number(await received.getAttribute('data-bytes')), { timeout: 10_000 })
    .toBeGreaterThan(2000)
}

test.describe('the call check page', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'no fake microphone in WebKit')

  test('two windows call each other directly', async ({ browser, account }) => {
    const caller = await open(browser, account)
    const callee = await open(browser, account)
    await connect(caller, callee)
    await hears(caller)
    await hears(callee)
    // 同一台机器上：本机地址直连
    await expect(caller.getByTestId('call-check-local')).not.toHaveText('Relay')
    await caller.getByRole('button', { name: 'Hang up' }).click()
    await expect(caller.getByTestId('call-check-state')).toHaveText('idle')
  })

  test('with relay only, the audio goes through our relay', async ({ browser, account }) => {
    const caller = await open(browser, account)
    const callee = await open(browser, account)
    for (const page of [caller, callee]) {
      await page.getByRole('checkbox', { name: 'Relay only (to test the relay)' }).check()
    }
    await connect(caller, callee)
    await expect(caller.getByTestId('call-check-local')).toHaveText('Relay')
    await expect(callee.getByTestId('call-check-local')).toHaveText('Relay')
    await hears(caller)
    await hears(callee)
  })

  test('unreadable connection details are refused', async ({ browser, account }) => {
    const page = await open(browser, account)
    await page.getByTestId('call-check-theirs').fill('hello')
    await page.getByRole('button', { name: 'Use' }).click()
    await expect(page.getByRole('alert')).toHaveText(
      "These connection details can't be read. Please copy them again.",
    )
  })
})
