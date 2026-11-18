// 桌面客户端在 Web 应用里的那一部分：页面的内容安全策略、设置里的下载入口，
// 以及页面被桌面端加载时的表现。
//
// 真正的桌面端是一个 Mac 应用，在这里跑不了。它和页面之间只隔着 `window.vibeDesktop`
// 这一组接口，所以这里放一组假的：记下页面调用了什么，并且可以扮演桌面端给页面发指令。
// 真应用的检查在 client/apps/desktop/scripts/check 里，在 Mac 上跑。

import type { Page } from '@playwright/test'
import {
  another,
  befriend,
  clickNotice,
  expect,
  gotoConnected,
  newApi,
  notices,
  say,
  setForeground,
  takeOverNotifications,
  test,
} from './support'

// scripts/e2e-stack 放在服务器上的那个假安装包
const INSTALLER = {
  version: '0.9.0',
  name: 'VibeChat-0.9.0-arm64.dmg',
  content: 'not a real installer, just bytes for the tests\n',
}

/** 让页面以为自己在某一种设备上。要在页面打开之前调用。 */
async function pretendDevice(page: Page, platform: string, maxTouchPoints = 0) {
  await page.addInitScript(
    (device) => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => device.platform })
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
        get: () => device.maxTouchPoints,
      })
    },
    { platform, maxTouchPoints },
  )
}

type Call = ['unread', number] | ['show'] | ['language', string]

/** 让页面以为自己被某个版本的桌面端加载。要在页面打开之前调用。 */
async function pretendDesktop(page: Page, version: string) {
  await pretendDevice(page, 'MacIntel')
  await page.addInitScript((version) => {
    const calls: unknown[][] = []
    const listeners: ((command: string) => void)[] = []
    Object.assign(window, {
      __desktop: {
        calls,
        send(command: string) {
          for (const listener of [...listeners]) listener(command)
        },
      },
      vibeDesktop: {
        version,
        setUnreadCount: (count: number) => calls.push(['unread', count]),
        showWindow: () => calls.push(['show']),
        setLanguage: (language: string) => calls.push(['language', language]),
        onCommand(listener: (command: string) => void) {
          listeners.push(listener)
          return () => listeners.splice(listeners.indexOf(listener), 1)
        },
      },
    })
  }, version)
}

interface FakeDesktop {
  calls: Call[]
  send(command: string): void
}
const desktop = (page: Page) =>
  page.evaluate(() => (window as unknown as { __desktop: FakeDesktop }).__desktop.calls)
const command = (page: Page, name: string) =>
  page.evaluate(
    (name) => (window as unknown as { __desktop: FakeDesktop }).__desktop.send(name),
    name,
  )
/** 页面最近一次告诉桌面端的未读数。 */
const lastUnread = async (page: Page) =>
  (await desktop(page)).filter((call) => call[0] === 'unread').at(-1)?.[1]

const client = (page: Page) => page.getByTestId('desktop-client')

test.describe('the content security policy', () => {
  test('comes with the page and stops inline scripts', async ({ browser, account }) => {
    // 这里故意去撞策略，所以不用默认的窗口（它会把被挡下的东西当作失败）
    const context = await browser.newContext({ storageState: account.storageState })
    const page = await context.newPage()
    const response = await page.goto('/settings')
    const policy = response?.headers()['content-security-policy'] ?? ''
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).not.toContain("'unsafe-eval'")
    await expect(page.getByTestId('server-status')).toContainText('version')

    const outcome = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          document.addEventListener('securitypolicyviolation', (event) =>
            resolve(`blocked by ${event.effectiveDirective}`),
          )
          const script = document.createElement('script')
          script.textContent = 'window.__ranInline = true'
          document.head.append(script)
          setTimeout(() => resolve('nothing stopped it'), 3000)
        }),
    )
    expect(outcome).toMatch(/^blocked by script-src/)
    expect(await page.evaluate(() => '__ranInline' in window)).toBe(false)

    // 页面里的事件处理属性也是内嵌脚本
    await page.evaluate(() => {
      const image = document.createElement('img')
      image.setAttribute('onerror', 'window.__ranHandler = true')
      image.src = '/no-such-image.png'
      document.body.append(image)
    })
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => '__ranHandler' in window)).toBe(false)
    await context.close()
  })

  test('is not put on what the backend serves', async () => {
    const api = await newApi()
    const health = await api.get('/api/health')
    expect(health.headers()['content-security-policy']).toBeUndefined()
    await api.dispose()
  })
})

