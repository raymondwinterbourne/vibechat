// 窗口的大小和位置：关闭时记下，下次打开时恢复。

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_SIZE = { width: 1200, height: 800 }
export const MIN_SIZE = { width: 380, height: 560 }

/** 至少要有这么多像素落在某一块屏幕里，才算"还看得到"。 */
const VISIBLE_MIN = 100

/** 从保存的内容里读出窗口的位置。不是合法的内容时返回空。 */
export function parseBounds(value: unknown): Bounds | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, width, height } = value as Record<string, unknown>
  const numbers = [x, y, width, height]
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return {
    x: Math.round(x as number),
    y: Math.round(y as number),
    width: Math.round(width as number),
    height: Math.round(height as number),
  }
}

/**
 * 这次用什么位置打开窗口。
 * 上次的位置还在某一块屏幕里就用它（大小不小于下限）；
 * 否则（没有记过，或者那块屏幕已经拔掉了）只给大小，位置交给系统居中。
 */
export function restoreBounds(
  saved: Bounds | null,
  displays: readonly Bounds[],
): Partial<Bounds> & { width: number; height: number } {
  if (!saved) return { ...DEFAULT_SIZE }
  const width = Math.max(saved.width, MIN_SIZE.width)
  const height = Math.max(saved.height, MIN_SIZE.height)
  const visible = displays.some((display) => {
    const overlapX =
      Math.min(saved.x + width, display.x + display.width) - Math.max(saved.x, display.x)
    const overlapY =
      Math.min(saved.y + height, display.y + display.height) - Math.max(saved.y, display.y)
    return overlapX >= VISIBLE_MIN && overlapY >= VISIBLE_MIN
  })
  return visible ? { x: saved.x, y: saved.y, width, height } : { width, height }
}

/**
 * 用户点了窗口的关闭按钮：是把窗口藏起来（应用继续运行），还是让它真的关掉。
 * Mac 上的习惯是藏起来，直到用户选了"退出"。
 */
export function hidesOnClose(quitting: boolean): boolean {
  return !quitting
}
