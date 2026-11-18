import { describe, expect, it } from 'vitest'
import { formatFileSize, splitFileName } from './files'

describe('file sizes', () => {
  it('are written the way people read them', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(12 * 1024 * 1024)).toBe('12 MB')
    expect(formatFileSize(100 * 1024 * 1024)).toBe('100 MB')
    expect(formatFileSize(1.25 * 1024 ** 3)).toBe('1.3 GB')
  })
})

describe('file names', () => {
  it('split into a stem and an extension that is always shown', () => {
    expect(splitFileName('季度报告.pdf')).toEqual(['季度报告', '.pdf'])
    expect(splitFileName('archive.tar.gz')).toEqual(['archive.tar', '.gz'])
    expect(splitFileName('README')).toEqual(['README', ''])
    // 以点开头的、以点结尾的、点后面太长的，都当作没有扩展名
    expect(splitFileName('.gitignore')).toEqual(['.gitignore', ''])
    expect(splitFileName('notes.')).toEqual(['notes.', ''])
    expect(splitFileName('v1.0 final version of the plan')).toEqual([
      'v1.0 final version of the plan',
      '',
    ])
  })
})
