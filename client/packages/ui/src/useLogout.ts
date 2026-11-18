import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { logout } from '@vibechat/core'
import { forgetUserData, meQuery } from './session'

/** 退出登录，然后回到登录页。 */
export function useLogout() {
  const router = useRouter()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: async () => {
      queryClient.setQueryData(meQuery.queryKey, null)
      forgetUserData()
      await router.invalidate()
    },
  })
}
