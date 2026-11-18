import * as RadixDialog from '@radix-ui/react-dialog'
import type { FileView } from '@vibechat/protocol'
import { ChevronLeft, ChevronRight, Download, MessageSquareText, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useFileUrls } from '../../files'

const BUTTON =
  'grid size-11 place-items-center rounded-full bg-black/50 text-white transition-colors duration-150 hover:bg-black/70'

interface LightboxProps {
  file: FileView | null
  onClose: () => void
  /** 看一组图片时（图片和文件一览）：上一张、下一张。没有了就不给。左右方向键也能翻。 */
  onPrevious?: () => void
  onNext?: () => void
  /** 回到聊天里这张图的位置。 */
  onLocate?: () => void
}

/** 盖住全屏的大图。按 Esc 或点图片旁边关闭。 */
export function Lightbox({ file, onClose, onPrevious, onNext, onLocate }: LightboxProps) {
  const { t } = useTranslation('chats')
  const urls = useFileUrls()
  return (
    <RadixDialog.Root open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          data-testid="lightbox-backdrop"
          className="fixed inset-0 z-50 bg-black/85"
        />
        <RadixDialog.Content
          aria-describedby={undefined}
          data-testid="lightbox"
          // 点到图片以外的地方就是点到了这一层
          onClick={(event) => event.target === event.currentTarget && onClose()}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-10"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' && onPrevious) onPrevious()
            else if (event.key === 'ArrowRight' && onNext) onNext()
          }}
        >
          <RadixDialog.Title className="sr-only">{file?.name}</RadixDialog.Title>
          {file && (
            <img
              src={urls.file(file.id)}
              alt={file.name}
              data-testid="lightbox-image"
              // 白底：透明底的图（比如截图）不会透出后面的深色，上面的黑字才看得清
              className="max-h-full max-w-full rounded-control bg-white object-contain"
            />
          )}
          {onPrevious && (
            <button
              type="button"
              onClick={onPrevious}
              aria-label={t('media.previous')}
              title={t('media.previous')}
              data-testid="lightbox-previous"
              className={`${BUTTON} -translate-y-1/2 absolute top-1/2 left-3`}
            >
              <ChevronLeft size={22} strokeWidth={1.5} aria-hidden />
            </button>
          )}
          {onNext && (
            <button
              type="button"
              onClick={onNext}
              aria-label={t('media.next')}
              title={t('media.next')}
              data-testid="lightbox-next"
              className={`${BUTTON} -translate-y-1/2 absolute top-1/2 right-3`}
            >
              <ChevronRight size={22} strokeWidth={1.5} aria-hidden />
            </button>
          )}
          <div className="absolute top-3 right-3 flex gap-2">
            {onLocate && (
              <button
                type="button"
                onClick={onLocate}
                aria-label={t('media.locate')}
                title={t('media.locate')}
                className={BUTTON}
              >
                <MessageSquareText size={20} strokeWidth={1.5} aria-hidden />
              </button>
            )}
            {file && (
              <a
                href={urls.download(file.id)}
                download={file.name}
                aria-label={t('attachment.download')}
                title={t('attachment.download')}
                className={BUTTON}
              >
                <Download size={20} strokeWidth={1.5} aria-hidden />
              </a>
            )}
            <RadixDialog.Close
              aria-label={t('attachment.close')}
              title={t('attachment.close')}
              className={BUTTON}
            >
              <X size={20} strokeWidth={1.5} aria-hidden />
            </RadixDialog.Close>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
