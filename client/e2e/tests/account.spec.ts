// M2 的验收：邀请码注册、保持登录、修改 ID、头像同步、登录锁定。

import type { Page } from '@playwright/test'
import {
  type Account,
  ADMIN_PASSWORD,
  anonymousTest,
  createAccount,
  createInviteCode,
  expect,
  logIn,
  logInElsewhere,
  newApi,
  pngImage,
  test,
  USER_PASSWORD,
} from './support'

async function fillRegistration(page: Page, code: string, nickname: string) {
  await page.goto('/register')
  await page.getByLabel('Invite code').fill(code)
  await page.getByLabel('Nickname').fill(nickname)
  await page.getByLabel('Password', { exact: true }).fill(USER_PASSWORD)
  await page.getByLabel('Confirm password').fill(USER_PASSWORD)
}

anonymousTest.describe('registration', () => {
  anonymousTest(
    'the admin generates invite codes and a newcomer registers with one',
    async ({ page, browser }) => {
      // 管理员登录并生成三个邀请码
      await logIn(page, 'admin', ADMIN_PASSWORD)
      await page.getByTestId('nav-rail').getByRole('link', { name: 'Admin' }).click()
      await page.getByTestId('admin-nav').getByRole('link', { name: 'Invite codes' }).click()
      await expect(page.getByRole('heading', { name: 'Invite codes' })).toBeVisible()

      const unused = page.locator('[data-testid="invite-code"][data-status="unused"]')
      // 别的测试也在同时生成邀请码，所以比较的是"生成之后新出现的"
      await expect(
        page.getByTestId('invite-code').first().or(page.getByText('No invite codes yet')),
      ).toBeVisible()
      const before = new Set(await page.getByTestId('invite-code-value').allInnerTexts())
      await page.getByLabel('Count').fill('3')
      await page.getByRole('button', { name: 'Generate' }).click()
      await expect(page.getByTestId('toast')).toHaveText('Generated 3 invite codes')

      await expect
        .poll(async () => {
          const now = await unused.getByTestId('invite-code-value').allInnerTexts()
          return now.filter((code) => !before.has(code)).length
        })
        .toBeGreaterThanOrEqual(3)
      const fresh = (await unused.getByTestId('invite-code-value').allInnerTexts()).filter(
        (code) => !before.has(code),
      )
      const code = fresh[0]
      if (!code) throw new Error('no fresh invite code found')
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)

      // 新用户在另一个浏览器窗口里用它注册
      const newcomerContext = await browser.newContext()
      const newcomer = await newcomerContext.newPage()
      const nickname = `Newcomer ${Date.now().toString(36)}`
      await fillRegistration(newcomer, code, nickname)

      // 不确认"管理员可以查看聊天内容"就不能提交
      const submit = newcomer.getByRole('button', { name: 'Register' })
      await expect(submit).toBeDisabled()
      await newcomer.getByRole('checkbox').check()
      await submit.click()

      // 看到系统分配的 ID
      const assigned = await newcomer.getByTestId('assigned-id').innerText()
      expect(assigned).toMatch(/^vc[a-z0-9]{8}$/)
      await newcomer.getByRole('button', { name: 'Get started' }).click()
      await expect(newcomer).toHaveURL(/\/chats$/)
      await newcomer.getByTestId('nav-rail').getByRole('link', { name: 'Settings' }).click()
      await expect(newcomer.getByTestId('my-id')).toHaveText(assigned)

      // 管理员那边看到这个邀请码已经被这位新用户使用
      await page.reload()
      const used = page.getByTestId('invite-code').filter({ hasText: code })
      await expect(used).toHaveAttribute('data-status', 'used')
      await expect(used).toContainText(`${nickname} (${assigned})`)

      await newcomerContext.close()
    },
  )

  anonymousTest('a used invite code is refused with the reason', async ({ page }) => {
    const code = await createInviteCode()
    await fillRegistration(page, code, 'First')
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Register' }).click()
    await expect(page.getByTestId('assigned-id')).toBeVisible()

    // 换一个人再用同一个邀请码
    await page.context().clearCookies()
    await fillRegistration(page, code, 'Second')
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Register' }).click()
    await expect(page.getByRole('alert')).toHaveText('That invite code has already been used.')
    await expect(page.getByTestId('assigned-id')).toBeHidden()
  })

  anonymousTest(
    'an invite code that does not exist is refused with the reason',
    async ({ page }) => {
      await fillRegistration(page, 'AAAA-BBBB-CCCC-DDDD', 'Nobody')
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Register' }).click()
      await expect(page.getByRole('alert')).toHaveText(
        "That invite code doesn't exist. Please check it.",
      )
    },
  )

  anonymousTest('mismatched or weak passwords are explained', async ({ page }) => {
    const code = await createInviteCode()
    await fillRegistration(page, code, 'Careful')
    await page.getByLabel('Confirm password').fill('something-else-1')
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Register' }).click()
    await expect(page.getByText("The two passwords don't match")).toBeVisible()

    await page.getByLabel('Password', { exact: true }).fill('short1')
    await page.getByLabel('Confirm password').fill('short1')
    await page.getByRole('button', { name: 'Register' }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'Use at least 8 characters, with both letters and digits.',
    )
  })
})

