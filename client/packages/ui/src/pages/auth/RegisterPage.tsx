import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { register } from '@vibechat/core'
import type { Me } from '@vibechat/protocol'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { TextField } from '../../components/TextField'
import { useErrorMessage } from '../../errors'
import { meQuery } from '../../session'

/** 注册成功后的一步：让新用户看到并记下系统分配的 ID。 */
function Registered({ me }: { me: Me }) {
  const { t } = useTranslation('auth')
  const router = useRouter()
  const queryClient = useQueryClient()

  async function start() {
    queryClient.setQueryData(meQuery.queryKey, me)
    await router.invalidate()
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-medium text-[17px]">{t('registered.title')}</h1>
      <div className="flex flex-col gap-1 rounded-card bg-surface p-4">
        <span className="text-[12px] text-fg-2">{t('registered.yourId')}</span>
        <span data-testid="assigned-id" className="select-all font-mono text-[20px]">
          {me.handle}
        </span>
      </div>
      <p className="text-fg-2">{t('registered.explain')}</p>
      <Button variant="primary" onClick={start}>
        {t('registered.start')}
      </Button>
    </div>
  )
}

export function RegisterPage() {
  const { t } = useTranslation('auth')
  const errorMessage = useErrorMessage()
  const [inviteCode, setInviteCode] = useState('')
  const [nickname, setNickname] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [mismatch, setMismatch] = useState(false)

  const submit = useMutation({
    mutationFn: () => register({ invite_code: inviteCode, nickname, password }),
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (password !== confirm) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    submit.mutate()
  }

  // 注册成功后先停在这里展示 ID，用户点"开始使用"才进入系统
  if (submit.isSuccess) return <Registered me={submit.data} />

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h1 className="font-medium text-[17px]">{t('register.title')}</h1>
      <TextField
        label={t('register.inviteCode')}
        hint={t('register.inviteCodeHint')}
        value={inviteCode}
        onChange={(event) => setInviteCode(event.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className="[&_input]:font-mono"
        required
        autoFocus
      />
      <TextField
        label={t('register.nickname')}
        value={nickname}
        onChange={(event) => setNickname(event.target.value)}
        autoComplete="nickname"
        maxLength={32}
        required
      />
      <TextField
        label={t('register.password')}
        hint={t('register.passwordHint')}
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="new-password"
        required
      />
      <TextField
        label={t('register.confirmPassword')}
        type="password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        autoComplete="new-password"
        error={mismatch ? t('register.passwordMismatch') : undefined}
        required
      />
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-1 size-4 flex-none accent-accent"
        />
        <span>{t('register.notice')}</span>
      </label>
      {submit.isError && (
        <p role="alert" className="text-danger">
          {errorMessage(submit.error)}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={!acknowledged || submit.isPending}>
        {t('register.submit')}
      </Button>
      <p className="text-center text-fg-2">
        {t('register.hasAccount')}{' '}
        <Link to="/login" className="text-accent-fg">
          {t('register.toLogin')}
        </Link>
      </p>
    </form>
  )
}
