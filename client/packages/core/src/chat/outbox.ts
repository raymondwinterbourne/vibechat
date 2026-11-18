// 还没有得到服务端确认的消息，保存在这台设备的浏览器里：刷新页面、重新打开浏览器之后，
// 发送失败的消息仍然在会话里，可以重发或删掉。确认了就从这里删掉。
//
// 只在这台设备上，不跟着账号走；按用户分开存放。退出登录、登录失效时整个清掉。

import type { FileView, QuoteView } from '@vibechat/protocol'
import type { Mentions } from './api'
import type { PendingForward, PendingMerge } from './thread'

/** 保存下来的一条消息。 */
export interface OutboxEntry {
  /** 谁发的：只交还给同一个用户。 */
  userId: string
  conversationId: string
  clientId: string
  /** 文字；带文件时是图片的说明。 */
  text: string
  mentions?: Mentions
  reply?: QuoteView
  /** 转发：来源和原消息的样子。 */
  forward?: PendingForward
  /** 合并转发：来源和聊天记录的样子。 */
  merge?: PendingMerge
  createdAt: number
  attachment?: {
    /** 文件本身。浏览器的存储空间不够、没存下来时为 null。 */
    content: Blob | null
    name: string
    size: number
    voiceDurationMs?: number
    /** 已经传上去了：服务端交回来的文件。 */
    file?: FileView
  }
}

export interface Outbox {
  /** 这个用户在这个会话里保存着的消息，按发出的先后。 */
  load(userId: string, conversationId: string): Promise<OutboxEntry[]>
  /** 存下或更新一条。存不下文件时，文件以外的部分照样存下。 */
  put(entry: OutboxEntry): Promise<void>
  remove(userId: string, clientId: string): Promise<void>
  /** 全部清掉：退出登录、登录失效时。 */
  clear(): Promise<void>
}

const byTime = (a: OutboxEntry, b: OutboxEntry) => a.createdAt - b.createdAt

/** 放在内存里的一份。测试用；浏览器不支持 IndexedDB 时也用它（刷新后就没有了）。 */
export class MemoryOutbox implements Outbox {
  readonly entries = new Map<string, OutboxEntry>()

  async load(userId: string, conversationId: string): Promise<OutboxEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.userId === userId && entry.conversationId === conversationId)
      .sort(byTime)
  }

  async put(entry: OutboxEntry): Promise<void> {
    this.entries.set(`${entry.userId}/${entry.clientId}`, entry)
  }

  async remove(userId: string, clientId: string): Promise<void> {
    this.entries.delete(`${userId}/${clientId}`)
  }

  async clear(): Promise<void> {
    this.entries.clear()
  }
}

const DATABASE = 'vibechat-outbox'
const STORE = 'messages'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/** IndexedDB 里存的样子：文件存成字节和类型。Safari 的无痕模式不让 IndexedDB 存 Blob，字节可以。 */
type StoredEntry = Omit<OutboxEntry, 'attachment'> & {
  attachment?: Omit<NonNullable<OutboxEntry['attachment']>, 'content'> & {
    content: { bytes: ArrayBuffer; type: string } | null
  }
}

async function toStored(entry: OutboxEntry): Promise<StoredEntry> {
  const { attachment } = entry
  if (!attachment) return { ...entry, attachment: undefined }
  const { content } = attachment
  return {
    ...entry,
    attachment: {
      ...attachment,
      content: content && { bytes: await content.arrayBuffer(), type: content.type },
    },
  }
}

function fromStored(stored: StoredEntry): OutboxEntry {
  const { attachment } = stored
  if (!attachment) return { ...stored, attachment: undefined }
  const { content } = attachment
  return {
    ...stored,
    attachment: {
      ...attachment,
      content: content && new Blob([content.bytes], { type: content.type }),
    },
  }
}

/** 存在浏览器的 IndexedDB 里。 */
export class IndexedDbOutbox implements Outbox {
  private database: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      const opening = indexedDB.open(DATABASE, 1)
      opening.onupgradeneeded = () => {
        const store = opening.result.createObjectStore(STORE, { keyPath: ['userId', 'clientId'] })
        store.createIndex('conversation', ['userId', 'conversationId'])
      }
      this.database = request(opening)
      // 打不开的话下次再试
      this.database.catch(() => {
        this.database = null
      })
    }
    return this.database
  }

  async load(userId: string, conversationId: string): Promise<OutboxEntry[]> {
    const database = await this.open()
    const index = database.transaction(STORE).objectStore(STORE).index('conversation')
    const found = await request(index.getAll([userId, conversationId]))
    return (found as StoredEntry[]).map(fromStored).sort(byTime)
  }

  async put(entry: OutboxEntry): Promise<void> {
    const database = await this.open()
    const stored = await toStored(entry)
    try {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(stored)
      await done(transaction)
    } catch (error) {
      // 多半是存储空间不够：文件不存了，其余的照样存下，至少知道有这么一条没发出去
      if (!stored.attachment?.content) throw error
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put({
        ...stored,
        attachment: { ...stored.attachment, content: null },
      })
      await done(transaction)
    }
  }

  async remove(userId: string, clientId: string): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).delete([userId, clientId])
    await done(transaction)
  }

  async clear(): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).clear()
    await done(transaction)
  }
}

/** 这个浏览器里用的那一份。 */
export function browserOutbox(): Outbox {
  return typeof indexedDB === 'undefined' ? new MemoryOutbox() : new IndexedDbOutbox()
}
