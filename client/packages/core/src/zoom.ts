// 手机上看对方共享的屏幕时放大、拖动（F7 Q6）。这里只算放大多少、挪了多少，手势在界面里。
//
// 画面的变换是"先按中心放大 scale 倍，再挪 (x, y)"：相对于中心的一点 q 落在 x + scale·q。
// 放大之后画面要一直盖满显示的区域，不能拖出空白来。

export interface Zoom {
  scale: number
  x: number
  y: number
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 }
/** 最多放大几倍。 */
export const MAX_ZOOM = 4
/** 双击放大到几倍。 */
export const DOUBLE_TAP_ZOOM = 2.5

/** 显示区域的大小。 */
export interface Box {
  width: number
  height: number
}

/** 不能缩得比原来小，也不能拖出空白。 */
export function clampZoom(zoom: Zoom, box: Box): Zoom {
  const scale = Math.min(MAX_ZOOM, Math.max(1, zoom.scale))
  const maxX = ((scale - 1) * box.width) / 2
  const maxY = ((scale - 1) * box.height) / 2
  return {
    scale,
    x: Math.min(maxX, Math.max(-maxX, zoom.x)),
    y: Math.min(maxY, Math.max(-maxY, zoom.y)),
  }
}

/** 以一点为中心放大 `factor` 倍：手指下面的那一处不动。点的坐标相对于显示区域的中心。 */
export function zoomAround(zoom: Zoom, factor: number, x: number, y: number, box: Box): Zoom {
  const scale = Math.min(MAX_ZOOM, Math.max(1, zoom.scale * factor))
  const ratio = scale / zoom.scale
  return clampZoom({ scale, x: x - (x - zoom.x) * ratio, y: y - (y - zoom.y) * ratio }, box)
}

/** 拖动。 */
export function panZoom(zoom: Zoom, dx: number, dy: number, box: Box): Zoom {
  return clampZoom({ ...zoom, x: zoom.x + dx, y: zoom.y + dy }, box)
}

/** 双击：没放大时以那一点为中心放大，放大了就还原。 */
export function toggleZoom(zoom: Zoom, x: number, y: number, box: Box): Zoom {
  return zoom.scale > 1 ? NO_ZOOM : zoomAround(NO_ZOOM, DOUBLE_TAP_ZOOM, x, y, box)
}
