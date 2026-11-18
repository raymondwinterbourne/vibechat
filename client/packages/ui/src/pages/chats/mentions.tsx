// 消息里的 @：文字里就是"@昵称"，另外带着被 @ 的人的编号。

import { publicName } from '@vibechat/core'
import type { MemberView, MessageView } from '@vibechat/protocol'
import type { ReactNode } from 'react'

/** "@ 所有人"在两种语言里写成的样子。发的人用的是哪种语言，读的人都要能认出来。 */
const MENTION_ALL_TOKENS = ['@所有人', '@All']

/** 输入"@"之后正在打的那一段：从哪里开始，打了什么。 */
export interface MentionQuery {
  /** "@"在文字里的位置。 */
  start: number
  query: string
}

const QUERY_MAX_CHARS = 20

/** 光标前面是不是正在打一个 @：往回找到"@"，中间不能有空白。 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  for (let index = caret - 1; index >= 0 && caret - index <= QUERY_MAX_CHARS + 1; index--) {
    const char = text[index] ?? ''
    if (char === '@') return { start: index, query: text.slice(index + 1, caret) }
    if (/\s/.test(char)) return null
  }
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把消息文字里 @ 到的名字标出来。只标真的 @ 了的人：碰巧写了"@某某"的不算。 */
export function highlightMentions(
  message: MessageView,
  members: readonly MemberView[] | undefined,
  className: string,
): ReactNode {
  const text = message.text ?? ''
  const tokens = message.mention_all ? [...MENTION_ALL_TOKENS] : []
  for (const id of message.mentions) {
    const member = members?.find((candidate) => candidate.user.id === id)
    // 写进去的是群内昵称或昵称：两种都认，改过群内昵称之前的消息也标得出来
    if (member) tokens.push(...new Set([`@${publicName(member)}`, `@${member.user.nickname}`]))
  }
  if (tokens.length === 0) return text
  // 长的在前：有人叫"小明"、有人叫"小明明"时，先认长的
  tokens.sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`)
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: 同一段文字切出来的顺序不会变
      <span key={index} data-testid="mention" className={className}>
        {part}
      </span>
    ) : (
      part
    ),
  )
}
