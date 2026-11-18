// 桌面客户端的下载：服务器上有没有可以给这台设备装的版本，以及界面上的几处入口。
//
// 入口有三处，点开都是同一份内容：会话列表顶部的一条提示（只出现一次）、
// 导航栏底部的一个图标（一直在）、设置的"关于"。装不了桌面客户端的设备上都不出现。
//
// 另有桌面端里的几处（U1）：有新版本时会话列表顶部提示一次；某项功能要求更新的桌面客户端时
// 弹出说明；服务器规定了最低版本、这个桌面客户端低于它时，整个页面换成"请更新"。

import { useQuery } from '@tanstack/react-query'
import {
  DESKTOP_DOWNLOAD_PATH,
  desktopTooOld,
  downloadWithProgress,
  fetchDesktopLatest,
  formatFileSize,
  isNewerVersion,
} from '@vibechat/core'
import type { DesktopLatest, DesktopRelease } from '@vibechat/protocol'
import { MonitorDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { usePlatform } from './App'
import { Button } from './components/Button'
import { Dialog } from './components/Dialog'
import { useNoticePromptShown } from './notifications'

/** 提示看过之后记在浏览器里的位置。 */
const PROMPT_KEY = 'vc.desktop-prompt'
/** 桌面端里"有新版本"的提示处理过的那个版本。 */
const UPDATE_PROMPT_KEY = 'vc.desktop-update-prompt'

export interface DesktopOffer {
  release: DesktopRelease
  /** 这台设备上已经装着桌面客户端（现在就在它里面），这是比它新的版本。 */
  update: boolean
}

/**
 * 可以给这台设备下载的桌面客户端。
 * 装不了的设备、服务器上没有安装包、已经装着最新的，都是空。
 */
export function useDesktopOffer(): DesktopOffer | null {
  const platform = usePlatform()
  const release = useDesktopLatest()?.release ?? null
  if (!release) return null
  const installed = platform.version
  if (installed === null) return { release, update: false }
  return isNewerVersion(release.version, installed) ? { release, update: true } : null
}

/** 服务器上现在可以下载哪个版本、要求的最低版本。装不了桌面客户端的设备上不问。 */
function useDesktopLatest(): DesktopLatest | undefined {
  const platform = usePlatform()
  const latest = useQuery({
    queryKey: ['desktop-latest'],
    queryFn: ({ signal }) => fetchDesktopLatest({ signal }),
    enabled: platform.desktopInstallable,
    // 几处入口共用这一次查询。安装包很少换，不用每次都问
    staleTime: 10 * 60 * 1000,
  })
  return latest.data
}

interface DesktopDownloadProps {
  offer: DesktopOffer
  /** 下载是这里最主要的一件事（对话框里）：按钮用醒目的样式。 */
  prominent?: boolean
}

/**
 * 桌面端里下载安装包：桌面端没有浏览器那样的下载栏，所以页面自己下载、显示进度，
 * 下完再交给"存储为"。关掉对话框也接着下，再打开时看得到进度。
 */
type Download =
  | { state: 'idle' }
  | { state: 'downloading'; received: number; total: number; abort: AbortController }
  | { state: 'done' }
  | { state: 'failed' }

const useDownload = create<{ download: Download; set: (download: Download) => void }>((set) => ({
  download: { state: 'idle' },
  set: (download) => set({ download }),
}))

async function downloadInstaller(release: DesktopRelease) {
  const { set } = useDownload.getState()
  const abort = new AbortController()
  set({ state: 'downloading', received: 0, total: release.size, abort })
  try {
    const blob = await downloadWithProgress(DESKTOP_DOWNLOAD_PATH, {
      expectedSize: release.size,
      signal: abort.signal,
      onProgress: ({ received, total }) => set({ state: 'downloading', received, total, abort }),
    })
    // 交给"存储为"：桌面端会问存到哪里，默认在"下载"文件夹
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = release.file_name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    set({ state: 'done' })
  } catch {
    set(abort.signal.aborted ? { state: 'idle' } : { state: 'failed' })
  }
}

/** 版本、大小、下载按钮，以及怎么安装。 */
export function DesktopDownload({ offer, prominent = false }: DesktopDownloadProps) {
  const { t } = useTranslation('settings')
  const platform = usePlatform()
  const download = useDownload((state) => state.download)
  const { release, update } = offer
  const buttonClass = `inline-flex h-11 flex-none items-center justify-center whitespace-nowrap rounded-control px-4 font-medium transition-colors duration-150 md:h-9 ${
    prominent
      ? 'bg-accent text-on-accent hover:opacity-90'
      : 'border border-border bg-bg text-fg hover:bg-hover'
  }`
  // 浏览器自己有下载栏，照常用链接；桌面端里由页面下载、显示进度
  const inApp = platform.name === 'desktop'
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <span data-testid="desktop-offer">
          {t(update ? 'about.desktop.newer' : 'about.desktop.available', {
            version: release.version,
            size: formatFileSize(release.size),
          })}
        </span>
        {!inApp ? (
          <a href={DESKTOP_DOWNLOAD_PATH} download={release.file_name} className={buttonClass}>
            {t('about.desktop.download')}
          </a>
        ) : download.state === 'downloading' ? (
          <Button variant="ghost" onClick={() => download.abort.abort()}>
            {t('about.desktop.cancelDownload')}
          </Button>
        ) : (
          <button
            type="button"
            className={buttonClass}
            onClick={() => void downloadInstaller(release)}
          >
            {download.state === 'failed'
              ? t('about.desktop.retryDownload')
              : t('about.desktop.download')}
          </button>
        )}
      </div>
      {inApp && download.state === 'downloading' && (
        <div className="flex flex-col gap-1" data-testid="desktop-download-progress">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor((download.received / download.total) * 100)}
            className="h-1.5 overflow-hidden rounded-full bg-hover"
          >
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${(download.received / download.total) * 100}%` }}
            />
          </div>
          <span className="text-[12px] text-fg-2 tabular-nums">
            {t('about.desktop.downloading', {
              percent: Math.floor((download.received / download.total) * 100),
              received: formatFileSize(download.received),
              total: formatFileSize(download.total),
            })}
          </span>
        </div>
      )}
      {inApp && download.state === 'done' && (
        <p data-testid="desktop-download-done" role="status" className="text-[12px] text-success">
          {t('about.desktop.downloaded')}
        </p>
      )}
      {inApp && download.state === 'failed' && (
        <p role="alert" className="text-[12px] text-danger">
          {t('about.desktop.downloadFailed')}
        </p>
      )}
      <ul className="flex flex-col gap-1 text-[12px] text-fg-3">
        <li>{t('about.desktop.requirement')}</li>
        {update ? (
          <li>{t('about.desktop.update')}</li>
        ) : (
          <>
            <li>{t('about.desktop.install')}</li>
            <li>{t('about.desktop.firstOpen')}</li>
          </>
        )}
      </ul>
    </>
  )
}

interface DesktopUi {
  /** 下载的对话框是不是开着。 */
  open: boolean
  /** 会话列表顶部的提示已经处理过了：点过"下载"或者"不用了"。 */
  prompted: boolean
  /** 桌面端里"有新版本"的提示处理过的那个版本。服务器上又有更新的版本时再提示。 */
  updatePrompted: string | null
  /** 某项功能要求更新的桌面客户端：正在说明的那一项。 */
  tooOld: { feature: string; required: string } | null
  show: () => void
  hide: () => void
  dismissPrompt: () => void
  dismissUpdatePrompt: (version: string) => void
  explainTooOld: (feature: string, required: string) => void
  closeTooOld: () => void
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存不下来就只在本次打开期间生效
  }
}

const useDesktopUi = create<DesktopUi>((set) => ({
  open: false,
  prompted: readStored(PROMPT_KEY) !== null,
  updatePrompted: readStored(UPDATE_PROMPT_KEY),
  tooOld: null,
  show: () => set({ open: true, tooOld: null }),
  hide: () => set({ open: false }),
  dismissPrompt: () => {
    store(PROMPT_KEY, 'seen')
    set({ prompted: true })
  },
  dismissUpdatePrompt: (version) => {
    store(UPDATE_PROMPT_KEY, version)
    set({ updatePrompted: version })
  },
  explainTooOld: (feature, required) => set({ tooOld: { feature, required } }),
  closeTooOld: () => set({ tooOld: null }),
}))

/**
 * 用到需要新版桌面客户端的功能之前问一下（U1）：返回能不能用。
 * 不能用时弹出说明（要求的版本、现在的版本、下载按钮）。浏览器里总是能用。
 *
 * ```ts
 * const desktopAllows = useDesktopRequirement()
 * if (!desktopAllows(t('call.voice'), '0.2.0')) return
 * ```
 */
export function useDesktopRequirement(): (feature: string, required: string) => boolean {
  const platform = usePlatform()
  const explainTooOld = useDesktopUi((state) => state.explainTooOld)
  return (feature, required) => {
    if (!desktopTooOld(platform.version, required)) return true
    explainTooOld(feature, required)
    return false
  }
}

/** 某项功能要求更新的桌面客户端时的说明。放在页面的最外层。 */
export function DesktopTooOldHost() {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation()
  const platform = usePlatform()
  const latest = useDesktopLatest()
  const { tooOld, closeTooOld } = useDesktopUi()
  const release = latest?.release ?? null
  return (
    <Dialog
      open={tooOld !== null}
      onOpenChange={(next) => !next && closeTooOld()}
      title={t('about.desktop.tooOldTitle')}
    >
      {tooOld && (
        <div data-testid="desktop-too-old" className="flex flex-col gap-3">
          <p>
            {t('about.desktop.tooOld', {
              feature: tooOld.feature,
              required: tooOld.required,
              installed: platform.version ?? '',
            })}
          </p>
          {release && !desktopTooOld(release.version, tooOld.required) ? (
            <DesktopDownload offer={{ release, update: true }} prominent />
          ) : (
            <p className="text-fg-2">{t('about.desktop.noInstaller')}</p>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="ghost" onClick={closeTooOld}>
          {tCommon('actions.close')}
        </Button>
      </div>
    </Dialog>
  )
}

/**
 * 服务器规定了桌面客户端的最低版本、这个桌面客户端低于它时，整个页面换成"请更新桌面客户端"（U1）。
 * 浏览器里、没有规定时，照常显示 `children`。
 */
export function DesktopGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation('settings')
  const platform = usePlatform()
  const latest = useDesktopLatest()
  const required = latest?.min_version ?? null
  if (!desktopTooOld(platform.version, required)) return children
  const release = latest?.release ?? null
  return (
    <div className="grid h-dvh place-items-center bg-bg p-4 text-fg">
      <div
        data-testid="desktop-update-required"
        className="flex w-full max-w-[440px] flex-col gap-4 rounded-card border border-border p-6"
      >
        <h1 className="font-medium text-[17px]">{t('about.desktop.mustUpdateTitle')}</h1>
        <p>
          {t('about.desktop.mustUpdate', {
            required: required ?? '',
            installed: platform.version ?? '',
          })}
        </p>
        {release && !desktopTooOld(release.version, required) ? (
          <DesktopDownload offer={{ release, update: true }} prominent />
        ) : (
          <p className="text-fg-2">{t('about.desktop.noInstaller')}</p>
        )}
      </div>
    </div>
  )
}

/** 下载的对话框。放在页面的最外层，几处入口打开的都是它。 */
export function DesktopDialogHost() {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation()
  const offer = useDesktopOffer()
  const { open, hide } = useDesktopUi()
  if (!offer) return null
  return (
    <Dialog open={open} onOpenChange={(next) => !next && hide()} title={t('about.desktop.title')}>
      <div data-testid="desktop-dialog" className="flex flex-col gap-3">
        <DesktopDownload offer={offer} prominent />
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" onClick={hide}>
          {tCommon('actions.close')}
        </Button>
      </div>
    </Dialog>
  )
}

/**
 * 会话列表顶部的一条提示：告诉在浏览器里用的人有桌面客户端。
 * 点过"下载"或者"不用了"之后不再出现；之后从导航栏的图标或者设置里随时可以下载。
 * 桌面端里有新版本时，这里提示一次那个版本（U1）；导航栏图标的小红点一直在，直到装上新版本。
 */
export function DesktopPrompt() {
  const { t } = useTranslation('settings')
  const { t: tChats } = useTranslation('chats')
  const offer = useDesktopOffer()
  const { prompted, updatePrompted, show, dismissPrompt, dismissUpdatePrompt } = useDesktopUi()
  // 一次只问一件事：还在问要不要开通知的时候，这一条先等着
  const askingAboutNotices = useNoticePromptShown()
  if (!offer || askingAboutNotices) return null
  // 桌面端里有新版本：每个版本提示一次。导航栏图标的小红点一直在，直到装上新版本
  if (offer.update) {
    const version = offer.release.version
    if (updatePrompted === version) return null
    return (
      <div
        data-testid="desktop-update-prompt"
        className="mx-3 mt-3 flex flex-col gap-2 rounded-card border border-border bg-bg p-3 text-[12px]"
      >
        <p className="text-fg-2">{t('about.desktop.updatePrompt', { version })}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dismissUpdatePrompt(version)}>
            {t('about.desktop.later')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              dismissUpdatePrompt(version)
              show()
            }}
          >
            {t('about.desktop.download')}
          </Button>
        </div>
      </div>
    )
  }
  if (prompted) return null
  return (
    <div
      data-testid="desktop-prompt"
      className="mx-3 mt-3 flex flex-col gap-2 rounded-card border border-border bg-bg p-3 text-[12px]"
    >
      <p className="text-fg-2">{t('about.desktop.prompt')}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={dismissPrompt}>
          {tChats('notice.dismiss')}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            dismissPrompt()
            show()
          }}
        >
          {t('about.desktop.download')}
        </Button>
      </div>
    </div>
  )
}

/**
 * 导航栏底部的图标。浏览器里是"下载桌面客户端"；
 * 桌面端里只在服务器上有更新的版本时出现，带一个小红点。
 */
export function DesktopRailEntry() {
  const { t } = useTranslation('settings')
  const offer = useDesktopOffer()
  const show = useDesktopUi((state) => state.show)
  if (!offer) return null
  const label = t(offer.update ? 'about.desktop.entryUpdate' : 'about.desktop.entry')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="desktop-entry"
      onClick={show}
      className="relative grid size-9 place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg"
    >
      <MonitorDown size={20} strokeWidth={1.5} aria-hidden />
      {offer.update && (
        <span
          data-testid="desktop-entry-dot"
          aria-hidden
          className="absolute top-1 right-1 size-2 rounded-full bg-danger"
        />
      )}
    </button>
  )
}
