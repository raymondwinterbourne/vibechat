// 主进程：窗口、系统菜单、程序坞、下载、权限，以及"页面可以去哪里"。
//
// 界面本身不在这里：窗口加载的是服务器上的 Web 应用。这里的每一处规则都尽量写成
// 不依赖 Electron 的函数（见同目录下的其他文件），这个文件只负责把它们接到 Electron 上。

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
} from 'electron'
import { builtInServer, isLocalServer, resolveServer } from './config.js'
import { ensurePolicy } from './csp.js'
import { applicationMenu, contextMenu, type Item } from './menus.js'
import {
  badgeText,
  CHANNELS,
  type Command,
  parseCallAlert,
  parseLanguage,
  parseUnread,
} from './messages.js'
import { fromServer, judge, mediaToAsk, screenAccessOf, usesSystemPicker } from './policy.js'
import { load, save } from './store.js'
import { languageOf } from './strings.js'
import { hidesOnClose, MIN_SIZE, restoreBounds } from './window-state.js'

/** 连不上服务器时，每隔多久自己重试一次。 */
const RETRY_MS = 5000
/** 页面可以申请的权限。别的一律拒绝。0.4.0 起放行共享屏幕（display-capture）。 */
const PERMISSIONS = new Set([
  'notifications',
  'media',
  'display-capture',
  'clipboard-sanitized-write',
])
/** 共享屏幕时用 macOS 自带的选择框（macOS 15 起）。 */
const SYSTEM_PICKER = usesSystemPicker(process.platform, process.getSystemVersion())
/** 自动检查时不弹出系统的对话框、不真的去打开浏览器。 */
const TESTING = process.env.VC_DESKTOP_TEST === '1'

// 自动检查用单独的数据目录，不碰平时用的那一份
if (process.env.VC_USER_DATA) app.setPath('userData', process.env.VC_USER_DATA)

const resolved = resolveServer({ argv: process.argv, env: process.env, builtIn: builtInServer() })
if (!resolved.ok) {
  if (!TESTING) {
    dialog.showErrorBox(
      'VibeChat',
      resolved.given
        ? `Invalid server address: ${resolved.given}`
        : 'No server address. Package the app with VC_SERVER_URL, or start it with --server=https://…',
    )
  }
  app.exit(1)
}
const server = resolved.ok ? resolved.url : new URL('https://invalid.invalid')

// 只运行一个。再启动一次时，把已经在运行的那个带到前台
if (!app.requestSingleInstanceLock()) app.exit(0)

const storePath = join(app.getPath('userData'), 'desktop.json')
const saved = load(storePath)
const offlineFile = join(app.getAppPath(), 'resources', 'offline', 'index.html')
const offlineUrl = pathToFileURL(offlineFile).href

/** 主进程此刻知道的情况。自动检查从这里读，确认页面发来的消息到了。 */
const state = {
  server: server.origin,
  unread: 0,
  language: saved.language ?? languageOf(app.getLocale()),
  /** 正显示着"连不上服务器"的页面。 */
  offline: false,
  /** 交给系统浏览器打开的地址。 */
  external: [] as string[],
  /** 发给页面的指令。 */
  commands: [] as Command[],
}
Object.assign(globalThis, { vcDesktop: state })

let window: BrowserWindow | null = null
// 自动检查时，让检查的脚本看得到窗口和菜单，并且能替用户做几个动作
if (TESTING) {
  Object.assign(globalThis, {
    vcDesktopProbe: {
      menu: () => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? [],
      window: () =>
        window && {
          visible: window.isVisible(),
          bounds: window.getNormalBounds(),
          minimum: window.getMinimumSize(),
        },
      moveWindow: (bounds: Electron.Rectangle) => window?.setBounds(bounds),
      closeWindow: () => window?.close(),
      clickDock: () => app.emit('activate'),
      chooseMenu: runMenuCommand,
      wake: () => powerMonitor.emit('resume'),
      quit: () => app.quit(),
    },
  })
}
let quitting = false
let retryTimer: NodeJS.Timeout | null = null

// 不能在这里直接等"准备好了"：Electron 要等这个文件执行完才会发出那个信号，等它就永远等不到
void app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'VibeChat',
    applicationVersion: app.getVersion(),
    version: '',
  })
  protectSession()
  window = createWindow()
  buildMenu()
  loadApp()
  // Mac 刚唤醒：连接多半已经断了，让页面立即重连，不用等心跳超时
  powerMonitor.on('resume', () => sendCommand('reconnect'))
})

