// 消息里的文件从哪里取。平时是普通的文件接口；
// 管理员查看聊天内容时换成带着查看凭据的那一组地址。

import { downloadUrl, fileUrl, thumbnailUrl } from '@vibechat/core'
import { createContext, useContext } from 'react'

export interface FileUrls {
  /** 文件本身：图片的原图、语音。 */
  file: (fileId: string) => string
  /** 图片的缩略图。 */
  thumbnail: (fileId: string) => string
  /** 存到本地。 */
  download: (fileId: string) => string
}

const FileUrlsContext = createContext<FileUrls>({
  file: fileUrl,
  thumbnail: thumbnailUrl,
  download: downloadUrl,
})

export const FileUrlsProvider = FileUrlsContext.Provider

export function useFileUrls(): FileUrls {
  return useContext(FileUrlsContext)
}
