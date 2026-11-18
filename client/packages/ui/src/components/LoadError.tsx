import { useTranslation } from 'react-i18next'
import { Button } from './Button'

interface LoadErrorProps {
  /** 为什么没有取到：给用户看的一句话。 */
  message: string
  onRetry: () => void
}

/** 取数据失败时显示在原处：原因，和一个"重试"。 */
export function LoadError({ message, onRetry }: LoadErrorProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <p role="alert" className="text-fg-2">
        {message}
      </p>
      <Button onClick={onRetry}>{t('actions.retry')}</Button>
    </div>
  )
}
