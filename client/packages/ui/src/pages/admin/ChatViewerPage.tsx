import { useQuery } from '@tanstack/react-query'
import { useParams, useRouter } from '@tanstack/react-router'
import {
  ApiError,
  formatMessageTime,
  startView,
  TIME_GAP_MS,
  viewFileUrls,
  viewMessages,
} from '@vibechat/core'
import type { ChatRecordView, FileView, MessageView, ViewStarted } from '@vibechat/protocol'
import { ChevronLeft, Eye, Phone } from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { LoadError } from '../../components/LoadError'
import { useErrorMessage } from '../../errors'
import { FileUrlsProvider } from '../../files'
import { usePreferences } from '../../preferences'
import { FileBody, ImageBody } from '../chats/attachments'
import { Bubble } from '../chats/Bubble'
import { ChatRecordCard, RecordViewer } from '../chats/ChatRecord'
import { Lightbox } from '../chats/Lightbox'
import { MediaFrame } from '../chats/MediaFrame'
import { QuoteBlock } from '../chats/QuoteBlock'
import { callRecordText, eventText } from '../chats/text'
import { VoiceBody } from '../chats/voice'
import { conversationLabel, Tag } from './common'

/** 同一个人连续发的几条只显示一次头像：后面几条在头像的位置留出同样宽的空白。 */
const AVATAR_GAP = <span aria-hidden className="w-8 flex-none" />

/** 取到的一段消息。 */
interface Loaded {
  items: MessageView[]
  /** 还有更早的没有取。 */
  hasMore: boolean
}

function isViewEnded(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'view_required'
}

interface MessagesProps {
  id: string
  started: ViewStarted
  /** 凭据失效了：停下来，问要不要继续。 */
  onEnded: () => void
}

