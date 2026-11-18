// 端到端测试的公共部分：准备账号、登录状态和测试用的图片。

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import {
  type APIRequestContext,
  type Browser,
  type BrowserContextOptions,
  test as base,
  expect,
  type Page,
  request,
  type WebSocketRoute,
} from '@playwright/test'

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3490'

// 管理员的初始密码与 scripts/e2e-stack 里的一致；第一次登录后会被改成第二个
export const ADMIN_INITIAL_PASSWORD = 'e2e-initial-1'
export const ADMIN_PASSWORD = 'e2e-admin-pass-2'
export const USER_PASSWORD = 'correct-horse-1'

type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>

export interface Account {
  /** 内部编号。 */
  id: string
  handle: string
  nickname: string
  password: string
  /** 这个账号的登录状态，可以交给新的浏览器窗口，窗口一打开就是已登录。 */
  storageState: StorageState
}

/** 一个直接调用接口的客户端。会改变数据的请求必须带上页面的来源。 */
export function newApi(storageState?: StorageState): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState,
  })
}

/** 以管理员身份调用接口。 */
export async function adminApi(): Promise<APIRequestContext> {
  const api = await newApi()
  const response = await api.post('/api/auth/login', {
    data: { handle: 'admin', password: ADMIN_PASSWORD },
  })
  expect(response.status(), 'admin login').toBe(200)
  return api
}

/** 管理员的一次新的登录，可以交给浏览器窗口。 */
export async function adminState(): Promise<StorageState> {
  const api = await adminApi()
  const state = await api.storageState()
  await api.dispose()
  return state
}

/** 以管理员的身份开一个浏览器窗口。 */
export async function openAsAdmin(
  browser: Browser,
  path: string,
  options: BrowserContextOptions = {},
) {
  const context = await browser.newContext({ ...options, storageState: await adminState() })
  const page = await context.newPage()
  await page.goto(path)
  return { context, page }
}

// 测试环境没有邮件服务：服务端把邮件写成这个目录里的文件（见 scripts/e2e-stack）
const MAIL_DIR = fileURLToPath(new URL('../.mail', import.meta.url))

/** 到现在为止写出来的邮件的文件名，按时间从早到晚。 */
function mailNames(): string[] {
  if (!existsSync(MAIL_DIR)) return []
  return readdirSync(MAIL_DIR)
    .filter((name) => name.endsWith('.txt'))
    .sort()
}

/**
 * 记下此刻已有的邮件；之后调用返回的函数，等来一封这之后发给 `to` 的邮件，
 * 交回里面的链接。
 */
export function watchMail(to: string): () => Promise<string> {
  const before = new Set(mailNames())
  return async () => {
    let link = ''
    await expect
      .poll(
        () => {
          for (const name of mailNames().reverse()) {
            if (before.has(name)) continue
            const content = readFileSync(join(MAIL_DIR, name), 'utf8')
            if (!content.startsWith(`To: ${to}\n`)) continue
            link = /https?:\/\/\S+/.exec(content)?.[0] ?? ''
            return link
          }
          return ''
        },
        { message: `mail to ${to}` },
      )
      .not.toBe('')
    return link
  }
}

/** 最近有没有发给这个地址的新邮件：给一点时间，仍然没有才算没有。 */
export async function noMailSince(names: Set<string>, to: string): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 1500))
  return !mailNames().some(
    (name) =>
      !names.has(name) && readFileSync(join(MAIL_DIR, name), 'utf8').startsWith(`To: ${to}\n`),
  )
}

/** 此刻已有的邮件。 */
export function mailSnapshot(): Set<string> {
  return new Set(mailNames())
}

// 预先生成的邀请码所在的目录，由 global-setup.ts 准备好后写进这个环境变量
const INVITE_POOL_ENV = 'E2E_INVITE_POOL'

/**
 * 预先生成一批邀请码，一个邀请码一个文件，放在一个临时目录里；
 * 之后注册测试账号时从里面领（见 createInviteCode）。返回这个目录。
 *
 * 邀请码列表按生成时间倒序、分页显示。如果每个测试账号都现生成一个邀请码，
 * 管理邀请码的测试刚生成的那几行，很快就被别的测试挤到后面的页上去了。
 * 预先生成的都比测试过程中生成的旧，排在后面，不会挤走谁。
 */
export async function prepareInvitePool(size: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vc-e2e-invites-'))
  const admin = await adminApi()
  for (let left = size; left > 0; left -= 20) {
    const response = await admin.post('/api/admin/invite-codes', {
      data: { count: Math.min(left, 20), note: 'e2e pool' },
    })
    expect(response.status(), 'prepare invite codes').toBe(201)
    const body = (await response.json()) as { items: { code: string }[] }
    for (const item of body.items) writeFileSync(join(dir, item.code), '')
  }
  await admin.dispose()
  process.env[INVITE_POOL_ENV] = dir
  return dir
}

