// 消息里的图片和文件：发出去了的，和正在上传的。

import { formatFileSize, type PendingAttachment, splitFileName } from '@vibechat/core'
import type { FileView } from '@vibechat/protocol'
import type { LucideIcon } from 'lucide-react'
import { File, FileArchive, FileText, Film, Image, Music, X } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileUrls } from '../../files'

/** 会话里的图片最大显示成多大。 */
const IMAGE_MAX_WIDTH = 240
const IMAGE_MAX_HEIGHT = 280
/** 太扁或太窄的图片也至少占这么大，否则点不到。 */
const IMAGE_MIN_SIDE = 48

/** 按原图的比例算出显示的大小：加载之前位置就留好了，页面不会跳。 */
export function imageBox(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height, 1)
  return {
    width: Math.max(IMAGE_MIN_SIDE, Math.round(width * scale)),
    height: Math.max(IMAGE_MIN_SIDE, Math.round(height * scale)),
  }
}

/** 服务端会当作图片显示的类型。最终以服务端按内容认定的为准。 */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

/** 这个文件看起来是一张会被当作图片发出去的图片：可以带文字说明。 */
export function looksLikeImage(file: File): boolean {
  return IMAGE_TYPES.includes(file.type)
}

const ICONS: [extensions: string[], icon: LucideIcon][] = [
  [['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg', '.bmp'], Image],
  [['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.webm'], Music],
  [['.mp4', '.mov', '.mkv', '.avi'], Film],
  [['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'], FileArchive],
  [['.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv'], FileText],
]

function iconFor(name: string): LucideIcon {
  const extension = splitFileName(name)[1].toLowerCase()
  return ICONS.find(([extensions]) => extensions.includes(extension))?.[1] ?? File
}

/** 文件名：很长时在中间省略，扩展名总是看得到。 */
function FileName({ name }: { name: string }) {
  const [stem, extension] = splitFileName(name)
  return (
    <span data-testid="file-name" title={name} className="flex min-w-0">
      <span className="truncate">{stem}</span>
      <span className="flex-none">{extension}</span>
    </span>
  )
}

const CARD =
  'flex w-60 max-w-full items-center gap-3 rounded-[12px] border border-border bg-bg px-3 py-2.5 text-left text-fg'

function FileCardBody({ name, detail }: { name: string; detail: string }) {
  const Icon = iconFor(name)
  return (
    <>
      <span className="grid size-10 flex-none place-items-center rounded-control bg-surface text-fg-2">
        <Icon size={20} strokeWidth={1.5} aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <FileName name={name} />
        <span data-testid="file-size" className="text-[12px] text-fg-3">
          {detail}
        </span>
      </span>
    </>
  )
}

/**
 * 会话里一张图片的外框。细边框让浅色的图和聊天的背景分得开；
 * 白底让透明底的图在深色外观下也看得清。
 */
const IMAGE_FRAME = 'flex-none overflow-hidden rounded-[12px] border border-border bg-white'

/** 一条图片消息：按比例显示缩略图，点开看原图。 */
export function ImageBody({ file, onOpen }: { file: FileView; onOpen: () => void }) {
  const { t } = useTranslation('chats')
  const urls = useFileUrls()
  const box = imageBox(file.width ?? IMAGE_MAX_WIDTH, file.height ?? IMAGE_MAX_WIDTH)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('attachment.open')}
      title={t('attachment.open')}
      data-testid="message-image"
      style={box}
      className={`block ${IMAGE_FRAME}`}
    >
      <img
        src={urls.thumbnail(file.id)}
        alt={file.name}
        width={box.width}
        height={box.height}
        loading="lazy"
        draggable={false}
        className="size-full object-cover"
      />
    </button>
  )
}

