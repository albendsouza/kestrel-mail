// Google OAuth for installed apps: system browser + loopback redirect + PKCE.
// https://developers.google.com/identity/protocols/oauth2/native-app

import crypto from 'crypto'
import fs from 'fs'
import http from 'http'

import { parseGoogleCredentials } from '../shared/credentials'

import { openExternalSafely } from './security'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

// Tells Google to cancel a refresh token, so Kestrel's access to that account ends
// there too (it disappears from myaccount.google.com/permissions). Best effort:
// returns false if Google couldn't be reached, and the token is forgotten anyway.
export async function revokeToken(token: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(8000)
    })
    // 400 means the token was already invalid: as good as revoked.
    return res.ok || res.status === 400
  } catch {
    return false
  }
}
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.modify']
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export interface GoogleClient {
  clientId: string
  clientSecret: string
}

// Filled in by scripts/build.mjs from the build environment; empty in dev builds without one.
declare const __KESTREL_GOOGLE_CLIENT_ID__: string
declare const __KESTREL_GOOGLE_CLIENT_SECRET__: string

// The environment wins so a developer can test with another client; otherwise use the built-in one.
// Desktop OAuth client IDs always end this way; catches a pasted secret or project ID.
export const isGoogleClientId = (id: string) => /^[\w-]+\.apps\.googleusercontent\.com$/.test(id.trim())

// KESTREL_GOOGLE_CREDENTIALS may point at the client JSON downloaded from Google Cloud.
function clientFromCredentialsFile(): GoogleClient | null {
  const file = process.env.KESTREL_GOOGLE_CREDENTIALS
  if (!file) return null
  try {
    const parsed = parseGoogleCredentials(fs.readFileSync(file, 'utf8'))
    if (parsed.ok) return { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
    console.error(`KESTREL_GOOGLE_CREDENTIALS: ${parsed.error}`)
  } catch (e) {
    console.error(`KESTREL_GOOGLE_CREDENTIALS: can't read ${file} (${e instanceof Error ? e.message : e})`)
  }
  return null
}

export function googleClientFromEnv(): GoogleClient | null {
  const fromFile = clientFromCredentialsFile()
  if (fromFile) return fromFile
  const clientId = process.env.KESTREL_GOOGLE_CLIENT_ID || __KESTREL_GOOGLE_CLIENT_ID__
  const clientSecret = process.env.KESTREL_GOOGLE_CLIENT_SECRET || __KESTREL_GOOGLE_CLIENT_SECRET__
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

export interface SignInResult {
  email: string
  name: string
  refreshToken: string
  accessToken: string
  expiresAt: number
}

const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Kestrel</title><body style="font:16px system-ui;padding:48px">${message}</body>`

// Sign-in failures the welcome screen explains in plain words.
export class SignInError extends Error {
  constructor(
    readonly code: 'cancelled' | 'denied' | 'timeout' | 'no-refresh-token' | 'network' | 'failed',
    message: string
  ) {
    super(message)
  }
}

export interface SignInOptions {
  signal?: AbortSignal
  // Receives the consent URL so the user can reopen the browser tab.
  onAuthUrl?: (url: string) => void
}

export async function signInWithGoogle(client: GoogleClient, { signal, onAuthUrl }: SignInOptions = {}): Promise<SignInResult> {
  try {
    return await runSignIn(client, signal, onAuthUrl)
  } catch (e) {
    if (e instanceof SignInError) throw e
    const message = e instanceof Error ? e.message : String(e)
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
      throw new SignInError('network', "Couldn't reach Google. Check your connection and try again.")
    }
    throw new SignInError('failed', message)
  }
}

async function runSignIn(client: GoogleClient, signal?: AbortSignal, onAuthUrl?: (url: string) => void): Promise<SignInResult> {
  const verifier = base64url(crypto.randomBytes(48))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  const state = base64url(crypto.randomBytes(16))

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const done = (err: Error | null, value?: string) => {
        res.writeHead(err ? 400 : 200, { 'Content-Type': 'text/html' })
        res.end(page(err ? `Sign-in failed: ${err.message}` : 'Signed in. You can close this tab and return to Kestrel.'))
        clearTimeout(timer)
        server.close()
        if (err) reject(err)
        else resolve({ code: value!, redirectUri })
      }
      if (url.searchParams.get('state') !== state) return done(new Error('state mismatch'))
      const error = url.searchParams.get('error')
      if (error === 'access_denied') {
        // Google uses the same error for "you clicked Cancel" and "not a test user of an app in Testing".
        return done(
          new SignInError(
            'denied',
            'Google denied access. If it said "Access blocked", add this Google account as a test user (Google Auth Platform → Audience → Test users), then try again.'
          )
        )
      }
      if (error) return done(new Error(error))
      const code = url.searchParams.get('code')
      if (!code) return done(new Error('missing code'))
      done(null, code)
    })
    let redirectUri = ''
    const timer = setTimeout(() => {
      server.close()
      reject(new SignInError('timeout', 'Sign-in timed out after 5 minutes. Try again when you are ready.'))
    }, SIGN_IN_TIMEOUT_MS)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      server.close()
      reject(new SignInError('cancelled', 'Sign-in cancelled.'))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      redirectUri = `http://127.0.0.1:${port}/callback`
      const params = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent select_account'
      })
      const authUrl = `${AUTH_URL}?${params}`
      onAuthUrl?.(authUrl)
      openExternalSafely(authUrl)
    })
  })

  const tokens = await tokenRequest({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  })
  if (!tokens.refresh_token) {
    throw new SignInError(
      'no-refresh-token',
      "Google didn't return a refresh token. Remove Kestrel at myaccount.google.com/permissions, then sign in again."
    )
  }

  const profileRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } })
  if (!profileRes.ok) throw new Error(`Could not read Google profile (${profileRes.status})`)
  const profile = (await profileRes.json()) as { email: string; name?: string }

  return {
    email: profile.email,
    name: profile.name ?? profile.email,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000
  }
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  })
  if (!res.ok) throw new Error(`Google token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as TokenResponse
}

// Caches access tokens per account and refreshes them a minute before expiry.
export class TokenManager {
  private cache = new Map<string, { token: string; expiresAt: number }>()
  private inflight = new Map<string, Promise<string>>()

  constructor(
    // Read on every refresh, so a client saved after launch takes effect at once.
    private readonly clientFor: () => GoogleClient | null,
    private readonly refreshTokenFor: (accountId: string) => string | null
  ) {}

  seed(accountId: string, token: string, expiresAt: number): void {
    this.cache.set(accountId, { token, expiresAt })
  }

  forget(accountId: string): void {
    this.cache.delete(accountId)
  }

  get(accountId: string): Promise<string> {
    const cached = this.cache.get(accountId)
    if (cached && cached.expiresAt - 60_000 > Date.now()) return Promise.resolve(cached.token)
    let pending = this.inflight.get(accountId)
    if (!pending) {
      pending = this.refresh(accountId).finally(() => this.inflight.delete(accountId))
      this.inflight.set(accountId, pending)
    }
    return pending
  }

  private async refresh(accountId: string): Promise<string> {
    const client = this.clientFor()
    if (!client) throw new Error('Google client is not configured')
    const refreshToken = this.refreshTokenFor(accountId)
    if (!refreshToken) throw new Error('Account needs to sign in again')
    const res = await tokenRequest({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
    this.cache.set(accountId, { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 })
    return res.access_token
  }
}
