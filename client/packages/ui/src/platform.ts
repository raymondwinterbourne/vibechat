// 平台能力接口：浏览器和桌面端各有一种实现，界面只依赖这个接口。
// 接口和两种实现都在 `@vibechat/core` 里。
export type { Platform, PlatformCommand } from '@vibechat/core'
export { detectPlatform } from '@vibechat/core'
