// README 里的截图：造一些像样的示例数据（几个人、一个爬山群、几个别的会话、一张照片、一条语音），
// 中文、英文各截一套：电脑上的聊天、手机上的聊天（深色）、群语音通话、管理后台的系统设置。
// 存到 screenshots-out/<语言>/，由 scripts/screenshots 复制到 docs/images/。见 screenshots.config.ts。

import { mkdirSync } from 'node:fs'
import { type Browser, type BrowserContextOptions, expect, type Page, test } from '@playwright/test'
import {
  type Account,
  adminState,
  befriend,
  createAccount,
  directWith,
  gotoConnected,
  newApi,
  post,
  say,
  uploadAs,
  voiceSample,
} from '../tests/support'

type Language = 'en' | 'zh-CN'

const TEXT = {
  en: {
    me: 'Alice Chen',
    ben: 'Ben Carter',
    carla: 'Carla Diaz',
    dev: 'Dev Patel',
    hike: 'Weekend Hike',
    book: 'Book Club',
    family: 'Family',
    family1: 'Dinner on Sunday at 6?',
    book1: 'Next month: "The Remains of the Day"',
    benAsks: 'Did you get the tickets?',
    meAnswers: 'Yes, two seats in row F 🎬',
    hike1: "Who's in for Saturday? The forecast says sunny ☀️",
    hike2: 'Count me in!',
    caption: 'The view from the top last time',
    reply: 'Wow, let’s go to the same spot',
    mention: (name: string) => `@${name} could you bring some snacks?`,
    sure: 'Sure, chocolate it is 🍫',
    start: 'Start',
  },
  'zh-CN': {
    me: '林小雨',
    ben: '陈明',
    carla: '王芳',
    dev: '周杰',
    hike: '周末爬山',
    book: '读书会',
    family: '一家人',
    family1: '周日晚上六点一起吃饭？',
    book1: '下个月读《长日将尽》',
    benAsks: '票买到了吗？',
    meAnswers: '买到了，F 排两个座位 🎬',
    hike1: '周六谁去？天气预报说是晴天 ☀️',
    hike2: '算我一个！',
    caption: '上次在山顶拍的',
    reply: '太美了，这次还去那儿',
    mention: (name: string) => `@${name} 能带点零食吗？`,
    sure: '没问题，带巧克力 🍫',
    start: '发起',
  },
} satisfies Record<Language, unknown>

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } }
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
}

/** 建一个群（群主和成员已经是好友）。 */
async function makeGroup(owner: Account, members: Account[], name: string): Promise<string> {
  const api = await newApi(owner.storageState)
  const created = await api.post('/api/conversations/group', {
    data: { name, member_ids: members.map((member) => member.id) },
  })
  expect(created.ok(), 'create group').toBe(true)
  const group = (await created.json()) as { id: string }
  await api.dispose()
  return group.id
}

/** 这个人把会话里的消息都看过了：别人那里显示"几人已读"。 */
async function readAll(account: Account, conversation: string) {
  const api = await newApi(account.storageState)
  const view = (await (await api.get(`/api/conversations/${conversation}`)).json()) as {
    last_seq: number
  }
  const read = await api.post(`/api/conversations/${conversation}/read`, {
    data: { seq: view.last_seq },
  })
  expect(read.ok(), 'mark read').toBe(true)
  await api.dispose()
}

/** 这个账号的界面语言和外观。 */
async function preferences(storageState: Account['storageState'], language: Language) {
  const api = await newApi(storageState)
  const reply = await api.patch('/api/me', { data: { language, theme: 'system' } })
  expect(reply.ok(), 'set preferences').toBe(true)
  await api.dispose()
}

/** 一张"照片"：在页面里画一幅山景再截下来，不用带图片文件。 */
async function photo(browser: Browser): Promise<Buffer> {
  const page = await browser.newPage({
    viewport: { width: 960, height: 640 },
    deviceScaleFactor: 1,
  })
  await page.setContent(`
    <body style="margin:0">
      <svg width="960" height="640" viewBox="0 0 960 640" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#3b6fb6"/><stop offset="0.55" stop-color="#f3a76b"/><stop offset="1" stop-color="#fbd38d"/>
          </linearGradient>
        </defs>
        <rect width="960" height="640" fill="url(#sky)"/>
        <circle cx="690" cy="330" r="46" fill="#fff3c4" opacity="0.9"/>
        <path d="M0 420 L160 250 L280 360 L420 190 L560 340 L700 230 L860 380 L960 300 L960 640 L0 640 Z" fill="#41506b"/>
        <path d="M0 500 L120 400 L260 470 L400 360 L540 470 L680 390 L820 480 L960 420 L960 640 L0 640 Z" fill="#2c3a50"/>
        <path d="M0 580 L200 520 L380 570 L560 510 L760 575 L960 530 L960 640 L0 640 Z" fill="#1d2738"/>
      </svg>
    </body>`)
  const image = await page.screenshot({ type: 'png' })
  await page.close()
  return image
}

