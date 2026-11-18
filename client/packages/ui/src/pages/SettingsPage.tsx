import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  changeHandle,
  fetchHealth,
  requestEmailChange,
  updateProfile,
  uploadAvatar,
} from '@vibechat/core'
import type { Me, UpdateProfileRequest } from '@vibechat/protocol'
import { ChevronRight } from 'lucide-react'
import { type ChangeEvent, type FormEvent, type ReactNode, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../App'
import { pageBuild } from '../build'
import { Avatar } from '../components/Avatar'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { SegmentedControl } from '../components/SegmentedControl'
import { TextField } from '../components/TextField'
import { DesktopDownload, useDesktopOffer } from '../desktopClient'
import { useErrorMessage } from '../errors'
import { LANGUAGES, type Language } from '../i18n'
import { adminDestination } from '../layout/navigation'
import { useNotices, useNoticesOn } from '../notifications'
import { type ThemePreference, usePreferences } from '../preferences'
import { useShowAllReleases } from '../releases'
import { meQuery, useMe } from '../session'
import { toast } from '../toast'
import { useLogout } from '../useLogout'
import { ChangePasswordForm } from './auth/ChangePasswordForm'
import { DevicesSection } from './DevicesSection'

interface SectionProps {
  title: string
  children: ReactNode
  className?: string
}

function Section({ title, children, className = '' }: SectionProps) {
  return (
    <section
      className={`flex flex-col gap-3 border-border border-b py-5 last:border-b-0 ${className}`}
    >
      <h2 className="text-[12px] text-fg-2">{title}</h2>
      {children}
    </section>
  )
}

/** 系统通知的开关，以及开不了的时候为什么。 */
function NoticeSettings() {
  const { t } = useTranslation('settings')
  const { support, enable, disable } = useNotices()
  const on = useNoticesOn()
  if (support === 'unsupported') {
    return <p className="text-fg-2">{t('notifications.unsupported')}</p>
  }
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <span>{t('notifications.system')}</span>
        <SegmentedControl
          label={t('notifications.system')}
          value={on ? 'on' : 'off'}
          options={[
            { value: 'on', label: t('notifications.on') },
            { value: 'off', label: t('notifications.off') },
          ]}
          onChange={(value) => (value === 'on' ? void enable() : disable())}
        />
      </div>
      <p className="text-[12px] text-fg-3">{t('notifications.explain')}</p>
      {support === 'denied' && (
        <p role="alert" data-testid="notice-denied" className="text-[12px] text-danger">
          {t('notifications.denied')}
        </p>
      )}
    </>
  )
}

/** 把服务端返回的最新资料放进缓存，页面各处随之更新。 */
function useStoreMe() {
  const queryClient = useQueryClient()
  return (me: Me) => queryClient.setQueryData(meQuery.queryKey, me)
}

function AvatarEditor({ me }: { me: Me }) {
  const { t } = useTranslation('settings')
  const errorMessage = useErrorMessage()
  const storeMe = useStoreMe()
  const input = useRef<HTMLInputElement>(null)

  const upload = useMutation({
    mutationFn: (file: File) => uploadAvatar(file),
    onSuccess: (updated) => {
      storeMe(updated)
      toast.success(t('profile.avatarUpdated'))
    },
    onError: (error) => toast.error(errorMessage(error)),
  })

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // 清空选择，这样再次选同一个文件也会触发
    event.target.value = ''
    if (file) upload.mutate(file)
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar user={me} size={64} />
      <Button onClick={() => input.current?.click()} disabled={upload.isPending}>
        {t('profile.changeAvatar')}
      </Button>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={onPick}
        data-testid="avatar-input"
        className="hidden"
      />
    </div>
  )
}

