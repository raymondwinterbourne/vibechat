// 对着真正的应用做的自动检查。在 Mac 上运行：scripts/mac check
//
// 这台 Mac 上没有 Node，所以由应用里的 Electron 当作 Node 来运行这个文件。
// 它自己起一个很小的本机网站扮演服务器，把应用启动起来连它，然后通过调试口
// 看主进程和页面里的情况。每次启动都用临时的数据目录，不碰平时用的那一份。
//
// 这里查的是桌面端自己的行为。页面在桌面端里的表现（未读数、通知、指令、版本提示）
// 由 client/e2e/tests/desktop.spec.ts 在三种浏览器内核里查。
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from './cdp.mjs'

const binary = process.execPath
const scratch = mkdtempSync(join(tmpdir(), 'vc-desktop-check-'))
const MAIN_PORT = 9229
const PAGE_PORT = 9333

// ---------- 扮演服务器的小网站 ----------

const PAGE = `<!doctype html>
<html>
  <head><meta charset="UTF-8"><title>fake server</title><script src="/app.js"></script></head>
  <body>
    <h1 id="hello">fake server</h1>
    <input id="field">
    <a id="file" href="/download">download</a>
    <script>window.__inline = true</script>
  </body>
</html>`

const site = {
  /** 'up' 正常；'broken' 答 503；'down' 不监听。 */
  mode: 'up',
  server: null,
  port: 0,
  /** 自己带内容安全策略，像正式的服务器那样。 */
  sendsPolicy: false,
}

function handle(request, response) {
  if (site.mode === 'broken') {
    response.writeHead(503, { 'content-type': 'text/plain' }).end('unavailable')
    return
  }
  const path = new URL(request.url, 'http://x').pathname
  if (path === '/app.js') {
    response
      .writeHead(200, { 'content-type': 'text/javascript' })
      .end('window.__external = true; window.__commands = [];')
  } else if (path === '/download') {
    response
      .writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="report.txt"',
      })
      .end('downloaded content')
  } else {
    const headers = { 'content-type': 'text/html' }
    if (site.sendsPolicy)
      headers['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'"
    response.writeHead(200, headers).end(PAGE)
  }
}

function listen() {
  return new Promise((resolve) => {
    site.server = createServer(handle)
    site.server.listen(site.port, '127.0.0.1', () => {
      site.port = site.server.address().port
      resolve()
    })
  })
}

function stopListening() {
  return new Promise((resolve) => {
    site.server.closeAllConnections()
    site.server.close(resolve)
  })
}

// ---------- 启动应用、和它说话 ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what, probe, seconds = 15) {
  const deadline = Date.now() + seconds * 1000
  let last
  while (Date.now() < deadline) {
    try {
      last = await probe()
      if (last) return last
    } catch (error) {
      last = error
    }
    await sleep(150)
  }
  throw new Error(
    `等不到：${what}（最后看到的是 ${last instanceof Error ? last.message : JSON.stringify(last)}）`,
  )
}

let running = null

/** 启动应用。`data` 是它的数据目录；同一个目录再启动，就是"退出之后再打开"。 */
async function launch({
  data,
  server = `http://127.0.0.1:${site.port}`,
  env = {},
  debug = true,
} = {}) {
  const args = [`--server=${server}`]
  if (debug) args.push(`--inspect=${MAIN_PORT}`, `--remote-debugging-port=${PAGE_PORT}`)
  const child = spawn(binary, args, {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      VC_DESKTOP_TEST: '1',
      VC_FORCE_CSP: '1',
      VC_USER_DATA: data,
      VC_TEST_DOWNLOAD_DIR: join(scratch, 'downloads'),
      ...env,
    },
    stdio: 'ignore',
  })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  const handle = { child, exited, main: null }
  if (!debug) return handle
  running = handle
  handle.main = await until('主进程的调试口', () => connect(MAIN_PORT))
  await until('主进程准备好', () =>
    handle.main.evaluate('typeof vcDesktopProbe === "object" && vcDesktopProbe.window() !== null'),
  )
  return handle
}

