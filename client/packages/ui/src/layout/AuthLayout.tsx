import { Outlet } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { SegmentedControl } from '../components/SegmentedControl'
import { LANGUAGES } from '../i18n'
import { usePreferences } from '../preferences'

/** 登录、注册这些还没有登录时的页面：居中的一张卡片。 */
export function AuthLayout() {
  const { t } = useTranslation()
  const { t: tSettings } = useTranslation('settings')
  const { language, setLanguage } = usePreferences()
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-subtle p-4">
      <p className="font-medium text-[20px]">{t('appName')}</p>
      <main className="w-full max-w-[380px] rounded-card border border-border bg-bg p-6">
        <Outlet />
      </main>
      {/* 还没有登录时进不了设置页，在这里也能换语言 */}
      <SegmentedControl
        label={tSettings('language.title')}
        value={language}
        options={LANGUAGES}
        onChange={setLanguage}
      />
    </div>
  )
}
