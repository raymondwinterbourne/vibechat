// 图片、文件、语音、引用和撤回。

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  controlConnection,
  expect,
  logInElsewhere,
  makeGroup,
  newApi,
  openAs,
  pngImage,
  post,
  say,
  sendFiles,
  test,
  uploadAs,
  voiceSample,
} from './support'

const messages = (page: Page) => page.getByTestId('message')
const texts = (page: Page) => page.getByTestId('message-text')
const events = (page: Page) => page.getByTestId('message-event')
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const row = (page: Page, who: Account) =>
  page.getByTestId('conversation').filter({ hasText: who.nickname })
const menu = (page: Page) => page.getByTestId('message-menu')

async function send(page: Page, text: string) {
  await composer(page).fill(text)
  await composer(page).press('Enter')
}

/** 两个好友各开一个窗口，都停在他们的会话里。 */
async function twoWindows(browser: import('@playwright/test').Browser, page: Page, me: Account) {
  const bea = await another('Bea')
  const conversation = await befriend(me, bea)
  const other = await openAs(browser, bea, `/chats/${conversation}`)
  await page.goto(`/chats/${conversation}`)
  await expect(events(page)).toHaveCount(1)
  await expect(events(other.page)).toHaveCount(1)
  return { bea, conversation, beaPage: other.page, context: other.context }
}

/** 图片已经加载出来了，并且是这么宽。 */
async function naturalWidth(page: Page, testId: string): Promise<number> {
  const image = page.getByTestId(testId).last()
  const target =
    (await image.evaluate((element) => element.tagName)) === 'IMG' ? image : image.locator('img')
  await expect.poll(() => target.evaluate((img: HTMLImageElement) => img.complete)).toBe(true)
  return target.evaluate((img: HTMLImageElement) => img.naturalWidth)
}

/** 让页面以为系统设置里的上限是这些值。 */
async function limits(page: Page, values: Record<string, number>) {
  await page.route('**/api/limits', (route) =>
    route.fulfill({
      json: {
        file_max_bytes: 100 * 1024 * 1024,
        voice_max_seconds: 60,
        recall_window_seconds: 120,
        edit_window_seconds: 24 * 60 * 60,
        group_call_max: 6,
        ...values,
      },
    }),
  )
}

