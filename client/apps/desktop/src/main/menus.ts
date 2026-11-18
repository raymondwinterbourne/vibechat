// 系统菜单和右键菜单有哪些项。这里只描述内容，不碰 Electron，所以可以单独测试。

import type { Language } from './messages.js'
import { strings } from './strings.js'

/** 菜单里的一项。`role` 是系统自带的行为，`command` 是交给主进程处理的。 */
export interface Item {
  label?: string
  role?: string
  command?: 'open-settings' | 'save-image'
  accelerator?: string
  enabled?: boolean
  separator?: true
  submenu?: Item[]
}

const SEPARATOR: Item = { separator: true }

/** 屏幕顶部的菜单，按 macOS 的习惯排列，文字跟随应用里选的语言。 */
export function applicationMenu(language: Language, version: string): Item[] {
  const { menu } = strings(language)
  return [
    {
      label: 'VibeChat',
      submenu: [
        { label: menu.about, role: 'about' },
        SEPARATOR,
        { label: menu.settings, command: 'open-settings', accelerator: 'CmdOrCtrl+,' },
        SEPARATOR,
        { label: menu.hide, role: 'hide' },
        { label: menu.hideOthers, role: 'hideOthers' },
        { label: menu.showAll, role: 'unhide' },
        SEPARATOR,
        { label: menu.quit, role: 'quit' },
      ],
    },
    {
      label: menu.edit,
      submenu: [
        { label: menu.undo, role: 'undo' },
        { label: menu.redo, role: 'redo' },
        SEPARATOR,
        { label: menu.cut, role: 'cut' },
        { label: menu.copy, role: 'copy' },
        { label: menu.paste, role: 'paste' },
        { label: menu.selectAll, role: 'selectAll' },
      ],
    },
    {
      label: menu.view,
      submenu: [
        { label: menu.reload, role: 'reload' },
        SEPARATOR,
        { label: menu.actualSize, role: 'resetZoom' },
        { label: menu.zoomIn, role: 'zoomIn' },
        { label: menu.zoomOut, role: 'zoomOut' },
        SEPARATOR,
        { label: menu.fullScreen, role: 'togglefullscreen' },
      ],
    },
    {
      label: menu.window,
      role: 'window',
      submenu: [
        { label: menu.minimize, role: 'minimize' },
        { label: menu.zoom, role: 'zoom' },
        { label: menu.close, role: 'close' },
      ],
    },
    {
      label: menu.help,
      role: 'help',
      submenu: [{ label: menu.version.replace('{{version}}', version), enabled: false }],
    },
  ]
}

/** 用户点右键时的情形。 */
export interface ContextTarget {
  /** 点在可以输入的地方。 */
  editable: boolean
  /** 有选中的文字。 */
  hasSelection: boolean
  /** 点在一张图片上。 */
  image: boolean
}

/** 右键菜单。没有可做的事时是空的，这时不弹出。 */
export function contextMenu(language: Language, target: ContextTarget): Item[] {
  const { menu, context } = strings(language)
  if (target.editable) {
    return [
      { label: menu.cut, role: 'cut', enabled: target.hasSelection },
      { label: menu.copy, role: 'copy', enabled: target.hasSelection },
      { label: menu.paste, role: 'paste' },
      SEPARATOR,
      { label: menu.selectAll, role: 'selectAll' },
    ]
  }
  const items: Item[] = []
  if (target.hasSelection) items.push({ label: menu.copy, role: 'copy' })
  if (target.image) items.push({ label: context.saveImage, command: 'save-image' })
  return items
}
