// 一个会话里的全部图片和文件（F6）：电脑上是右侧的面板，手机上盖住整个会话。
// 从新到旧，往下翻接着取更早的；只有我看得到的，撤回了的不列。

import { useInfiniteQuery } from '@tanstack/react-query'
import { formatFileSize, formatListTime, listMedia } from '@vibechat/core'
import type { ConversationView, MessageView } from '@vibechat/protocol'
import { ChevronLeft, Download, MessageSquareText, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/Button'
import { SegmentedControl } from '../../components/SegmentedControl'
import { useErrorMessage } from '../../errors'
import { useFileUrls } from '../../files'
import { usePreferences } from '../../preferences'
import { Lightbox } from './Lightbox'

type Kind = 'image' | 'file'

interface MediaPanelProps {
  conversation: ConversationView
  onJump: (seq: number) => void
  onClose: () => void
}

export function MediaPanel({ conversation, onJump, onClose }: MediaPanelProps) {
  const { t } = useTranslation('chats')
  const errorMessage = useErrorMessage()
  const [kind, setKind] = useState<Kind>('image')
  const found = useInfiniteQuery({
    queryKey: ['conversation-media', conversation.id, kind] as const,
    queryFn: ({ pageParam, signal }) =>
      listMedia(conversation.id, kind, { before: pageParam }, { signal }),
    initialPageParam: undefined as number | undefined,
    // 一页里从旧到新：往更早翻，从这一页最早的那一条之前接着取
    getNextPageParam: (last) => (last.has_more ? last.items[0]?.seq : undefined),
    staleTime: 0,
  })
  // 新的在前
  const items = (found.data?.pages ?? []).flatMap((page) => [...page.items].reverse())

  // 翻到底部附近就接着取
  const sentinel = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = found
  useEffect(() => {
    const element = sentinel.current
    if (!element || !hasNextPage) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
        void fetchNextPage()
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return (
    <aside
      data-testid="media-panel"
      className="absolute inset-0 z-10 flex flex-col bg-bg md:static md:z-auto md:w-[300px] md:flex-none md:border-border md:border-l"
    >
      <header className="flex h-[52px] flex-none items-center gap-1 border-border border-b pr-2 pl-4 max-md:pl-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('media.close')}
          className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:hidden"
        >
          <ChevronLeft size={22} strokeWidth={1.5} aria-hidden />
        </button>
        <h2 className="min-w-0 flex-1 truncate font-medium text-[17px] md:text-[15px]">
          {t('media.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('media.close')}
          title={t('media.close')}
          className="hidden size-9 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:grid"
        >
          <X size={18} strokeWidth={1.5} aria-hidden />
        </button>
      </header>
      <div className="flex-none p-3">
        <SegmentedControl
          label={t('media.title')}
          value={kind}
          onChange={setKind}
          fillOnPhone
          options={[
            { value: 'image', label: t('media.images') },
            { value: 'file', label: t('media.files') },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {found.isError ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-fg-3">
            <p>{errorMessage(found.error)}</p>
            <Button onClick={() => void found.refetch()}>{t('media.retry')}</Button>
          </div>
        ) : found.isPending ? (
          <p className="p-6 text-center text-fg-3">{t('media.loading')}</p>
        ) : items.length === 0 ? (
          <p data-testid="media-empty" className="p-6 text-center text-fg-3">
            {kind === 'image' ? t('media.noImages') : t('media.noFiles')}
          </p>
        ) : kind === 'image' ? (
          <ImageGrid items={items} onJump={onJump} />
        ) : (
          <FileList items={items} onJump={onJump} />
        )}
        <div ref={sentinel} className="h-px" />
      </div>
    </aside>
  )
}

/** 图片排成三列的小方块，点开看大图、左右翻。 */
function ImageGrid({
  items,
  onJump,
}: {
  items: readonly MessageView[]
  onJump: (seq: number) => void
}) {
  const urls = useFileUrls()
  const [open, setOpen] = useState<number | null>(null)
  const shown = open === null ? null : items[open]
  return (
    <>
      <ul className="grid grid-cols-3 gap-1">
        {items.map((message, index) =>
          message.file ? (
            <li key={message.id}>
              <button
                type="button"
                data-testid="media-image"
                data-seq={message.seq}
                onClick={() => setOpen(index)}
                aria-label={message.file.name}
                className="block aspect-square w-full overflow-hidden rounded-control bg-surface"
              >
                <img
                  src={urls.thumbnail(message.file.id)}
                  alt=""
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
            </li>
          ) : null,
        )}
      </ul>
      <Lightbox
        file={shown?.file ?? null}
        onClose={() => setOpen(null)}
        // 新的在前：往左是更新的，往右是更早的
        onPrevious={open !== null && open > 0 ? () => setOpen(open - 1) : undefined}
        onNext={open !== null && open < items.length - 1 ? () => setOpen(open + 1) : undefined}
        onLocate={
          shown
            ? () => {
                setOpen(null)
                onJump(shown.seq)
              }
            : undefined
        }
      />
    </>
  )
}

/** 文件一行一个：名字、大小、发送的时间；可以下载，也可以回到聊天里那一条。 */
function FileList({
  items,
  onJump,
}: {
  items: readonly MessageView[]
  onJump: (seq: number) => void
}) {
  const { t } = useTranslation('chats')
  const urls = useFileUrls()
  const language = usePreferences((state) => state.language)
  return (
    <ul className="flex flex-col">
      {items.map((message) =>
        message.file ? (
          <li
            key={message.id}
            data-testid="media-file"
            data-seq={message.seq}
            className="flex items-center gap-2 border-border border-b py-2"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{message.file.name}</span>
              <span className="text-[12px] text-fg-3">
                {formatFileSize(message.file.size)} ·{' '}
                {formatListTime(message.created_at, Date.now(), language)}
              </span>
            </span>
            <a
              href={urls.download(message.file.id)}
              download={message.file.name}
              aria-label={t('attachment.download')}
              title={t('attachment.download')}
              className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:size-9"
            >
              <Download size={18} strokeWidth={1.5} aria-hidden />
            </a>
            <button
              type="button"
              onClick={() => onJump(message.seq)}
              aria-label={t('media.locate')}
              title={t('media.locate')}
              data-testid="media-locate"
              className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:size-9"
            >
              <MessageSquareText size={18} strokeWidth={1.5} aria-hidden />
            </button>
          </li>
        ) : null,
      )}
    </ul>
  )
}