test.describe('pictures and files', () => {
  test('a picture shows as a thumbnail, opens full size and can be saved', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, beaPage, context } = await twoWindows(browser, page, account)
    const picture = pngImage(800, 600, [40, 160, 90])

    await sendFiles(page, {
      name: 'holiday.png',
      mimeType: 'image/png',
      buffer: picture,
    })

    // 发的人：发出去了；对方：不刷新就看到
    const mine = messages(page).last()
    await expect(mine.getByTestId('message-status')).toHaveText(/Sent|Read/)
    for (const each of [page, beaPage]) {
      const image = each.getByTestId('message-image')
      await expect(image).toBeVisible()
      // 按原图的比例留好了位置：800x600 的图显示成 240x180
      const box = await image.boundingBox()
      expect([Math.round(box?.width ?? 0), Math.round(box?.height ?? 0)]).toEqual([240, 180])
      // 会话里的是缩略图，比原图小
      expect(await naturalWidth(each, 'message-image')).toBe(480)
    }
    await expect(row(beaPage, account).getByTestId('conversation-summary')).toHaveText('[Photo]')
    await expect(row(page, bea).getByTestId('conversation-summary')).toHaveText('[Photo]')

    // 点开是原图
    await beaPage.getByTestId('message-image').click()
    await expect(beaPage.getByTestId('lightbox')).toBeVisible()
    expect(await naturalWidth(beaPage, 'lightbox-image')).toBe(800)
    // 存到本地：内容和发的那张一模一样
    const saving = beaPage.waitForEvent('download')
    await beaPage.getByTestId('lightbox').getByRole('link', { name: 'Download' }).click()
    const saved = await saving
    expect(saved.suggestedFilename()).toBe('holiday.png')
    expect(readFileSync(await saved.path()).equals(picture)).toBe(true)
    await beaPage.keyboard.press('Escape')
    await expect(beaPage.getByTestId('lightbox')).toHaveCount(0)

    // 刷新之后还在
    await beaPage.reload()
    await expect(beaPage.getByTestId('message-image')).toBeVisible()
    await context.close()
  })

  test('files keep their names and bytes, one message each, in the order picked', async ({
    page,
    account,
    browser,
  }) => {
    const { beaPage, context } = await twoWindows(browser, page, account)
    const report = Buffer.from('%PDF-1.7 quarterly numbers '.repeat(60))

    await sendFiles(page, [
      { name: '季度 报告.pdf', mimeType: 'application/pdf', buffer: report },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
      // 网页文件：只是一个文件，不会被打开
      { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>1</script>') },
    ])

    const names = beaPage.getByTestId('file-name')
    await expect(names).toHaveText(['季度 报告.pdf', 'notes.txt', 'page.html'])
    await expect(beaPage.getByTestId('file-size')).toHaveText(['1.6 KB', '5 B', '18 B'])
    await expect(page.getByTestId('file-name')).toHaveText([
      '季度 报告.pdf',
      'notes.txt',
      'page.html',
    ])
    await expect(row(beaPage, account).getByTestId('conversation-summary')).toHaveText(
      '[File] page.html',
    )

    // 下载：名字和内容都不变
    const saving = beaPage.waitForEvent('download')
    await beaPage.getByTestId('message-file').first().click()
    const saved = await saving
    expect(saved.suggestedFilename()).toBe('季度 报告.pdf')
    expect(readFileSync(await saved.path()).equals(report)).toBe(true)
    // 网页文件也是下载，页面没有跳走
    const savingPage = beaPage.waitForEvent('download')
    await beaPage.getByTestId('message-file').last().click()
    expect((await savingPage).suggestedFilename()).toBe('page.html')
    await expect(beaPage.getByTestId('message-file')).toHaveCount(3)
    await context.close()
  })

  test('a file over the limit is refused before it is uploaded', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await limits(page, { file_max_bytes: 1000 })
    let uploads = 0
    await page.route('**/api/files', (route) => {
      uploads += 1
      return route.continue()
    })
    await page.goto(`/chats/${conversation}`)
    await expect(events(page)).toHaveCount(1)

    await sendFiles(page, [
      { name: 'big.bin', mimeType: '', buffer: Buffer.alloc(1001, 7) },
      { name: 'ok.bin', mimeType: '', buffer: Buffer.alloc(1000, 7) },
    ])

    await expect(page.getByTestId('toast')).toHaveText("Files can't be larger than 1000 B")
    // 没超的那个照常发出去；超了的根本没有开始传
    await expect(page.getByTestId('file-name')).toHaveText(['ok.bin'])
    await expect(messages(page).last().getByTestId('message-status')).toHaveText('Sent')
    expect(uploads).toBe(1)
  })

  test('a pasted picture and a dropped file wait above the input until Send', async ({
    page,
    account,
    browser,
  }) => {
    const { beaPage, context } = await twoWindows(browser, page, account)
    const bytes = [...pngImage(64, 64, [200, 60, 60])]
    const staged = page.getByTestId('staged-file')
    const send = page.getByRole('button', { name: 'Send' })
    await expect(send).toBeDisabled()

    // 粘贴一张截图：排在输入框上方，带着小图，没有发出去
    await composer(page).focus()
    await composer(page).evaluate((element, data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(data)], 'image.png', { type: 'image/png' }))
      // 有的内核不让脚本在构造粘贴事件时带上内容，所以造一个普通的事件再把内容挂上去
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: transfer })
      element.dispatchEvent(event)
    }, bytes)
    await expect(staged.getByTestId('staged-name')).toHaveText(['image.png'])
    await expect(staged.locator('img')).toBeVisible()
    await expect(composer(page)).toHaveValue('')
    await expect(composer(page)).toBeFocused()
    // 不打字也可以发
    await expect(send).toBeEnabled()

    // 把文件拖到会话上：经过时有提示，松开后也排在那里
    const dropped = await page.evaluateHandle(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['dropped content'], 'dropped.txt', { type: 'text/plain' }))
      return transfer
    })
    const pane = page.getByTestId('conversation-pane')
    await pane.dispatchEvent('dragenter', { dataTransfer: dropped })
    await expect(page.getByTestId('drop-hint')).toHaveText('Drop to add to your message')
    await pane.dispatchEvent('drop', { dataTransfer: dropped })
    await expect(page.getByTestId('drop-hint')).toHaveCount(0)
    await expect(staged.getByTestId('staged-name')).toHaveText(['image.png', 'dropped.txt'])
    await expect(page.getByRole('list', { name: 'Files to send' })).toBeVisible()

    // 到这里什么都还没有发出去
    await expect(page.getByTestId('message-image')).toHaveCount(0)
    await expect(page.getByTestId('message-file')).toHaveCount(0)
    await expect(beaPage.getByTestId('message')).toHaveCount(0)

    // 接着打字，回车：两个文件各是一条消息，然后是文字，顺序不变
    await composer(page).fill('here they are')
    await expect(staged).toHaveCount(2)
    await composer(page).press('Enter')
    await expect(staged).toHaveCount(0)
    await expect(composer(page)).toHaveValue('')
    await expect(send).toBeDisabled()
    await expect(texts(beaPage).last()).toHaveText('here they are')
    await expect(beaPage.getByTestId('message-image')).toBeVisible()
    await expect(beaPage.getByTestId('file-name')).toHaveText(['dropped.txt'])
    const order = () =>
      beaPage.getByTestId('message').evaluateAll((messages) =>
        messages.map((message) => {
          if (message.querySelector('[data-testid="message-image"]')) return 'picture'
          return message.querySelector('[data-testid="message-file"]') ? 'file' : 'text'
        }),
      )
    await expect.poll(order).toEqual(['picture', 'file', 'text'])
    await context.close()
  })

  test('a file picked by mistake can be taken away before anything is sent', async ({
    page,
    account,
    browser,
  }) => {
    const { conversation, bea, beaPage, context } = await twoWindows(browser, page, account)
    const staged = page.getByTestId('staged-file')
    const send = page.getByRole('button', { name: 'Send' })
    const file = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })

    await page.getByTestId('file-input').setInputFiles([file('wrong.txt'), file('right.txt')])
    await expect(staged.getByTestId('staged-name')).toHaveText(['wrong.txt', 'right.txt'])
    // 没有小图的文件显示大小
    await expect(staged.first()).toContainText('9 B')
    await page.getByRole('button', { name: 'Remove wrong.txt' }).click()
    await expect(staged.getByTestId('staged-name')).toHaveText(['right.txt'])

    // 再选的接在后面；同一个文件可以再选一次
    await page.getByTestId('file-input').setInputFiles(file('right.txt'))
    await expect(staged).toHaveCount(2)
    await page.getByRole('button', { name: 'Remove right.txt' }).last().click()
    await expect(staged).toHaveCount(1)

    // 不打字，直接点发送：只发文件
    await send.click()
    await expect(staged).toHaveCount(0)
    await expect(beaPage.getByTestId('file-name')).toHaveText(['right.txt'])
    await expect(texts(beaPage)).toHaveCount(0)

    // 全拿掉之后没有东西可发
    await page.getByTestId('file-input').setInputFiles(file('never.txt'))
    await page.getByRole('button', { name: 'Remove never.txt' }).click()
    await expect(staged).toHaveCount(0)
    await expect(page.getByTestId('staged')).toHaveCount(0)
    await expect(send).toBeDisabled()

    // 拿掉的那些没有传到服务端：会话里只有一条文件消息
    const api = await newApi(bea.storageState)
    const reply = await api.get(`/api/conversations/${conversation}/messages`)
    const body = (await reply.json()) as { items: { kind: string; name?: string | null }[] }
    await api.dispose()
    expect(body.items.filter((item) => item.kind === 'file')).toHaveLength(1)
    await context.close()
  })

  test('a pale or see-through picture keeps its edges, in the conversation and full size', async ({
    page,
    account,
    browser,
  }) => {
    const { context } = await twoWindows(browser, page, account)
    // 一张纯白的图：没有边框和遮罩的话，它在白色的页面上是看不出来的
    await sendFiles(page, {
      name: 'blank-page.png',
      mimeType: 'image/png',
      buffer: pngImage(600, 400, [255, 255, 255]),
    })
    await expect(messages(page).last().getByTestId('message-status')).toHaveText(/Sent|Read/)

    // 浏览器报颜色的写法各不相同：把它画出来，读画出来的那个点，得到 [红, 绿, 蓝, 不透明度]
    const paint = (testId: string, property: 'backgroundColor' | 'color' | 'borderTopColor') =>
      page
        .getByTestId(testId)
        .last()
        .evaluate((element, property) => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d') as CanvasRenderingContext2D
          context.fillStyle = getComputedStyle(element)[property]
          context.fillRect(0, 0, 1, 1)
          return [...context.getImageData(0, 0, 1, 1).data]
        }, property)

    // 会话里：一圈细边框，底是白的（透明底的图在深色外观下也看得清）
    const frame = page.getByTestId('message-image')
    expect(await frame.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('1px')
    expect(await frame.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe(
      'solid',
    )
    const border = await paint('message-image', 'borderTopColor')
    expect(border[3], 'the border is drawn').toBe(255)
    expect(border.slice(0, 3), 'and is not white').not.toEqual([255, 255, 255])
    expect(await paint('message-image', 'backgroundColor')).toEqual([255, 255, 255, 255])

    // 放大：后面是一层深色的遮罩，把聊天的内容压下去；图垫着白底
    await frame.click()
    await expect(page.getByTestId('lightbox-image')).toBeVisible()
    const backdrop = await paint('lightbox-backdrop', 'backgroundColor')
    expect(backdrop.slice(0, 3)).toEqual([0, 0, 0])
    expect(backdrop[3] ?? 0, 'the backdrop is mostly opaque').toBeGreaterThan(200)
    expect(await paint('lightbox-image', 'backgroundColor')).toEqual([255, 255, 255, 255])
    // 遮罩盖住整个窗口
    const size = page.viewportSize()
    const covered = await page.getByTestId('lightbox-backdrop').boundingBox()
    expect([covered?.width, covered?.height]).toEqual([size?.width, size?.height])

    // 右上角的按钮：深色的圆底、白色的图标，压在什么图上都看得见
    const close = page.getByTestId('lightbox').getByRole('button', { name: 'Close' })
    const look = await close.evaluate((element) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d') as CanvasRenderingContext2D
      const read = (color: string) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
      }
      const style = getComputedStyle(element)
      return { disc: read(style.backgroundColor), icon: read(style.color) }
    })
    expect(look.icon).toEqual([255, 255, 255, 255])
    expect(look.disc.slice(0, 3)).toEqual([0, 0, 0])
    expect(look.disc[3] ?? 0, 'the disc behind the icon is visible').toBeGreaterThan(100)
    await context.close()
  })

  test('an upload can be cancelled, and one that failed can be retried', async ({
    page,
    account,
    browser,
  }) => {
    const { conversation, bea, beaPage, context } = await twoWindows(browser, page, account)
    const file = { name: 'slow.bin', mimeType: '', buffer: Buffer.alloc(5000, 1) }

    // 上传一直没有结果：可以取消，取消后这条消息消失
    let release = () => {}
    await page.route('**/api/files', (route) => {
      release = () => void route.abort()
    })
    await sendFiles(page, file)
    const pending = messages(page).last()
    await expect(pending.getByTestId('message-status')).toHaveText('Uploading')
    await expect(pending.getByTestId('upload-progress')).toBeVisible()
    // 进度条有底色，看得出它有多长
    const track = await pending
      .getByTestId('upload-progress')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(track).not.toBe('rgba(0, 0, 0, 0)')
    await pending.getByRole('button', { name: 'Cancel upload' }).click()
    await expect(page.getByTestId('message-file')).toHaveCount(0)
    release()

    // 上传失败：显示"发送失败"，重试后对方只收到一条
    await page.unroute('**/api/files')
    await page.route('**/api/files', (route) => route.abort())
    await sendFiles(page, { ...file, name: 'flaky.bin' })
    const failed = messages(page).last()
    await expect(failed.getByTestId('message-status')).toContainText('Not sent')
    await page.unroute('**/api/files')
    await failed.getByRole('button', { name: 'Retry' }).click()
    await expect(failed.getByTestId('message-status')).toHaveText(/Sent|Read/)
    await expect(beaPage.getByTestId('file-name')).toHaveText(['flaky.bin'])

    // 取消了的那一个没有留在服务端：会话里只有一条文件消息
    const api = await newApi(bea.storageState)
    const reply = await api.get(`/api/conversations/${conversation}/messages`)
    const body = (await reply.json()) as { items: { kind: string }[] }
    await api.dispose()
    expect(body.items.filter((item) => item.kind === 'file')).toHaveLength(1)
    await context.close()
  })

  test('someone outside the conversation cannot fetch the file even with its address', async ({
    account,
  }) => {
    const bea = await another('Bea')
    const stranger = await another('Stranger')
    const conversation = await befriend(account, bea)
    const picture = await uploadAs(account, 'private.png', 'image/png', pngImage(32, 32, [1, 2, 3]))
    const seq = await post(account, conversation, { file_id: picture.id })
    const fetchAs = async (who: Account, path: string) => {
      const api = await newApi(who.storageState)
      const status = (await api.get(path)).status()
      await api.dispose()
      return status
    }

    for (const path of [`/api/files/${picture.id}`, `/api/files/${picture.id}/thumbnail`]) {
      expect(await fetchAs(bea, path)).toBe(200)
      expect(await fetchAs(stranger, path)).toBe(404)
    }
    // 撤回之后，原来能看的人也取不到了
    const api = await newApi(account.storageState)
    const recalled = await api.post(`/api/conversations/${conversation}/messages/${seq}/recall`)
    expect(recalled.status()).toBe(200)
    await api.dispose()
    expect(await fetchAs(bea, `/api/files/${picture.id}`)).toBe(404)
  })
})

