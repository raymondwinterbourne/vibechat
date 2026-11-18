import { describe, expect, it } from 'vitest'
import { fromServer, judge, mediaToAsk, screenAccessOf, usesSystemPicker } from './policy.js'

const SERVER = new URL('https://chat.example.com')
const OFFLINE =
  'file:///Applications/VibeChat.app/Contents/Resources/app/resources/offline/index.html'
const verdict = (target: string) => judge(target, SERVER, OFFLINE)

describe('where the window may go', () => {
  it('stays on the server', () => {
    expect(verdict('https://chat.example.com/')).toBe('allow')
    expect(verdict('https://chat.example.com/chats/abc?x=1#y')).toBe('allow')
    expect(verdict('https://chat.example.com/api/desktop/download')).toBe('allow')
  })

  it('hands other web pages to the system browser', () => {
    expect(verdict('https://example.com/')).toBe('external')
    expect(verdict('http://example.com/')).toBe('external')
  })

  it('treats a look-alike address as another site', () => {
    for (const target of [
      'http://chat.example.com/', // 不是加密的
      'https://chat.example.com:8443/', // 端口不同
      'https://chat.example.com.evil.example/',
      'https://evil.example/https://chat.example.com/',
      'https://chat.example.com@evil.example/',
      'https://sub.chat.example.com/',
    ]) {
      expect(verdict(target), target).toBe('external')
    }
  })

  it('opens its own offline page and no other local file', () => {
    expect(verdict(OFFLINE)).toBe('allow')
    expect(verdict(`${OFFLINE}?lang=en`)).toBe('allow')
    expect(verdict('file:///etc/passwd')).toBe('deny')
    expect(verdict('file:///Applications/VibeChat.app/Contents/Resources/app/package.json')).toBe(
      'deny',
    )
  })

  it('does nothing for addresses that could start other programs', () => {
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/1234',
      'mailto:someone@example.com',
      'ssh://host',
      'vscode://open',
      'about:blank',
      'not a url',
      '',
    ]) {
      expect(verdict(target), target).toBe('deny')
    }
  })
})

describe('who a message came from', () => {
  it('counts only pages on the server', () => {
    expect(fromServer('https://chat.example.com/settings', SERVER)).toBe(true)
    expect(fromServer('https://example.com/', SERVER)).toBe(false)
    expect(fromServer(OFFLINE, SERVER)).toBe(false)
    expect(fromServer('about:blank', SERVER)).toBe(false)
    expect(fromServer('', SERVER)).toBe(false)
    expect(fromServer(undefined, SERVER)).toBe(false)
    expect(fromServer('not a url', SERVER)).toBe(false)
  })
})

describe('what the page may use for media', () => {
  it('gets the microphone for sound and the camera for pictures', () => {
    expect(mediaToAsk(['audio'])).toEqual(['microphone'])
    expect(mediaToAsk(['video'])).toEqual(['camera'])
    expect(mediaToAsk(['audio', 'video'])).toEqual(['microphone', 'camera'])
    expect(mediaToAsk([])).toEqual([])
  })

  it('gets nothing when it asks for anything else, such as the screen', () => {
    expect(mediaToAsk(['audio', 'screen'])).toBeNull()
    expect(mediaToAsk(['display'])).toBeNull()
  })
})

describe('sharing the screen', () => {
  it('uses the system picker from macOS 15 on', () => {
    expect(usesSystemPicker('darwin', '15.0.0')).toBe(true)
    expect(usesSystemPicker('darwin', '26.1')).toBe(true)
    expect(usesSystemPicker('darwin', '14.7.1')).toBe(false)
    expect(usesSystemPicker('win32', '10.0.22631')).toBe(false)
  })

  it('tells the page whether recording the screen is allowed, unless the picker decides', () => {
    expect(screenAccessOf('granted', false)).toBe('granted')
    expect(screenAccessOf('denied', false)).toBe('denied')
    expect(screenAccessOf('not-determined', false)).toBe('denied')
    expect(screenAccessOf('denied', true)).toBe('unknown')
  })
})
