import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { login } from '@vibechat/core'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { TextField } from '../../components/TextField'
import { useErrorMessage } from '../../errors'
import { meQuery, takeSignedOutNotice } from '../../session'

export function LoginPage() {
  const { t } = useTranslation('auth')
  const errorMessage = useErrorMessage()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [handle, setHandle] = useState('')
  const [password, setPassword] = useState('')
  // 是在另一台设备上被退出登录才来到这里的（F9）
  const [signedOut] = useState(takeSignedOutNotice)

  const submit = useMutation({
    mutationFn: () => login(handle.trim(), password),
    onSuccess: async (me) => {
      queryClient.setQueryData(meQuery.queryKey, me)
      // 重新判断当前页面：已经登录的人不该留在登录页，路由会带他去该去的地方
      await router.invalidate()
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    submit.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h1 className="font-medium text-[17px]">{t('login.title')}</h1>
      {signedOut && (
        <p
          role="status"
          data-testid="signed-out-notice"
          className="rounded-control bg-surface px-3 py-2 text-[13px] text-fg-2"
        >
          {t('login.signedOutElsewhere')}
        </p>
      )}
      <TextField
        label={t('login.id')}
        value={handle}
        onChange={(event) => setHandle(event.target.value)}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        autoFocus
      />
      <TextField
        label={t('login.password')}
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="current-password"
        required
      />
      {submit.isError && (
        <p role="alert" className="text-danger">
          {errorMessage(submit.error)}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={submit.isPending}>
        {t('login.submit')}
      </Button>
      <p className="text-center text-fg-2">
        {t('login.noAccount')}{' '}
        <Link to="/register" className="text-accent-fg">
          {t('login.toRegister')}
        </Link>
      </p>
      {/* 只有管理员能自己找回密码；普通用户忘了密码找管理员重置 */}
      <p className="text-center text-[12px]">
        <Link to="/forgot-password" className="text-fg-2 hover:text-fg">
          {t('login.forgot')}
        </Link>
      </p>
    </form>
  )
}