const state = (app) => app.main.evaluate('JSON.parse(JSON.stringify(vcDesktop))')
const probe = (app, call) => app.main.evaluate(`vcDesktopProbe.${call}`)

/** 连到窗口里现在的页面。页面换了（跳转、重新加载）之后要重新连。 */
async function page(expected) {
  return until(`页面 ${expected}`, async () => {
    const found = await connect(
      PAGE_PORT,
      (target) => target.type === 'page' && target.url.startsWith(expected),
    )
    const ready = await found.evaluate('document.readyState === "complete"')
    if (ready) return found
    found.close()
    return null
  })
}

async function quit(app) {
  await probe(app, 'quit()').catch(() => {})
  // 调试口上还连着人的时候，主进程会等对方断开才真的退出
  app.main.close()
  const code = await Promise.race([app.exited, sleep(10_000).then(() => 'still running')])
  running = null
  if (code === 'still running') {
    app.child.kill('SIGKILL')
    throw new Error('应用没有在 10 秒内退出')
  }
}

function dockLabel() {
  return new Promise((resolve) => {
    execFile('lsappinfo', ['info', '-only', 'StatusLabel', 'VibeChat'], (_error, stdout) => {
      const match = /"label"="([^"]*)"/.exec(stdout ?? '')
      resolve(match ? match[1] : '')
    })
  })
}

// ---------- 检查 ----------

