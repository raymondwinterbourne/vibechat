import { fetchBuildId, UpdateChecker } from '@vibechat/core'
import { X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { pageBuild } from '../build'
import { useConnectionState, useRealtime } from '../realtime'
import { reloadForUpdate } from '../releases'

/**
 * 服务器上的页面换了：在页面顶部提示"系统已更新，点这里刷新"（U1）。
 * 在重新连上服务器之后、窗口回到前台时检查。不自动刷新，由用户点；关掉之后这一次不再提示。
 */
export function UpdateBanner() {
  const { t } = useTranslation()
  const realtime = useRealtime()
  const connection = useConnectionState()
  const [checker] = useState(
    () => new UpdateChecker({ current: pageBuild(), fetchBuild: fetchBuildId }),
  )
  const available = useSyncExternalStore(
    (onChange) => checker.subscribe(onChange),
    () => checker.available,
  )

  // 同步代码会重启服务端，所有页面都会断开再连上：连上之后查一次
  useEffect(
    () =>
      realtime.subscribe((state) => {
        if (state === 'open') void checker.check('reconnected')
      }),
    [realtime, checker],
  )

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') void checker.check('foreground')
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [checker])

  // 断线时顶部是"正在重连"，连上之后再出现
  if (!available || connection !== 'open') return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4">
      <div
        role="status"
        data-testid="update-banner"
        className="pointer-events-auto mt-2 flex items-center rounded-card border border-border bg-surface text-[13px] shadow-float"
      >
        <button
          type="button"
          onClick={reloadForUpdate}
          className="px-3 py-1.5 text-accent-fg hover:underline max-md:min-h-11"
        >
          {t('update.available')}
        </button>
        <button
          type="button"
          onClick={() => checker.dismiss()}
          aria-label={t('update.dismiss')}
          title={t('update.dismiss')}
          className="grid size-8 flex-none place-items-center rounded-control text-fg-3 hover:bg-hover hover:text-fg max-md:size-11"
        >
          <X size={14} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
    </div>
  )
}
