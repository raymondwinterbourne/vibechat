import { describe, expect, it } from 'vitest'
import { clampZoom, MAX_ZOOM, NO_ZOOM, panZoom, toggleZoom, zoomAround } from './zoom'

const BOX = { width: 400, height: 800 }

describe('zooming into a shared screen', () => {
  it('keeps the point under the fingers where it was', () => {
    // 在中心右边 100 处放大两倍：画面上原来在那里的一点，放大之后还在那里
    const zoomed = zoomAround(NO_ZOOM, 2, 100, 0, BOX)
    expect(zoomed).toEqual({ scale: 2, x: -100, y: 0 })
    expect(zoomed.x + zoomed.scale * 100).toBe(100)
  })

  it('never goes below the original size or above the limit', () => {
    expect(zoomAround(NO_ZOOM, 0.5, 0, 0, BOX)).toEqual(NO_ZOOM)
    expect(zoomAround(NO_ZOOM, 10, 0, 0, BOX).scale).toBe(MAX_ZOOM)
  })

  it('cannot be dragged past the edges', () => {
    const zoomed = zoomAround(NO_ZOOM, 2, 0, 0, BOX)
    // 放大两倍：左右最多各挪半个宽度
    expect(panZoom(zoomed, 1000, -1000, BOX)).toEqual({ scale: 2, x: 200, y: -400 })
    // 没放大时拖不动
    expect(panZoom(NO_ZOOM, 50, 50, BOX)).toEqual(NO_ZOOM)
    expect(clampZoom({ scale: 1, x: 30, y: 0 }, BOX)).toEqual(NO_ZOOM)
  })

  it('a double tap zooms in where it was tapped, and the next one zooms back out', () => {
    const zoomed = toggleZoom(NO_ZOOM, 40, -80, BOX)
    expect(zoomed.scale).toBe(2.5)
    expect(zoomed.x + zoomed.scale * 40).toBeCloseTo(40)
    expect(zoomed.y + zoomed.scale * -80).toBeCloseTo(-80)
    expect(toggleZoom(zoomed, 0, 0, BOX)).toEqual(NO_ZOOM)
  })
})
