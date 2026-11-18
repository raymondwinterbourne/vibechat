import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { meQuery } from '../../session'
import { toast } from '../../toast'
import { useLogout } from '../../useLogout'
import { ChangePasswordForm } from './ChangePasswordForm'

/** 必须先修改密码时看到的页面：管理员首次登录，或密码被管理员重置之后。 */
export function ChangePasswordPage() {
  const { t } = useTranslation('auth')
  const router = useRouter()
  const queryClient = useQueryClient()
  const logout = useLogout()

  async function onDone() {
    toast.success(t('changePassword.done'))
    // 重新取资料：必须修改密码的标记已经去掉，路由会放行到正常的页面。
    // 这个页面上没有组件在使用资料，所以要明确地重新获取，而不只是标记为过期
    await queryClient.refetchQueries({ queryKey: meQuery.queryKey })
    await router.invalidate()
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-medium text-[17px]">{t('changePassword.title')}</h1>
      <p className="text-fg-2">{t('changePassword.forced')}</p>
      <ChangePasswordForm
        onDone={onDone}
        extraActions={
          <Button variant="ghost" onClick={() => logout.mutate()}>
            {t('changePassword.logout')}
          </Button>
        }
      />
    </div>
  )
}
