// 群视频里每一路画面收哪一档（F11 任务清单第 1 章）。
//
// 每个人同时发"清楚的"和"小的"两档，媒体转发服务给每个观看的人只转一档。收哪一档由看的人自己定，
// 规则只有这一处：服务器的出口带宽就是按它估的，所以写成一个不依赖别的东西的函数，单独测。

import type { CallVideoView } from '@vibechat/protocol'
import { GROUP_VIDEO, type GroupVideoSettings, type VideoLayer } from './room'

/** 别人里开着摄像头的不超过这么多个、又没有放大谁时，每一路都收清楚的。 */
export const ALL_CLEAR_UP_TO = 2

export interface WatchInput {
  /** 开着摄像头的别人（不含我自己），用户编号。 */
  cameras: readonly string[]
  /** 我放大了谁（可以是我自己、也可以是没开摄像头的人）。没有放大谁时为空。 */
  enlarged: string | null
  /** 现在显示在屏幕上的人。为空表示不知道，都当作看得到。 */
  visible: ReadonlySet<string> | null
  /** 通话缩小了：显示的画面都很小，一律收小的一档。 */
  compact: boolean
  /** 我正在看别人共享的屏幕（F12）：屏幕那一路已经占了不少带宽，摄像头一律收小的一档。 */
  screen?: boolean
}

/**
 * 每一路画面要哪一档。
 *
 * - 看不到的不收。
 * - 放大了谁：他收清楚的，其余收小的。
 * - 没有放大谁：别人不超过 2 个时都收清楚的，超过了都收小的。
 * - 缩小时都收小的。
 * - 正在看别人共享的屏幕时都收小的，放大了谁也一样：屏幕那一路另算。
 *
 * 所以每个人最多收"1 路清楚的 + 其余小的"（或者 2 路清楚的），不随人数成倍增加。
 */
export function layersToWatch(input: WatchInput): Record<string, VideoLayer> {
  const { cameras, enlarged, visible, compact, screen = false } = input
  const shown = cameras.filter((user) => visible === null || visible.has(user))
  const layers: Record<string, VideoLayer> = {}
  for (const user of cameras) {
    if (!shown.includes(user)) layers[user] = 'off'
    else if (compact || screen) layers[user] = 'low'
    else if (enlarged !== null) layers[user] = user === enlarged ? 'high' : 'low'
    else layers[user] = shown.length <= ALL_CLEAR_UP_TO ? 'high' : 'low'
  }
  return layers
}

/** 群视频的画面参数：两档的码率是管理员在系统设置里定的，大小和帧率是固定的。 */
export function groupVideoSettings(video: CallVideoView): GroupVideoSettings {
  return {
    high: { ...GROUP_VIDEO.high, kbps: video.group_camera_high_kbps },
    low: { ...GROUP_VIDEO.low, kbps: video.group_camera_low_kbps },
    fps: GROUP_VIDEO.fps,
    // 共享的屏幕：码率也是管理员定的（F12），大小和帧率是固定的
    screen: { ...GROUP_VIDEO.screen, kbps: video.group_screen_kbps },
  }
}

/**
 * 按第 1 章的规则，一个有 `people` 个人、都开着摄像头的通话，服务器最多往外发多少画面（千比特每秒）。
 * 最坏的情况是每个人都放大着一路：1 路清楚的加上其余小的；别人不超过 2 个时是都收清楚的。
 * 声音另算。管理页面用它把码率换算成对带宽的影响。
 */
export function groupVideoEgressKbps(people: number, highKbps: number, lowKbps: number): number {
  const others = Math.max(0, people - 1)
  const each = others <= ALL_CLEAR_UP_TO ? others * highKbps : highKbps + (others - 1) * lowKbps
  return people * each
}

/**
 * 有人共享屏幕时（F12 第 5 章），一个有 `people` 个人的通话，服务器最多往外发多少画面（千比特每秒）。
 * 每个看的人收屏幕，`cameras` 为真时还收其他每个人的摄像头，都是小的一档；
 * 共享的人通话界面缩小着，只收小窗里的那一路。语音通话里没有摄像头，就只有屏幕。声音另算。
 */
export function groupScreenEgressKbps(
  people: number,
  screenKbps: number,
  lowKbps: number,
  cameras: boolean,
): number {
  const viewers = Math.max(0, people - 1)
  if (viewers === 0) return 0
  if (!cameras) return viewers * screenKbps
  return viewers * (screenKbps + viewers * lowKbps) + lowKbps
}
