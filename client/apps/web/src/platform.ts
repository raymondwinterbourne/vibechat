import { detectPlatform } from '@vibechat/ui'

// 同一份页面既在浏览器里打开，也被桌面端加载。在桌面端里，`window` 上多了一组接口。
export const platform = detectPlatform(window)
