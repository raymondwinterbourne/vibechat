import { describe, expect, it } from 'vitest'
import { applicationMenu, contextMenu, type Item } from './menus.js'
import { languageOf, strings } from './strings.js'

const labels = (items: Item[]) => items.map((item) => (item.separator ? '-' : item.label))
const roles = (items: Item[]) => items.filter((item) => !item.separator).map((item) => item.role)

describe('the menu bar', () => {
  it('has the five menus a Mac app is expected to have', () => {
    expect(labels(applicationMenu('zh-CN', '0.1.0'))).toEqual([
      'VibeChat',
      '编辑',
      '显示',
      '窗口',
      '帮助',
    ])
    expect(labels(applicationMenu('en', '0.1.0'))).toEqual([
      'VibeChat',
      'Edit',
      'View',
      'Window',
      'Help',
    ])
  })

  it('opens the settings page with ⌘,', () => {
    for (const language of ['zh-CN', 'en'] as const) {
      const app = applicationMenu(language, '0.1.0')[0]?.submenu ?? []
      const settings = app.filter((item) => item.command === 'open-settings')
      expect(settings).toHaveLength(1)
      expect(settings[0]?.accelerator).toBe('CmdOrCtrl+,')
    }
    expect(labels(applicationMenu('zh-CN', '0.1.0')[0]?.submenu ?? [])).toEqual([
      '关于 VibeChat',
      '-',
      '设置…',
      '-',
      '隐藏 VibeChat',
      '隐藏其他',
      '全部显示',
      '-',
      '退出 VibeChat',
    ])
  })

  it('is the same menu in both languages, only the words differ', () => {
    const shape = (items: Item[]): unknown =>
      items.map((item) => ({
        role: item.role,
        command: item.command,
        accelerator: item.accelerator,
        separator: item.separator,
        submenu: item.submenu && shape(item.submenu),
      }))
    expect(shape(applicationMenu('en', '1.2.3'))).toEqual(shape(applicationMenu('zh-CN', '1.2.3')))
  })

  it('leaves the developer tools out', () => {
    const all = (items: Item[]): Item[] =>
      items.flatMap((item) => [item, ...all(item.submenu ?? [])])
    for (const item of all(applicationMenu('en', '0.1.0'))) {
      expect(item.role).not.toBe('toggleDevTools')
      expect(item.role).not.toBe('forceReload')
    }
  })

  it('shows the version under Help', () => {
    expect(labels(applicationMenu('zh-CN', '0.1.0').at(-1)?.submenu ?? [])).toEqual(['版本 0.1.0'])
    expect(labels(applicationMenu('en', '2.0.1').at(-1)?.submenu ?? [])).toEqual(['Version 2.0.1'])
  })
})

describe('the right-click menu', () => {
  it('offers editing where text can be typed', () => {
    const menu = contextMenu('zh-CN', { editable: true, hasSelection: true, image: false })
    expect(labels(menu)).toEqual(['剪切', '复制', '粘贴', '-', '全选'])
    expect(roles(menu)).toEqual(['cut', 'copy', 'paste', 'selectAll'])
  })

  it('greys out cut and copy when nothing is selected', () => {
    const menu = contextMenu('en', { editable: true, hasSelection: false, image: false })
    expect(menu.filter((item) => item.enabled === false).map((item) => item.role)).toEqual([
      'cut',
      'copy',
    ])
  })

  it('offers copy on selected text and save on an image', () => {
    expect(
      labels(contextMenu('en', { editable: false, hasSelection: true, image: false })),
    ).toEqual(['Copy'])
    const onImage = contextMenu('zh-CN', { editable: false, hasSelection: false, image: true })
    expect(labels(onImage)).toEqual(['存储图片…'])
    expect(onImage[0]?.command).toBe('save-image')
  })

  it('does not pop up when there is nothing to do', () => {
    expect(contextMenu('en', { editable: false, hasSelection: false, image: false })).toEqual([])
  })
})

describe('the language of the menus', () => {
  it('starts from the system language until the app says otherwise', () => {
    expect(languageOf('zh-CN')).toBe('zh-CN')
    expect(languageOf('zh-Hans-CN')).toBe('zh-CN')
    expect(languageOf('ZH-tw')).toBe('zh-CN')
    expect(languageOf('en-US')).toBe('en')
    expect(languageOf('ja-JP')).toBe('en')
    expect(languageOf('')).toBe('en')
  })

  it('has every string in both languages', () => {
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([key, inner]) =>
        typeof inner === 'object' ? keys(inner).map((k) => `${key}.${k}`) : [key],
      )
    expect(keys(strings('en'))).toEqual(keys(strings('zh-CN')))
    for (const language of ['zh-CN', 'en'] as const) {
      expect(strings(language).microphone.length).toBeGreaterThan(0)
    }
  })
})
