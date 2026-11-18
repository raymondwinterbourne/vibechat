import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type ErrorComponentProps,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from './components/Button'
import { useErrorMessage } from './errors'
import { AppShell } from './layout/AppShell'
import { AuthLayout } from './layout/AuthLayout'
import { AdminGroupsPage } from './pages/admin/AdminGroupsPage'
import { AdminLayout } from './pages/admin/AdminLayout'
import { AuditPage } from './pages/admin/AuditPage'
import { ChatRecordsPage } from './pages/admin/ChatRecordsPage'
import { ChatViewerPage } from './pages/admin/ChatViewerPage'
import { InviteCodesPage } from './pages/admin/InviteCodesPage'
import { OverviewPage } from './pages/admin/OverviewPage'
import { SystemSettingsPage } from './pages/admin/SystemSettingsPage'
import { UsersPage } from './pages/admin/UsersPage'
import { ChangePasswordPage } from './pages/auth/ChangePasswordPage'
import { ConfirmEmailPage } from './pages/auth/ConfirmEmailPage'
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage'
import { LoginPage } from './pages/auth/LoginPage'
import { RegisterPage } from './pages/auth/RegisterPage'
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage'
import { CallCheckPage } from './pages/CallCheckPage'
import { ChatsPage, ChatsPlaceholder } from './pages/chats/ChatsPage'
import { ConversationPane } from './pages/chats/ConversationPane'
import { ContactsPage, ContactsPlaceholder } from './pages/contacts/ContactsPage'
import { FriendPane } from './pages/contacts/FriendPane'
import { GroupsPane } from './pages/contacts/GroupsPane'
import { RequestsPane } from './pages/contacts/RequestsPane'
import { GroupCallCheckPage } from './pages/GroupCallCheckPage'
import { SettingsPage } from './pages/SettingsPage'
import { meQuery, queryClient, safeRedirect, setSessionChangedHandler } from './session'

interface RouterContext {
  queryClient: QueryClient
}

/** 页面打不开时显示的内容，例如一打开就连不上服务器。 */
function LoadError({ error }: ErrorComponentProps) {
  const { t } = useTranslation()
  const errorMessage = useErrorMessage()
  const router = useRouter()

  async function retry() {
    await queryClient.resetQueries()
    await router.invalidate()
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="font-medium text-[17px]">{t('loadFailed')}</p>
      <p role="alert" className="text-fg-2">
        {errorMessage(error)}
      </p>
      <Button variant="primary" onClick={retry}>
        {t('actions.retry')}
      </Button>
    </div>
  )
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  errorComponent: LoadError,
})

// ---------- 还没有登录时的页面 ----------

const authLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  component: AuthLayout,
})

/** 已经登录的人不该看到登录和注册页：带他去原本要去的页面。 */
async function leaveIfLoggedIn(context: RouterContext, redirectTo: unknown) {
  const me = await context.queryClient.ensureQueryData(meQuery)
  if (!me) return
  if (me.must_change_password) throw redirect({ to: '/change-password' })
  // 地址栏里的参数是任何人都可以构造的，必须在使用的地方校验：只去站内的路径。
  // 不能依赖 validateSearch，路由会把没有通过校验的原始参数一并交过来
  const target = safeRedirect(redirectTo)
  if (target) throw redirect({ href: target })
  throw redirect({ to: '/chats' })
}

const loginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/login',
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const target = safeRedirect(search.redirect)
    return target ? { redirect: target } : {}
  },
  beforeLoad: ({ context, search }) => leaveIfLoggedIn(context, search.redirect),
})

const registerRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/register',
  component: RegisterPage,
  beforeLoad: ({ context }) => leaveIfLoggedIn(context, undefined),
})

const changePasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/change-password',
  component: ChangePasswordPage,
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (!me) throw redirect({ to: '/login' })
    if (!me.must_change_password) throw redirect({ to: '/chats' })
  },
})

/** 邮件里的链接带着的令牌。 */
function tokenSearch(search: Record<string, unknown>): { token?: string } {
  const token = typeof search.token === 'string' ? search.token.trim() : ''
  return token ? { token } : {}
}

// 管理员找回密码的三个页面。后两个是从邮件里点进来的，不管登录没登录都能打开
const forgotPasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/forgot-password',
  component: ForgotPasswordPage,
  beforeLoad: ({ context }) => leaveIfLoggedIn(context, undefined),
})

const resetPasswordRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/reset-password',
  component: ResetPasswordPage,
  validateSearch: tokenSearch,
})

const confirmEmailRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/confirm-email',
  component: ConfirmEmailPage,
  validateSearch: tokenSearch,
})

// ---------- 登录后的页面 ----------

