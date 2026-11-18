// 会话的图片和文件一览（F6）：新的在前，点开大图可以左右翻，可以回到聊天里那一条的位置。

import type { Page } from '@playwright/test'
import {
  another,
  befriend,
  expect,
  gotoConnected,
  makeGroup,
  pngImage,
  post,
  say,
  test,
  uploadAs,
} from './support'

const openMedia = async (page: Page) => {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Photos and files' }).click()
  return page.getByTestId('media-panel')
}

test.describe('photos and files of a conversation', () => {
  test('lists the photos newest first, opens them and goes back to the chat', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    const seqs: number[] = []
    for (const color of [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ] as [number, number, number][]) {
      const image = await uploadAs(
        bea,
        `${color.join('-')}.png`,
        'image/png',
        pngImage(8, 8, color),
      )
      seqs.push(await post(bea, conversation, { file_id: image.id }))
      // 中间夹几条文字，让最早的图片翻出屏幕
      await say(bea, conversation, ...Array.from({ length: 15 }, (_, i) => `line ${i}`))
    }
    const notes = await uploadAs(bea, 'notes.txt', 'text/plain', Buffer.from('hello'))
    const file = await post(bea, conversation, { file_id: notes.id })

    await gotoConnected(page, `/chats/${conversation}`)
    const panel = await openMedia(page)
    const images = panel.getByTestId('media-image')
    await expect(images).toHaveCount(3)
    // 新的在前
    expect(await images.evaluateAll((all) => all.map((el) => Number(el.dataset.seq)))).toEqual(
      [...seqs].reverse(),
    )

    // 点最新的一张，往右翻到更早的
    await images.first().click()
    const lightbox = page.getByTestId('lightbox')
    await expect(lightbox.getByTestId('lightbox-image')).toHaveAttribute('alt', '0-0-255.png')
    await expect(page.getByTestId('lightbox-previous')).toHaveCount(0)
    await page.getByTestId('lightbox-next').click()
    await expect(lightbox.getByTestId('lightbox-image')).toHaveAttribute('alt', '0-255-0.png')
    await page.keyboard.press('ArrowRight')
    await expect(lightbox.getByTestId('lightbox-image')).toHaveAttribute('alt', '255-0-0.png')
    await expect(page.getByTestId('lightbox-next')).toHaveCount(0)

    // 回到聊天里最早那张图的位置
    await page.getByRole('button', { name: 'Show in chat' }).click()
    await expect(lightbox).toHaveCount(0)
    const first = page.locator(`[data-seq="${seqs[0]}"][data-highlighted]`)
    await expect(first).toBeInViewport()

    // 文件那一页
    await panel.getByRole('radio', { name: 'Files' }).click()
    await expect(panel.getByTestId('media-file')).toHaveCount(1)
    await expect(panel.getByTestId('media-file')).toContainText('notes.txt')
    await panel.getByTestId('media-locate').click()
    await expect(page.locator(`[data-seq="${file}"][data-highlighted]`)).toBeInViewport()
  })

  test('says so when there is nothing yet, and is in the group info too', async ({
    page,
    account,
  }) => {
    const bea = await another('Bea')
    const conversation = await befriend(account, bea)
    await gotoConnected(page, `/chats/${conversation}`)
    const panel = await openMedia(page)
    await expect(panel.getByTestId('media-empty')).toHaveText('No photos here yet')
    await panel.getByRole('radio', { name: 'Files' }).click()
    await expect(panel.getByTestId('media-empty')).toHaveText('No files here yet')

    // 群里：群信息里也有入口
    const cara = await another('Cara')
    const dan = await another('Dan')
    const group = await makeGroup(account, [cara, dan])
    await gotoConnected(page, `/chats/${group}`)
    await page.getByRole('button', { name: 'Group info' }).click()
    await page.getByTestId('group-media').click()
    await expect(page.getByTestId('media-panel')).toBeVisible()
  })
})
