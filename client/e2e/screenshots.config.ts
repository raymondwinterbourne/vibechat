import { defineConfig, devices } from '@playwright/test'

// README 里的截图：造好示例数据，按中文、英文各截一套，存到 screenshots-out/ 下（不进 git），
// 再由 scripts/screenshots 复制到 docs/images/。不是测试，平时的检查和全量测试都不跑它。
//
// 跑法（在宿主机上、仓库根目录）：./scripts/screenshots

export default defineConfig({
  testDir: './screenshots',
  globalSetup: './global-setup.ts',
  // 一张接一张截：同时跑会抢 CPU，画面和通话不稳定
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3490',
    ...devices['Desktop Chrome'],
    // 截出来是两倍的像素，在高分屏上也清楚
    deviceScaleFactor: 2,
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
})
