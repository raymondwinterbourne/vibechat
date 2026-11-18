import { fileUrl } from '@vibechat/core'

interface AvatarProps {
  user: { id: string; nickname: string; avatar_file_id: string | null }
  /** 边长，像素。 */
  size?: number
}

const PALETTE_SIZE = 8

/** 由内部编号算出一个固定的颜色序号：同一个用户在任何地方的默认头像颜色都一样。 */
function paletteIndex(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % PALETTE_SIZE
}

/** 头像。没有上传过头像时显示昵称的第一个字。 */
export function Avatar({ user, size = 36 }: AvatarProps) {
  const style = { width: size, height: size }
  if (user.avatar_file_id) {
    return (
      <img
        src={fileUrl(user.avatar_file_id)}
        alt=""
        style={style}
        className="flex-none rounded-card bg-surface object-cover"
      />
    )
  }
  // 按字符而不是按编码单元取第一个字，表情符号之类不会被截成半个
  const initial = Array.from(user.nickname.trim())[0] ?? '?'
  return (
    <span
      aria-hidden
      style={{
        ...style,
        fontSize: Math.round(size * 0.42),
        background: `var(--vc-avatar-${paletteIndex(user.id)})`,
      }}
      className="grid flex-none select-none place-items-center rounded-card font-medium text-on-accent"
    >
      {initial.toUpperCase()}
    </span>
  )
}