/** 一条文件消息：点击下载。 */
export function FileBody({ file }: { file: FileView }) {
  const { t } = useTranslation('chats')
  const urls = useFileUrls()
  return (
    <a
      href={urls.download(file.id)}
      download={file.name}
      title={t('attachment.download')}
      data-testid="message-file"
      className={`${CARD} transition-colors duration-150 hover:bg-hover`}
    >
      <FileCardBody name={file.name} detail={formatFileSize(file.size)} />
    </a>
  )
}

interface UploadingBodyProps {
  attachment: PendingAttachment
  /** 还在上传时可以取消。 */
  onCancel?: () => void
}

/** 正在上传（或者上传失败了）的文件。图片先用本地的内容显示出来。 */
export function UploadingBody({ attachment, onCancel }: UploadingBodyProps) {
  const { t } = useTranslation('chats')
  const { content, name, size, progress } = attachment
  const preview = useMemo(
    () => (content?.type.startsWith('image/') ? URL.createObjectURL(content) : null),
    [content],
  )
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])
  const percent = Math.round(progress * 100)

  const cancel = onCancel && (
    <button
      type="button"
      onClick={onCancel}
      aria-label={t('attachment.cancel')}
      title={t('attachment.cancel')}
      className="grid size-8 flex-none place-items-center rounded-full bg-black/55 text-white hover:bg-black/75"
    >
      <X size={16} strokeWidth={1.5} aria-hidden />
    </button>
  )
  const bar = (
    <span
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={t('attachment.progress', { percent })}
      data-testid="upload-progress"
      className="block h-1 overflow-hidden rounded-full bg-black/20"
    >
      <span className="block h-full bg-accent" style={{ width: `${percent}%` }} />
    </span>
  )

  if (preview) {
    return (
      <div data-testid="message-image" className={`relative w-40 ${IMAGE_FRAME}`}>
        <img src={preview} alt={name} className="block max-h-[280px] w-full object-cover" />
        <div className="absolute inset-0 flex flex-col justify-between bg-black/25 p-2">
          <span className="flex justify-end">{cancel}</span>
          {bar}
        </div>
      </div>
    )
  }
  return (
    <div data-testid="message-file" className={`${CARD} relative`}>
      <FileCardBody name={name} detail={formatFileSize(size)} />
      {cancel}
      <span className="absolute inset-x-3 bottom-1">{bar}</span>
    </div>
  )
}

/** 一个选好了、还没有发出去的文件。 */
export interface StagedFile {
  /** 只在这个页面里有意义，用来区分名字相同的两个文件。 */
  id: number
  file: File
}

/** 输入框上方、还没有发出去的一个文件。图片显示小图，别的显示图标；点叉拿掉。 */
export function StagedCard({ file, onRemove }: { file: File; onRemove: () => void }) {
  const { t } = useTranslation('chats')
  const name = file.name || 'file'
  const isImage = file.type.startsWith('image/')
  const preview = useMemo(() => (isImage ? URL.createObjectURL(file) : null), [file, isImage])
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])
  const Icon = iconFor(name)
  const [stem, extension] = splitFileName(name)
  const remove = t('composer.unstage', { name })
  return (
    <li
      data-testid="staged-file"
      className="flex w-56 max-w-full flex-none items-center gap-2 rounded-control border border-border bg-bg py-1 pr-1 pl-1.5"
    >
      {preview ? (
        <img
          src={preview}
          alt=""
          className="size-10 flex-none rounded-[4px] border border-border bg-white object-cover"
        />
      ) : (
        <span className="grid size-10 flex-none place-items-center rounded-[4px] bg-surface text-fg-2">
          <Icon size={20} strokeWidth={1.5} aria-hidden />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-testid="staged-name" title={name} className="flex min-w-0">
          <span className="truncate">{stem}</span>
          <span className="flex-none">{extension}</span>
        </span>
        <span className="text-[12px] text-fg-3">{formatFileSize(file.size)}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={remove}
        title={remove}
        className="grid size-11 flex-none place-items-center rounded-control text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg md:size-7"
      >
        <X size={16} strokeWidth={1.5} aria-hidden />
      </button>
    </li>
  )
}
