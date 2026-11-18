// 图片的文字说明；图片、文件、语音也能带着引用。

import type { Browser, Page } from '@playwright/test'
import {
  type Account,
  another,
  befriend,
  expect,
  openAs,
  pngImage,
  post,
  sendFiles,
  test,
  uploadAs,
  voiceSample,
} from './support'

const messages = (page: Page) => page.getByTestId('message')
const texts = (page: Page) => page.getByTestId('message-text')
const events = (page: Page) => page.getByTestId('message-event')
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const staged = (page: Page) => page.getByTestId('staged-file')
const row = (page: Page, who: Account) =>
  page.getByTestId('conversation').filter({ hasText: who.nickname })
const picture = (name: string) => ({
  name,
  mimeType: 'image/png',
  buffer: pngImage(120, 80, [230, 140, 60]),
})

/** 两个好友各开一个窗口，都停在他们的会话里。 */
async function twoWindows(browser: Browser, page: Page, me: Account) {
  const bea = await another('Bea')
  const conversation = await befriend(me, bea)
  const other = await openAs(browser, bea, `/chats/${conversation}`)
  await page.goto(`/chats/${conversation}`)
  await expect(events(page)).toHaveCount(1)
  await expect(events(other.page)).toHaveCount(1)
  return { bea, conversation, beaPage: other.page, context: other.context }
}

/** 把一条消息设为要回复的那一条。 */
async function replyTo(page: Page, text: string) {
  // 回复里也带着这段话：原消息是最早的那一条
  const original = messages(page).filter({ hasText: text }).first()
  await original.hover()
  await original.getByRole('button', { name: 'Reply' }).click()
  await expect(page.getByTestId('replying')).toContainText(text)
}

test.describe('captions', () => {
  test('a single picture and the words typed with it go out as one message', async ({
    page,
    account,
    browser,
  }) => {
    const { beaPage, context } = await twoWindows(browser, page, account)

    await page.getByTestId('file-input').setInputFiles(picture('sunset.png'))
    await expect(staged(page)).toHaveCount(1)
    await composer(page).fill('sunset at the beach')
    await composer(page).press('Enter')
    await expect(staged(page)).toHaveCount(0)

    // 两边都是一条消息：图片和说明在一起，没有另外一条文字
    for (const each of [page, beaPage]) {
      const message = messages(each).last()
      await expect(message.getByTestId('message-image')).toBeVisible()
      await expect(message.getByTestId('message-caption')).toHaveText('sunset at the beach')
      await expect(texts(each)).toHaveCount(0)
    }
    await expect(messages(page).last().getByTestId('message-status')).toHaveText(/Sent|Read/)

    // 会话列表的摘要
    await beaPage.goto('/chats')
    await expect(row(beaPage, account).getByTestId('conversation-summary')).toHaveText(
      '[Photo] sunset at the beach',
    )
    // 说明里的词能搜到
    await beaPage.getByTestId('open-search').click()
    await beaPage.getByTestId('search-panel').getByRole('searchbox').fill('beach')
    await expect(beaPage.getByTestId('search-panel').getByTestId('search-item')).toContainText(
      account.nickname,
    )
    await expect(beaPage.getByTestId('search-panel').getByTestId('hit-text')).toContainText(
      'sunset at the beach',
    )
    await context.close()
  })

  test('with several pictures the words go out on their own, after them', async ({
    page,
    account,
    browser,
  }) => {
    const { beaPage, context } = await twoWindows(browser, page, account)

    await page.getByTestId('file-input').setInputFiles([picture('a.png'), picture('b.png')])
    await expect(staged(page)).toHaveCount(2)
    await composer(page).fill('two shots')
    await composer(page).press('Enter')

    await expect(texts(beaPage).last()).toHaveText('two shots')
    await expect(beaPage.getByTestId('message-image')).toHaveCount(2)
    await expect(beaPage.getByTestId('message-caption')).toHaveCount(0)
    await context.close()
  })

  test('recalling a captioned picture puts the picture and its words back', async ({
    page,
    account,
    browser,
  }) => {
    const { beaPage, context } = await twoWindows(browser, page, account)
    await page.getByTestId('file-input').setInputFiles(picture('typo.png'))
    await composer(page).fill('the view form here')
    await composer(page).press('Enter')
    await expect(beaPage.getByTestId('message-caption')).toHaveText('the view form here')

    const last = messages(page).last()
    await last.hover()
    await last.getByRole('button', { name: 'Message options' }).click()
    await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Recall' }).click()

    await expect(staged(page).getByTestId('staged-name')).toHaveText(['typo.png'])
    await expect(composer(page)).toHaveValue('the view form here')
    await composer(page).fill('the view from here')
    await composer(page).press('Enter')
    await expect(beaPage.getByTestId('message-caption')).toHaveText('the view from here')
    await expect(beaPage.getByTestId('message-image')).toHaveCount(1)
    await context.close()
  })
})

test.describe('replying with pictures, files and voice', () => {
  test('a picture, a file and a recording can each carry a reply', async ({
    page,
    account,
    browser,
    browserName,
  }) => {
    const { bea, conversation, beaPage, context } = await twoWindows(browser, page, account)
    await post(bea, conversation, { text: 'send me the photo' })
    await expect(texts(page)).toHaveText(['send me the photo'])

    // 引用之后只发一张图片、不打字：图片带着引用
    await replyTo(page, 'send me the photo')
    await sendFiles(page, picture('photo.png'))
    await expect(page.getByTestId('replying')).toHaveCount(0)
    // 引用之后发一张带说明的图片：同一条消息带着引用和说明
    await replyTo(page, 'send me the photo')
    await page.getByTestId('file-input').setInputFiles(picture('another.png'))
    await composer(page).fill('and another')
    await composer(page).press('Enter')
    // 引用之后发一个文件
    await replyTo(page, 'send me the photo')
    await sendFiles(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('n') })

    const quoted = beaPage.getByTestId('media-quote')
    await expect(quoted).toHaveCount(3)
    for (const quote of await quoted.all()) {
      await expect(quote.getByTestId('quote')).toContainText('send me the photo')
    }
    await expect(beaPage.getByTestId('message-caption')).toHaveText('and another')

    // 点图片上方的引用，跳到原消息
    await quoted.first().getByTestId('quote').click()
    await expect(
      messages(beaPage).filter({ hasText: 'send me the photo' }).first(),
    ).toHaveAttribute('data-highlighted', 'true')

    // 语音也可以：能录音的内核里从界面上录，否则通过接口发
    if (browserName === 'webkit') {
      const voice = await uploadAs(account, 'voice.webm', 'audio/webm;codecs=opus', voiceSample())
      const original = await messages(page)
        .filter({ hasText: 'send me the photo' })
        .first()
        .getAttribute('data-seq')
      await post(account, conversation, {
        file_id: voice.id,
        voice_duration_ms: 1500,
        reply_to: Number(original),
      })
    } else {
      await replyTo(page, 'send me the photo')
      await page.getByRole('button', { name: 'Record a voice message' }).click()
      await expect(page.getByTestId('voice-elapsed')).toHaveText('0:02', { timeout: 5000 })
      // 消息里引用的那段话也带着"send"：按钮名要完全一样
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(page.getByTestId('replying')).toHaveCount(0)
    }
    const voiceMessage = messages(beaPage).filter({ has: beaPage.getByTestId('message-voice') })
    await expect(voiceMessage.getByTestId('quote')).toContainText('send me the photo')
    await context.close()
  })
})
