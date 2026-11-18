import { defineConfig, devices } from '@playwright/test'

// 端到端测试在专门的测试容器里运行（compose.yaml 的 e2e 服务），
// 访问 scripts/e2e-stack 启动的那一套前后端。平时用 scripts/test-all 一起跑。
//
// 注意：@playwright/test 的版本必须和测试容器镜像的版本完全一致。

// 会改动全局状态的测试（系统设置、管理员的密码和邮箱）放在这一个文件里。
// 它们会影响同时在跑的别的测试，所以等别的全部跑完再跑，两种内核一个接一个，不同时跑。
const GLOBAL = /admin-global\.spec\.ts/

const chromium = {
  ...devices['Desktop Chrome'],
  // 录语音的测试需要麦克风：用浏览器自带的假设备，并且不弹出询问
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
}
// 只支持 Chrome 和 Safari（2026-11-18 起不再支持 Firefox），所以只测这两种内核。
// 测试用的 Safari 内核没有假的麦克风：录制的测试在它上面跳过，播放照常测
const webkit = devices['Desktop Safari']

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  // 同时跑 3 个：再多，通话、视频的测试在高峰时会把 CPU 用满、被拖到超时（F11、F12；2026-11-18 试过 4 个，没有快多少）
  workers: 3,
  // 失败就是失败，不靠重试掩盖不稳定的测试
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3490',
    locale: 'en-US',
    // 每个用例都要先录下来、通过了再删，所以录得越多越慢：不录逐帧的截图，
    // 失败时仍有每一步的页面快照和日志可查（全量时磁盘写入从约 50 GB 降下来）
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  projects: [
    { name: 'chromium', use: chromium, testIgnore: GLOBAL },
    { name: 'webkit', use: webkit, testIgnore: GLOBAL },
    {
      name: 'global-chromium',
      use: chromium,
      testMatch: GLOBAL,
      dependencies: ['chromium', 'webkit'],
    },
    { name: 'global-webkit', use: webkit, testMatch: GLOBAL, dependencies: ['global-chromium'] },
  ],
})