/** 从预先生成的邀请码里领一个；领完了返回 undefined。 */
function takePooledInviteCode(): string | undefined {
  const dir = process.env[INVITE_POOL_ENV]
  if (!dir) return undefined
  for (;;) {
    const left = readdirSync(dir)
    const code = left[Math.floor(Math.random() * left.length)]
    if (!code) return undefined
    try {
      // 删除文件是原子操作：几个测试进程同时领同一个，只有一个成功
      rmSync(join(dir, code))
      return code
    } catch {
      // 被别的进程领走了，换一个
    }
  }
}

/** 一个还没有使用的邀请码：优先从预先生成的里面领，领完了再让管理员现生成。 */
export async function createInviteCode(): Promise<string> {
  const pooled = takePooledInviteCode()
  if (pooled) return pooled
  const admin = await adminApi()
  const response = await admin.post('/api/admin/invite-codes', { data: { count: 1 } })
  expect(response.status(), 'create invite code').toBe(201)
  const body = (await response.json()) as { items: { code: string }[] }
  await admin.dispose()
  const code = body.items[0]?.code
  if (!code) throw new Error('no invite code was returned')
  return code
}

let counter = 0

/** 通过接口注册一个新用户。每次调用都是一个全新的账号。 */
export async function createAccount(nickname?: string): Promise<Account> {
  counter += 1
  const name = nickname ?? `Tester ${Date.now().toString(36)}${counter}`
  const api = await newApi()
  const response = await api.post('/api/auth/register', {
    data: { invite_code: await createInviteCode(), nickname: name, password: USER_PASSWORD },
  })
  expect(response.status(), 'register').toBe(201)
  const me = (await response.json()) as { id: string; handle: string }
  const storageState = await api.storageState()
  await api.dispose()
  return { id: me.id, handle: me.handle, nickname: name, password: USER_PASSWORD, storageState }
}

/** 在登录页用 ID 和密码登录。 */
export async function logIn(page: Page, handle: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('ID').fill(handle)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
}

/** 同一个账号在另一个浏览器里再登录一次（是另一次登录，不是共用同一个 Cookie）。 */
export async function logInElsewhere(browser: Browser, account: Account) {
  const context = await browser.newContext({
    // 新建的窗口默认会沿用这个测试的登录状态；这里要的是一个没有登录过的浏览器
    storageState: { cookies: [], origins: [] },
  })
  const page = await context.newPage()
  await logIn(page, account.handle, account.password)
  await expect(page).toHaveURL(/\/chats$/)
  return { context, page }
}

/**
 * 接管一个页面的 WebSocket，可以掐断它，并且在放行之前不让它重新连上。
 * 要在页面打开之前调用。
 */
export async function controlConnection(page: Page) {
  let blocked = false
  const open = new Set<WebSocketRoute>()
  await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
    if (blocked) {
      void socket.close()
      return
    }
    const server = socket.connectToServer()
    open.add(socket)
    socket.onClose(() => {
      open.delete(socket)
      void server.close()
    })
  })
  return {
    /** 掐断连接。页面会不停地重试，但连不上。 */
    async cut() {
      blocked = true
      for (const socket of open) await socket.close()
    },
    /** 放行。页面下一次重试时就能连上。 */
    restore() {
      blocked = false
    },
  }
}

/**
 * 打开一个页面，并等它的实时连接建立好。
 * 接下来要靠推送才能看到的事情（别人发来消息、弹通知），要等连接好了再做，否则会错过。
 */
export async function gotoConnected(page: Page, path: string) {
  await page.goto(path)
  // 页面的最外层带着连接此刻的状态
  await expect(page.locator('[data-connection="open"]')).toBeVisible()
}

/** 再注册一个用户，名字带上给定的前缀，方便在页面上认出来。 */
export function another(prefix: string): Promise<Account> {
  counter += 1
  return createAccount(`${prefix} ${Date.now().toString(36)}${counter}`)
}

/** 以某个用户的身份开一个浏览器窗口。 */
export async function openAs(browser: Browser, account: Account, path: string) {
  const context = await browser.newContext({ storageState: account.storageState })
  const page = await context.newPage()
  await page.goto(path)
  return { context, page }
}

