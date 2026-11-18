// 预加载脚本：页面和主进程之间唯一的通道。
//
// 它运行在页面的脚本之前，和页面的脚本互相隔离。页面看不到这里的任何东西，
// 只看得到下面明确挂出去的那几个函数；这些函数只能给主进程发几种固定的消息。
import electron = require('electron')

const { contextBridge, ipcRenderer } = electron

// 预加载脚本运行在页面所在的进程里，看得到页面的地址；主进程的代码里没有这个东西
declare const location: { origin: string; protocol: string }

/** 主进程创建窗口时带过来的参数，形如 `--vc-server=https://…`。 */
function argument(name: string): string {
  const prefix = `--vc-${name}=`
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : ''
}

const server = argument('server')

if (server !== '' && location.origin === server) {
  // 服务器上的页面：给它桌面端的那几样能力
  contextBridge.exposeInMainWorld('vibeDesktop', {
    version: argument('version'),
    setUnreadCount: (count: number) => ipcRenderer.send('vc:set-unread', count),
    showWindow: () => ipcRenderer.send('vc:show-window'),
    setLanguage: (language: string) => ipcRenderer.send('vc:set-language', language),
    callAlert: (on: boolean) => ipcRenderer.send('vc:call-alert', on),
    screenAccess: () => ipcRenderer.invoke('vc:screen-access'),
    onCommand: (listener: (command: string) => void) => {
      const handler = (_event: unknown, command: string) => listener(command)
      ipcRenderer.on('vc:command', handler)
      return () => {
        ipcRenderer.removeListener('vc:command', handler)
      }
    },
  })
} else if (location.protocol === 'file:') {
  // 应用自带的"连不上服务器"页面：只能请主进程现在重试一次
  contextBridge.exposeInMainWorld('vibeOffline', {
    retry: () => ipcRenderer.send('vc:retry'),
  })
}