/** 查看中的会话里的消息。只读：没有输入区，消息上没有任何操作。 */
function Messages({ id, started, onEnded }: MessagesProps) {
  const { t } = useTranslation('admin')
  const { t: tChats } = useTranslation('chats')
  const { t: tCommon } = useTranslation()
  const errorMessage = useErrorMessage()
  const language = usePreferences((state) => state.language)
  const view = started.view
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [viewed, setViewed] = useState<FileView | null>(null)
  const [record, setRecord] = useState<ChatRecordView | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // 上一次显示时最早的那条和内容的高度：更早的一段接在前面之后，原来看的那几条不动
  const previous = useRef({ first: 0, height: 0 })

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换了会话或者换了凭据才重新取
  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setError(null)
    viewMessages(id, view)
      .then((page) => {
        if (!cancelled) setLoaded({ items: page.items, hasMore: page.has_more })
      })
      .catch((cause) => {
        if (cancelled) return
        if (isViewEnded(cause)) onEnded()
        else setError(cause)
      })
    return () => {
      cancelled = true
    }
  }, [id, view])

  const first = loaded?.items[0]?.seq ?? 0
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (previous.current.first === 0) {
      // 刚取到：停在最新的一条
      element.scrollTop = element.scrollHeight
    } else if (first < previous.current.first) {
      element.scrollTop += element.scrollHeight - previous.current.height
    }
    previous.current = { first, height: element.scrollHeight }
  }, [first])

  async function loadOlder() {
    if (!loaded || loadingOlder || first === 0) return
    setLoadingOlder(true)
    try {
      const page = await viewMessages(id, view, { before: first })
      setLoaded({ items: [...page.items, ...loaded.items], hasMore: page.has_more })
    } catch (cause) {
      if (isViewEnded(cause)) onEnded()
      else setError(cause)
    } finally {
      setLoadingOlder(false)
    }
  }

  if (error) {
    return (
      <div className="min-h-0 flex-1">
        <LoadError message={errorMessage(error)} onRetry={() => window.location.reload()} />
      </div>
    )
  }

  const members = started.members
  const now = Date.now()
  const rows: ReactNode[] = []
  let previousTime: number | null = null
  let previousSender: string | null = null

  function body(message: MessageView): { content: ReactNode; bare: boolean } {
    const shown = message.record
    if (shown) {
      return {
        content: <ChatRecordCard record={shown} onOpen={() => setRecord(shown)} />,
        bare: true,
      }
    }
    const file = message.file
    if (file) {
      const media =
        message.kind === 'image' ? (
          <ImageBody file={file} onOpen={() => setViewed(file)} />
        ) : message.kind === 'voice' ? (
          <VoiceBody
            file={file}
            durationMs={message.duration_ms ?? 0}
            mine={false}
            unplayed={false}
            // 管理员听了不算谁"听过"
            onPlayed={() => {}}
          />
        ) : (
          <FileBody file={file} />
        )
      return {
        content: (
          <MediaFrame
            mine={false}
            quote={
              message.reply && <QuoteBlock quote={message.reply} name={message.reply.sender_name} />
            }
            caption={message.kind === 'image' && message.text ? message.text : undefined}
          >
            {media}
          </MediaFrame>
        ),
        bare: true,
      }
    }
    if (message.kind === 'call') {
      // 通话记录：和主叫看到的一样（时长或原因）。通话本身不录音，没有别的内容
      return {
        content: (
          <span data-testid="call-record" className="flex items-center gap-2">
            <Phone size={16} strokeWidth={1.75} aria-hidden className="flex-none" />
            {callRecordText(message, message.sender_id ?? '', tChats).text}
          </span>
        ),
        bare: false,
      }
    }
    return {
      content: (
        <>
          {message.reply && <QuoteBlock quote={message.reply} name={message.reply.sender_name} />}
          <span data-testid="message-text">{message.text}</span>
        </>
      ),
      bare: false,
    }
  }

  // 编辑过的消息的每一次修改（F8）：修改之前的内容在编辑事件里，按先后
  const versions = new Map<number, { previous: string | null; at: number }[]>()
  for (const message of loaded?.items ?? []) {
    if (message.kind !== 'edited' || message.target_seq === null) continue
    const list = versions.get(message.target_seq) ?? []
    list.push({ previous: message.previous_text, at: message.created_at })
    versions.set(message.target_seq, list)
  }

  for (const message of loaded?.items ?? []) {
    // 撤回、编辑事件本身不显示：被撤回的那一条上标着"已撤回"，被编辑的那一条下面有修改记录
    if (message.kind === 'recalled' || message.kind === 'edited') continue
    if (previousTime === null || message.created_at - previousTime > TIME_GAP_MS) {
      previousSender = null
      rows.push(
        <p key={`time-${message.id}`} className="self-center text-[11px] text-fg-3">
          {formatMessageTime(message.created_at, now, language)}
        </p>,
      )
    }
    previousTime = message.created_at
    const isMessage =
      message.kind === 'text' ||
      message.kind === 'image' ||
      message.kind === 'file' ||
      message.kind === 'voice' ||
      message.kind === 'chat_record' ||
      message.kind === 'call'
    if (!isMessage) {
      previousSender = null
      rows.push(
        <p
          key={message.id}
          data-testid="message-event"
          data-seq={message.seq}
          className="max-w-[90%] self-center text-center text-[12px] text-fg-3 [overflow-wrap:anywhere]"
        >
          {/* 管理员不是成员：事件里的人都按当时的昵称写 */}
          {eventText(message, undefined, '', tChats)}
          {/* 群公告的全文：管理员打不开公告的对话框，直接写在这一行下面 */}
          {message.kind === 'notice_changed' && message.text && (
            <span
              data-testid="notice-event-text"
              className="mt-1 block whitespace-pre-wrap text-left text-fg-2"
            >
              {message.text}
            </span>
          )}
        </p>,
      )
      continue
    }
    const sender = members.find((member) => member.user.id === message.sender_id)
    const name = sender?.user.nickname ?? message.sender_name ?? ''
    const user = sender?.user ?? {
      id: message.sender_id ?? '',
      nickname: name,
      avatar_file_id: null,
    }
    const continued = previousSender === message.sender_id
    previousSender = message.sender_id
    const { content, bare } = body(message)
    const history = versions.get(message.seq) ?? []
    rows.push(
      <Bubble
        key={message.id}
        mine={false}
        bare={bare}
        seq={message.seq}
        avatar={continued ? AVATAR_GAP : <Avatar user={user} size={32} />}
        name={continued ? null : name}
        note={message.recalled ? t('viewer.recalled') : undefined}
        edited={message.edited_at !== null}
      >
        {content}
        {history.length > 0 && (
          <details data-testid="edit-history" className="mt-1 text-[12px] text-fg-2">
            <summary className="cursor-pointer select-none">
              {t('viewer.editHistory', { count: history.length })}
            </summary>
            <ol className="mt-1 flex flex-col gap-1">
              {history.map((version) => (
                <li
                  key={version.at}
                  data-testid="edit-version"
                  className="[overflow-wrap:anywhere]"
                >
                  <span className="text-fg-3">
                    {t('viewer.versionBefore', {
                      time: formatMessageTime(version.at, now, language),
                    })}
                  </span>
                  <span className="whitespace-pre-wrap">{version.previous ?? ''}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </Bubble>,
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        data-testid="message-list"
        className="flex h-full flex-col gap-3 overflow-y-auto p-3 [overflow-anchor:none] md:p-4"
      >
        {loaded?.hasMore && (
          <Button onClick={() => void loadOlder()} disabled={loadingOlder} className="self-center">
            {t('viewer.loadOlder')}
          </Button>
        )}
        {rows}
        {loaded && rows.length === 0 && <p className="m-auto text-fg-3">{t('viewer.empty')}</p>}
      </div>
      {!loaded && (
        <p
          role="status"
          data-testid="loading"
          className="pointer-events-none absolute inset-0 grid place-items-center text-fg-3"
        >
          {tCommon('loading')}
        </p>
      )}
      <Lightbox file={viewed} onClose={() => setViewed(null)} />
      <RecordViewer record={record} onClose={() => setRecord(null)} />
    </div>
  )
}

/**
 * 管理员只读地查看一个会话。打开这一页就是"开始一次查看"：服务端先写下操作记录，
 * 再交出查看凭据；凭据过期之后要再开始一次，又是一条记录。
 */
export function ChatViewerPage() {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const router = useRouter()
  const { conversationId: id } = useParams({ from: '/app/admin/chats/$conversationId' })
  const [ended, setEnded] = useState(false)

  const view = useQuery({
    queryKey: ['admin', 'view', id],
    queryFn: () => startView(id),
    // 一次查看只开始一次：不因为切回页面而重来；离开这一页就丢掉，再进来算新的一次
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const started = view.data

  // 到了失效的时间就停下来，不等下一次请求被拒绝
  const expiresAt = started?.expires_at
  useEffect(() => {
    if (expiresAt === undefined) return
    setEnded(false)
    const timer = window.setTimeout(() => setEnded(true), Math.max(0, expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [expiresAt])

  const urls = useMemo(() => (started ? viewFileUrls(id, started.view) : null), [id, started])

  const conversation = started?.conversation
  const title = conversation ? conversationLabel(conversation, t('chats.unnamedSeparator')) : ''
  return (
    <div data-testid="admin-viewer" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] flex-none items-center gap-1 border-border border-b px-2 md:px-4">
        <button
          type="button"
          onClick={() => router.history.back()}
          aria-label={t('viewer.back')}
          title={t('viewer.back')}
          className="grid size-11 flex-none place-items-center rounded-control text-fg-2 hover:bg-hover hover:text-fg md:size-9"
        >
          <ChevronLeft size={22} strokeWidth={1.5} aria-hidden />
        </button>
        <h1
          data-testid="admin-viewer-title"
          className="min-w-0 flex-1 truncate font-medium text-[17px] md:text-[15px]"
        >
          {title}
        </h1>
        {conversation?.dissolved && <Tag tone="danger">{t('chats.dissolved')}</Tag>}
      </header>
      <p
        role="status"
        data-testid="admin-viewer-banner"
        className="flex flex-none items-center gap-2 border-danger/30 border-b bg-danger/10 px-4 py-2 text-danger"
      >
        <Eye size={16} strokeWidth={1.5} aria-hidden className="flex-none" />
        <span>
          <span className="font-medium">{t('viewer.banner')}</span>
          <span className="max-md:block md:ml-2">{t('viewer.bannerDetail')}</span>
        </span>
      </p>
      {view.isError ? (
        <LoadError message={errorMessage(view.error)} onRetry={() => void view.refetch()} />
      ) : !started || !urls ? null : ended ? (
        <div
          data-testid="admin-viewer-ended"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        >
          <p className="text-fg-2">{t('viewer.expired')}</p>
          <Button variant="primary" onClick={() => void view.refetch()} disabled={view.isFetching}>
            {t('viewer.resume')}
          </Button>
        </div>
      ) : (
        <FileUrlsProvider value={urls}>
          <Messages id={id} started={started} onEnded={() => setEnded(true)} />
        </FileUrlsProvider>
      )}
    </div>
  )
}