function ProfileForm({ me }: { me: Me }) {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const storeMe = useStoreMe()
  const [nickname, setNickname] = useState(me.nickname)
  const [signature, setSignature] = useState(me.signature)
  const changed = nickname !== me.nickname || signature !== me.signature

  const save = useMutation({
    mutationFn: () => updateProfile({ nickname, signature }),
    onSuccess: (updated) => {
      storeMe(updated)
      // 服务端会去掉首尾的空白，以它返回的为准
      setNickname(updated.nickname)
      setSignature(updated.signature)
      toast.success(tCommon('saved'))
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <TextField
        label={t('profile.nickname')}
        value={nickname}
        onChange={(event) => setNickname(event.target.value)}
        maxLength={32}
        required
      />
      <TextField
        label={t('profile.signature')}
        value={signature}
        onChange={(event) => setSignature(event.target.value)}
        maxLength={100}
      />
      {save.isError && (
        <p role="alert" className="text-danger">
          {errorMessage(save.error)}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={!changed || save.isPending}>
          {tCommon('actions.save')}
        </Button>
      </div>
    </form>
  )
}

function IdRow({ me }: { me: Me }) {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const storeMe = useStoreMe()
  const [open, setOpen] = useState(false)
  const [handle, setHandle] = useState('')

  const save = useMutation({
    mutationFn: () => changeHandle(handle.trim()),
    onSuccess: (updated) => {
      storeMe(updated)
      setOpen(false)
      toast.success(t('profile.idUpdated'))
    },
  })

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setHandle(me.handle)
      save.reset()
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-[12px] text-fg-2">{t('profile.id')}</span>
        <span data-testid="my-id" className="truncate font-mono">
          {me.handle}
        </span>
      </div>
      <Button onClick={() => onOpenChange(true)}>{t('profile.changeId')}</Button>
      <Dialog open={open} onOpenChange={onOpenChange} title={t('profile.changeIdTitle')}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <TextField
            label={t('profile.newId')}
            hint={t('profile.idHint')}
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            error={save.isError ? errorMessage(save.error) : undefined}
            autoCapitalize="none"
            spellCheck={false}
            className="[&_input]:font-mono"
            required
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tCommon('actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={save.isPending || handle.trim() === me.handle}
            >
              {tCommon('actions.save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  )
}

function AccountActions() {
  const { t } = useTranslation('settings')
  const { t: tAuth } = useTranslation('auth')
  const { t: tCommon } = useTranslation()
  const logout = useLogout()
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setOpen(true)}>{t('account.changePassword')}</Button>
      <Button variant="danger" onClick={() => logout.mutate()} disabled={logout.isPending}>
        {t('account.logout')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={t('account.changePassword')}>
        {/* 每次打开都是一张空白的表单 */}
        {open && (
          <ChangePasswordForm
            onDone={() => {
              setOpen(false)
              toast.success(tAuth('changePassword.done'))
            }}
            extraActions={
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {tCommon('actions.cancel')}
              </Button>
            }
          />
        )}
      </Dialog>
    </div>
  )
}

/** 管理员绑定的邮箱：忘记密码时用。改的时候要验证当前密码，新邮箱确认之后才生效。 */
function AdminEmail({ me }: { me: Me }) {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const save = useMutation({
    mutationFn: () => requestEmailChange(password, email),
    onSuccess: () => {
      setOpen(false)
      toast.success(t('adminEmail.sent', { email: email.trim() }))
    },
  })

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setEmail('')
      setPassword('')
      save.reset()
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span data-testid="admin-email" className="min-w-0 truncate">
          {me.email ?? t('adminEmail.none')}
        </span>
        <Button onClick={() => onOpenChange(true)}>{t('adminEmail.change')}</Button>
      </div>
      <p className="text-[12px] text-fg-3">{t('adminEmail.explain')}</p>
      <Dialog open={open} onOpenChange={onOpenChange} title={t('adminEmail.changeTitle')}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <TextField
            label={t('adminEmail.newEmail')}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
            autoFocus
          />
          <TextField
            label={t('adminEmail.currentPassword')}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
          {save.isError && (
            <p role="alert" className="text-danger">
              {errorMessage(save.error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tCommon('actions.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {t('adminEmail.submit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}

function ServerStatus() {
  const { t } = useTranslation('settings')
  const errorMessage = useErrorMessage()
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth({ signal }),
  })

  let text: string
  if (health.isPending) text = t('about.checking')
  else if (health.isError) text = errorMessage(health.error)
  else if (health.data.status === 'ok') text = t('about.ok', { version: health.data.version })
  else text = t('about.degraded', { version: health.data.version })

  return (
    <p data-testid="server-status">
      <span className="text-fg-2">{t('about.server')}</span> {text}
    </p>
  )
}

/** 页面的构建编号：每次同步了有改动的页面都会变，刷新之后看它就知道是不是新的。 */
function PageBuild() {
  const { t } = useTranslation('settings')
  const build = pageBuild()
  const showAll = useShowAllReleases()
  return (
    <p data-testid="page-build">
      <span className="text-fg-2">{t('about.page')}</span>{' '}
      {build ? t('about.build', { build: build.slice(0, 8) }) : t('about.development')}
      {' · '}
      <button
        type="button"
        onClick={showAll}
        className="text-accent-fg hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
      >
        {t('about.releases')}
      </button>
    </p>
  )
}

/**
 * 桌面客户端：在桌面端里显示它自己的版本，服务器上有更新的就提示；
 * 在 Mac 的浏览器里提供下载。装不了它的设备上什么都不显示。
 */
function DesktopClient() {
  const { t } = useTranslation('settings')
  const installed = usePlatform().version
  const offer = useDesktopOffer()
  if (installed === null && !offer) return null
  return (
    <div data-testid="desktop-client" className="flex flex-col gap-2">
      <p>
        <span className="text-fg-2">{t('about.desktop.title')}</span>{' '}
        {installed !== null && (
          <span data-testid="desktop-version">
            {t('about.desktop.installed', { version: installed })}
          </span>
        )}
      </p>
      {offer && <DesktopDownload offer={offer} />}
    </div>
  )
}

export function SettingsPage() {
  const { t } = useTranslation('settings')
  const errorMessage = useErrorMessage()
  const me = useMe()
  const storeMe = useStoreMe()
  const { theme, language, setTheme, setLanguage } = usePreferences()

  // 语言和外观先在本机立即生效，同时保存到账号，换一台设备登录后保持一致
  const savePreference = useMutation({
    mutationFn: (changes: UpdateProfileRequest) => updateProfile(changes),
    onSuccess: storeMe,
    onError: (error) => toast.error(errorMessage(error)),
  })

  function chooseTheme(next: ThemePreference) {
    setTheme(next)
    savePreference.mutate({ theme: next })
  }

  function chooseLanguage(next: Language) {
    setLanguage(next)
    savePreference.mutate({ language: next })
  }

  const themes: { value: ThemePreference; label: string }[] = [
    { value: 'light', label: t('appearance.light') },
    { value: 'dark', label: t('appearance.dark') },
    { value: 'system', label: t('appearance.system') },
  ]

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <header className="flex h-[52px] items-center border-border border-b px-4">
        <h1 className="font-medium text-[17px] md:text-[15px]">{t('title')}</h1>
      </header>
      <div className="mx-auto max-w-[560px] px-4 md:px-8">
        <Section title={t('profile.title')}>
          <AvatarEditor me={me} />
          {/* 资料在别处被改了之后，表单从最新的内容重新开始 */}
          <ProfileForm key={`${me.nickname}\n${me.signature}`} me={me} />
          <IdRow me={me} />
        </Section>
        <Section title={t('account.title')}>
          <AccountActions />
        </Section>
        <Section title={t('devices.title')}>
          <DevicesSection />
        </Section>
        {me.role === 'admin' && (
          // 电脑上管理入口在左侧的导航栏里；手机上没有导航栏，入口放在这里
          <Section title={t('admin.title')} className="md:hidden">
            <Link
              to={adminDestination.to}
              className="flex h-11 items-center justify-between rounded-control border border-border px-3 hover:bg-hover"
            >
              {t('admin.open')}
              <ChevronRight size={16} strokeWidth={1.5} aria-hidden className="text-fg-3" />
            </Link>
          </Section>
        )}
        {me.role === 'admin' && (
          <Section title={t('adminEmail.title')}>
            <AdminEmail me={me} />
          </Section>
        )}
        <Section title={t('appearance.title')}>
          <div>
            <SegmentedControl
              label={t('appearance.title')}
              value={theme}
              options={themes}
              onChange={chooseTheme}
            />
          </div>
        </Section>
        <Section title={t('language.title')}>
          <div>
            <SegmentedControl
              label={t('language.title')}
              value={language}
              options={LANGUAGES}
              onChange={chooseLanguage}
            />
          </div>
        </Section>
        <Section title={t('notifications.title')}>
          <NoticeSettings />
        </Section>
        <Section title={t('about.title')}>
          <ServerStatus />
          <PageBuild />
          <DesktopClient />
        </Section>
      </div>
    </div>
  )
}