app.on('second-instance', showWindow)
// 点了程序坞上的图标
app.on('activate', showWindow)
app.on('before-quit', () => {
  quitting = true
})
// 任何页面都不许嵌入别的内容
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
})
// ---------- 窗口 ----------

function createWindow(): BrowserWindow {
  const displays = screen.getAllDisplays().map((display) => display.workArea)
  const created = new BrowserWindow({
    ...restoreBounds(saved.window, displays),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'VibeChat',
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
      // 页面运行在沙箱里，拿不到 Node，和预加载脚本互相隔离
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // 窗口藏在后台时不要把页面的定时器降速：心跳慢了会被服务器当成断线
      backgroundThrottling: false,
      additionalArguments: [`--vc-server=${server.origin}`, `--vc-version=${app.getVersion()}`],
    },
  })
  created.once('ready-to-show', () => created.show())

  const contents = created.webContents
  // 窗口只能待在服务器的地址上
  const guard = (event: { preventDefault: () => void }, url: string) => {
    const verdict = judge(url, server, offlineUrl)
    if (verdict === 'allow') return
    event.preventDefault()
    if (verdict === 'external') openExternal(url)
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.setWindowOpenHandler(({ url }) => {
    if (judge(url, server, offlineUrl) === 'external') openExternal(url)
    return { action: 'deny' }
  })

  // 页面加载不出来，或者服务器答的是"出错了"：显示自带的页面
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    // -3 是"这次加载被别的加载取代了"，不是失败
    if (isMainFrame && code !== -3 && fromServer(url, server)) showOffline()
  })
  contents.on('did-navigate', (_event, url, status) => {
    if (fromServer(url, server) && status >= 500) showOffline()
  })

  contents.on('context-menu', (_event, params) => {
    const items = contextMenu(state.language, {
      editable: params.isEditable,
      hasSelection: params.selectionText.trim() !== '',
      image: params.mediaType === 'image' && fromServer(params.srcURL, server),
    })
    if (items.length === 0) return
    const menu = Menu.buildFromTemplate(
      toOptions(items, (command) => {
        if (command === 'save-image') contents.downloadURL(params.srcURL)
      }),
    )
    menu.popup({ window: created })
  })

  created.on('close', (event) => {
    remember(created)
    if (hidesOnClose(quitting)) {
      event.preventDefault()
      created.hide()
    }
  })
  return created
}

function remember(target: BrowserWindow): void {
  save(storePath, { window: target.getNormalBounds(), language: state.language })
}

function showWindow(): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  app.focus({ steal: true })
}

function sendCommand(command: Command): void {
  state.commands.push(command)
  window?.webContents.send(CHANNELS.command, command)
}

function openExternal(url: string): void {
  state.external.push(url)
  if (!TESTING) void shell.openExternal(url)
}

// ---------- 加载页面 ----------

function loadApp(): void {
  state.offline = false
  // 加载失败由 did-fail-load 处理
  window?.loadURL(server.href).catch(() => {})
}

function showOffline(): void {
  if (state.offline || !window) return
  state.offline = true
  setUnread(0)
  window
    .loadFile(offlineFile, { query: { lang: state.language, server: server.host } })
    .catch(() => {})
  scheduleRetry()
}

function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => void retry(), RETRY_MS)
}

async function retry(): Promise<void> {
  if (!state.offline) return
  if (await reachable()) loadApp()
  else scheduleRetry()
}

/** 服务器现在是不是答得上话。 */
async function reachable(): Promise<boolean> {
  try {
    const reply = await session.defaultSession.fetch(server.href, { cache: 'no-store' })
    return reply.status < 500
  } catch {
    return false
  }
}

// ---------- 页面发来的消息 ----------

/** 这条消息是不是主窗口里、服务器上的页面发来的。 */
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.sender === window?.webContents && fromServer(event.senderFrame?.url, server)
}

function setUnread(unread: number): void {
  state.unread = unread
  app.dock?.setBadge(badgeText(unread))
}

ipcMain.on(CHANNELS.setUnread, (event, value: unknown) => {
  const unread = trusted(event) ? parseUnread(value) : null
  if (unread !== null) setUnread(unread)
})

ipcMain.on(CHANNELS.showWindow, (event) => {
  if (trusted(event)) showWindow()
})

/** 程序坞图标正在为来电跳动：跳动的编号，停的时候用。 */
let callBounce: number | null = null

// 来电：把窗口带到前面，程序坞的图标一直跳，直到接听、拒绝或者对方挂断
ipcMain.on(CHANNELS.callAlert, (event, value: unknown) => {
  const on = trusted(event) ? parseCallAlert(value) : null
  if (on === null) return
  if (callBounce !== null) app.dock?.cancelBounce(callBounce)
  callBounce = null
  if (!on) return
  showWindow()
  callBounce = app.dock?.bounce('critical') ?? null
})

