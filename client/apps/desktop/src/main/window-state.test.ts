import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load, save } from './store.js'
import { DEFAULT_SIZE, hidesOnClose, MIN_SIZE, parseBounds, restoreBounds } from './window-state.js'

const LAPTOP = { x: 0, y: 0, width: 1512, height: 982 }
const EXTERNAL = { x: 1512, y: -200, width: 2560, height: 1440 }

describe('where the window opens', () => {
  it('uses the default size, centred by the system, the first time', () => {
    expect(restoreBounds(null, [LAPTOP])).toEqual(DEFAULT_SIZE)
  })

  it('goes back to where it was', () => {
    const saved = { x: 100, y: 80, width: 1000, height: 700 }
    expect(restoreBounds(saved, [LAPTOP])).toEqual(saved)
    const onExternal = { x: 2000, y: 100, width: 1300, height: 900 }
    expect(restoreBounds(onExternal, [LAPTOP, EXTERNAL])).toEqual(onExternal)
  })

  it('keeps the size but lets the system place it when that screen is gone', () => {
    const onExternal = { x: 2000, y: 100, width: 1300, height: 900 }
    expect(restoreBounds(onExternal, [LAPTOP])).toEqual({ width: 1300, height: 900 })
    // 只剩一条边还在屏幕里也算看不到
    const barely = { x: 1500, y: 100, width: 1000, height: 700 }
    expect(restoreBounds(barely, [LAPTOP])).toEqual({ width: 1000, height: 700 })
    expect(restoreBounds({ x: 0, y: 0, width: 800, height: 600 }, [])).toEqual({
      width: 800,
      height: 600,
    })
  })

  it('never opens smaller than the minimum', () => {
    expect(restoreBounds({ x: 10, y: 10, width: 50, height: 50 }, [LAPTOP])).toEqual({
      x: 10,
      y: 10,
      ...MIN_SIZE,
    })
  })

  it('reads saved bounds only when all four numbers are there', () => {
    expect(parseBounds({ x: 1.4, y: 2.6, width: 800, height: 600 })).toEqual({
      x: 1,
      y: 3,
      width: 800,
      height: 600,
    })
    for (const odd of [
      null,
      'x',
      {},
      { x: 1, y: 2, width: 800 },
      { x: '1', y: 2, width: 800, height: 600 },
      { x: Number.NaN, y: 2, width: 800, height: 600 },
      { x: Infinity, y: 2, width: 800, height: 600 },
    ]) {
      expect(parseBounds(odd)).toBeNull()
    }
  })
})

describe('closing the window', () => {
  it('hides it until the user really quits', () => {
    expect(hidesOnClose(false)).toBe(true)
    expect(hidesOnClose(true)).toBe(false)
  })
})

describe('what the app remembers', () => {
  it('gets back what it saved', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vc-desktop-')), 'desktop.json')
    const saved = { window: { x: 5, y: 6, width: 900, height: 700 }, language: 'en' as const }
    save(path, saved)
    expect(load(path)).toEqual(saved)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(saved)
  })

  it('starts fresh when the file is missing or damaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-desktop-'))
    const fresh = { window: null, language: null }
    expect(load(join(dir, 'missing.json'))).toEqual(fresh)
    const path = join(dir, 'desktop.json')
    for (const content of ['', 'not json', 'null', '[]', '{"window":"here","language":"fr"}']) {
      writeFileSync(path, content)
      expect(load(path), content).toEqual(fresh)
    }
    // 存不下来不出错
    expect(() => save(join(dir, 'no-such-dir', 'desktop.json'), fresh)).not.toThrow()
  })
})
