import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { requestPasswordReset } from '@vibechat/core'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { TextField } from '../../components/TextField'
import { useErrorMessage } from '../../errors'

/** 管理员忘记密码：输入邮箱，收一封带链接的邮件。不管邮箱对不对，显示的话都一样。 */
export function ForgotPasswordPage() {
  const { t } = useTranslation('auth')
  const errorMessage = useErrorMessage()
  const [email, setEmail] = useState('')
  const submit = useMutation({ mutationFn: () => requestPasswordReset(email) })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    submit.mutate()
  }

  const back = (
    <p className="text-center">
      <Link to="/login" className="text-accent-fg">
        {t('forgot.back')}
      </Link>
    </p>
  )

  if (submit.isSuccess) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-medium text-[17px]">{t('forgot.title')}</h1>
        <p role="status" data-testid="reset-requested">
          {t('forgot.sent')}
        </p>
        {back}
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h1 className="font-medium text-[17px]">{t('forgot.title')}</h1>
      <p className="text-fg-2">{t('forgot.explain')}</p>
      <TextField
        label={t('forgot.email')}
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        required
        autoFocus
      />
      {submit.isError && (
        <p role="alert" className="text-danger">
          {errorMessage(submit.error)}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={submit.isPending}>
        {t('forgot.submit')}
      </Button>
      {back}
    </form>
  )
}
