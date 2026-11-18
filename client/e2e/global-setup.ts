// 全部测试开始前执行一次：让管理员完成首次登录后的改密码，再预先生成一批邀请码。
//
// 这一步本身也是一项验收：用初始密码登录后只能看到修改密码的页面，
// 改完才能进入系统。它只在全新的环境里发生一次，所以放在这里而不是普通的测试里。

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import {
  ADMIN_INITIAL_PASSWORD,
  ADMIN_PASSWORD,
  BASE_URL,
  newApi,
  prepareInvitePool,
  VOICE_SAMPLE_ENV,
} from './tests/support'

// 预先生成多少个邀请码。要多于一轮测试里注册的账号数（2026-10 时三种内核一共一千多个）。
// 不够时测试会现生成，但现生成的排在邀请码列表的最前面，会把管理邀请码的测试刚生成的那几行
// 挤到后面的页上，让它失败。用完了时，测试结束后会提醒加大
const INVITE_POOL_SIZE = 2400

export default async function globalSetup() {
  await changeAdminPassword()
  const pool = await prepareInvitePool(INVITE_POOL_SIZE)
  const samples = await recordVoiceSample()
  // 返回的函数在全部测试结束后执行
  return () => {
    const left = readdirSync(pool).length
    if (left === 0) {
      console.warn(
        `预先生成的 ${INVITE_POOL_SIZE} 个邀请码用完了：请加大 global-setup.ts 里的 INVITE_POOL_SIZE`,
      )
    }
    rmSync(pool, { recursive: true, force: true })
    rmSync(samples, { recursive: true, force: true })
  }
}

/**
 * 用 Chrome 的内核和它自带的假麦克风录一小段语音，存成文件，返回所在的目录。
 * 播放语音的测试在三种内核里都用这一段：它就是 Chrome 用户发出的语音的样子。
 */
async function recordVoiceSample(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vc-e2e-voice-'))
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  const page = await browser.newPage({ baseURL: BASE_URL })
  // 录音只能在本站的页面里做
  await page.goto('/login')
  const base64 = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => chunks.push(event.data)
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve
    })
    recorder.start()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    recorder.stop()
    await stopped
    for (const track of stream.getTracks()) track.stop()
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  })
  await browser.close()
  const sample = join(dir, 'voice.webm')
  writeFileSync(sample, Buffer.from(base64, 'base64'))
  process.env[VOICE_SAMPLE_ENV] = sample
  return dir
}

async function changeAdminPassword() {
  // 管理员的密码已经改过了（对着同一套环境重复跑测试时）：什么也不用做
  const api = await newApi()
  const probe = await api.post('/api/auth/login', {
    data: { handle: 'admin', password: ADMIN_PASSWORD },
  })
  await api.dispose()
  if (probe.status() === 200) return

  const browser = await chromium.launch()
  const page = await browser.newPage({ baseURL: BASE_URL, locale: 'en-US' })

  await page.goto('/login')
  await page.getByLabel('ID').fill('admin')
  await page.getByLabel('Password').fill(ADMIN_INITIAL_PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()

  // 用初始密码登录后被带到修改密码的页面，别的页面进不去
  await expect(page).toHaveURL(/\/change-password$/)
  await page.goto('/admin/invite-codes')
  await expect(page).toHaveURL(/\/change-password$/)
  await page.goto('/chats')
  await expect(page).toHaveURL(/\/change-password$/)

  await page.getByLabel('Current password').fill(ADMIN_INITIAL_PASSWORD)
  await page.getByLabel('New password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByLabel('Confirm new password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()

  // 改完之后进入系统，并且能看到管理入口
  await expect(page).toHaveURL(/\/chats$/)
  await expect(page.getByTestId('nav-rail').getByRole('link', { name: 'Admin' })).toBeVisible()

  await browser.close()
}