test.describe('downloading the desktop app from the web app', () => {
  test('is offered in a browser on a Mac', async ({ page }) => {
    await pretendDevice(page, 'MacIntel')
    await page.goto('/settings')
    await expect(client(page).getByTestId('desktop-offer')).toHaveText(
      `For macOS, ${INSTALLER.version}, ${INSTALLER.content.length} B`,
    )
    // 这是浏览器，没有"已经装了哪个版本"可说
    await expect(client(page).getByTestId('desktop-version')).toHaveCount(0)
    await expect(client(page)).toContainText('Apple silicon')
    await expect(client(page)).toContainText('Open Anyway')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      client(page).getByRole('link', { name: 'Download' }).click(),
    ])
    expect(download.suggestedFilename()).toBe(INSTALLER.name)
    const chunks: Buffer[] = []
    for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe(INSTALLER.content)
  })

  for (const device of [
    { name: 'Windows', platform: 'Win32', touch: 0 },
    { name: 'Linux', platform: 'Linux x86_64', touch: 0 },
    { name: 'an iPhone', platform: 'iPhone', touch: 5 },
    // iPad 在"桌面版网站"模式下自称 Mac
    { name: 'an iPad', platform: 'MacIntel', touch: 5 },
  ]) {
    test(`is not offered on ${device.name}`, async ({ page }) => {
      await pretendDevice(page, device.platform, device.touch)
      await page.goto('/settings')
      await expect(page.getByTestId('server-status')).toContainText('version')
      await expect(client(page)).toHaveCount(0)
    })
  }

  test('is not offered when the server has no installer', async ({ page }) => {
    await pretendDevice(page, 'MacIntel')
    await page.route('**/api/desktop/latest', (route) => route.fulfill({ json: { release: null } }))
    const asked = page.waitForResponse('**/api/desktop/latest')
    await page.goto('/settings')
    await asked
    await expect(page.getByTestId('server-status')).toContainText('version')
    await expect(client(page)).toHaveCount(0)
  })

  test('needs a login', async () => {
    const visitor = await newApi()
    for (const path of ['/api/desktop/latest', '/api/desktop/download']) {
      expect((await visitor.get(path)).status(), path).toBe(401)
    }
    await visitor.dispose()
  })
})

