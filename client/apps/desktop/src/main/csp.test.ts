import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy } from '../../../web/csp.js'
import { ensurePolicy, fallbackPolicy } from './csp.js'

const SERVER = new URL('https://chat.example.com')

describe('the content security policy', () => {
  it('runs scripts from the server only, never inline ones', () => {
    const directives = Object.fromEntries(
      fallbackPolicy(SERVER)
        .split('; ')
        .map((directive) => {
          const [name, ...values] = directive.split(' ')
          return [name, values]
        }),
    )
    expect(directives['script-src']).toEqual(["'self'"])
    expect(directives['default-src']).toEqual(["'self'"])
    expect(directives['object-src']).toEqual(["'none'"])
    expect(directives['frame-ancestors']).toEqual(["'none'"])
    expect(directives['connect-src']).toContain('wss://chat.example.com')
    for (const values of Object.values(directives)) {
      expect(values).not.toContain("'unsafe-eval'")
      expect(values).not.toContain('*')
    }
  })

  it('is the same policy the web app sends for itself', () => {
    expect(fallbackPolicy(SERVER)).toBe(contentSecurityPolicy(SERVER.host))
    const local = new URL('http://127.0.0.1:3490')
    expect(fallbackPolicy(local)).toBe(contentSecurityPolicy('127.0.0.1:3490'))
  })

  it('is added only when the server did not send one', () => {
    const bare = { 'content-type': ['text/html'] }
    expect(ensurePolicy(bare, SERVER)).toEqual({
      ...bare,
      'Content-Security-Policy': [fallbackPolicy(SERVER)],
    })
    for (const name of [
      'Content-Security-Policy',
      'content-security-policy',
      'CONTENT-SECURITY-POLICY',
    ]) {
      const sent = { [name]: ["default-src 'none'"] }
      expect(ensurePolicy(sent, SERVER)).toBe(sent)
    }
  })
})
