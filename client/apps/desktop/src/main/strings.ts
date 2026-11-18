// 主进程自己显示的文字：系统菜单、右键菜单、申请麦克风时的说明。
// 页面里的文字不在这里，那是 Web 应用自己的；"连不上服务器"那一页的文字在它自己的文件里。

import type { Language } from './messages.js'

const zh = {
  menu: {
    about: '关于 VibeChat',
    settings: '设置…',
    hide: '隐藏 VibeChat',
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quit: '退出 VibeChat',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    view: '显示',
    reload: '重新载入',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullScreen: '进入或退出全屏',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    close: '关闭',
    help: '帮助',
    version: '版本 {{version}}',
  },
  context: {
    saveImage: '存储图片…',
  },
  microphone: '发语音消息、语音和视频通话需要使用麦克风。',
  camera: '视频通话需要使用摄像头。',
}

const en: typeof zh = {
  menu: {
    about: 'About VibeChat',
    settings: 'Settings…',
    hide: 'Hide VibeChat',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit VibeChat',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullScreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    close: 'Close',
    help: 'Help',
    version: 'Version {{version}}',
  },
  context: {
    saveImage: 'Save Image As…',
  },
  microphone: 'The microphone is used for voice messages and calls.',
  camera: 'The camera is used for video calls.',
}

export type Strings = typeof zh

export function strings(language: Language): Strings {
  return language === 'zh-CN' ? zh : en
}

/** 系统的语言是中文就用中文，其余用英文。应用里选过语言之后以选的为准。 */
export function languageOf(systemLocale: string): Language {
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}