test.describe('telling people about the desktop app', () => {
  const prompt = (page: Page) => page.getByTestId('desktop-prompt')
  const entry = (page: Page) => page.getByTestId('desktop-entry')
  const dialog = (page: Page) => page.getByTestId('desktop-dialog')
  const offer = `For macOS, ${INSTALLER.version}, ${INSTALLER.content.length} B`

  test('a Mac browser is told once, after the question about notifications', async ({ page }) => {
    await takeOverNotifications(page, { permission: 'default', answer: 'denied' })
    await pretendDevice(page, 'MacIntel')
    await page.goto('/chats')
    // 一次只问一件事：先问通知
    await expect(page.getByTestId('notice-prompt')).toBeVisible()
    await expect(prompt(page)).toHaveCount(0)
    await page.getByTestId('notice-prompt').getByRole('button', { name: 'No thanks' }).click()
    await expect(prompt(page)).toContainText('VibeChat now has a Mac app')

    // "下载"打开的是带着安装说明的对话框，提示就此收起
    await prompt(page).getByRole('button', { name: 'Download' }).click()
    await expect(prompt(page)).toHaveCount(0)
    await expect(dialog(page).getByTestId('desktop-offer')).toHaveText(offer)
    await expect(dialog(page)).toContainText('Apple silicon')
    await expect(dialog(page)).toContainText('Open Anyway')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog(page).getByRole('link', { name: 'Download' }).click(),
    ])
    expect(download.suggestedFilename()).toBe(INSTALLER.name)
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(dialog(page)).toHaveCount(0)

    await page.reload()
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(entry(page)).toBeVisible()
    await expect(prompt(page)).toHaveCount(0)
  })

  test('after "No thanks" it stays away, and the icon in the navigation remains', async ({
    page,
  }) => {
    await takeOverNotifications(page, { permission: 'granted', choice: 'off' })
    await pretendDevice(page, 'MacIntel')
    await page.goto('/chats')
    await prompt(page).getByRole('button', { name: 'No thanks' }).click()
    await expect(prompt(page)).toHaveCount(0)
    await expect(dialog(page)).toHaveCount(0)
    await page.reload()
    await expect(entry(page)).toBeVisible()
    await expect(prompt(page)).toHaveCount(0)

    await expect(entry(page)).toHaveAccessibleName('Download the desktop app')
    await expect(page.getByTestId('desktop-entry-dot')).toHaveCount(0)
    await entry(page).click()
    await expect(dialog(page).getByTestId('desktop-offer')).toHaveText(offer)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    // 图标在哪个页面上都在
    await page.goto('/contacts')
    await entry(page).click()
    await expect(dialog(page).getByTestId('desktop-offer')).toHaveText(offer)
  })

  test('a narrow window on a Mac still gets the prompt', async ({ page }) => {
    await takeOverNotifications(page, { permission: 'granted', choice: 'off' })
    await pretendDevice(page, 'MacIntel')
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto('/chats')
    await expect(prompt(page)).toBeVisible()
    // 窄的时候没有左侧的导航栏
    await expect(entry(page)).toBeHidden()
    await prompt(page).getByRole('button', { name: 'Download' }).click()
    await expect(dialog(page).getByTestId('desktop-offer')).toHaveText(offer)
  })

  for (const device of [
    { name: 'Windows', platform: 'Win32', touch: 0 },
    { name: 'Linux', platform: 'Linux x86_64', touch: 0 },
    { name: 'an iPad', platform: 'MacIntel', touch: 5 },
  ]) {
    test(`nothing is shown on ${device.name}`, async ({ page }) => {
      await takeOverNotifications(page, { permission: 'granted', choice: 'off' })
      await pretendDevice(page, device.platform, device.touch)
      await page.goto('/chats')
      await expect(page.getByTestId('open-search')).toBeVisible()
      await expect(page.getByTestId('nav-rail')).toBeVisible()
      await expect(prompt(page)).toHaveCount(0)
      await expect(entry(page)).toHaveCount(0)
    })
  }

  test('nothing is shown when the server has no installer', async ({ page }) => {
    await takeOverNotifications(page, { permission: 'granted', choice: 'off' })
    await pretendDevice(page, 'MacIntel')
    await page.route('**/api/desktop/latest', (route) => route.fulfill({ json: { release: null } }))
    const asked = page.waitForResponse('**/api/desktop/latest')
    await page.goto('/chats')
    await asked
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(prompt(page)).toHaveCount(0)
    await expect(entry(page)).toHaveCount(0)
  })

  test('inside the desktop app a newer version is announced once, and the dot on the icon stays', async ({
    page,
  }) => {
    await takeOverNotifications(page, { permission: 'granted' })
    await pretendDesktop(page, '0.1.0')
    await page.goto('/chats')
    await expect(entry(page)).toHaveAccessibleName('Desktop app update available')
    await expect(page.getByTestId('desktop-entry-dot')).toBeVisible()
    // 顶部提示一次这个版本；不是给浏览器的那条"有 Mac 客户端了"
    await expect(prompt(page)).toHaveCount(0)
    const update = page.getByTestId('desktop-update-prompt')
    await expect(update).toContainText(`Desktop app ${INSTALLER.version} is available`)
    await update.getByRole('button', { name: 'Later' }).click()
    await expect(update).toHaveCount(0)
    // 这个版本不再提示；小红点还在
    await page.reload()
    await expect(page.getByTestId('desktop-entry-dot')).toBeVisible()
    await expect(update).toHaveCount(0)
    await entry(page).click()
    await expect(dialog(page).getByTestId('desktop-offer')).toHaveText(
      `Version ${INSTALLER.version} is available, ${INSTALLER.content.length} B`,
    )
    await expect(dialog(page)).toContainText('quit VibeChat')
  })

  test('inside an up-to-date desktop app nothing is shown', async ({ page }) => {
    await takeOverNotifications(page, { permission: 'granted' })
    await pretendDesktop(page, INSTALLER.version)
    const asked = page.waitForResponse('**/api/desktop/latest')
    await page.goto('/chats')
    await asked
    await expect(page.getByTestId('open-search')).toBeVisible()
    await expect(prompt(page)).toHaveCount(0)
    await expect(entry(page)).toHaveCount(0)
  })
})

