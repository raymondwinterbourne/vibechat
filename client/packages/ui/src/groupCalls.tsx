// 群通话的状态在页面里的入口（F10）：登录后创建一份，跟着服务端的推送更新。界面在 pages/calls 里。

import { useQuery } from '@tanstack/react-query'
import { fetchIceServers, GroupCallController, type GroupCallSnapshot } from '@vibechat/core'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { useCall } from './calls'
import { DEVICE_ID } from './device'
import { useConnectionState, useRealtime } from './realtime'
import { useMe } from './session'

const GroupCallContext = createContext<GroupCallController | null>(null)

/** 登录期间维持一份群通话的状态。退出登录时放掉麦克风和连接。 */
export function GroupCallProvider({ children }: { children: ReactNode }) {
  const me = useMe()
  const realtime = useRealtime()
  const connection = useConnectionState()
  const [controller] = useState(() => new GroupCallController({ me: me.id, device: DEVICE_ID }))

  useEffect(
    () => realtime.onEvent((event) => controller.handleEvent(event)),
    [realtime, controller],
  )

  // 每次连上都问一下我所在的群里现在有哪些通话：页面打开前就在进行的、断开期间结束了的
  useEffect(() => {
    if (connection === 'open') void controller.resync()
  }, [connection, controller])

  useEffect(() => () => controller.dispose(), [controller])

  return <GroupCallContext value={controller}>{children}</GroupCallContext>
}

export function useGroupCallController(): GroupCallController {
  const controller = useContext(GroupCallContext)
  if (!controller) throw new Error('useGroupCallController must be used inside GroupCallProvider')
  return controller
}

export function useGroupCalls(): GroupCallSnapshot {
  const controller = useGroupCallController()
  return useSyncExternalStore(controller.subscribe, controller.getState)
}

/** 这台服务器能不能群通话：配置了媒体转发服务才能。 */
export function useGroupCallsAvailable(): boolean {
  const { data } = useQuery({
    queryKey: ['ice-servers'] as const,
    queryFn: ({ signal }) => fetchIceServers({ signal }),
    staleTime: 60 * 60 * 1000,
  })
  return data?.group_calls === true
}

/** 我现在是不是在一个通话里（在这台设备上）：一对一的，或者群里的。一个人同一时间只能在一个通话里。 */
export function useInAnyCall(): boolean {
  const direct = useCall().phase
  const group = useGroupCalls().phase
  return (direct !== 'idle' && direct !== 'ended') || group !== 'idle'
}
