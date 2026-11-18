import { MessageCircle, Settings, Shield, UserRound, Users } from 'lucide-react'

/** 主导航的去处。电脑上的导航栏和手机上的标签栏共用。 */
export const destinations = [
  { to: '/chats', label: 'chats', icon: MessageCircle },
  { to: '/contacts', label: 'contacts', icon: Users },
] as const

/** 管理入口，只有管理员能看到。手机上它在"我"页面里，不占标签栏的位置。 */
export const adminDestination = {
  to: '/admin',
  label: 'admin',
  icon: Shield,
} as const

/** 设置在电脑上叫"设置"，放在导航栏底部；在手机上叫"我"，是第三个标签。 */
export const settingsDestination = {
  to: '/settings',
  desktop: { label: 'settings', icon: Settings },
  mobile: { label: 'me', icon: UserRound },
} as const