const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppShell,
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (!me) {
      // 记下原本要去的页面，登录后回到那里
      const target = safeRedirect(location.href)
      throw redirect({ to: '/login', search: target ? { redirect: target } : {} })
    }
    if (me.must_change_password) throw redirect({ to: '/change-password' })
    return { me }
  },
})

const indexRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/chats' })
  },
})

const chatsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/chats',
  component: ChatsPage,
})

// 聊天右侧的内容：什么也没打开，或者某一个会话
const chatsIndexRoute = createRoute({
  getParentRoute: () => chatsRoute,
  path: '/',
  component: ChatsPlaceholder,
})

const conversationRoute = createRoute({
  getParentRoute: () => chatsRoute,
  path: '$conversationId',
  component: ConversationPane,
  // 从搜索结果点进来时带着：`m` 是要跳到的那条消息的序号，
  // `find` 是要在这个会话里接着搜的关键词
  validateSearch: (search: Record<string, unknown>): { m?: number; find?: string } => {
    const seq = Number(search.m)
    const find = typeof search.find === 'string' ? search.find.trim().slice(0, 50) : ''
    return {
      ...(Number.isInteger(seq) && seq > 0 ? { m: seq } : {}),
      ...(find ? { find } : {}),
    }
  },
})

const contactsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/contacts',
  component: ContactsPage,
})

// 通讯录右侧的内容：什么也没选、"新的朋友"、"群聊"、某一位好友
const contactsIndexRoute = createRoute({
  getParentRoute: () => contactsRoute,
  path: '/',
  component: ContactsPlaceholder,
})

const friendRequestsRoute = createRoute({
  getParentRoute: () => contactsRoute,
  path: 'new',
  component: RequestsPane,
})

const groupsRoute = createRoute({
  getParentRoute: () => contactsRoute,
  path: 'groups',
  component: GroupsPane,
})

const friendRoute = createRoute({
  getParentRoute: () => contactsRoute,
  path: '$userId',
  component: FriendPane,
})

const settingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/settings',
  component: SettingsPage,
})

// 通话的技术验证页面（F3）：界面上没有入口，只能输入地址打开
const callCheckRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/call-check',
  component: CallCheckPage,
})

// 群通话的技术验证页面（F10）：同样没有入口
const groupCallCheckRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/group-call-check',
  component: GroupCallCheckPage,
})

// ---------- 管理 ----------

const adminRoute = createRoute({
  getParentRoute: () => appLayout,
  path: '/admin',
  component: AdminLayout,
  // 界面上普通用户看不到入口；直接输入地址也进不来。真正的权限检查在服务端
  beforeLoad: ({ context }) => {
    if (context.me.role !== 'admin') throw redirect({ to: '/chats' })
  },
})

// 地址停在 /admin 上：电脑上右边显示概况，手机上只显示管理的导航
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: OverviewPage,
})

const adminOverviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'overview',
  component: OverviewPage,
})

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'users',
  component: UsersPage,
})

const inviteCodesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'invite-codes',
  component: InviteCodesPage,
})

const adminChatsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'chats',
  component: ChatRecordsPage,
  // `user` 是要看谁参与的会话
  validateSearch: (search: Record<string, unknown>): { user?: string } => {
    const user = typeof search.user === 'string' ? search.user.trim() : ''
    return /^[0-9a-f-]{36}$/i.test(user) ? { user } : {}
  },
})

const adminViewerRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'chats/$conversationId',
  component: ChatViewerPage,
})

const adminGroupsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'groups',
  component: AdminGroupsPage,
})

const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'settings',
  component: SystemSettingsPage,
})

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'audit',
  component: AuditPage,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    authLayout.addChildren([
      loginRoute,
      registerRoute,
      changePasswordRoute,
      forgotPasswordRoute,
      resetPasswordRoute,
      confirmEmailRoute,
    ]),
    appLayout.addChildren([
      indexRoute,
      chatsRoute.addChildren([chatsIndexRoute, conversationRoute]),
      contactsRoute.addChildren([
        contactsIndexRoute,
        friendRequestsRoute,
        groupsRoute,
        friendRoute,
      ]),
      settingsRoute,
      callCheckRoute,
      groupCallCheckRoute,
      adminRoute.addChildren([
        adminIndexRoute,
        adminOverviewRoute,
        adminUsersRoute,
        inviteCodesRoute,
        adminChatsRoute,
        adminViewerRoute,
        adminGroupsRoute,
        adminSettingsRoute,
        adminAuditRoute,
      ]),
    ]),
  ]),
  context: { queryClient },
})

// 登录在别处失效时，重新判断当前页面还能不能看
setSessionChangedHandler(() => {
  void router.invalidate()
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
