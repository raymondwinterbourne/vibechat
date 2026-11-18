// 更新说明的对话框（U1 第 7 章）：刷新或重新打开之后，有没看过的更新说明就弹出来；
// 设置的"关于"里随时可以翻看全部。看过的最新一条按用户记在这个浏览器里。

import { firstReleases, type Release, unseenReleases, visibleReleases } from '@vibechat/core'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { Button } from './components/Button'
import { Dialog } from './components/Dialog'
import { RELEASE_NOTES } from './releaseNotes'
import { useMe } from './session'
import { toast } from './toast'

/** 点了"点这里刷新"：刷新之后要告诉他更新好了。只在这一次刷新里有效。 */
const RELOADED_KEY = 'vc.reloaded-for-update'

// 2026-10-15 改过名字：第一版把点了旧页面"点这里刷新"的人误记成了"都看过了"，换个名字重新判断一次
const seenKey = (userId: string) => `vc.releases-seen.${userId}`

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

function write(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key)
    else storage().setItem(key, value)
  } catch {
    // 存不下来就只在本次打开期间生效
  }
}

/** 点了"点这里刷新"，马上要重新载入页面。 */
export function reloadForUpdate() {
  write(() => sessionStorage, RELOADED_KEY, '1')
  window.location.reload()
}

interface ReleaseDialog {
  /** 正在显示的更新说明；为空时对话框关着。 */
  shown: Release[] | null
  /** 是刚更新完弹出来的（标题是"已更新到最新版本"），还是从"关于"里打开看全部的。 */
  justUpdated: boolean
  show: (releases: Release[], justUpdated: boolean) => void
  close: () => void
}

const useReleaseDialog = create<ReleaseDialog>((set) => ({
  shown: null,
  justUpdated: false,
  show: (releases, justUpdated) => set({ shown: releases, justUpdated }),
  close: () => set({ shown: null }),
}))

/** 设置的"关于"里的"更新说明"：全部历史。 */
export function useShowAllReleases(): () => void {
  const me = useMe()
  const show = useReleaseDialog((state) => state.show)
  return () => show(visibleReleases(RELEASE_NOTES, me.role === 'admin'), false)
}

/** 放在登录后的页面最外层：打开时看一次有没有没看过的更新说明。 */
export function ReleaseNotesHost() {
  const { t, i18n } = useTranslation()
  const me = useMe()
  const { shown, justUpdated, show, close } = useReleaseDialog()
  const latest = RELEASE_NOTES[0]?.id ?? null

  useEffect(() => {
    const reloaded = read(() => sessionStorage, RELOADED_KEY) !== null
    write(() => sessionStorage, RELOADED_KEY, null)
    const seen = read(() => localStorage, seenKey(me.id))
    const admin = me.role === 'admin'
    // 这个浏览器里还没有记下他看过哪一条：按注册时间判断，最新的说明在他注册之后才弹
    const unseen =
      seen !== null
        ? unseenReleases(RELEASE_NOTES, seen, admin)
        : firstReleases(RELEASE_NOTES, me.created_at, admin)
    if (seen === null && latest !== null) write(() => localStorage, seenKey(me.id), latest)
    if (unseen.length > 0) show(unseen, true)
    else if (reloaded) toast.success(t('releases.upToDate'))
  }, [me.id, me.role, me.created_at, latest, show, t])

  function done() {
    if (latest !== null) write(() => localStorage, seenKey(me.id), latest)
    close()
  }

  const chinese = i18n.language.startsWith('zh')
  return (
    <Dialog
      open={shown !== null}
      onOpenChange={(open) => !open && done()}
      title={justUpdated ? t('releases.updated') : t('releases.title')}
      large
      // 底部的"知道了"就是关掉它的按钮，右上角不再放一个
      closeButton={false}
    >
      <div
        data-testid="release-notes"
        className="-mx-5 flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5"
      >
        {shown?.map((release) => (
          <section key={release.id} data-testid="release" className="flex flex-col gap-1.5">
            <h3 className="text-[12px] text-fg-3">{release.id}</h3>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {release.items.map((item) => (
                <li key={item.en}>{chinese ? item.zh : item.en}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="flex justify-end">
        <Button variant="primary" onClick={done}>
          {t('releases.gotIt')}
        </Button>
      </div>
    </Dialog>
  )
}
