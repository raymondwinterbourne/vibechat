// 通话的状态在页面里的入口：登录后创建一份，跟着服务端的推送更新。界面在 pages/calls 里。

import { useQuery } from '@tanstack/react-query'
import { CallController, type CallSnapshot, fetchIceServers } from '@vibechat/core'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { usePlatform } from './App'
import { DEVICE_ID } from './device'
import { useConnectionState, useRealtime } from './realtime'
import { useMe } from './session'

/** 视频通话要求的桌面客户端版本：0.2.0 及以前的桌面端不放行摄像头（F5 Q6）。 */
export const VIDEO_DESKTOP_VERSION = '0.3.0'

/** 共享屏幕要求的桌面客户端版本：0.3.0 及以前的桌面端不放行屏幕的画面（F7 Q9）。 */
export const SCREEN_DESKTOP_VERSION = '0.4.0'

const CallContext = createContext<CallController | null>(null)

/** 登录期间维持一份通话状态。退出登录时放掉麦克风和连接。 */
export function CallProvider({ children }: { children: ReactNode }) {
  const me = useMe()
  const realtime = useRealtime()
  const connection = useConnectionState()
  const platform = usePlatform()
  const [controller] = useState(
    () =>
      new CallController({
        me: me.id,
        device: DEVICE_ID,
        screenAccess: () => platform.screenAccess(),
      }),
  )

  useEffect(
    () => realtime.onEvent((event) => controller.handleEvent(event)),
    [realtime, controller],
  )

  // 每次连上都问一下现在的通话：页面打开前就在响铃的来电、断开期间结束了的通话
  useEffect(() => {
    if (connection === 'open') void controller.resync()
  }, [connection, controller])

  useEffect(() => () => controller.dispose(), [controller])

  return <CallContext value={controller}>{children}</CallContext>
}

export function useCallController(): CallController {
  const controller = useContext(CallContext)
  if (!controller) throw new Error('useCallController must be used inside CallProvider')
  return controller
}

export function useCall(): CallSnapshot {
  const controller = useCallController()
  return useSyncExternalStore(controller.subscribe, controller.getState)
}

/** 有没有配置中转服务。没有时不能打电话（连不上的情况太多）。 */
export function useCallsAvailable(): boolean {
  const { data } = useQuery({
    queryKey: ['ice-servers'] as const,
    queryFn: ({ signal }) => fetchIceServers({ signal }),
    staleTime: 60 * 60 * 1000,
  })
  return (data?.ice_servers.length ?? 0) > 0
}