/** 通过接口让一个人向另一个人发好友申请，返回申请的编号。 */
export async function requestFriend(from: Account, to: Account, message = ''): Promise<string> {
  const api = await newApi(from.storageState)
  const found = await api.get(`/api/users/lookup?handle=${to.handle}`)
  expect(found.status(), 'lookup').toBe(200)
  const { user } = (await found.json()) as { user: { id: string } }
  const sent = await api.post('/api/friend-requests', { data: { to: user.id, message } })
  expect(sent.status(), 'send request').toBe(201)
  const body = (await sent.json()) as { request: { id: string } }
  await api.dispose()
  return body.request.id
}

/** 通过接口让两个人成为好友，省去在页面上一步步点。返回他们的会话的编号。 */
export async function befriend(a: Account, b: Account): Promise<string> {
  const id = await requestFriend(a, b)
  const api = await newApi(b.storageState)
  const accepted = await api.post(`/api/friend-requests/${id}/accept`)
  expect(accepted.status(), 'accept request').toBe(200)
  const { friend } = (await accepted.json()) as { friend: { user: { id: string } } }
  // 成为好友时会话已经创建好了
  const opened = await api.post('/api/conversations/direct', { data: { user_id: friend.user.id } })
  expect(opened.status(), 'open conversation').toBe(200)
  const conversation = (await opened.json()) as { id: string }
  await api.dispose()
  return conversation.id
}

/** 通过接口建一个群：`owner` 是群主，他先和每个成员成为好友。返回群的编号。 */
export async function makeGroup(owner: Account, members: Account[], name = ''): Promise<string> {
  for (const member of members) await befriend(owner, member)
  const api = await newApi(owner.storageState)
  const created = await api.post('/api/conversations/group', {
    data: { name, member_ids: members.map((member) => member.id) },
  })
  expect(created.ok(), 'create group').toBe(true)
  const group = (await created.json()) as { id: string }
  await api.dispose()
  return group.id
}

// 预先录好的那段语音放在哪里，由 global-setup.ts 录好后写进这个环境变量
export const VOICE_SAMPLE_ENV = 'E2E_VOICE_SAMPLE'

/** 预先录好的一段语音：WebM 里的 Opus，大约一秒半，是 Chrome 和 Firefox 录出来的格式。 */
export function voiceSample(): Buffer {
  const path = process.env[VOICE_SAMPLE_ENV]
  if (!path) throw new Error('the voice sample was not recorded')
  return readFileSync(path)
}

export interface UploadedFile {
  id: string
  name: string
  size: number
  width: number | null
  audio: boolean
}

/** 通过接口上传一个文件。 */
export async function uploadAs(
  account: Account,
  name: string,
  type: string,
  content: Buffer,
): Promise<UploadedFile> {
  const api = await newApi(account.storageState)
  const reply = await api.post('/api/files', {
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
    data: content,
  })
  expect(reply.status(), 'upload').toBe(201)
  const file = (await reply.json()) as UploadedFile
  await api.dispose()
  return file
}

/** 通过接口发一条消息，内容随意：带文件的、语音、回复。返回它的序号。 */
export async function post(
  from: Account,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<number> {
  const api = await newApi(from.storageState)
  messageCounter += 1
  const sent = await api.post(`/api/conversations/${conversationId}/messages`, {
    data: { client_id: `e2e-${Date.now().toString(36)}-p${messageCounter}`, ...body },
  })
  expect(sent.status(), 'send message').toBe(201)
  const message = (await sent.json()) as { seq: number }
  await api.dispose()
  return message.seq
}

/** 两个已经是好友的人的单聊会话的编号。 */
export async function directWith(me: Account, friend: Account): Promise<string> {
  const api = await newApi(me.storageState)
  const opened = await api.post('/api/conversations/direct', { data: { user_id: friend.id } })
  expect(opened.status(), 'open conversation').toBe(200)
  const conversation = (await opened.json()) as { id: string }
  await api.dispose()
  return conversation.id
}

let messageCounter = 0

/** 通过接口发几条消息，一条接一条，顺序就是给的顺序。 */
export async function say(from: Account, conversationId: string, ...texts: string[]) {
  const api = await newApi(from.storageState)
  for (const text of texts) {
    messageCounter += 1
    const sent = await api.post(`/api/conversations/${conversationId}/messages`, {
      data: { client_id: `e2e-${Date.now().toString(36)}-${messageCounter}`, text },
    })
    expect(sent.status(), 'send message').toBe(201)
  }
  await api.dispose()
}

export interface ShownNotice {
  title: string
  body: string
  tag: string
  closed: boolean
}

type NoticePermission = 'granted' | 'default' | 'denied'

/**
 * 接管浏览器的系统通知：不真的弹到屏幕上，只把每一条记下来。要在页面打开之前调用。
 * `choice` 是用户以前在这个浏览器里的选择；`answer` 是向浏览器请求授权时用户会怎么答。
 */
export async function takeOverNotifications(
  page: Page,
  options: { permission: NoticePermission; choice?: 'on' | 'off'; answer?: NoticePermission },
) {
  await page.addInitScript(({ permission, choice, answer }) => {
    const shown: unknown[] = []
    // 授权是浏览器记着的：刷新页面之后还在
    const remembered = localStorage.getItem('e2e.permission') as typeof permission | null
    class FakeNotification {
      static permission = remembered ?? permission
      static async requestPermission() {
        FakeNotification.permission = answer ?? 'granted'
        localStorage.setItem('e2e.permission', FakeNotification.permission)
        return FakeNotification.permission
      }
      title: string
      body: string
      tag: string
      closed = false
      onclick: (() => void) | null = null
      constructor(title: string, init: { body?: string; tag?: string } = {}) {
        this.title = title
        this.body = init.body ?? ''
        this.tag = init.tag ?? ''
        shown.push(this)
      }
      close() {
        this.closed = true
      }
    }
    Object.assign(window, { Notification: FakeNotification, __notices: shown })
    if (choice && !localStorage.getItem('vc.notify')) localStorage.setItem('vc.notify', choice)
  }, options)
}

export const notices = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __notices: ShownNotice[] }).__notices.map(
      ({ title, body, tag, closed }) => ({
        title,
        body,
        tag,
        closed,
      }),
    ),
  )

