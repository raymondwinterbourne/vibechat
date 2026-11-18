// 设置里的"登录设备"（F9）：我正在哪几台设备上登录着，可以让别的设备退出登录。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { describeDevice, listSessions, signOutOtherSessions, signOutSession } from '@vibechat/core'
import type { SessionView } from '@vibechat/protocol'
import type { TFunction } from 'i18next'
import { Monitor, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { useErrorMessage } from '../errors'
import { usePreferences } from '../preferences'
import { toast } from '../toast'

const QUERY_KEY = ['sessions'] as const

/** 一台设备写成一行字，例如"Chrome · macOS"、"桌面客户端 0.4.0 · macOS"。 */
export function deviceName(userAgent: string, t: TFunction<'settings'>): string {
  const device = describeDevice(userAgent)
  const app =
    device.desktop !== null
      ? device.desktop
        ? t('devices.desktop', { version: device.desktop })
        : t('devices.desktopUnknown')
      : device.browser
  const parts = [app, device.os].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : t('devices.unknown')
}

/** 多久以前：刚刚、5 分钟前、3 小时前、2 天前。 */
function ago(time: number, now: number, language: string, t: TFunction<'settings'>): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return t('devices.justNow')
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  if (minutes < 60) return format.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return format.format(-hours, 'hour')
  return format.format(-Math.floor(hours / 24), 'day')
}

function isPhone(userAgent: string): boolean {
  const os = describeDevice(userAgent).os
  return os === 'iPhone' || os === 'Android'
}

export function DevicesSection() {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const language = usePreferences((state) => state.language)
  const sessions = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => listSessions({ signal }),
    staleTime: 0,
  })
  const [confirming, setConfirming] = useState<SessionView | 'others' | null>(null)

  const signOut = useMutation({
    mutationFn: async (target: SessionView | 'others') => {
      if (target === 'others') return (await signOutOtherSessions()).count
      await signOutSession(target.id)
      return 1
    },
    onSuccess: (count, target) => {
      setConfirming(null)
      toast.success(target === 'others' ? t('devices.doneOthers', { count }) : t('devices.done'))
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  const items = sessions.data?.items ?? []
  const others = items.filter((item) => !item.current)
  const now = Date.now()

  return (
    <div data-testid="devices" className="flex flex-col gap-3">
      {sessions.isError && <p className="text-danger">{errorMessage(sessions.error)}</p>}
      <ul className="flex flex-col divide-y divide-border rounded-control border border-border">
        {items.map((item) => {
          const Icon = isPhone(item.user_agent) ? Smartphone : Monitor
          return (
            <li
              key={item.id}
              data-testid="device"
              data-current={item.current ? '' : undefined}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <Icon size={20} strokeWidth={1.5} aria-hidden className="flex-none text-fg-3" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2">
                  <span data-testid="device-name" className="font-medium">
                    {deviceName(item.user_agent, t)}
                  </span>
                  {item.current && (
                    <span className="rounded-full bg-accent px-2 text-[11px] text-on-accent">
                      {t('devices.current')}
                    </span>
                  )}
                  {item.online && !item.current && (
                    <span data-testid="device-online" className="text-[12px] text-accent-fg">
                      {t('devices.online')}
                    </span>
                  )}
                </p>
                <p className="text-[12px] text-fg-3 [overflow-wrap:anywhere]">
                  {[
                    t('devices.signedInAt', {
                      time: new Date(item.created_at).toLocaleDateString(language),
                    }),
                    t('devices.lastActive', { time: ago(item.last_seen_at, now, language, t) }),
                    item.ip ? t('devices.ip', { ip: item.ip }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {/* 本机用"退出登录"，不在这里 */}
              {!item.current && (
                <Button
                  variant="secondary"
                  className="flex-none"
                  onClick={() => setConfirming(item)}
                  disabled={signOut.isPending}
                >
                  {t('devices.signOut')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {sessions.data &&
        (others.length > 0 ? (
          <div>
            <Button
              variant="danger"
              onClick={() => setConfirming('others')}
              disabled={signOut.isPending}
            >
              {t('devices.signOutOthers')}
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-fg-3">{t('devices.only')}</p>
        ))}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming === 'others' ? t('devices.confirmOthers') : t('devices.confirmOne')}
      >
        <div data-testid="devices-confirm" className="flex flex-col gap-4">
          <p className="text-fg-2">
            {confirming === 'others'
              ? t('devices.confirmOthersText')
              : confirming
                ? t('devices.confirmOneText', { device: deviceName(confirming.user_agent, t) })
                : ''}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {tCommon('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => confirming && signOut.mutate(confirming)}
              disabled={signOut.isPending}
            >
              {t('devices.signOut')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
