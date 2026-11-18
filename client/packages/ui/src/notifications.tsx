// 系统通知和页面标题上的未读数。
//
// 通知由打开着的页面弹出：页面不在前台时，有新消息或好友申请就弹一条，点击回到对应的地方。
// 什么时候该弹的规则在 `@vibechat/core` 里，这里只管和浏览器打交道。

import { useNavigate } from '@tanstack/react-router'
import {
  noticesOn,
  noticeTag,
  shouldNotifyMessage,
  shouldNotifyRequest,
  titleWithUnread,
  totalUnread,
} from '@vibechat/core'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { usePlatform } from './App'
import { useChatState, useChatStore } from './chat'
import { Button } from './components/Button'
import { displayName, summarize } from './pages/chats/text'
import { useRealtime } from './realtime'
import { useMe } from './session'

// 用户的选择保存在这台设备的浏览器里：授权本来就是每个浏览器各给各的
const CHOICE_KEY = 'vc.notify'
const FRIEND_REQUEST_TAG = 'vc-friend-request'

/** 用户选了开、选了关，还是还没有选过。 */
type Choice = 'on' | 'off' | null

/** 浏览器这边的情况：不支持，或者授权的状态。 */
export type NoticeSupport = 'unsupported' | NotificationPermission

function readChoice(): Choice {
  try {
    const saved = localStorage.getItem(CHOICE_KEY)
    return saved === 'on' || saved === 'off' ? saved : null
  } catch {
    return null
  }
}

function support(): NoticeSupport {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

interface NoticeState {
  choice: Choice
  support: NoticeSupport
  /** 开启。需要的话向浏览器请求授权；用户在那里拒绝了就开不了。 */
  enable: () => Promise<void>
  /** 关闭，或者表示"不用了"。 */
  disable: () => void
}

export const useNotices = create<NoticeState>((set) => {
  function choose(choice: Choice) {
    try {
      if (choice) localStorage.setItem(CHOICE_KEY, choice)
    } catch {
      // 存不下来就只在本次打开期间生效
    }
    set({ choice, support: support() })
  }
  return {
    choice: readChoice(),
    support: support(),
    enable: async () => {
      if (support() === 'unsupported') return
      // 用户点了"开启"之后才问浏览器，不在页面一打开时就问
      if (Notification.permission === 'default') await Notification.requestPermission()
      choose(Notification.permission === 'granted' ? 'on' : readChoice())
    },
    disable: () => choose('off'),
  }
})

/** 系统通知现在是不是开着：用户的选择、系统的授权，加上平台的默认值。 */
export function useNoticesOn(): boolean {
  const platform = usePlatform()
  return useNotices((state) =>
    noticesOn(state.choice, state.support === 'granted', platform.noticesOnByDefault),
  )
}

/** 页面此刻是不是在前台：标签页看得见，并且窗口有焦点。 */
export function inForeground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** 登录期间：让页面标题带上未读数，并在该弹通知的时候弹。不显示任何东西。 */
export function NotificationsHost() {
  const { t } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const navigate = useNavigate()
  const realtime = useRealtime()
  const store = useChatStore()
  const me = useMe()
  const platform = usePlatform()
  const enabled = useNoticesOn()
  const conversations = useChatState((state) => state.conversations)
  // 还开着的通知，按会话。会话读过之后收起
  const open = useRef(new Map<string, Notification>())

  const appName = tCommon('appName')
  const unread = totalUnread(conversations ?? [])
  useEffect(() => {
    document.title = titleWithUnread(unread, appName)
    // 桌面端同时显示在程序坞的图标上
    platform.setUnreadCount(unread)
    return () => {
      document.title = appName
      platform.setUnreadCount(0)
    }
  }, [unread, appName, platform])

  useEffect(() => {
    for (const [id, notice] of open.current) {
      const conversation = conversations?.find((item) => item.id === id)
      if (conversation && conversation.unread === 0) {
        notice.close()
        open.current.delete(id)
      }
    }
  }, [conversations])

  // 每次渲染都换成最新的，订阅本身不用跟着重来
  const latest = useRef({ t, navigate, store, enabled, platform })
  latest.current = { t, navigate, store, enabled, platform }

  useEffect(
    () =>
      realtime.onEvent((event) => {
        const { t, navigate, store, enabled, platform } = latest.current
        if (!enabled) return
        const foreground = inForeground()

        if (event.type === 'msg.new') {
          const message = event.data
          const id = message.conversation_id
          const conversation = store.conversation(id)
          if (!shouldNotifyMessage(message, conversation, me.id, foreground)) return
          // 刚被拉进一个群时还不知道它叫什么：用发送人的名字
          const title = conversation
            ? displayName(conversation, t)
            : (message.sender_name ?? appName)
          const body = conversation
            ? summarize(message, conversation, store.getState().members[id], me.id, t)
            : (message.text ?? '')
          const notice = new Notification(title, { body, tag: noticeTag(id) })
          notice.onclick = () => {
            platform.showWindow()
            notice.close()
            void navigate({ to: '/chats/$conversationId', params: { conversationId: id } })
          }
          open.current.set(id, notice)
        } else if (event.type === 'contact.request') {
          const request = event.data
          if (!shouldNotifyRequest(request, foreground)) return
          const greeting = request.message ? `: ${request.message}` : ''
          const notice = new Notification(request.user.nickname, {
            body: `${t('notice.friendRequest')}${greeting}`,
            tag: FRIEND_REQUEST_TAG,
          })
          notice.onclick = () => {
            platform.showWindow()
            notice.close()
            void navigate({ to: '/contacts/new' })
          }
        }
      }),
    [realtime, me.id, appName],
  )

  // 退出登录时把还开着的通知都收起
  useEffect(() => {
    const notices = open.current
    return () => {
      for (const notice of notices.values()) notice.close()
      notices.clear()
    }
  }, [])

  return null
}

/** 下面那条提示此刻是不是显示着。别的提示看它来决定要不要先等一等。 */
export function useNoticePromptShown(): boolean {
  return useNotices((state) => state.choice === null && state.support === 'default')
}

/**
 * 聊天页顶部的一条提示：还没有决定过要不要系统通知的人，在这里开启或者说"不用了"。
 * 说过一次之后不再出现；之后在设置里随时可以改。
 */
export function NoticePrompt() {
  const { t } = useTranslation('chats')
  const { enable, disable } = useNotices()
  if (!useNoticePromptShown()) return null
  return (
    <div
      data-testid="notice-prompt"
      className="mx-3 mt-3 flex flex-col gap-2 rounded-card border border-border bg-bg p-3 text-[12px]"
    >
      <p className="text-fg-2">{t('notice.prompt')}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={disable}>
          {t('notice.dismiss')}
        </Button>
        <Button variant="primary" onClick={() => void enable()}>
          {t('notice.enable')}
        </Button>
      </div>
    </div>
  )
}
