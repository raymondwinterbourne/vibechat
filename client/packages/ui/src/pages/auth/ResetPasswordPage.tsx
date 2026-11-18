import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { confirmPasswordReset } from '@vibechat/core'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { TextField } from '../../components/TextField'
import { useErrorMessage } from '../../errors'
import { forgetUserData, meQuery } from '../../session'

/** 从找回密码的邮件里点进来：设一个新密码。链接只能用一次。 */
export function ResetPasswordPage() {
  const { t } = useTranslation('auth')
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const { token } = useSearch({ from: '/auth/reset-password' })
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [mismatch, setMismatch] = useState(false)

  const submit = useMutation({
    mutationFn: () => confirmPasswordReset(token ?? '', next),
    onSuccess: () => {
      // 以前的登录全部失效了，这个浏览器里的也一样
      queryClient.setQueryData(meQuery.queryKey, null)
      forgetUserData()
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (next !== confirm) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    submit.mutate()
  }

  const toLogin = (
    <p className="text-center">
      <Link to="/login" className="text-accent-fg">
        {t('reset.toLogin')}
      </Link>
    </p>
  )

  if (!token) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-medium text-[17px]">{t('reset.title')}</h1>
        <p role="alert" className="text-danger">
          {t('reset.missing')}
        </p>
        {toLogin}
      </div>
    )
  }

  if (submit.isSuccess) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-medium text-[17px]">{t('reset.title')}</h1>
        <p role="status" data-testid="reset-done">
          {t('reset.done')}
        </p>
        {toLogin}
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h1 className="font-medium text-[17px]">{t('reset.title')}</h1>
      <TextField
        label={t('reset.new')}
        hint={t('register.passwordHint')}
        type="password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        autoComplete="new-password"
        required
        autoFocus
      />
      <TextField
        label={t('reset.confirm')}
        type="password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        autoComplete="new-password"
        error={mismatch ? t('register.passwordMismatch') : undefined}
        required
      />
      {submit.isError && (
        <p role="alert" className="text-danger">
          {errorMessage(submit.error)}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={submit.isPending}>
        {t('reset.submit')}
      </Button>
    </form>
  )
}
