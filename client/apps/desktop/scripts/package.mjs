// 把桌面端打成 macOS 的应用。在容器里运行：
//
//   VC_SERVER_URL=https://chat.example.com pnpm --filter @vibechat/desktop package
//
// VC_SERVER_URL 是这个应用要连的服务器，写进应用里（dist/main/built-in-server.json），必须给。
// 打出来的应用还没有签名，Apple 芯片的 Mac 不让它运行；签名在 Mac 上做，见 scripts/mac。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'
import { strings } from '../dist/main/strings.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const server = process.env.VC_SERVER_URL ?? ''
if (!/^https:\/\/[^/]+/.test(server)) {
  console.error('要用 VC_SERVER_URL 说明这个应用连哪个服务器，必须是 https 的，例如：')
  console.error('  VC_SERVER_URL=https://chat.example.com pnpm --filter @vibechat/desktop package')
  process.exit(1)
}
writeFileSync(
  new URL('../dist/main/built-in-server.json', import.meta.url),
  `${JSON.stringify({ server: new URL(server).origin })}\n`,
)

const [output] = await packager({
  dir: root,
  out: `${root}out`,
  overwrite: true,
  platform: 'darwin',
  arch: 'arm64',
  name: manifest.productName,
  appBundleId: 'io.github.raymondwinterbourne.vibechat',
  appVersion: manifest.version,
  icon: `${root}assets/icon.icns`,
  appCategoryType: 'public.app-category.social-networking',
  extendInfo: {
    // 第一次用麦克风、摄像头时，系统问用户要不要允许，会把这句话显示出来。两种语言都写上
    NSMicrophoneUsageDescription: `${strings('zh-CN').microphone} ${strings('en').microphone}`,
    NSCameraUsageDescription: `${strings('zh-CN').camera} ${strings('en').camera}`,
  },
  // 应用自己没有运行时的依赖，只带上编译结果和资源
  prune: false,
  ignore: (path) =>
    path !== '' &&
    !['/package.json', '/dist', '/resources'].some(
      (kept) => path === kept || path.startsWith(`${kept}/`),
    ),
  // Electron 的下载地址：默认用 npmmirror 的镜像（国内快，国外也能用），设 ELECTRON_MIRROR 可以换，
  // 例如官方的 https://github.com/electron/electron/releases/download/
  download: {
    mirrorOptions: {
      mirror: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
    },
  },
})
console.log(`打好了：${output}`)
