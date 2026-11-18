import { describe, expect, it } from 'vitest'
import {
  groupScreenEgressKbps,
  groupVideoEgressKbps,
  groupVideoSettings,
  layersToWatch,
} from './groupVideo'

const watch = (
  cameras: string[],
  patch: {
    enlarged?: string | null
    visible?: string[] | null
    compact?: boolean
    screen?: boolean
  } = {},
) =>
  layersToWatch({
    cameras,
    enlarged: patch.enlarged ?? null,
    visible: patch.visible ? new Set(patch.visible) : null,
    compact: patch.compact ?? false,
    screen: patch.screen ?? false,
  })

describe('which tier to get for each picture', () => {
  it('gets everything clear while there are at most two other cameras', () => {
    expect(watch([])).toEqual({})
    expect(watch(['a'])).toEqual({ a: 'high' })
    expect(watch(['a', 'b'])).toEqual({ a: 'high', b: 'high' })
  })

  it('gets everything small once there are more than two', () => {
    expect(watch(['a', 'b', 'c'])).toEqual({ a: 'low', b: 'low', c: 'low' })
    expect(Object.values(watch(['a', 'b', 'c', 'd', 'e']))).toEqual(Array(5).fill('low'))
  })

  it('gets the enlarged one clear and the rest small, however few there are', () => {
    expect(watch(['a', 'b', 'c', 'd', 'e'], { enlarged: 'c' })).toEqual({
      a: 'low',
      b: 'low',
      c: 'high',
      d: 'low',
      e: 'low',
    })
    expect(watch(['a', 'b'], { enlarged: 'a' })).toEqual({ a: 'high', b: 'low' })
  })

  it('gets only small ones when the enlarged tile is me or somebody without a camera', () => {
    expect(watch(['a', 'b'], { enlarged: 'me' })).toEqual({ a: 'low', b: 'low' })
  })

  it('does not get what is off the screen', () => {
    expect(watch(['a', 'b', 'c', 'd'], { visible: ['a', 'b'] })).toEqual({
      a: 'high',
      b: 'high',
      c: 'off',
      d: 'off',
    })
    expect(watch(['a', 'b', 'c'], { enlarged: 'a', visible: ['b'] })).toEqual({
      a: 'off',
      b: 'low',
      c: 'off',
    })
  })

  it('gets only the small tier of what is shown while the call is minimised', () => {
    expect(watch(['a', 'b'], { compact: true, visible: ['b'] })).toEqual({ a: 'off', b: 'low' })
    expect(watch(['a'], { compact: true, enlarged: 'a' })).toEqual({ a: 'low' })
  })

  it('gets only small ones while a shared screen is being watched, enlarged or not', () => {
    expect(watch(['a', 'b'], { screen: true })).toEqual({ a: 'low', b: 'low' })
    expect(watch(['a', 'b', 'c'], { screen: true, enlarged: 'b' })).toEqual({
      a: 'low',
      b: 'low',
      c: 'low',
    })
    // 看不到的照样不收
    expect(watch(['a', 'b'], { screen: true, visible: ['a'] })).toEqual({ a: 'low', b: 'off' })
  })

  it('never asks for more than one clear picture plus small ones, or two clear ones', () => {
    // 带宽就是按这个估的：任何情况下，清楚的最多 2 路，并且有 2 路清楚的时没有别的
    const people = ['a', 'b', 'c', 'd', 'e']
    for (let count = 0; count <= people.length; count += 1) {
      const cameras = people.slice(0, count)
      for (const enlarged of [null, 'me', ...cameras]) {
        const layers = Object.values(watch(cameras, { enlarged }))
        const clear = layers.filter((layer) => layer === 'high').length
        expect(clear).toBeLessThanOrEqual(2)
        if (clear === 2) expect(layers).toHaveLength(2)
      }
    }
  })
})

describe('the picture settings', () => {
  it('takes the bitrates from the administrator and keeps the sizes fixed', () => {
    const settings = groupVideoSettings({
      screen_max_width: 2560,
      screen_max_fps: 15,
      screen_direct_kbps: 6000,
      screen_relay_kbps: 1000,
      camera_relay_kbps: 500,
      group_camera_high_kbps: 600,
      group_camera_low_kbps: 100,
      group_screen_kbps: 1500,
    })
    expect(settings).toEqual({
      high: { width: 640, height: 360, kbps: 600 },
      low: { width: 320, height: 180, kbps: 100 },
      fps: 15,
      // 共享的屏幕：码率跟着设置，大小和帧率是固定的
      screen: { maxWidth: 1920, fps: 10, kbps: 1500 },
    })
  })

  it('estimates what the server sends out at worst, as in chapter 5 of the task list', () => {
    expect(groupVideoEgressKbps(1, 400, 120)).toBe(0)
    expect(groupVideoEgressKbps(3, 400, 120)).toBe(2400)
    expect(groupVideoEgressKbps(4, 400, 120)).toBe(2560)
    expect(groupVideoEgressKbps(6, 400, 120)).toBe(5280)
    expect(groupVideoEgressKbps(10, 400, 120)).toBe(13600)
  })

  it('estimates what a shared screen adds, as in chapter 5 of the F12 task list', () => {
    // 语音通话里共享：只有屏幕，转给其他每一个人
    expect(groupScreenEgressKbps(3, 1000, 120, false)).toBe(2000)
    expect(groupScreenEgressKbps(6, 1000, 120, false)).toBe(5000)
    // 视频通话里共享，别人都开着摄像头：每个看的人再收其他每个人小的一档，共享的人只收小窗里的一路
    expect(groupScreenEgressKbps(3, 1000, 120, true)).toBe(2600)
    expect(groupScreenEgressKbps(4, 1000, 120, true)).toBe(4200)
    expect(groupScreenEgressKbps(6, 1000, 120, true)).toBe(8120)
    // 只有共享的人自己：没有人看
    expect(groupScreenEgressKbps(1, 1000, 120, true)).toBe(0)
  })
})