test.describe('voice messages', () => {
  test('a recording plays, and the unplayed mark goes away everywhere', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const voice = await uploadAs(bea, 'voice.webm', 'audio/webm;codecs=opus', voiceSample())
    expect(voice.audio).toBe(true)
    await post(bea, conversation, { file_id: voice.id, voice_duration_ms: 1500 })
    const elsewhere = await logInElsewhere(browser, account)

    await page.goto('/chats')
    await expect(row(page, bea).getByTestId('conversation-summary')).toHaveText('[Voice message]')
    await row(page, bea).click()
    const bubble = page.getByTestId('message-voice')
    await expect(page.getByTestId('voice-duration')).toHaveText('0:02')
    await expect(page.getByTestId('voice-unplayed')).toBeVisible()

    await bubble.click()
    // 放得出来：这种内核能解码另一种浏览器录的语音。开始放了，没听过的标记才会消失。
    // 这一段只有一秒多，转眼就放完，所以不去看"正在播放"那一下
    await expect(page.getByTestId('voice-unplayed')).toHaveCount(0)
    // 放完了回到原样，没有报"放不出来"
    await expect(bubble).toHaveAttribute('data-state', 'idle', { timeout: 10_000 })
    await expect(page.getByText("can't be played")).toHaveCount(0)

    // 同一个账号的另一处登录：标记也没有了
    await row(elsewhere.page, bea).click()
    await expect(elsewhere.page.getByTestId('message-voice')).toBeVisible()
    await expect(elsewhere.page.getByTestId('voice-unplayed')).toHaveCount(0)
    // 发的人自己那边没有"没听过"的标记
    const sender = await openAs(browser, bea, `/chats/${conversation}`)
    await expect(sender.page.getByTestId('message-voice')).toBeVisible()
    await expect(sender.page.getByTestId('voice-unplayed')).toHaveCount(0)
    await sender.context.close()
    await elsewhere.context.close()
  })

  test('recording shows the time, can be cancelled, and sends on demand', async ({
    page,
    account,
    browser,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'the test build of WebKit has no fake microphone')
    const { beaPage, context } = await twoWindows(browser, page, account)
    const elapsed = page.getByTestId('voice-elapsed')

    // 录了又取消：什么也没有发
    await page.getByRole('button', { name: 'Record a voice message' }).click()
    await expect(page.getByTestId('voice-recorder')).toBeVisible()
    await expect(elapsed).toHaveText('0:02', { timeout: 5000 })
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(composer(page)).toBeVisible()
    await expect(page.getByTestId('message-voice')).toHaveCount(0)

    // 录一段发出去
    await page.getByRole('button', { name: 'Record a voice message' }).click()
    await expect(elapsed).toHaveText('0:02', { timeout: 5000 })
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(composer(page)).toBeVisible()
    await expect(messages(page).last().getByTestId('message-status')).toHaveText(/Sent|Read/)
    await expect(page.getByTestId('message-voice')).toHaveCount(1)

    // 对方收到，能放
    const received = beaPage.getByTestId('message-voice')
    await expect(received).toBeVisible()
    await expect(beaPage.getByTestId('voice-unplayed')).toBeVisible()
    await received.click()
    // 开始放了：没听过的标记消失。假麦克风录出来的这一段可能很短，转眼就放完，所以不去看"正在播放"
    await expect(beaPage.getByTestId('voice-unplayed')).toHaveCount(0)
    await expect(received).not.toHaveAttribute('data-state', 'failed')
    await context.close()
  })

  test('recording stops by itself at the time limit and waits for a decision', async ({
    page,
    account,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'the test build of WebKit has no fake microphone')
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await limits(page, { voice_max_seconds: 2 })
    await page.goto(`/chats/${conversation}`)
    await expect(events(page)).toHaveCount(1)

    await page.getByRole('button', { name: 'Record a voice message' }).click()
    await expect(page.getByTestId('voice-recorder')).toContainText('Up to 2 seconds')
    await expect(page.getByTestId('voice-recorder')).toContainText('Reached the time limit', {
      timeout: 6000,
    })
    await expect(page.getByTestId('voice-elapsed')).toHaveText('0:02')
    // 没有自动发出去
    await expect(page.getByTestId('message-voice')).toHaveCount(0)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.getByTestId('voice-duration')).toHaveText('0:02')
  })

  test('says why when the microphone cannot be used', async ({ page, account, browserName }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    // 用户拒绝了麦克风
    await page.addInitScript(() => {
      if (!navigator.mediaDevices) return
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('denied', 'NotAllowedError'))
    })
    await page.goto(`/chats/${conversation}`)
    await expect(events(page)).toHaveCount(1)

    await page.getByRole('button', { name: 'Record a voice message' }).click()
    // 测试用的 Safari 内核根本不能录音，这时说的是另一句话
    const reason =
      browserName === 'webkit' ? "This browser can't record audio" : "The microphone isn't allowed"
    await expect(page.getByTestId('voice-problem')).toContainText(reason)
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(composer(page)).toBeVisible()
  })
})