const results = []
async function check(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

function equal(actual, expected, what) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what}：应当是 ${e}，实际是 ${a}`)
}

async function firstRun() {
  const data = join(scratch, 'profile')
  const origin = `http://127.0.0.1:${site.port}`
  let app = await launch({ data })
  let view = await page(origin)

  await check('打开后加载的是服务器上的页面', async () => {
    equal(
      await view.evaluate('document.getElementById("hello").textContent'),
      'fake server',
      '页面内容',
    )
    equal((await state(app)).server, origin, '主进程记下的服务器地址')
    equal((await probe(app, 'window()')).visible, true, '窗口看得见')
  })

  await check('页面拿不到 Node，也拿不到 Electron', async () => {
    const seen = await view.evaluate(
      '[typeof require, typeof process, typeof module, typeof Buffer, typeof global, typeof ipcRenderer, typeof electron].join()',
    )
    equal(seen, Array(7).fill('undefined').join(), '页面里看得到的东西')
  })

  await check('页面能用的只有那五个接口', async () => {
    equal(
      await view.evaluate('Object.keys(vibeDesktop).sort()'),
      ['onCommand', 'setLanguage', 'setUnreadCount', 'showWindow', 'version'],
      '挂在页面上的接口',
    )
    equal(
      await view.evaluate('typeof vibeOffline'),
      'undefined',
      '"连不上服务器"页面的接口不该出现在这里',
    )
    const version = await view.evaluate('vibeDesktop.version')
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号不对：${version}`)
  })

  await check('服务器没有带内容安全策略时，桌面端自己补上：内嵌脚本不执行', async () => {
    equal(await view.evaluate('window.__external === true'), true, '本站的脚本照常运行')
    equal(await view.evaluate('"__inline" in window'), false, '内嵌脚本没有运行')
  })

  await check('未读数显示在程序坞的图标上：没有时不显示，超过 99 显示 99+', async () => {
    for (const [count, label] of [
      [5, '5'],
      [99, '99'],
      [120, '99+'],
      [0, ''],
    ]) {
      await view.evaluate(`vibeDesktop.setUnreadCount(${count})`)
      await until(`主进程记下未读数 ${count}`, async () => (await state(app)).unread === count)
      await until(`程序坞上显示 "${label}"`, async () => (await dockLabel()) === label, 5)
    }
  })

  await check('不合规矩的消息被丢掉', async () => {
    await view.evaluate('vibeDesktop.setUnreadCount(7)')
    await until('未读数 7', async () => (await state(app)).unread === 7)
    await view.evaluate(
      'for (const odd of [-1, 1.5, "9", null, undefined, {}, [3], 1e9, NaN]) vibeDesktop.setUnreadCount(odd)',
    )
    await view.evaluate(
      'vibeDesktop.setLanguage("fr"); vibeDesktop.setLanguage({}); vibeDesktop.setLanguage()',
    )
    await sleep(300)
    equal((await state(app)).unread, 7, '未读数没有被改掉')
    await view.evaluate('vibeDesktop.setUnreadCount(0)')
  })

  await check('系统菜单有五个，跟着应用里的语言换', async () => {
    await view.evaluate('vibeDesktop.setLanguage("zh-CN")')
    await until('中文菜单', async () => (await probe(app, 'menu()')).includes('编辑'))
    equal(await probe(app, 'menu()'), ['VibeChat', '编辑', '显示', '窗口', '帮助'], '中文菜单')
    await view.evaluate('vibeDesktop.setLanguage("en")')
    await until('英文菜单', async () => (await probe(app, 'menu()')).includes('Edit'))
    equal(await probe(app, 'menu()'), ['VibeChat', 'Edit', 'View', 'Window', 'Help'], '英文菜单')
    // 留在中文，下面查"重新打开后还记得"
    await view.evaluate('vibeDesktop.setLanguage("zh-CN")')
    await until('中文菜单', async () => (await probe(app, 'menu()')).includes('编辑'))
  })

  await check('菜单里的"设置…"和 Mac 唤醒，都作为指令发给页面', async () => {
    await view.evaluate('vibeDesktop.onCommand((command) => window.__commands.push(command)); 0')
    await probe(app, 'chooseMenu("open-settings")')
    await probe(app, 'wake()')
    await until(
      '页面收到两条指令',
      async () => (await view.evaluate('window.__commands.join()')) === 'open-settings,reconnect',
    )
  })

  await check('页面去不了别的网站：跳转被拦下，交给系统的浏览器', async () => {
    await view.evaluate('location.href = "https://example.com/elsewhere"; 0')
    await until('记下要交给浏览器的地址', async () =>
      (await state(app)).external.includes('https://example.com/elsewhere'),
    )
    equal(await view.evaluate('location.origin'), origin, '窗口还在服务器的页面上')
    equal(
      await view.evaluate('window.open("https://example.org/popup") === null'),
      true,
      '打不开新窗口',
    )
    await until('新窗口要去的地址也交给浏览器', async () =>
      (await state(app)).external.includes('https://example.org/popup'),
    )
    // 本机的文件、会启动别的程序的地址：什么也不做
    const before = (await state(app)).external.length
    await view.evaluate('location.href = "file:///etc/passwd"; 0')
    await view.evaluate('window.open("vscode://open"); window.open("file:///etc/passwd"); 0')
    await sleep(500)
    equal(await view.evaluate('location.origin'), origin, '窗口还在服务器的页面上')
    equal((await state(app)).external.length, before, '这些地址不交给系统')
    equal(
      await view.evaluate('document.getElementById("hello").textContent'),
      'fake server',
      '页面没有被换掉',
    )
  })

  await check('权限：通知放行，其余的拒绝', async () => {
    equal(await view.evaluate('Notification.permission'), 'granted', '通知')
    const query = (name) =>
      view.evaluate(`navigator.permissions.query({ name: "${name}" }).then((s) => s.state)`)
    equal(await query('notifications'), 'granted', '通知的权限')
    equal(await query('geolocation'), 'denied', '定位的权限')
    equal(await query('camera'), 'denied', '摄像头的权限')
    const camera = await view.evaluate(
      'navigator.mediaDevices.getUserMedia({ video: true }).then(() => "allowed", (error) => error.name)',
    )
    equal(camera, 'NotAllowedError', '申请摄像头')
    const position = await view.evaluate(
      'new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("allowed"), (error) => resolve(error.code)))',
    )
    equal(position, 1, '申请定位')
  })

  await check('下载的文件存成原来的名字', async () => {
    await view.evaluate('document.getElementById("file").click()')
    const file = join(scratch, 'downloads', 'report.txt')
    await until(
      '文件出现',
      () => existsSync(file) && readFileSync(file, 'utf8') === 'downloaded content',
    )
    equal(await view.evaluate('location.origin'), origin, '窗口还在原来的页面上')
  })

  await check('点关闭只是把窗口藏起来，点程序坞的图标又出来', async () => {
    await probe(app, 'closeWindow()')
    await until('窗口藏起来', async () => (await probe(app, 'window()')).visible === false)
    equal(app.child.exitCode, null, '应用还在运行')
    // 藏起来的时候页面照常工作
    await view.evaluate('vibeDesktop.setUnreadCount(3)')
    await until('未读数照常更新', async () => (await state(app)).unread === 3)
    await probe(app, 'clickDock()')
    await until('窗口又出来', async () => (await probe(app, 'window()')).visible === true)
    await view.evaluate('vibeDesktop.setUnreadCount(0)')
  })

  await check('只能运行一个：再启动一次，新的那个自己退出，原来的窗口到前台', async () => {
    await probe(app, 'closeWindow()')
    await until('窗口藏起来', async () => (await probe(app, 'window()')).visible === false)
    const second = await launch({ data, debug: false })
    const code = await Promise.race([second.exited, sleep(10000).then(() => 'still running')])
    equal(code, 0, '第二个的退出码')
    await until('原来的窗口出来', async () => (await probe(app, 'window()')).visible === true)
  })

  // 退出之前留下几样东西，下面查重新打开后还在不在
  await view.evaluate('document.cookie = "vc_check=kept; max-age=3600; path=/"; 0')
  const moved = { x: 140, y: 120, width: 1000, height: 720 }
  await probe(app, `moveWindow(${JSON.stringify(moved)})`)
  view.close()
  await quit(app)

  app = await launch({ data })
  view = await page(origin)
  await check('退出再打开：登录状态、窗口的位置、语言都还在', async () => {
    equal(await view.evaluate('document.cookie'), 'vc_check=kept', '上次留下的 Cookie')
    equal((await probe(app, 'window()')).bounds, moved, '窗口的位置和大小')
    equal(await probe(app, 'menu()'), ['VibeChat', '编辑', '显示', '窗口', '帮助'], '菜单的语言')
    equal((await probe(app, 'window()')).minimum, [380, 560], '窗口的最小尺寸')
  })
  view.close()
  await quit(app)
}

async function serverPolicy() {
  site.sendsPolicy = true
  const app = await launch({ data: join(scratch, 'policy') })
  const view = await page(`http://127.0.0.1:${site.port}`)
  await check('服务器自己带了内容安全策略时，用服务器的，不去改它', async () => {
    // 这个假服务器的策略允许内嵌脚本：脚本运行了，说明桌面端没有换成自己的
    equal(await view.evaluate('window.__inline === true'), true, '按服务器的策略，内嵌脚本可以运行')
  })
  view.close()
  await quit(app)
  site.sendsPolicy = false
}

async function offline() {
  const origin = `http://127.0.0.1:${site.port}`
  await stopListening()
  site.mode = 'down'
  const app = await launch({ data: join(scratch, 'offline') })

  await check('连不上服务器时显示自带的页面', async () => {
    await until('主进程知道连不上', async () => (await state(app)).offline === true)
    const view = await page('file://')
    equal(
      await view.evaluate('document.getElementById("title").textContent'),
      "Can't reach the server",
      '页面上的标题',
    )
    equal(
      await view.evaluate('document.getElementById("server").textContent'),
      `127.0.0.1:${site.port}`,
      '页面上写着连的是哪里',
    )
    equal(
      await view.evaluate('typeof vibeDesktop'),
      'undefined',
      '这个页面拿不到给服务器页面的接口',
    )
    equal(await view.evaluate('Object.keys(vibeOffline).join()'), 'retry', '它只有"重试"')
    equal(
      await view.evaluate('[typeof require, typeof process].join()'),
      'undefined,undefined',
      '它同样拿不到 Node',
    )
    view.close()
  })

  await check('服务器恢复后不用操作，自己进入', async () => {
    site.mode = 'up'
    await listen()
    const view = await page(origin)
    equal(
      await view.evaluate('document.getElementById("hello").textContent'),
      'fake server',
      '页面内容',
    )
    equal((await state(app)).offline, false, '主进程知道连上了')
    view.close()
  })

  await check('服务器答"出错了"也显示自带的页面；点"重试"立即再试', async () => {
    site.mode = 'broken'
    const view = await page(origin)
    await view.evaluate('location.reload(); 0').catch(() => {})
    view.close()
    await until('主进程知道连不上', async () => (await state(app)).offline === true)
    const away = await page('file://')
    site.mode = 'up'
    await away.evaluate('document.getElementById("retry").click()')
    away.close()
    // 自动重试要等 5 秒；点了按钮应当马上回来
    const back = await until(
      '回到服务器的页面',
      async () => ((await state(app)).offline ? null : page(origin)),
      3,
    )
    back.close()
  })
  await quit(app)
}

async function badServer() {
  await check('不是加密连接的服务器地址不接受（本机的除外）', async () => {
    for (const server of ['http://example.com', 'ftp://example.com', 'not-an-address']) {
      const app = await launch({ data: join(scratch, 'bad'), server, debug: false })
      const code = await Promise.race([app.exited, sleep(10000).then(() => 'still running')])
      if (code === 'still running') app.child.kill('SIGKILL')
      equal(code, 1, `用 ${server} 启动时的退出码`)
    }
  })
}

/** 开发环境在运行的话，顺便看一眼真正的 Web 应用在桌面端里能不能打开。 */
async function realApp() {
  const server = process.env.VC_CHECK_APP ?? 'http://127.0.0.1:8780'
  const up = await fetch(`${server}/api/health`).then(
    (reply) => reply.ok,
    () => false,
  )
  if (!up) {
    console.log(`  - 跳过：${server} 上没有在运行的开发环境，没有用真正的 Web 应用检查`)
    return
  }
  // 开发模式的页面要用内嵌脚本，不强加内容安全策略
  const app = await launch({ data: join(scratch, 'real'), server, env: { VC_FORCE_CSP: '' } })
  const view = await page(server)
  await check(`真正的 Web 应用（${server}）：打开是登录页，认出自己在桌面端里`, async () => {
    await until('登录页', () =>
      view.evaluate(
        'location.pathname === "/login" && document.querySelector("input[type=password]") !== null',
      ),
    )
    await until('页面把语言告诉了桌面端', async () =>
      ['zh-CN', 'en'].includes((await state(app)).language),
    )
    equal(await view.evaluate('typeof vibeDesktop.version'), 'string', '桌面端的接口')
  })
  view.close()
  await quit(app)
}

try {
  await listen()
  console.log('桌面端自动检查\n')
  await firstRun()
  await serverPolicy()
  await offline()
  await badServer()
  await realApp()
} catch (error) {
  results.push({ name: '检查没有跑完', ok: false })
  console.log(`\n  ✗ 检查中断：${error.message}`)
} finally {
  running?.child.kill('SIGKILL')
  site.server?.closeAllConnections()
  site.server?.close()
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.ok).length
console.log(`\n${results.length - failed} 项通过${failed ? `，${failed} 项没有通过` : ''}`)
process.exit(failed ? 1 : 0)
