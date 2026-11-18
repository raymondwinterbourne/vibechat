// 这个页面是哪一台"设备"：页面打开时生成，连 WebSocket 和打电话时都带上。页面刷新后是新的一台。

import { newDeviceId } from '@vibechat/core'

export const DEVICE_ID = newDeviceId()