test.describe('replying', () => {
  test('a reply shows what it quotes, and clicking the quote goes there', async ({
    page,
    account,
    browser,
  }) => {
    const { bea, beaPage, context } = await twoWindows(browser, page, account)
    await send(beaPage, 'shall we go hiking on Saturday?')
    const original = messages(page).filter({ hasText: 'hiking' })
    await expect(original).toBeVisible()

    // 鼠标移到消息上，旁边出现"引用"
    await original.hover()
    await original.getByRole('button', { name: 'Reply' }).click()
    await expect(page.getByTestId('replying')).toContainText(`Replying to ${bea.nickname}`)
    await expect(page.getByTestId('replying')).toContainText('shall we go hiking')
    await expect(composer(page)).toBeFocused()
    // Esc 取消；再选一次
    await composer(page).press('Escape')
    await expect(page.getByTestId('replying')).toHaveCount(0)
    await original.hover()
    await original.getByRole('button', { name: 'Reply' }).click()
    await send(page, 'yes, count me in')
    await expect(page.getByTestId('replying')).toHaveCount(0)

    for (const each of [page, beaPage]) {
      const reply = messages(each).filter({ hasText: 'count me in' })
      await expect(reply.getByTestId('quote')).toContainText('shall we go hiking on Saturday?')
    }
    // 对方看到的引用里是"你"
    const quote = messages(beaPage).filter({ hasText: 'count me in' }).getByTestId('quote')
    await expect(quote).toContainText('You: ')
    await quote.click()
    await expect(messages(beaPage).filter({ hasText: 'hiking' }).first()).toHaveAttribute(
      'data-highlighted',
      'true',
    )
    await context.close()
  })

  test('a quote of a message from long ago fetches it and can return to the latest', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const ancient = await post(bea, conversation, { text: 'the very first plan' })
    const filler = Array.from({ length: 130 }, (_, index) => `filler ${index + 1}`)
    await say(bea, conversation, ...filler)
    await post(bea, conversation, { text: 'as I said back then', reply_to: ancient })

    await page.goto(`/chats/${conversation}`)
    const reply = messages(page).filter({ hasText: 'as I said back then' })
    await expect(reply).toBeVisible()
    // 原消息在一百多条之前，还没有加载
    const target = page.locator(`[data-testid="message"][data-seq="${ancient}"]`)
    await expect(target).toHaveCount(0)
    await expect(reply.getByTestId('quote')).toContainText('the very first plan')

    await reply.getByTestId('quote').click()

    await expect(target).toBeInViewport()
    await expect(target).toHaveAttribute('data-highlighted', 'true')
    // 高亮过一会儿自己消失
    await expect(target).not.toHaveAttribute('data-highlighted', 'true', { timeout: 5000 })
    // 这时看的是历史里的一段：最新的那条不在页面里，有"回到最新"
    await expect(reply).toHaveCount(0)
    await page.getByTestId('back-to-latest').click()
    await expect(reply).toBeVisible()
    await expect(reply).toBeInViewport()
    await expect(page.getByTestId('back-to-latest')).toHaveCount(0)
  })
})

