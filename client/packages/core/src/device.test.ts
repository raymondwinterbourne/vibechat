import { describe, expect, it } from 'vitest'
import { describeDevice } from './device'

describe('describing a device from what the browser reports', () => {
  it('tells the common browsers and systems apart', () => {
    const cases: [string, string | null, string | null][] = [
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Chrome',
        'macOS',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
        'Safari',
        'macOS',
      ],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
        'Safari',
        'iPhone',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
        'Edge',
        'Windows',
      ],
      [
        'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
        'Firefox',
        'Linux',
      ],
      [
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
        'Chrome',
        'Android',
      ],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
        'Chrome',
        'iPhone',
      ],
    ]
    for (const [ua, browser, os] of cases) {
      expect(describeDevice(ua), ua).toEqual({ browser, os, desktop: null })
    }
  })

  it('recognizes the desktop app and its version', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) VibeChat/0.4.0 Chrome/146.0.0.0 Electron/44.5.1 Safari/537.36'
    expect(describeDevice(ua)).toEqual({ browser: null, os: 'macOS', desktop: '0.4.0' })
  })

  it('knows nothing about something it does not recognize', () => {
    expect(describeDevice('')).toEqual({ browser: null, os: null, desktop: null })
    expect(describeDevice('curl/8.0')).toEqual({ browser: null, os: null, desktop: null })
  })
})