/** 用户点了第几条通知。 */
export const clickNotice = (page: Page, index: number) =>
  page.evaluate((i) => {
    const all = (window as unknown as { __notices: { onclick: (() => void) | null }[] }).__notices
    all[i]?.onclick?.()
  }, index)

/** 让页面以为自己被切到了后台，或者回到了前台。 */
export async function setForeground(page: Page, foreground: boolean) {
  await page.evaluate((visible) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (visible ? 'visible' : 'hidden'),
    })
    document.hasFocus = () => visible
    document.dispatchEvent(new Event('visibilitychange'))
  }, foreground)
}

type PickedFiles = Parameters<ReturnType<Page['getByTestId']>['setInputFiles']>[0]

/**
 * 在会话里选几个文件并发出去。
 * 选了之后它们先排在输入框上方，点发送才发出去；超过上限的那些当场就被拒绝，不会排进去。
 */
export async function sendFiles(page: Page, files: PickedFiles) {
  await page.getByTestId('file-input').setInputFiles(files)
  await expect(page.getByTestId('staged-file')).not.toHaveCount(0)
  // 按钮名要完全一样：消息里引用的话也可能带着"send"
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('staged-file')).toHaveCount(0)
}

/**
 * 默认的测试：每个测试都有一个刚注册的账号，浏览器一打开就是已登录。
 * 视口、语言、外观等设置照常生效。
 */
export const test = base.extend<{ account: Account; policyGuard: undefined }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright 要求第一个参数用解构的写法
  account: async ({}, use) => {
    await use(await createAccount())
  },
  storageState: async ({ account }, use) => {
    await use(account.storageState)
  },
  // 页面带着内容安全策略。正常使用时不应当有任何东西被它挡住：
  // 每个测试结束时检查一遍，有就算失败。
  policyGuard: [
    async ({ context }, use) => {
      const blocked: string[] = []
      await context.exposeBinding('__policyViolation', (_source, text: string) => {
        blocked.push(text)
      })
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          const report = (window as unknown as { __policyViolation?: (text: string) => void })
            .__policyViolation
          report?.(`${event.effectiveDirective} ${event.blockedURI} on ${location.pathname}`)
        })
      })
      await use(undefined)
      expect(blocked, 'blocked by the content security policy').toEqual([])
    },
    { auto: true },
  ],
})

/** 还没有登录的测试：登录页、注册页等。 */
export const anonymousTest = base

export { expect }

/** 生成一张纯色的 PNG 图片，用来测试上传头像。 */
export function pngImage(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from(rgb))])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8 位，RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 让"共享屏幕"不弹选择框，直接拿到一段品红色、上面有个黑块在动的画面。 */
export function fakeScreen() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    const g = canvas.getContext('2d') as CanvasRenderingContext2D
    let n = 0
    const draw = () => {
      g.fillStyle = '#ff00ff'
      g.fillRect(0, 0, canvas.width, canvas.height)
      g.fillStyle = '#000000'
      g.fillRect((n++ * 20) % 1200, 320, 80, 80)
    }
    draw()
    setInterval(draw, 100)
    const stream = canvas.captureStream(15)
    Object.assign(globalThis, { sharedScreen: stream.getVideoTracks()[0] })
    return stream
  }
}
