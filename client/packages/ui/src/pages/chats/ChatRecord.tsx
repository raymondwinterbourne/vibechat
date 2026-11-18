// 聊天记录（合并转发）：消息流里的一张卡片，点开是只读的查看页。

import { formatMessageTime } from '@vibechat/core'
import type { ChatRecordView, FileView, RecordItemView } from '@vibechat/protocol'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { Dialog } from '../../components/Dialog'
import { usePreferences } from '../../preferences'
import { FileBody, ImageBody } from './attachments'
import { Lightbox } from './Lightbox'
import { contentLabel } from './text'
import { VoiceBody } from './voice'

/** 卡片上显示前几条的摘要。 */
const SUMMARY_LINES = 4

/** 聊天记录里的一条写成一行字。 */
function itemLabel(item: RecordItemView, t: ReturnType<typeof useTranslation<'chats'>>['t']) {
  // 嵌在里面的聊天记录：标题在文字里
  return contentLabel({ kind: item.kind, text: item.text, file: item.file }, t)
}

interface ChatRecordCardProps {
  record: ChatRecordView
  /** 点开查看。发送中的没有。 */
  onOpen?: () => void
}

/** 消息流里的一条聊天记录：标题、前几条的摘要，底下写着"聊天记录"。 */
export function ChatRecordCard({ record, onOpen }: ChatRecordCardProps) {
  const { t } = useTranslation('chats')
  const content = (
    <>
      <span className="block truncate font-medium" data-testid="chat-record-title">
        {record.title}
      </span>
      <span className="mt-1 block text-[12px] text-fg-2">
        {record.items.slice(0, SUMMARY_LINES).map((item, index) => (
          <span
            // 条目没有自己的编号，按位置
            // biome-ignore lint/suspicious/noArrayIndexKey: 快照不会变
            key={index}
            data-testid="chat-record-line"
            className="block truncate"
          >
            {item.sender_name}: {itemLabel(item, t)}
          </span>
        ))}
      </span>
      <span className="mt-2 block border-border border-t pt-1.5 text-[11px] text-fg-3">
        {t('record.label')}
      </span>
    </>
  )
  const className =
    'block w-[240px] max-w-full rounded-card border border-border bg-bg p-3 text-left md:w-[260px]'
  if (!onOpen) {
    return (
      <div data-testid="chat-record" className={className}>
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid="chat-record"
      onClick={onOpen}
      aria-label={t('record.open', { title: record.title })}
      className={`${className} hover:bg-hover`}
    >
      {content}
    </button>
  )
}

interface RecordViewerProps {
  record: ChatRecordView | null
  onClose: () => void
}

/**
 * 只读的查看页：按原来的先后，每一条带头像、昵称、时间。图片看大图、文件下载、语音播放都可以，
 * 没有其他操作。嵌在里面的聊天记录只有一行标题，不能再点开。
 */
export function RecordViewer({ record, onClose }: RecordViewerProps) {
  const language = usePreferences((state) => state.language)
  const [viewed, setViewed] = useState<FileView | null>(null)
  const now = Date.now()
  return (
    <Dialog
      open={record !== null}
      onOpenChange={(open) => !open && onClose()}
      title={record?.title ?? ''}
      large
    >
      {record && (
        <ul
          data-testid="record-viewer"
          className="-mx-5 -mb-5 flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 pb-5"
        >
          {record.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 快照不会变
            <li key={index} data-testid="record-item" className="flex gap-2.5">
              <Avatar
                user={{
                  id: item.sender_id ?? item.sender_name,
                  nickname: item.sender_name,
                  avatar_file_id: item.sender_avatar_file_id,
                }}
                size={32}
              />
              <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                <p className="flex w-full items-baseline gap-2 text-[12px] text-fg-3">
                  <span className="min-w-0 truncate" data-testid="record-item-name">
                    {item.sender_name}
                  </span>
                  <span className="ml-auto flex-none">
                    {formatMessageTime(item.created_at, now, language)}
                  </span>
                </p>
                <RecordItemBody item={item} onOpenImage={setViewed} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <Lightbox file={viewed} onClose={() => setViewed(null)} />
    </Dialog>
  )
}

function RecordItemBody({
  item,
  onOpenImage,
}: {
  item: RecordItemView
  onOpenImage: (file: FileView) => void
}) {
  const { t } = useTranslation('chats')
  const { file } = item
  if (item.kind === 'chat_record') {
    return <p className="text-fg-2">{itemLabel(item, t)}</p>
  }
  if (!file) {
    return (
      <p data-testid="record-item-text" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {item.text}
      </p>
    )
  }
  if (item.kind === 'voice') {
    return (
      <VoiceBody
        file={file}
        durationMs={item.duration_ms ?? 0}
        mine={false}
        unplayed={false}
        onPlayed={() => {}}
      />
    )
  }
  if (item.kind === 'image') {
    return (
      <>
        <ImageBody file={file} onOpen={() => onOpenImage(file)} />
        {item.text && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</p>}
      </>
    )
  }
  return <FileBody file={file} />
}
