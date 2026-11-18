import { ApiError } from '@vibechat/core'
import { useTranslation } from 'react-i18next'

/** 把接口调用的错误转成当前语言的提示文字。 */
export function useErrorMessage(): (error: unknown) => string {
  const { t } = useTranslation('errors')
  return (error) => {
    if (!(error instanceof ApiError)) return t('unknown')
    const message = t(error.code)
    const wait = error.retryAfterSecs
    if (wait === null) return message
    // 等待时间不到两分钟按秒说，否则按分钟说（向上取整，宁可让人多等一会儿）
    const retry =
      wait < 120
        ? t('retry_in_seconds', { count: wait })
        : t('retry_in_minutes', { count: Math.ceil(wait / 60) })
    return `${message} ${retry}`
  }
}