// 共享屏幕没成功时，页面问一下系统给没给录屏的权限，好说明原因
ipcMain.handle(CHANNELS.screenAccess, (event) =>
  trusted(event)
    ? screenAccessOf(systemPreferences.getMediaAccessStatus('screen'), SYSTEM_PICKER)
    : 'unknown',
)

ipcMain.on(CHANNELS.setLanguage, (event, value: unknown) => {
  const language = trusted(event) ? parseLanguage(value) : null
  if (language === null || language === state.language) return
  state.language = language
  buildMenu()
  if (window) remember(window)
})

// "连不上服务器"页面上的"重试"
ipcMain.on(CHANNELS.retry, (event) => {
  if (event.sender === window?.webContents && event.senderFrame?.url.startsWith(offlineUrl)) {
    void retry()
  }
})

// ---------- 菜单 ----------

function buildMenu(): void {
  const items = applicationMenu(state.language, app.getVersion())
  Menu.setApplicationMenu(Menu.buildFromTemplate(toOptions(items, runMenuCommand)))
}

function runMenuCommand(command: NonNullable<Item['command']>): void {
  if (command === 'open-settings') {
    showWindow()
    sendCommand('open-settings')
  }
}

function toOptions(
  items: Item[],
  run: (command: NonNullable<Item['command']>) => void,
): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (item.separator) return { type: 'separator' }
    const { command, submenu, role, ...rest } = item
    return {
      ...rest,
      ...(role ? { role: role as MenuItemConstructorOptions['role'] } : {}),
      ...(command ? { click: () => run(command) } : {}),
      ...(submenu ? { submenu: toOptions(submenu, run) } : {}),
    }
  })
}

// ---------- 权限、下载、内容安全策略 ----------

function protectSession(): void {
  const ses = session.defaultSession

  // 权限默认全部拒绝，只对服务器上的页面放行通知、麦克风、摄像头、共享屏幕和"复制到剪贴板"
  ses.setPermissionCheckHandler((_contents, permission, origin, details) => {
    if (!PERMISSIONS.has(permission) || !fromServer(origin, server)) return false
    // "媒体"里给声音和画面（0.3.0 起有视频通话）
    return permission !== 'media' || details.mediaType === 'audio' || details.mediaType === 'video'
  })
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const from = details.requestingUrl || contents.getURL()
    if (!PERMISSIONS.has(permission) || !fromServer(from, server)) return callback(false)
    if (permission !== 'media') return callback(true)
    // 麦克风、摄像头；别的（例如共享屏幕）不给
    const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    const devices = mediaToAsk(types)
    if (devices === null) return callback(false)
    // macOS 自己还要问用户一次，每样都得允许
    void (async () => {
      for (const device of devices) {
        if (!(await systemPreferences.askForMediaAccess(device).catch(() => false))) {
          return callback(false)
        }
      }
      callback(true)
    })()
  })

  // 共享屏幕（0.4.0 起，F7）。macOS 15 起用系统自带的选择框，这时不经过下面的处理。
  // 更早的系统没有选择框：直接共享主屏幕（F7 Q8）。没有录屏的权限时先不共享，
  // 但还是去取一次屏幕：系统第一次会弹出提示，并把我们列进"录屏"的名单里，用户去打开就行
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!fromServer(request.securityOrigin, server) || !request.videoRequested) {
        return callback({})
      }
      const allowed =
        process.platform !== 'darwin' ||
        systemPreferences.getMediaAccessStatus('screen') === 'granted'
      void desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const primary = String(screen.getPrimaryDisplay().id)
          const source = sources.find((item) => item.display_id === primary) ?? sources[0]
          callback(allowed && source ? { video: source } : {})
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: true },
  )

  // 下载：问用户存到哪里，默认在"下载"文件夹。下载完不自动打开
  ses.on('will-download', (_event, item) => {
    const testDir = process.env.VC_TEST_DOWNLOAD_DIR
    if (testDir) {
      item.setSavePath(join(testDir, item.getFilename()))
      return
    }
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
  })

  // 页面没有带内容安全策略时补上。本机的开发服务器除外：开发模式的热更新要用内嵌脚本
  if (!isLocalServer(server) || process.env.VC_FORCE_CSP === '1') {
    ses.webRequest.onHeadersReceived({ urls: [`${server.origin}/*`] }, (details, callback) => {
      if (details.resourceType !== 'mainFrame') return callback({})
      callback({ responseHeaders: ensurePolicy(details.responseHeaders ?? {}, server) })
    })
  }
}
