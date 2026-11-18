import { type ConnectionState, RealtimeClient } from '@vibechat/core'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { DEVICE_ID } from './device'
import { signedOutElsewhere } from './session'

const RealtimeContext = createContext<RealtimeClient | null>(null)

function websocketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // 带上设备编号：通话的连接信息只推给通话里的那一台设备
  return `${scheme}//${window.location.host}/ws?device=${DEVICE_ID}`
}

/** 在整个应用的生命周期里维持一条 WebSocket 连接。 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new RealtimeClient({ url: websocketUrl }))

  useEffect(() => {
    client.start()
    return () => client.stop()
  }, [client])

  // 这台设备在我的另一台设备上被退出登录了（F9）：回到登录页，说明原因
  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.type === 'sys.signed_out') signedOutElsewhere()
      }),
    [client],
  )

  return <RealtimeContext value={client}>{children}</RealtimeContext>
}

/** 取得 WebSocket 客户端，用来订阅服务端推来的事件。 */
export function useRealtime(): RealtimeClient {
  const client = useContext(RealtimeContext)
  if (!client) throw new Error('useRealtime must be used inside RealtimeProvider')
  return client
}

export function useConnectionState(): ConnectionState {
  const client = useRealtime()
  return useSyncExternalStore(
    (onChange) => client.subscribe(onChange),
    () => client.state,
  )
}