async function shot(page: Page, file: string) {
  // 动画、加载中的图都停下来再截
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images)
        .filter((image) => !image.complete)
        .map(
          (image) =>
            new Promise((resolve) => image.addEventListener('load', resolve, { once: true })),
        ),
    ),
  )
  await page.waitForTimeout(500)
  await page.screenshot({ path: file })
}

/** 以这个人的身份开一个窗口，打开这个会话。 */
async function open(
  browser: Browser,
  account: Account,
  path: string,
  language: Language,
  options: BrowserContextOptions,
) {
  const context = await browser.newContext({
    ...options,
    locale: language,
    storageState: account.storageState,
  })
  const page = await context.newPage()
  await gotoConnected(page, path)
  return page
}

for (const language of ['en', 'zh-CN'] as const) {
  test(`README screenshots (${language})`, async ({ browser }) => {
    const t = TEXT[language]
    const dir = `screenshots-out/${language}`
    mkdirSync(dir, { recursive: true })

    const me = await createAccount(t.me)
    const ben = await createAccount(t.ben)
    const carla = await createAccount(t.carla)
    const dev = await createAccount(t.dev)
    for (const account of [me, ben, carla, dev]) await preferences(account.storageState, language)
    for (const friend of [ben, carla, dev]) await befriend(me, friend)

    // 列表里别的会话：先建，好让爬山群排在最上面
    const family = await makeGroup(me, [ben, carla], t.family)
    await say(ben, family, t.family1)
    const book = await makeGroup(me, [carla, dev], t.book)
    await say(carla, book, t.book1)
    const withBen = await directWith(me, ben)
    await say(ben, withBen, t.benAsks)
    await say(me, withBen, t.meAnswers)
    const api = await newApi(me.storageState)
    expect(
      (await api.put(`/api/conversations/${family}/pin`, { data: { pinned: true } })).ok(),
    ).toBe(true)
    await api.dispose()

    // 爬山群：文字、照片带说明、回复、语音、@
    const hike = await makeGroup(me, [ben, carla, dev], t.hike)
    await say(ben, hike, t.hike1)
    await say(carla, hike, t.hike2)
    const picture = await uploadAs(dev, 'summit.png', 'image/png', await photo(browser))
    const photoSeq = await post(dev, hike, { file_id: picture.id, text: t.caption })
    await post(me, hike, { text: t.reply, reply_to: photoSeq })
    const voice = await uploadAs(ben, 'voice.webm', 'audio/webm;codecs=opus', voiceSample())
    await post(ben, hike, { file_id: voice.id, voice_duration_ms: 4000 })
    await post(carla, hike, { text: t.mention(me.nickname), mentions: [me.id] })
    await say(me, hike, t.sure)
    for (const person of [carla, dev]) await readAll(person, hike)

    // 1. 电脑上的聊天（浅色）
    const desktop = await open(browser, me, `/chats/${hike}`, language, {
      ...DESKTOP,
      colorScheme: 'light',
    })
    await expect(desktop.getByTestId('message-text').last()).toBeVisible()
    await shot(desktop, `${dir}/chat.png`)

    // 2. 手机上的聊天（深色）
    const phone = await open(browser, me, `/chats/${hike}`, language, {
      ...PHONE,
      colorScheme: 'dark',
    })
    await expect(phone.getByTestId('message-text').last()).toBeVisible()
    await shot(phone, `${dir}/phone.png`)
    await phone.context().close()

    // 3. 群语音通话：四个人都在里面
    const others = []
    for (const person of [ben, carla, dev]) {
      others.push(await open(browser, person, `/chats/${hike}`, language, DESKTOP))
    }
    await desktop.getByTestId('group-voice-call').click()
    await desktop.getByTestId('group-call-picker').getByRole('button', { name: t.start }).click()
    for (const page of others) await page.getByTestId('group-call-accept').click()
    await expect(desktop.getByTestId('group-call-member')).toHaveCount(4, { timeout: 30_000 })
    await expect(desktop.getByTestId('group-call-screen')).toHaveAttribute('data-phase', 'active')
    // 让通话的计时走几秒
    await desktop.waitForTimeout(6_000)
    await shot(desktop, `${dir}/group-call.png`)
    for (const page of [desktop, ...others]) await page.context().close()

    // 4. 管理后台的系统设置
    const adminContext = await browser.newContext({
      ...DESKTOP,
      locale: language,
      colorScheme: 'light',
      storageState: await adminState(),
    })
    await preferences(await adminContext.storageState(), language)
    const admin = await adminContext.newPage()
    await admin.goto('/admin/settings')
    // 管理员看到更新说明时先关掉
    const notes = admin.getByTestId('release-notes')
    if (await notes.isVisible().catch(() => false)) await admin.keyboard.press('Escape')
    await expect(admin.getByRole('heading').first()).toBeVisible()
    await shot(admin, `${dir}/admin.png`)
    await adminContext.close()
  })
}