test.describe('inside the desktop app', () => {
  test('shows its own version, and a newer one when the server has it', async ({ page }) => {
    await pretendDesktop(page, '0.1.0')
    await page.goto('/settings')
    await expect(client(page).getByTestId('desktop-version')).toHaveText('Version 0.1.0')
    await expect(client(page).getByTestId('desktop-offer')).toHaveText(
      `Version ${INSTALLER.version} is available, ${INSTALLER.content.length} B`,
    )
    // 桌面端里是按钮：页面自己下载、显示进度
    await expect(client(page).getByRole('button', { name: 'Download' })).toBeVisible()
    await expect(client(page)).toContainText('quit VibeChat')
  })

  test('downloads the new version with progress, then hands it over to be saved', async ({
    page,
  }) => {
    await pretendDesktop(page, '0.1.0')
    // 先把下载拦住，看得到下载中的样子
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/desktop/download', async (route) => {
      await held
      await route.continue()
    })
    await page.goto('/settings')
    await client(page).getByRole('button', { name: 'Download' }).click()
    const progress = client(page).getByTestId('desktop-download-progress')
    await expect(progress).toContainText('Downloading 0%')
    await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')

    const saved = page.waitForEvent('download')
    release()
    const download = await saved
    expect(download.suggestedFilename()).toBe(INSTALLER.name)
    const chunks: Buffer[] = []
    for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe(INSTALLER.content)
    await expect(client(page).getByTestId('desktop-download-done')).toContainText('Downloaded')
    await expect(progress).toHaveCount(0)
  })

  test('a download in progress can be cancelled', async ({ page }) => {
    await pretendDesktop(page, '0.1.0')
    await page.route('**/api/desktop/download', () => {
      // 一直不回答
    })
    await page.goto('/settings')
    await client(page).getByRole('button', { name: 'Download' }).click()
    await expect(client(page).getByTestId('desktop-download-progress')).toBeVisible()
    await client(page).getByRole('button', { name: 'Cancel download' }).click()
    await expect(client(page).getByTestId('desktop-download-progress')).toHaveCount(0)
    await expect(client(page).getByRole('button', { name: 'Download' })).toBeVisible()
  })

  for (const version of ['0.9.0', '0.10.0', '1.0.0']) {
    test(`offers nothing when it is already at ${version}`, async ({ page }) => {
      await pretendDesktop(page, version)
      const asked = page.waitForResponse('**/api/desktop/latest')
      await page.goto('/settings')
      await asked
      await expect(client(page).getByTestId('desktop-version')).toHaveText(`Version ${version}`)
      await expect(client(page).getByTestId('desktop-offer')).toHaveCount(0)
      await expect(client(page).getByRole('button', { name: 'Download' })).toHaveCount(0)
    })
  }

  test('tells the desktop side the unread total, for the Dock icon', async ({ page, account }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const withBea = await befriend(account, bea)
    const withCy = await befriend(account, cy)
    await pretendDesktop(page, '0.1.0')
    await gotoConnected(page, '/contacts')
    await expect.poll(() => lastUnread(page)).toBe(0)

    await say(bea, withBea, 'one', 'two')
    await expect.poll(() => lastUnread(page)).toBe(2)
    await say(cy, withCy, 'three')
    await expect.poll(() => lastUnread(page)).toBe(3)
    // 页面标题照旧
    await expect(page).toHaveTitle('(3) VibeChat')

    await page.goto(`/chats/${withBea}`)
    await expect.poll(() => lastUnread(page)).toBe(1)
    await page.goto(`/chats/${withCy}`)
    await expect.poll(() => lastUnread(page)).toBe(0)
  })

  test('keeps the desktop side in step with the language', async ({ page }) => {
    await pretendDesktop(page, '0.1.0')
    await page.goto('/settings')
    const languages = async () =>
      (await desktop(page)).filter((call) => call[0] === 'language').map((call) => call[1])
    await expect.poll(languages).toEqual(['en'])
    await page.getByRole('radio', { name: '简体中文' }).click()
    await expect.poll(async () => (await languages()).at(-1)).toBe('zh-CN')
    await page.getByRole('radio', { name: 'English' }).click()
    await expect.poll(async () => (await languages()).at(-1)).toBe('en')
  })

  test('has notifications on without being asked, and a click on one brings the window forward', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    // 桌面端对自己的服务器直接放行通知；用户从来没有动过这个开关
    await takeOverNotifications(page, { permission: 'granted' })
    await pretendDesktop(page, '0.1.0')
    await gotoConnected(page, '/settings')
    const toggle = page.getByRole('radiogroup', { name: 'System notifications' })
    await expect(toggle.getByRole('radio', { name: 'On' })).toBeChecked()
    await expect(page.getByTestId('notice-prompt')).toHaveCount(0)

    await setForeground(page, false)
    await say(bea, conversation, 'are you there?')
    await expect.poll(() => notices(page)).toHaveLength(1)
    expect((await desktop(page)).some((call) => call[0] === 'show')).toBe(false)
    await clickNotice(page, 0)
    await expect(page).toHaveURL(new RegExp(`/chats/${conversation}$`))
    expect((await desktop(page)).filter((call) => call[0] === 'show')).toHaveLength(1)

    // 关掉之后就不弹了，和浏览器里一样
    await setForeground(page, true)
    await page.goto('/settings')
    await toggle.getByRole('radio', { name: 'Off' }).click()
    await expect(toggle.getByRole('radio', { name: 'Off' })).toBeChecked()
    await page.reload()
    await expect(toggle.getByRole('radio', { name: 'Off' })).toBeChecked()
  })

  test('in a browser the same switch still starts off', async ({ page }) => {
    await takeOverNotifications(page, { permission: 'granted' })
    await page.goto('/settings')
    const toggle = page.getByRole('radiogroup', { name: 'System notifications' })
    await expect(toggle.getByRole('radio', { name: 'Off' })).toBeChecked()
  })

  test('opens the settings page when the menu asks for it', async ({ page }) => {
    await pretendDesktop(page, '0.1.0')
    await gotoConnected(page, '/contacts')
    await command(page, 'open-settings')
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId('server-status')).toBeVisible()
    // 不认识的指令不出错，也不做什么
    await command(page, 'something-newer')
    await expect(page).toHaveURL(/\/settings$/)
  })

  test('reconnects at once when the Mac wakes up', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await pretendDesktop(page, '0.1.0')
    let sockets = 0
    page.on('websocket', () => {
      sockets += 1
    })
    await gotoConnected(page, `/chats/${conversation}`)
    expect(sockets).toBe(1)

    await command(page, 'reconnect')
    await expect.poll(() => sockets).toBe(2)
    await expect(page.locator('[data-connection="open"]')).toBeVisible()
    // 新的连接是好的：推送照常收到
    await say(bea, conversation, 'welcome back')
    await expect(page.getByTestId('message').last()).toContainText('welcome back')
  })
})

