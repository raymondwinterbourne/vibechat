// 文件的显示：大小写成人读的样子，文件名拆成"名字"和"扩展名"。

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 字节数写成人读的样子，例如 `1.5 MB`。不到 1 KB 的按字节写。 */
export function formatFileSize(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  // 小的数留一位小数，大的不留：1.5 MB，12 MB
  const digits = unit === 0 || value >= 10 ? 0 : 1
  const text = value.toFixed(digits).replace(/\.0$/, '')
  return `${text} ${UNITS[unit]}`
}

/** 扩展名最多这么长；更长的多半不是扩展名，只是名字里有个点。 */
const EXTENSION_MAX = 8

/**
 * 把文件名拆成两段：前面的名字，和最后的扩展名（带着点）。
 * 名字很长时界面在中间省略，扩展名总是看得到。没有扩展名时第二段为空。
 */
export function splitFileName(name: string): [stem: string, extension: string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1 || name.length - dot - 1 > EXTENSION_MAX) {
    return [name, '']
  }
  return [name.slice(0, dot), name.slice(dot)]
}
