import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { contentSecurityPolicy } from './csp'

// 后端地址。Vite 把 /api 和 /ws 代理过去，浏览器只访问 Vite 这一个端口，没有跨域问题。
// 端到端测试用自己的一套前后端，通过环境变量改这两个值。
const server = process.env.SERVER_URL ?? 'http://127.0.0.1:3488'
const port = Number(process.env.WEB_PORT ?? 3480)

// 群通话的媒体转发服务（LiveKit）控制用的端口。浏览器连网页地址下的 /livekit，由这里转过去，
// 去掉前面的 /livekit；声音不经过这里，浏览器直接连 LiveKit 的另外两个端口。
const livekit = process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880'

const proxy = {
  '/api': server,
  '/ws': { target: server, ws: true },
  '/livekit': {
    target: livekit,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/livekit/, ''),
  },
}

// 经反向代理访问时，请求里的主机名是站点的域名。Vite 只认本机的地址，
// 别的主机名要在这里列出来（逗号分隔），否则请求会被它挡掉。本机开发和测试不用设。
const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)

// Vite 对根目录之外的源码是逐个文件监听的。编辑器"写临时文件再改名"式的保存会换掉文件，
// 而 Docker Desktop 的挂载不会把这个事件传给单文件监听，热更新就此失效。
// 按目录监听 packages/ 则不受影响。
function watchWorkspacePackages(): Plugin {
  const packages = fileURLToPath(new URL('../../packages', import.meta.url))
  return {
    name: 'watch-workspace-packages',
    configureServer({ watcher }) {
      watcher.add(packages)
    },
  }
}

// 提供构建结果时，页面带上内容安全策略。
// 开发模式不加：Vite 的热更新靠往页面里插内嵌脚本，加了就用不了。
// 转给后端的请求也不加：文件接口有它自己更严的策略。
function withContentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    configurePreviewServer({ middlewares }) {
      middlewares.use((request, response, next) => {
        const path = request.url ?? ''
        const host = request.headers.host
        const proxied = ['/api/', '/ws', '/livekit/'].some((prefix) => path.startsWith(prefix))
        if (host && !proxied) {
          response.setHeader('Content-Security-Policy', contentSecurityPolicy(host))
        }
        next()
      })
    },
  }
}

// 每次构建的编号：由构建出的全部文件名算出来。文件名里带着内容的摘要，
// 所以内容不变编号就不变，任何一处改了编号就变。编号写进页面（一个 meta），
// 同时写成 version.json 和页面放在一起：已经开着的页面取它来比，就知道服务器上的页面换了没有。
// 只在构建时生效；开发服务器没有 version.json，页面也就不检查。
function buildVersion(): Plugin {
  return {
    name: 'build-version',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !name.endsWith('.html'))
        .sort()
      const build = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16)
      const page = bundle['index.html']
      if (page?.type === 'asset' && typeof page.source === 'string') {
        page.source = page.source.replace(
          '</head>',
          `  <meta name="vc-build" content="${build}" />\n  </head>`,
        )
      }
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ build })}\n`,
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    watchWorkspacePackages(),
    withContentSecurityPolicy(),
    buildVersion(),
  ],
  server: {
    // 监听所有网卡，容器外才能通过端口映射访问
    host: true,
    port,
    strictPort: true,
    proxy,
    allowedHosts,
  },
  // 预览构建结果时用同样的端口和代理（端到端测试跑的是构建结果）
  preview: {
    host: true,
    port,
    strictPort: true,
    proxy,
    allowedHosts,
  },
})