anonymousTest.describe('managing invite codes', () => {
  // 这一组一个接一个地跑。它们都靠"刚生成的邀请码排在第一页最前面"找到自己的那几行，
  // 同时跑的话会把彼此的挤到后面的页上去
  anonymousTest.describe.configure({ mode: 'default' })

  /** 管理员打开邀请码页面。 */
  async function openInviteCodes(page: Page) {
    await logIn(page, 'admin', ADMIN_PASSWORD)
    await page.getByTestId('nav-rail').getByRole('link', { name: 'Admin' }).click()
    await page.getByTestId('admin-nav').getByRole('link', { name: 'Invite codes' }).click()
    await expect(page.getByRole('heading', { name: 'Invite codes' })).toBeVisible()
  }

  /** 生成一个带备注的邀请码，返回它所在的那一行。备注是唯一的，用它来找这一行。 */
  async function generateWithNote(page: Page, validity?: string) {
    const note = `e2e ${Date.now().toString(36)} ${Math.floor(Math.random() * 100000)}`
    await page.getByLabel('Count').fill('1')
    if (validity) await page.getByLabel('Valid for').selectOption({ label: validity })
    await page.getByLabel('Note').fill(note)
    await page.getByRole('button', { name: 'Generate' }).click()
    const row = page.getByTestId('invite-code').filter({ hasText: note })
    await expect(row).toBeVisible()
    return row
  }

  /** 一次生成几个邀请码，共用一个唯一的备注，返回这几行。 */
  async function generateBatch(page: Page, count: number) {
    const note = `e2e ${Date.now().toString(36)} ${Math.floor(Math.random() * 100000)}`
    await page.getByLabel('Count').fill(String(count))
    await page.getByLabel('Note').fill(note)
    await page.getByRole('button', { name: 'Generate' }).click()
    const rows = page.getByTestId('invite-code').filter({ hasText: note })
    await expect(rows).toHaveCount(count)
    return rows
  }

  anonymousTest('a code can be generated with a note and a validity', async ({ page }) => {
    await openInviteCodes(page)

    const forever = await generateWithNote(page)
    await expect(forever).toHaveAttribute('data-status', 'unused')
    await expect(forever).toContainText('No expiry')
    // 生成之后备注清空，方便接着生成下一批
    await expect(page.getByLabel('Note')).toHaveValue('')

    const week = await generateWithNote(page, '7 days')
    await expect(week).toContainText('Valid until')
    await expect(week).not.toContainText('No expiry')
  })

  anonymousTest('a revoked code can no longer be used to register', async ({ page, browser }) => {
    await openInviteCodes(page)
    const row = await generateWithNote(page)
    const code = await row.getByTestId('invite-code-value').innerText()

    // 先取消一次：什么也不发生
    await row.getByRole('button', { name: `Revoke invite code ${code}` }).click()
    const dialog = page.getByRole('dialog', { name: 'Revoke this invite code?' })
    await expect(dialog).toContainText(code)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toHaveAttribute('data-status', 'unused')

    // 确认作废
    await row.getByRole('button', { name: `Revoke invite code ${code}` }).click()
    await dialog.getByRole('button', { name: 'Revoke' }).click()
    await expect(row).toHaveAttribute('data-status', 'revoked')
    await expect(row).toContainText('Revoked')
    // 作废之后不再有复制和作废的按钮，只能删除
    await expect(row.getByRole('button')).toHaveCount(1)
    await expect(row.getByRole('button', { name: `Delete invite code ${code}` })).toBeVisible()

    const newcomerContext = await browser.newContext()
    const newcomer = await newcomerContext.newPage()
    await fillRegistration(newcomer, code, 'Too Late')
    await newcomer.getByRole('checkbox').check()
    await newcomer.getByRole('button', { name: 'Register' }).click()
    await expect(newcomer.getByRole('alert')).toHaveText('That invite code has been revoked.')
    await newcomerContext.close()
  })

  anonymousTest('a code can be copied', async ({ page, browserName, context }) => {
    await openInviteCodes(page)
    const row = await generateWithNote(page)
    const code = await row.getByTestId('invite-code-value').innerText()

    // 只有 Chrome 内核允许测试读取剪贴板的内容；其余的只确认给出了"已复制"的提示
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    }
    await row.getByRole('button', { name: `Copy invite code ${code}` }).click()
    await expect(page.getByTestId('toast').filter({ hasText: 'Copied' })).toBeVisible()
    if (browserName === 'chromium') {
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
    }
  })

  anonymousTest('a used code offers neither copy nor revoke', async ({ page }) => {
    await openInviteCodes(page)
    const row = await generateWithNote(page)
    const code = await row.getByTestId('invite-code-value').innerText()

    // 有人用它注册了
    const api = await newApi()
    const response = await api.post('/api/auth/register', {
      data: { invite_code: code, nickname: 'Used It', password: USER_PASSWORD },
    })
    expect(response.status()).toBe(201)
    await api.dispose()

    await page.reload()
    const used = page.getByTestId('invite-code').filter({ hasText: code })
    await expect(used).toHaveAttribute('data-status', 'used')
    await expect(used).toContainText('Used It')
    await expect(used.getByRole('button')).toHaveCount(0)
    await expect(used.getByRole('checkbox')).toHaveCount(0)
  })

  anonymousTest(
    'a freshly generated batch is selected and copied in one go',
    async ({ page, browserName, context }) => {
      await openInviteCodes(page)
      const rows = await generateBatch(page, 3)
      const codes = await rows.getByTestId('invite-code-value').allInnerTexts()

      // 刚生成的这一批已经勾选上了
      const selection = page.getByTestId('invite-code-selection')
      await expect(selection).toContainText('3 selected')
      for (const code of codes) {
        await expect(
          page.getByRole('checkbox', { name: `Select invite code ${code}` }),
        ).toBeChecked()
      }

      if (browserName === 'chromium') {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      }
      await selection.getByRole('button', { name: 'Copy selected invite codes' }).click()
      await expect(
        page.getByTestId('toast').filter({ hasText: 'Copied 3 invite codes' }),
      ).toBeVisible()
      if (browserName === 'chromium') {
        // 一行一个，顺序与列表一致
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(codes.join('\n'))
      }
    },
  )

  anonymousTest('several codes are revoked at once', async ({ page }) => {
    await openInviteCodes(page)
    const rows = await generateBatch(page, 3)
    const codes = await rows.getByTestId('invite-code-value').allInnerTexts()
    const [kept, ...doomed] = codes
    const selection = page.getByTestId('invite-code-selection')

    // 去掉一个，只作废剩下的两个
    await page.getByRole('checkbox', { name: `Select invite code ${kept}` }).uncheck()
    await expect(selection).toContainText('2 selected')

    // 先取消一次：什么也不发生
    await selection.getByRole('button', { name: 'Revoke selected invite codes' }).click()
    const dialog = page.getByRole('dialog', { name: 'Revoke 2 unused invite codes?' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(rows.and(page.locator('[data-status="unused"]'))).toHaveCount(3)

    await selection.getByRole('button', { name: 'Revoke selected invite codes' }).click()
    await dialog.getByRole('button', { name: 'Revoke' }).click()
    await expect(
      page.getByTestId('toast').filter({ hasText: 'Revoked 2 invite codes' }),
    ).toBeVisible()

    for (const code of doomed) {
      const row = page.getByTestId('invite-code').filter({ hasText: code })
      await expect(row).toHaveAttribute('data-status', 'revoked')
    }
    await expect(page.getByTestId('invite-code').filter({ hasText: kept })).toHaveAttribute(
      'data-status',
      'unused',
    )
    // 作废之后不再有选中的
    await expect(selection).toContainText('Select all')
    await expect(selection.getByRole('button')).toHaveCount(0)
  })

  anonymousTest('a revoked code can be deleted', async ({ page }) => {
    await openInviteCodes(page)
    const row = await generateWithNote(page)
    const code = await row.getByTestId('invite-code-value').innerText()
    // 还能用的邀请码不能直接删除
    await expect(row.getByRole('button', { name: `Delete invite code ${code}` })).toHaveCount(0)

    await row.getByRole('button', { name: `Revoke invite code ${code}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click()
    await expect(row).toHaveAttribute('data-status', 'revoked')

    // 先取消一次：什么也不发生
    await row.getByRole('button', { name: `Delete invite code ${code}` }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete this invite code?' })
    await expect(dialog).toContainText(code)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toBeVisible()

    await row.getByRole('button', { name: `Delete invite code ${code}` }).click()
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByTestId('toast').filter({ hasText: 'Deleted' })).toBeVisible()
    await expect(row).toHaveCount(0)

    // 刷新之后也没有了
    await page.reload()
    await expect(page.getByTestId('invite-code').first()).toBeVisible()
    await expect(page.getByTestId('invite-code').filter({ hasText: code })).toHaveCount(0)
  })

  anonymousTest('several revoked codes are deleted at once', async ({ page }) => {
    await openInviteCodes(page)
    const rows = await generateBatch(page, 3)
    const codes = await rows.getByTestId('invite-code-value').allInnerTexts()
    const [kept, ...doomed] = codes
    const selection = page.getByTestId('invite-code-selection')

    // 作废其中两个
    await page.getByRole('checkbox', { name: `Select invite code ${kept}` }).uncheck()
    await selection.getByRole('button', { name: 'Revoke selected invite codes' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click()
    await expect(rows.and(page.locator('[data-status="revoked"]'))).toHaveCount(2)

    // 三个都勾选：能用的那个可以复制和作废，作废的两个可以删除
    for (const code of codes) {
      await page.getByRole('checkbox', { name: `Select invite code ${code}` }).check()
    }
    await expect(selection).toContainText('3 selected')
    await expect(selection.getByRole('button')).toHaveCount(3)

    await selection.getByRole('button', { name: 'Delete selected invite codes' }).click()
    const dialog = page.getByRole('dialog', {
      name: 'Delete 2 revoked or expired invite codes?',
    })
    await dialog.getByRole('button', { name: 'Delete' }).click()
    await expect(
      page.getByTestId('toast').filter({ hasText: 'Deleted 2 invite codes' }),
    ).toBeVisible()

    // 只删掉了作废的两个，能用的那个还在
    await expect(rows).toHaveCount(1)
    for (const code of doomed) {
      await expect(page.getByTestId('invite-code').filter({ hasText: code })).toHaveCount(0)
    }
    await expect(page.getByTestId('invite-code').filter({ hasText: kept })).toHaveAttribute(
      'data-status',
      'unused',
    )
  })

  anonymousTest('the list is shown a page at a time', async ({ page }) => {
    await openInviteCodes(page)
    // 一页 20 个。测试开始前预先生成的邀请码就远不止一页
    const newest = await generateWithNote(page)
    const pager = page.getByTestId('invite-code-pager')
    const current = page.getByTestId('invite-code-page')

    await expect(page.getByTestId('invite-code')).toHaveCount(20)
    await expect(current).toHaveText(/^1 \/ \d+$/)
    await expect(pager).toContainText(/\d+ in total/)
    await expect(pager.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await expect(newest).toBeVisible()

    // 下一页：是另外一批，刚才勾选的也不再算数
    await pager.getByRole('button', { name: 'Next page' }).click()
    await expect(current).toHaveText(/^2 \/ \d+$/)
    await expect(newest).toHaveCount(0)
    await expect(page.getByTestId('invite-code').first()).toBeVisible()
    await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0)

    await pager.getByRole('button', { name: 'Previous page' }).click()
    await expect(current).toHaveText(/^1 \/ \d+$/)
    await expect(newest).toBeVisible()

    // 在后面的页上生成新的邀请码：回到第一页，新的排在最前面
    await pager.getByRole('button', { name: 'Next page' }).click()
    await expect(current).toHaveText(/^2 \/ \d+$/)
    const another = await generateWithNote(page)
    await expect(current).toHaveText(/^1 \/ \d+$/)
    await expect(another.getByRole('checkbox')).toBeChecked()
  })

  anonymousTest('the list is filtered by status', async ({ page }) => {
    await openInviteCodes(page)
    const rows = await generateBatch(page, 3)
    const codes = await rows.getByTestId('invite-code-value').allInnerTexts()
    const [unused, used, revoked] = codes
    if (!unused || !used || !revoked) throw new Error('expected three codes')
    const row = (code: string) => page.getByTestId('invite-code').filter({ hasText: code })
    const all = page.getByTestId('invite-code')
    const filter = (name: string) => page.getByRole('radio', { name, exact: true })

    // 一个被人用掉，一个作废，一个留着
    const api = await newApi()
    const response = await api.post('/api/auth/register', {
      data: { invite_code: used, nickname: 'Filtered', password: USER_PASSWORD },
    })
    expect(response.status()).toBe(201)
    await api.dispose()
    await row(revoked)
      .getByRole('button', { name: `Revoke invite code ${revoked}` })
      .click()
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click()
    await expect(row(revoked)).toHaveAttribute('data-status', 'revoked')

    await expect(filter('All')).toBeChecked()
    for (const [name, status, shown] of [
      ['Unused', 'unused', unused],
      ['Used', 'used', used],
      ['Revoked', 'revoked', revoked],
    ] as const) {
      await filter(name).click()
      await expect(filter(name)).toBeChecked()
      // 只剩这一种状态的，我们的那一个在里面，另外两个不在
      await expect(row(shown)).toHaveAttribute('data-status', status)
      await expect(all.and(page.locator(`:not([data-status="${status}"])`))).toHaveCount(0)
      await expect(rows).toHaveCount(1)
    }

    // 测试环境里没有过期的邀请码
    await filter('Expired').click()
    await expect(page.getByText('No invite codes match')).toBeVisible()
    await expect(all).toHaveCount(0)

    await filter('All').click()
    await expect(rows).toHaveCount(3)

    // 只看"已作废"时生成新的：换回"全部"，新生成的就在眼前
    await filter('Revoked').click()
    await expect(row(revoked)).toBeVisible()
    const fresh = await generateWithNote(page)
    await expect(filter('All')).toBeChecked()
    await expect(fresh).toHaveAttribute('data-status', 'unused')
  })

  anonymousTest('the list is ordered by creation time, either way', async ({ page }) => {
    await openInviteCodes(page)
    const newest = await generateWithNote(page)
    const first = page.getByTestId('invite-code').first()

    // 默认最新的在前：刚生成的在第一页。（别的测试也在同时生成，不一定正好排第一）
    await expect(newest).toBeVisible()
    await expect(first).not.toContainText('e2e pool')

    // 换个方向：排第一的是测试开始前预先生成的那一批，刚生成的在最后一页
    await page.getByRole('button', { name: 'Newest first' }).click()
    await expect(page.getByRole('button', { name: 'Oldest first' })).toBeVisible()
    await expect(first).toContainText('e2e pool')
    await expect(newest).toHaveCount(0)
    await expect(page.getByTestId('invite-code-page')).toHaveText(/^1 \/ \d+$/)

    // 这时生成新的：换回最新的在前，新生成的就在眼前
    const another = await generateWithNote(page)
    await expect(page.getByRole('button', { name: 'Newest first' })).toBeVisible()
    await expect(another).toBeVisible()
    await expect(first).not.toContainText('e2e pool')
  })

  anonymousTest('select all ticks every unused code, and unticks them again', async ({ page }) => {
    await openInviteCodes(page)
    const first = await generateWithNote(page)
    const second = await generateWithNote(page)
    const selection = page.getByTestId('invite-code-selection')

    // 每次生成后选中的是刚生成的那一批
    await expect(first.getByRole('checkbox')).not.toBeChecked()
    await expect(second.getByRole('checkbox')).toBeChecked()

    await selection.getByRole('checkbox').check()
    await expect(first.getByRole('checkbox')).toBeChecked()
    await expect(second.getByRole('checkbox')).toBeChecked()

    await selection.getByRole('checkbox').uncheck()
    await expect(first.getByRole('checkbox')).not.toBeChecked()
    await expect(second.getByRole('checkbox')).not.toBeChecked()
    await expect(selection).toContainText('Select all')
    await expect(selection.getByRole('button')).toHaveCount(0)
  })
})

anonymousTest.describe('staying logged in', () => {
  anonymousTest(
    'the login survives closing the browser, and logging out ends it',
    async ({ browser }) => {
      const account = await createAccount()

      const first = await browser.newContext()
      const page = await first.newPage()
      await logIn(page, account.handle, account.password)
      await expect(page).toHaveURL(/\/chats$/)
      const saved = await first.storageState()
      await first.close()

      // "重新打开浏览器"：一个新的窗口，带着上次留下的 Cookie
      const second = await browser.newContext({ storageState: saved })
      const reopened = await second.newPage()
      await reopened.goto('/')
      await expect(reopened).toHaveURL(/\/chats$/)
      await expect(reopened.getByRole('heading', { name: 'Chats' })).toBeVisible()

      // 退出之后需要重新登录
      await reopened.goto('/settings')
      await reopened.getByRole('button', { name: 'Log out' }).click()
      await expect(reopened).toHaveURL(/\/login/)
      await reopened.goto('/chats')
      await expect(reopened).toHaveURL(/\/login/)
      await expect(reopened.getByRole('heading', { name: 'Log in' })).toBeVisible()
      await second.close()
    },
  )

  anonymousTest(
    'the same account can be logged in from two browsers at once',
    async ({ browser }) => {
      const account = await createAccount()
      const contexts = [await browser.newContext(), await browser.newContext()]
      for (const context of contexts) {
        const page = await context.newPage()
        await logIn(page, account.handle, account.password)
        await expect(page).toHaveURL(/\/chats$/)
      }
      // 第二处登录没有把第一处挤掉
      const first = contexts[0]?.pages()[0]
      await first?.reload()
      await expect(first ?? null).not.toBeNull()
      if (first) await expect(first.getByRole('heading', { name: 'Chats' })).toBeVisible()
      for (const context of contexts) await context.close()
    },
  )
})

test.describe('changing the id', () => {
  test('the new id logs in and the old one no longer does', async ({ page, account }) => {
    const newId = `e2e_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`

    await page.goto('/settings')
    await expect(page.getByTestId('my-id')).toHaveText(account.handle)
    await page.getByRole('button', { name: 'Change', exact: true }).click()

    const dialog = page.getByRole('dialog', { name: 'Change ID' })
    // 不符合规则的 ID 会说明原因
    await dialog.getByLabel('New ID').fill('ab')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog.getByRole('alert')).toContainText('6 to 20 characters')

    await dialog.getByLabel('New ID').fill(newId)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('my-id')).toHaveText(newId)

    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page).toHaveURL(/\/login/)

    await logIn(page, account.handle, account.password)
    await expect(page.getByRole('alert')).toHaveText('Incorrect ID or password.')

    await logIn(page, newId, account.password)
    await expect(page).toHaveURL(/\/chats$/)
  })

  test('an id that someone else has is refused', async ({ page }) => {
    const other = await createAccount()
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Change', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Change ID' })
    await dialog.getByLabel('New ID').fill(other.handle.toUpperCase())
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('That ID is already taken.')
  })
})

test.describe('profile', () => {
  test('nickname and signature can be changed', async ({ page }) => {
    await page.goto('/settings')
    const save = page.getByRole('button', { name: 'Save' })
    await expect(save).toBeDisabled()

    await page.getByLabel('Nickname').fill('  New Name  ')
    await page.getByLabel('Signature').fill('Hello there')
    await save.click()
    await expect(page.getByTestId('toast')).toHaveText('Saved')

    await page.reload()
    await expect(page.getByLabel('Nickname')).toHaveValue('New Name')
    await expect(page.getByLabel('Signature')).toHaveValue('Hello there')
  })

  test('an avatar uploaded in one window appears in another without reloading', async ({
    page,
    browser,
    account,
  }) => {
    // 同一个账号在另一个浏览器里的登录
    const { context: otherContext, page: other } = await logInElsewhere(browser, account)
    await other.goto('/settings')
    await page.goto('/settings')

    const avatar = (target: Page) => target.locator('img[src^="/api/files/"]')
    await expect(avatar(page)).toBeHidden()
    await expect(avatar(other)).toBeHidden()

    await page.getByTestId('avatar-input').setInputFiles({
      name: 'me.png',
      mimeType: 'image/png',
      buffer: pngImage(800, 600, [91, 91, 214]),
    })
    await expect(page.getByTestId('toast')).toHaveText('Avatar updated')
    await expect(avatar(page)).toBeVisible()

    // 另一个窗口没有刷新，头像自己出现了
    await expect(avatar(other)).toBeVisible()
    // 图片确实能加载出来，而不是一个坏掉的图标
    await expect
      .poll(() => avatar(other).evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    await otherContext.close()
  })

  test('a file that is not an image is refused', async ({ page }) => {
    await page.goto('/settings')
    await page.getByTestId('avatar-input').setInputFiles({
      name: 'notes.png',
      mimeType: 'image/png',
      buffer: Buffer.from('this is not an image'),
    })
    await expect(page.getByTestId('toast')).toHaveText(
      'Please choose an image (JPEG, PNG, GIF or WebP).',
    )
  })

  test('the password can be changed, ending the login in other browsers', async ({
    page,
    browser,
    account,
  }) => {
    const { context: otherContext, page: other } = await logInElsewhere(browser, account)
    await expect(other.getByRole('heading', { name: 'Chats' })).toBeVisible()

    await page.goto('/settings')
    await page.getByRole('button', { name: 'Change password' }).click()
    const dialog = page.getByRole('dialog', { name: 'Change password' })
    await dialog.getByLabel('Current password').fill('not-my-password-1')
    await dialog.getByLabel('New password', { exact: true }).fill('brand-new-pass-2')
    await dialog.getByLabel('Confirm new password').fill('brand-new-pass-2')
    await dialog.getByRole('button', { name: 'Change password' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('The current password is incorrect.')

    await dialog.getByLabel('Current password').fill(account.password)
    await dialog.getByRole('button', { name: 'Change password' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('toast')).toHaveText('Password changed')

    // 另一个浏览器里的登录失效了：不用刷新，它自己回到登录页
    await expect(other).toHaveURL(/\/login/)
    await otherContext.close()
  })
})

test.describe('preferences follow the account', () => {
  test('a language chosen in one browser applies after logging in from another', async ({
    page,
    browser,
    account,
  }) => {
    await page.goto('/settings')
    await page.getByRole('radio', { name: '简体中文' }).click()
    await page.getByRole('radio', { name: '深色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    // 等保存到账号的请求完成
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/me')
        const me = (await response.json()) as { language: string | null; theme: string | null }
        return `${me.language} ${me.theme}`
      })
      .toBe('zh-CN dark')

    // 一个全新的英文浏览器：登录前是英文、浅色，登录后跟着账号变成中文、深色
    const fresh = await browser.newContext({
      locale: 'en-US',
      colorScheme: 'light',
      // 新建的窗口默认会沿用这个测试的登录状态；这里要的是一个没有登录过的浏览器
      storageState: { cookies: [], origins: [] },
    })
    const other = await fresh.newPage()
    await logIn(other, account.handle, account.password)
    await expect(other.getByRole('heading', { name: '聊天' })).toBeVisible()
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark')
    await fresh.close()
  })
})

anonymousTest.describe('login protection', () => {
  let account: Account

  anonymousTest.beforeEach(async () => {
    account = await createAccount()
  })

  anonymousTest(
    'five wrong passwords lock the id, even for the right password',
    async ({ page }) => {
      await page.goto('/login')
      await page.getByLabel('ID').fill(account.handle)
      for (let attempt = 1; attempt <= 5; attempt++) {
        await page.getByLabel('Password').fill(`wrong-password-${attempt}`)
        await page.getByRole('button', { name: 'Log in' }).click()
        await expect(page.getByRole('alert')).toHaveText('Incorrect ID or password.')
        // 等这一次的请求结束，按钮恢复可用
        await expect(page.getByRole('button', { name: 'Log in' })).toBeEnabled()
      }

      await page.getByLabel('Password').fill(account.password)
      await page.getByRole('button', { name: 'Log in' }).click()
      await expect(page.getByRole('alert')).toHaveText(
        'Too many wrong passwords. This ID is temporarily locked. Try again in 15 minutes.',
      )
      await expect(page).toHaveURL(/\/login/)
    },
  )
})
