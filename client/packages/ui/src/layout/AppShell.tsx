import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Outlet, useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect } from 'react'
import { usePlatform } from '../App'
import { CallProvider } from '../calls'
import { ChatProvider } from '../chat'
import { ContactsSync } from '../contacts'
import { DesktopDialogHost, DesktopGate, DesktopTooOldHost } from '../desktopClient'
import { GroupCallProvider } from '../groupCalls'
import { NotificationsHost } from '../notifications'
import { CallLayer } from '../pages/calls/CallLayer'
import { GroupCallLayer } from '../pages/calls/GroupCallLayer'
import { SearchHost } from '../pages/chats/SearchPanel'
import { adoptAccountPreferences } from '../preferences'
import { RealtimeProvider, useConnectionState, useRealtime } from '../realtime'
import { ReleaseNotesHost } from '../releases'
import { meQuery } from '../session'
import { ConnectionBanner } from './ConnectionBanner'
import { NavRail } from './NavRail'
import { TabBar } from './TabBar'
import { UpdateBanner } from './UpdateBanner'

/** 让本页面的登录状态和资料与服务端保持一致。不显示任何东西。 */
function SessionSync() {
  const queryClient = useQueryClient()
  const realtime = useRealtime()
  const connection = useConnectionState()

  // 自己的资料在别处被改了：直接用推来的最新内容
  useEffect(
    () =>
      realtime.onEvent((event) => {
        if (event.type === 'me.updated') queryClient.setQueryData(meQuery.queryKey, event.data)
      }),
    [realtime, queryClient],
  )

  // 连接断了可能只是网络问题，也可能是登录已经失效（服务端会主动断开失效登录的连接）。
  // 重新取一次自己的资料就知道是哪一种
  useEffect(() => {
    if (connection === 'reconnecting') {
      void queryClient.invalidateQueries({ queryKey: meQuery.queryKey })
    }
  }, [connection, queryClient])

  return null
}

/** 桌面端发来的指令：菜单里点了"设置…"；电脑刚唤醒，要立即重连。浏览器里没有这些。 */
function PlatformCommands() {
  const platform = usePlatform()
  const realtime = useRealtime()
  const navigate = useNavigate()
  useEffect(
    () =>
      platform.onCommand((command) => {
        if (command === 'open-settings') void navigate({ to: '/settings' })
        else realtime.reconnectNow()
      }),
    [platform, realtime, navigate],
  )
  return null
}

/** 页面的最外层。带着实时连接此刻的状态，排查问题和测试时看得到。 */
function Frame({ children }: { children: ReactNode }) {
  const connection = useConnectionState()
  return (
    <div data-connection={connection} className="flex h-dvh flex-col bg-bg text-fg md:flex-row">
      {children}
    </div>
  )
}

/**
 * 登录后的页面框架。电脑上从左到右是导航栏、列表、内容；
 * 手机上是单栏，导航变成底部的标签栏。两种布局是同一套组件，只由屏幕宽度决定。
 */
export function AppShell() {
  const { data: me } = useQuery(meQuery)

  // 账号里保存的语言和外观生效；在别处改了之后这里也跟着变
  const language = me?.language ?? null
  const theme = me?.theme ?? null
  useEffect(() => {
    adoptAccountPreferences({ language, theme })
  }, [language, theme])

  // 登录失效了（在别处退出、改了密码或被禁用）：让路由重新判断，它会带用户去登录页
  const router = useRouter()
  const loggedOut = me === null
  useEffect(() => {
    if (loggedOut) void router.invalidate()
  }, [loggedOut, router])

  // 手机上进入会话后会话占满整屏，不显示底部的标签栏。管理员查看聊天内容的那一页也一样
  const inConversation = useLocation({
    select: (location) => /^\/(admin\/)?chats\/[^/]+/.test(location.pathname),
  })

  // Ctrl/⌘ 加逗号：打开设置
  const navigate = useNavigate()
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault()
        void navigate({ to: '/settings' })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  // 跳转完成前不显示任何内容
  if (!me) return null

  return (
    <DesktopGate>
      <RealtimeProvider>
        <SessionSync />
        <PlatformCommands />
        <ContactsSync />
        <ChatProvider>
          <CallProvider>
            <GroupCallProvider>
              <Frame>
                <ConnectionBanner />
                <UpdateBanner />
                <NavRail />
                <main className="flex min-h-0 min-w-0 flex-1">
                  <Outlet />
                </main>
                {!inConversation && <TabBar />}
              </Frame>
              <SearchHost />
              <DesktopDialogHost />
              <DesktopTooOldHost />
              <ReleaseNotesHost />
              <NotificationsHost />
              <CallLayer />
              <GroupCallLayer />
            </GroupCallProvider>
          </CallProvider>
        </ChatProvider>
      </RealtimeProvider>
    </DesktopGate>
  )
}
