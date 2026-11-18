/**
 * 把文字放进剪贴板，返回是否成功。
 *
 * 浏览器只在安全连接（HTTPS 或本机）下提供新的剪贴板接口。
 * 其他情况（例如用内网地址通过 HTTP 访问）退回到旧的办法。
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 被浏览器拒绝时继续尝试旧的办法
    }
  }
  return copyWithSelection(text)
}

function copyWithSelection(text: string): boolean {
  const holder = document.createElement('textarea')
  holder.value = text
  holder.setAttribute('readonly', '')
  // 放在看不见的地方，避免页面跳动
  holder.style.position = 'fixed'
  holder.style.opacity = '0'
  document.body.append(holder)
  holder.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  holder.remove()
  return copied
}
