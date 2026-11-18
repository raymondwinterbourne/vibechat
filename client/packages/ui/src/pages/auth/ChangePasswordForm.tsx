import { useMutation } from '@tanstack/react-query'
import { changePassword } from '@vibechat/core'
import { type FormEvent, type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { TextField } from '../../components/TextField'
import { useErrorMessage } from '../../errors'

interface ChangePasswordFormProps {
  onDone: () => void
  /** 提交按钮旁边的其他按钮，例如"取消"。 */
  extraActions?: ReactNode
}

/** 修改密码的表单。设置页的对话框和"必须先修改密码"的页面共用。 */
export function ChangePasswordForm({ onDone, extraActions }: ChangePasswordFormProps) {
  const { t } = useTranslation('auth')
  const errorMessage = useErrorMessage()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [mismatch, setMismatch] = useState(false)

  const submit = useMutation({
    mutationFn: () => changePassword(current, next),
    onSuccess: onDone,
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

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        label={t('changePassword.current')}
        type="password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
        autoComplete="current-password"
        required
        autoFocus
      />
      <TextField
        label={t('changePassword.new')}
        hint={t('register.passwordHint')}
        type="password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        autoComplete="new-password"
        required
      />
      <TextField
        label={t('changePassword.confirm')}
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
      <div className="flex justify-end gap-2">
        {extraActions}
        <Button type="submit" variant="primary" disabled={submit.isPending}>
          {t('changePassword.submit')}
        </Button>
      </div>
    </form>
  )
}
