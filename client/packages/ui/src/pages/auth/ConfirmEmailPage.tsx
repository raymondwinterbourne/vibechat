import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { confirmEmail } from '@vibechat/core'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { useErrorMessage } from '../../errors'
import { meQuery } from '../../session'

/**
 * 从确认邮箱的邮件里点进来。要点一下"确认"才生效：
 * 有些邮件系统会自己把邮件里的链接打开看一眼，光是打开页面不应当算数。
 */
export function ConfirmEmailPage() {
  const { t } = useTranslation('auth')
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const { token } = useSearch({ from: '/auth/confirm-email' })

  const submit = useMutation({
    mutationFn: () => confirmEmail(token ?? ''),
    // 管理员在这个浏览器里登录着的话，设置里的邮箱跟着变
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
  })

  const back = (
    <p className="text-center">
      <Link to="/" className="text-accent-fg">
        {t('confirmEmail.back')}
      </Link>
    </p>
  )

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-medium text-[17px]">{t('confirmEmail.title')}</h1>
      {!token ? (
        <p role="alert" className="text-danger">
          {t('reset.missing')}
        </p>
      ) : submit.isSuccess ? (
        <p role="status" data-testid="email-confirmed">
          {t('confirmEmail.done', { email: submit.data.email })}
        </p>
      ) : (
        <>
          <p className="text-fg-2">{t('confirmEmail.explain')}</p>
          {submit.isError && (
            <p role="alert" className="text-danger">
              {errorMessage(submit.error)}
            </p>
          )}
          <Button variant="primary" onClick={() => submit.mutate()} disabled={submit.isPending}>
            {t('confirmEmail.submit')}
          </Button>
        </>
      )}
      {back}
    </div>
  )
}
