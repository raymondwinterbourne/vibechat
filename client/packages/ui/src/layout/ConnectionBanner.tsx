import { useTranslation } from 'react-i18next'
import { useConnectionState } from '../realtime'

/** 与服务端的连接断开时，在页面顶部提示正在重连；连上后自动消失。 */
export function ConnectionBanner() {
  const { t } = useTranslation()
  const state = useConnectionState()
  if (state !== 'reconnecting') return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center">
      <output
        data-testid="connection-banner"
        className="mt-2 rounded-card border border-border bg-surface px-3 py-1 text-[12px] text-fg-2"
      >
        {t('connection.reconnecting')}
      </output>
    </div>
  )
}