test.describe('an old desktop app', () => {
  test('is asked to update first when the server requires a newer one', async ({ page }) => {
    await takeOverNotifications(page, { permission: 'granted' })
    await pretendDesktop(page, '0.1.0')
    await page.route('**/api/desktop/latest', async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      await route.fulfill({ response, json: { ...body, min_version: '0.5.0' } })
    })
    await page.goto('/chats')
    const required = page.getByTestId('desktop-update-required')
    await expect(required).toContainText('Please update the desktop app')
    await expect(required).toContainText('(0.1.0) can no longer be used')
    await expect(required.getByTestId('desktop-offer')).toHaveText(
      `Version ${INSTALLER.version} is available, ${INSTALLER.content.length} B`,
    )
    // 更新之前什么都用不了
    await expect(page.getByTestId('open-search')).toHaveCount(0)
  })

  for (const where of ['an up-to-date desktop app', 'a browser']) {
    test(`${where} is not stopped by the minimum`, async ({ page }) => {
      await takeOverNotifications(page, { permission: 'granted' })
      if (where === 'a browser') await pretendDevice(page, 'MacIntel')
      else await pretendDesktop(page, INSTALLER.version)
      await page.route('**/api/desktop/latest', async (route) => {
        const response = await route.fetch()
        const body = await response.json()
        await route.fulfill({ response, json: { ...body, min_version: '0.5.0' } })
      })
      const asked = page.waitForResponse('**/api/desktop/latest')
      await page.goto('/chats')
      await asked
      await expect(page.getByTestId('open-search')).toBeVisible()
      await expect(page.getByTestId('desktop-update-required')).toHaveCount(0)
    })
  }
})
