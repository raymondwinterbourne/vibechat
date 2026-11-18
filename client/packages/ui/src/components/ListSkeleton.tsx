import { useTranslation } from 'react-i18next'

/** 列表第一次取数据时的占位：几行灰色的条，不是一片空白，也不是先闪一下"还没有…"。 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  const { t } = useTranslation()
  return (
    <div role="status" aria-label={t('loading')} data-testid="loading" className="animate-pulse">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 这几行一模一样，顺序也不会变
        <div key={index} className="flex h-14 items-center gap-3 px-4">
          <span className="size-9 flex-none rounded-card bg-surface" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3 w-2/5 rounded bg-surface" />
            <span className="h-2.5 w-3/5 rounded bg-surface" />
          </span>
        </div>
      ))}
    </div>
  )
}
