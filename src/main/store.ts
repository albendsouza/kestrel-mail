// Persists accounts, window state and OAuth refresh tokens. Tokens are
// encrypted with the OS keychain through safeStorage when it is available.

import fs from 'fs'
import path from 'path'

import { app, safeStorage } from 'electron'

import type { Account } from '../shared/types'

export interface SavedWindow {
  bounds: { x: number; y: number; width: number; height: number }
  tabs: { accountId: string | null }[]
  activeIndex: number
}

interface StoreData {
  accounts: Account[]
  windows: SavedWindow[]
  tokens: Record<string, string> // accountId -> encrypted (base64) or plain refresh token
  tokensEncrypted: boolean
  tourDone: boolean // finished or skipped the guided tour
  // A Google OAuth client entered on the welcome screen; the secret is encoded like tokens.
  googleClient?: { clientId: string; clientSecret: string }
}

const empty = (): StoreData => ({ accounts: [], windows: [], tokens: {}, tokensEncrypted: false, tourDone: false })

export class Store {
  private data: StoreData
  private readonly file: string

  constructor(file = path.join(app.getPath('userData'), 'kestrel.json')) {
    this.file = file
    try {
      this.data = { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }
    } catch {
      this.data = empty()
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  accounts(): Account[] {
    return this.data.accounts
  }

  account(id: string): Account | undefined {
    return this.data.accounts.find(a => a.id === id)
  }

  upsertAccount(account: Account): void {
    this.data.accounts = [...this.data.accounts.filter(a => a.id !== account.id), account]
    this.save()
  }

  removeAccount(id: string): void {
    this.data.accounts = this.data.accounts.filter(a => a.id !== id)
    delete this.data.tokens[id]
    this.save()
  }

  googleClient(): { clientId: string; clientSecret: string } | null {
    const saved = this.data.googleClient
    if (!saved) return null
    const clientSecret = this.decode(saved.clientSecret)
    return clientSecret ? { clientId: saved.clientId, clientSecret } : null
  }

  setGoogleClient(clientId: string, clientSecret: string): void {
    this.syncEncryption()
    this.data.googleClient = { clientId, clientSecret: this.encode(clientSecret) }
    this.save()
  }

  tourDone(): boolean {
    return this.data.tourDone
  }

  setTourDone(): void {
    this.data.tourDone = true
    this.save()
  }

  windows(): SavedWindow[] {
    return this.data.windows
  }

  setWindows(windows: SavedWindow[]): void {
    this.data.windows = windows
    this.save()
  }

  setRefreshToken(accountId: string, token: string): void {
    this.syncEncryption()
    this.data.tokens[accountId] = this.encode(token)
    this.save()
  }

  getRefreshToken(accountId: string): string | null {
    const stored = this.data.tokens[accountId]
    return stored ? this.decode(stored) : null
  }

  // Re-encodes stored secrets if encryption availability changed.
  private syncEncryption(): void {
    const encrypt = safeStorage.isEncryptionAvailable()
    if (encrypt === this.data.tokensEncrypted) return
    const plain = Object.fromEntries(Object.keys(this.data.tokens).map(id => [id, this.getRefreshToken(id) ?? '']))
    const client = this.googleClient()
    this.data.tokensEncrypted = encrypt
    this.data.tokens = {}
    for (const [id, t] of Object.entries(plain)) if (t) this.data.tokens[id] = this.encode(t)
    if (client) this.data.googleClient = { clientId: client.clientId, clientSecret: this.encode(client.clientSecret) }
  }

  private decode(stored: string): string | null {
    if (!this.data.tokensEncrypted) return stored
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }

  private encode(token: string): string {
    return this.data.tokensEncrypted ? safeStorage.encryptString(token).toString('base64') : token
  }
}
