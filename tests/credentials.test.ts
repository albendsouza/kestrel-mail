import fs from 'fs'

import { describe, expect, it } from 'vitest'

import { parseGoogleCredentials } from '../src/shared/credentials'

// kestrel.local.json (git-ignored) may point at your real client JSON; its contents are never printed.
const local = fs.existsSync('kestrel.local.json') ? JSON.parse(fs.readFileSync('kestrel.local.json', 'utf8')) : {}
const realFile: string | undefined = local.googleCredentials && fs.existsSync(local.googleCredentials) ? local.googleCredentials : undefined

describe('parseGoogleCredentials', () => {
  it('reads a Desktop app client', () => {
    const json = JSON.stringify({ installed: { client_id: '1-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test', redirect_uris: ['http://localhost'] } })
    expect(parseGoogleCredentials(json)).toEqual({ ok: true, clientId: '1-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-test' })
  })

  it('explains the wrong kind of file', () => {
    expect(parseGoogleCredentials('not json')).toMatchObject({ ok: false, error: expect.stringContaining("isn't JSON") })
    expect(parseGoogleCredentials(JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('Web application')
    })
    expect(parseGoogleCredentials('{}')).toMatchObject({ ok: false, error: expect.stringContaining('no Desktop app client') })
  })

  it.runIf(realFile)('reads your client JSON from kestrel.local.json', () => {
    const parsed = parseGoogleCredentials(fs.readFileSync(realFile!, 'utf8'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.clientId.endsWith('.apps.googleusercontent.com')).toBe(true)
      expect(parsed.clientSecret.length).toBeGreaterThan(10)
    }
  })
})
