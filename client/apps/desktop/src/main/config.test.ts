import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { builtInServer, isLocalServer, resolveServer } from './config.js'

const url = (argv: string[], env: Record<string, string> = {}, builtIn: string | null = null) => {
  const resolved = resolveServer({ argv, env, builtIn })
  return resolved.ok ? resolved.url.href : `rejected: ${resolved.given}`
}

describe('the server written in when packaging', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vc-built-in-'))
  const file = (name: string, content: string) => {
    const path = join(dir, name)
    writeFileSync(path, content)
    return pathToFileURL(path)
  }

  it('is read from the file next to the app', () => {
    const written = file('ok.json', JSON.stringify({ server: 'https://chat.example.com' }))
    expect(builtInServer(written)).toBe('https://chat.example.com')
  })

  it('is absent when there is no file, or it is broken', () => {
    expect(builtInServer(pathToFileURL(join(dir, 'missing.json')))).toBeNull()
    expect(builtInServer(file('broken.json', '{ server: '))).toBeNull()
    expect(builtInServer(file('empty.json', JSON.stringify({ server: '' })))).toBeNull()
    expect(builtInServer(file('number.json', JSON.stringify({ server: 42 })))).toBeNull()
    expect(builtInServer(file('other.json', JSON.stringify({})))).toBeNull()
  })
})

describe('which server to load', () => {
  it('is the one written in when packaging, unless told otherwise', () => {
    expect(url([], {}, 'https://chat.example.com')).toBe('https://chat.example.com/')
    expect(url(['--server=https://from-flag.example'], {}, 'https://chat.example.com')).toBe(
      'https://from-flag.example/',
    )
    // 哪里都没有给：不能用
    expect(url([])).toBe('rejected: ')
  })

  it('prefers the launch argument, then the environment', () => {
    const env = { VC_SERVER_URL: 'https://from-env.example' }
    expect(url(['--server=https://from-flag.example'], env)).toBe('https://from-flag.example/')
    expect(url(['--other'], env)).toBe('https://from-env.example/')
    // 空的参数等于没有给
    expect(url(['--server='], env)).toBe('https://from-env.example/')
  })

  it('keeps only the origin', () => {
    expect(url(['--server=https://chat.example:8443/some/path?x=1#y'])).toBe(
      'https://chat.example:8443/',
    )
  })

  it('accepts plain http only for this machine', () => {
    expect(url(['--server=http://127.0.0.1:8780'])).toBe('http://127.0.0.1:8780/')
    expect(url(['--server=http://localhost:3490'])).toBe('http://localhost:3490/')
    expect(url(['--server=http://[::1]:3490'])).toBe('http://[::1]:3490/')
    expect(url(['--server=http://chat.example'])).toBe('rejected: http://chat.example')
    expect(url(['--server=http://127.0.0.1.evil.example'])).toMatch(/^rejected/)
  })

  it('rejects anything that is not a web address', () => {
    for (const given of ['not a url', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x']) {
      expect(url([`--server=${given}`]), given).toBe(`rejected: ${given}`)
    }
  })

  it('knows a development server on this machine from a real one', () => {
    expect(isLocalServer(new URL('http://127.0.0.1:8780'))).toBe(true)
    expect(isLocalServer(new URL('https://127.0.0.1:8780'))).toBe(false)
    expect(isLocalServer(new URL('https://chat.example.com'))).toBe(false)
  })
})
