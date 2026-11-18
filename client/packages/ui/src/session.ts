// 登录状态。当前用户的资料放在查询缓存里，键是 ['me']；没有登录时它是 null。

import {
  MutationCache,
  QueryCache,
  QueryClient,
  queryOptions,
  useQuery,
} from '@tanstack/react-query'
import { ApiError, browserOutbox, fetchMe } from '@vibechat/core'
import type { Me } from '@vibechat/protocol'

export const meQuery = queryOptions({
  queryKey: ['me'] as const,
  queryFn: ({ signal }) => fetchMe({ signal }),
  // 资料的变化由推送和显式的刷新带来，不需要定时重新获取
  staleTime: Number.POSITIVE_INFINITY,
})

let onSessionChanged: () => void = () => {}

/** 登录状态在别处发生变化后要做的事（重新判断当前页面还能不能看）。由路由注册。 */
export function setSessionChangedHandler(handler: () => void): void {
  onSessionChanged = handler
}

// 登录可能在别处失效：在另一个窗口退出了、改了密码、被管理员禁用或重置了密码。
// 这之后任何接口都会开始返回下面这两种错误，据此更新登录状态。
function watchForSessionLoss(error: unknown): void {
  if (!(error instanceof ApiError)) return
  if (error.code === 'unauthorized') {
    queryClient.setQueryData(meQuery.queryKey, null)
    forgetUserData()
    onSessionChanged()
  } else if (error.code === 'must_change_password') {
    void queryClient.refetchQueries({ queryKey: meQuery.queryKey }).then(onSessionChanged)
  }
}

/** 在登录页上说明"这台设备已在别处被退出登录"的记号。存在这个标签页里，刷新也还在，看过就清掉。 */
const SIGNED_OUT_KEY = 'vc-signed-out-elsewhere'

/**
 * 这台设备在我的另一台设备上被退出登录了（F9，推送 `sys.signed_out`）：
 * 和登录失效一样回到登录页，并且在那里说明原因。
 */
export function signedOutElsewhere(): void {
  try {
    sessionStorage.setItem(SIGNED_OUT_KEY, '1')
  } catch {
    // 存不了就不说明原因，照样回到登录页
  }
  queryClient.setQueryData(meQuery.queryKey, null)
  forgetUserData()
  onSessionChanged()
}

/** 登录页上要不要说明"已在别处被退出登录"。看过一次就不再说。 */
export function takeSignedOutNotice(): boolean {
  try {
    const signedOut = sessionStorage.getItem(SIGNED_OUT_KEY) === '1'
    sessionStorage.removeItem(SIGNED_OUT_KEY)
    return signedOut
  } catch {
    return false
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: watchForSessionLoss }),
  mutationCache: new MutationCache({ onError: watchForSessionLoss }),
  defaultOptions: {
    // 失败就直接显示出来，由用户决定是否重试
    queries: { retry: false },
  },
})

/** 这个浏览器里保存没有发出去的消息的地方。 */
export const outbox = browserOutbox()

/**
 * 登录结束之后调用：上一个用户的好友、申请等数据不留在内存里，也不会被下一个登录的人看到；
 * 保存在这台设备上的、没有发出去的消息也一并清掉。
 */
export function forgetUserData(): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' })
  outbox.clear().catch(() => {})
}

/** 当前登录的用户。只能在登录后才显示的页面里使用。 */
export function useMe(): Me {
  const { data } = useQuery(meQuery)
  if (!data) throw new Error('useMe was used on a page that does not require login')
  return data
}

/** 登录成功后要去的地址。只接受站内的路径，不让登录页被用来跳去别的网站。 */
export function safeRedirect(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined
  if (!target.startsWith('/') || target.startsWith('//')) return undefined
  if (target.startsWith('/login') || target.startsWith('/register')) return undefined
  return target
}