test.describe('recalling', () => {
  test('a recalled message turns into a notice for everyone, without refreshing', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Recalls')
    const b = await openAs(browser, bea, `/chats/${group}`)
    const c = await openAs(browser, cy, '/chats')
    await page.goto(`/chats/${group}`)
    await send(page, 'first')
    await send(page, 'oops, wrong group')
    await send(page, 'last')
    await expect(texts(b.page)).toHaveText(['first', 'oops, wrong group', 'last'])
    // 有人引用了要撤回的那一条
    const wrong = messages(b.page).filter({ hasText: 'oops' })
    await wrong.hover()
    await wrong.getByRole('button', { name: 'Reply' }).click()
    await send(b.page, 'what do you mean?')
    await expect(row(c.page, { nickname: 'Recalls' } as Account).getByTestId('badge')).toHaveText(
      '4',
    )

    // 自己发的消息的"更多"里有"撤回"；别人的消息没有
    const mine = messages(page).filter({ hasText: 'oops' }).first()
    await mine.hover()
    await mine.getByRole('button', { name: 'Message options' }).click()
    await expect(menu(page).getByRole('menuitem')).toHaveText([
      'Copy',
      'Forward',
      'Select',
      'Edit',
      'Recall',
      'Delete',
    ])
    await menu(page).getByRole('menuitem', { name: 'Recall' }).click()

    // 原来的位置换成了提示，前后的消息不动
    await expect(texts(page)).toHaveText(['first', 'last', 'what do you mean?'])
    const notice = (who: Page) => who.locator('[data-testid="message-event"]').nth(1)
    await expect(notice(page)).toHaveText('You recalled a message')
    await expect(notice(b.page)).toHaveText(`${account.nickname} recalled a message`)
    await expect(texts(b.page)).toHaveText(['first', 'last', 'what do you mean?'])
    // 引用了它的回复
    for (const each of [page, b.page]) {
      await expect(each.getByTestId('quote')).toHaveText('The original message was recalled')
    }
    // 还没读的人：未读数少了一条，列表里的摘要不变（最新一条还是那条回复）
    await expect(row(c.page, { nickname: 'Recalls' } as Account).getByTestId('badge')).toHaveText(
      '3',
    )
    await row(c.page, { nickname: 'Recalls' } as Account).click()
    await expect(texts(c.page)).toHaveText(['first', 'last', 'what do you mean?'])
    await expect(notice(c.page)).toHaveText(`${account.nickname} recalled a message`)

    // 别人的消息只能复制，不能撤回
    const theirs = messages(page).filter({ hasText: 'what do you mean?' })
    await theirs.hover()
    await theirs.getByRole('button', { name: 'Message options' }).click()
    await expect(menu(page).getByRole('menuitem')).toHaveText([
      'Copy',
      'Forward',
      'Select',
      'Delete',
    ])
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)

    // 刷新之后还是这样
    await page.reload()
    await expect(texts(page)).toHaveText(['first', 'last', 'what do you mean?'])
    await expect(notice(page)).toHaveText('You recalled a message')
    await b.context.close()
    await c.context.close()
  })

  test('recalling puts the content back into the message box, ready to fix and resend', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const cy = await another('Cy')
    const group = await makeGroup(account, [bea, cy], 'Second thoughts')
    const b = await openAs(browser, bea, `/chats/${group}`)
    await page.goto(`/chats/${group}`)
    await expect(events(page)).toHaveCount(1)
    const staged = page.getByTestId('staged-file')
    const recallLast = async () => {
      const last = messages(page).last()
      await last.hover()
      await last.getByRole('button', { name: 'Message options' }).click()
      await menu(page).getByRole('menuitem', { name: 'Recall' }).click()
    }

    // 文字：原样回到输入框，光标在末尾；@ 了的人再发时仍然算 @ 了
    await composer(page).pressSequentially('@')
    await page.getByTestId('mention-option').filter({ hasText: bea.nickname }).click()
    await composer(page).pressSequentially('see the typo hear')
    await composer(page).press('Enter')
    await expect(texts(b.page).last()).toHaveText(`@${bea.nickname} see the typo hear`)
    await recallLast()
    await expect(composer(page)).toHaveValue(`@${bea.nickname} see the typo hear`)
    await expect(composer(page)).toBeFocused()
    await composer(page).press('Backspace')
    await composer(page).press('Backspace')
    await composer(page).press('Backspace')
    await composer(page).press('Backspace')
    await composer(page).pressSequentially('here')
    await composer(page).press('Enter')
    await expect(texts(b.page).last()).toHaveText(`@${bea.nickname} see the typo here`)
    await expect(b.page.getByTestId('mention').last()).toHaveText(`@${bea.nickname}`)

    // 图片和文件：回到输入框上方，可以直接再发
    await sendFiles(page, [
      { name: 'shot.png', mimeType: 'image/png', buffer: pngImage(48, 48, [20, 20, 200]) },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('a few notes') },
    ])
    await expect(b.page.getByTestId('file-name')).toHaveText(['notes.txt'])
    await recallLast()
    await expect(staged.getByTestId('staged-name')).toHaveText(['notes.txt'])
    await recallLast()
    await expect(staged.getByTestId('staged-name')).toHaveText(['notes.txt', 'shot.png'])
    await expect(staged.last().locator('img')).toBeVisible()
    await expect(b.page.getByTestId('message-image')).toHaveCount(0)
    await expect(b.page.getByTestId('message-file')).toHaveCount(0)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(staged).toHaveCount(0)
    await expect(b.page.getByTestId('file-name')).toHaveText(['notes.txt'])
    await expect(b.page.getByTestId('message-image')).toBeVisible()
    expect(await naturalWidth(b.page, 'message-image')).toBe(48)

    // 输入框里已经有字：撤回的文字接在后面
    await composer(page).fill('draft')
    await send(page, 'one more')
    await composer(page).fill('draft')
    await recallLast()
    await expect(composer(page)).toHaveValue('draft\none more')
    await composer(page).fill('')

    // 语音只撤回，不放回来
    const voice = await uploadAs(account, 'voice.webm', 'audio/webm;codecs=opus', voiceSample())
    await post(account, group, { file_id: voice.id, voice_duration_ms: 1500 })
    await expect(page.getByTestId('message-voice')).toBeVisible()
    await recallLast()
    await expect(events(page).last()).toHaveText('You recalled a message')
    await expect(staged).toHaveCount(0)
    await expect(composer(page)).toHaveValue('')
    await b.context.close()
  })

  test('the recall option goes away once the time window has passed', async ({ page, account }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await limits(page, { recall_window_seconds: 3 })
    await page.goto(`/chats/${conversation}`)
    await send(page, 'think twice')
    const mine = messages(page).filter({ hasText: 'think twice' })
    await expect(mine.getByTestId('message-status')).toHaveText('Sent')

    await mine.hover()
    await mine.getByRole('button', { name: 'Message options' }).click()
    await expect(menu(page).getByRole('menuitem')).toHaveText([
      'Copy',
      'Forward',
      'Select',
      'Edit',
      'Recall',
      'Delete',
    ])
    await page.keyboard.press('Escape')

    await page.waitForTimeout(3200)
    await mine.hover()
    await mine.getByRole('button', { name: 'Message options' }).click()
    // 撤回的时限过了，编辑的还没有（F8）
    await expect(menu(page).getByRole('menuitem')).toHaveText([
      'Copy',
      'Forward',
      'Select',
      'Edit',
      'Delete',
    ])
  })

  test('a recall that happened while disconnected shows up after reconnecting', async ({
    page,
    account,
    browser,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const other = await openAs(browser, bea, `/chats/${conversation}`)
    const connection = await controlConnection(page)
    await page.goto(`/chats/${conversation}`)
    await send(other.page, 'you will not see this for long')
    await expect(texts(page)).toHaveText(['you will not see this for long'])

    await connection.cut()
    await expect(page.getByText('Reconnecting')).toBeVisible()
    const sent = messages(other.page).filter({ hasText: 'not see this' })
    await sent.hover()
    await sent.getByRole('button', { name: 'Message options' }).click()
    await menu(other.page).getByRole('menuitem', { name: 'Recall' }).click()
    await expect(events(other.page).last()).toHaveText('You recalled a message')
    // 断着的这一边还不知道
    await expect(texts(page)).toHaveCount(1)

    connection.restore()
    await expect(texts(page)).toHaveCount(0, { timeout: 15_000 })
    await expect(events(page).last()).toHaveText(`${bea.nickname} recalled a message`)
    await other.context.close()
  })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 700 }, hasTouch: true })

  test('a long press opens the message menu, and pictures fit the screen', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const picture = await uploadAs(bea, 'wide.png', 'image/png', pngImage(1600, 400, [9, 9, 200]))
    await post(bea, conversation, { file_id: picture.id })
    await say(bea, conversation, 'press and hold me')
    await page.goto(`/chats/${conversation}`)
    const bubble = texts(page).filter({ hasText: 'press and hold me' })
    await expect(bubble).toBeVisible()

    // 按住半秒：弹出菜单，里面有"引用"
    const box = await bubble.boundingBox()
    const touch = {
      identifier: 0,
      clientX: (box?.x ?? 0) + 20,
      clientY: (box?.y ?? 0) + 10,
    }
    await bubble.dispatchEvent('touchstart', {
      touches: [touch],
      changedTouches: [touch],
      targetTouches: [touch],
    })
    await expect(menu(page).getByRole('menuitem')).toHaveText([
      'Reply',
      'Copy',
      'Forward',
      'Select',
      'Delete',
    ])
    await bubble.dispatchEvent('touchend', { touches: [], changedTouches: [touch] })
    const menuBox = await menu(page).boundingBox()
    expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(375)
    await menu(page).getByRole('menuitem', { name: 'Reply' }).click()
    await expect(page.getByTestId('replying')).toContainText('press and hold me')
    // 手机上回车是换行，点按钮发送
    await composer(page).fill('held')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(messages(page).last().getByTestId('quote')).toContainText('press and hold me')

    // 很宽的图片不会把页面撑宽；大图不超出屏幕
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
    expect(await overflow()).toBe(0)
    await page.getByTestId('message-image').click()
    const full = await page.getByTestId('lightbox-image').boundingBox()
    expect(full?.width ?? 0).toBeLessThanOrEqual(375)
    expect(await overflow()).toBe(0)
  })
})
