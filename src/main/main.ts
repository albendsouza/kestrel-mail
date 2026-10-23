import path from 'path'

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, Notification, protocol } from 'electron'
import { pathToFileURL } from 'url'

import { APP_HOST, APP_ORIGIN, APP_SCHEME, UNDO_SEND_MS, distDir, isDemo, preloadPath } from './config'
import { googleClientFromEnv, isGoogleClientId, revokeToken, SignInError, signInWithGoogle, TokenManager, type GoogleClient } from './google-auth'
import { buildMenu } from './menu'
import { isTrustedSender, openExternalSafely } from './security'
import { Store } from './store'
import { SyncHost } from './sync-host'
import { AppWindow, lockToUrl, type Tab } from './window'

import type { Account } from '../shared/types'

// The bundled UI is served from kestrel://app so it gets a real origin and CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Remote images are allowed by policy but the reader only loads them on request.
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' about:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'"
].join('; ')

// Lets tests and multiple dev instances run against a throwaway profile.
if (process.env.KESTREL_USER_DATA) app.setPath('userData', process.env.KESTREL_USER_DATA)

if (!app.requestSingleInstanceLock()) app.exit(0)

let store: Store
let syncHost: SyncHost
let tokens: TokenManager
const windows: AppWindow[] = []
const unreadByAccount = new Map<string, number>()
// Kept referenced so click handlers keep firing after creation.
const liveNotifications = new Set<Notification>()
let pendingMailto: string | null = null

function rendererRoot(): string {
  return path.join(distDir(), 'renderer')
}

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async request => {
    const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' }
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response('Wrong origin', { status: 400, headers })
    const root = path.resolve(rendererRoot())
    const file = path.resolve(path.join(root, decodeURIComponent(url.pathname)))
    if (!file.startsWith(root + path.sep)) return new Response('Bad request', { status: 400, headers })
    try {
      const res = await net.fetch(pathToFileURL(file).toString())
      const merged = new Headers(res.headers)
      for (const [k, v] of Object.entries(headers)) merged.set(k, v)
      return new Response(res.body, { status: res.status, headers: merged })
    } catch {
      return new Response('Not found', { status: 404, headers })
    }
  })
}

function accountLabel(accountId: string | null): string {
  if (!accountId) return 'New tab'
  return store.account(accountId)?.email ?? 'Account'
}

function focusedWindow(): AppWindow | undefined {
  return windows.find(w => w.window.isFocused()) ?? windows[windows.length - 1]
}

function findTab(contents: Electron.WebContents): { win: AppWindow; tab: Tab } | null {
  for (const win of windows) {
    const tab = win.tabByContents(contents)
    if (tab) return { win, tab }
  }
  return null
}

function broadcastStrip(): void {
  for (const w of windows) {
    if (!w.strip.webContents.isDestroyed()) w.strip.webContents.send('kestrel:tabs', w.stripState())
  }
}

function persistWindows(): void {
  if (windows.length) store.setWindows(windows.map(w => w.toJson()))
}

function createWindow(saved?: ReturnType<AppWindow['toJson']>): AppWindow {
  const win = new AppWindow(
    {
      accountLabel,
      onChange: () => {
        broadcastStrip()
        updateTabBadges()
      },
      onClosed: w => {
        windows.splice(windows.indexOf(w), 1)
        if (windows.length) persistWindows()
        if (process.platform !== 'darwin' && !windows.length) app.quit()
      }
    },
    saved
  )
  windows.push(win)
  return win
}

function updateTabBadges(): void {
  for (const w of windows) for (const t of w.tabs) t.unread = t.accountId ? (unreadByAccount.get(t.accountId) ?? 0) : 0
  let total = 0
  for (const n of unreadByAccount.values()) total += n
  app.setBadgeCount(total)
}

function addAccount(account: Account, refresh?: { refreshToken: string; accessToken: string; expiresAt: number }): void {
  const existing = store.account(account.id)
  if (refresh) {
    store.setRefreshToken(account.id, refresh.refreshToken)
    tokens.seed(account.id, refresh.accessToken, refresh.expiresAt)
  }
  store.upsertAccount(account)
  if (!existing) syncHost.addAccount(account)
}

// The environment (or a release build's built-in client) wins over one saved in the app.
function googleClient(): GoogleClient | null {
  return googleClientFromEnv() ?? store.googleClient()
}

// A small window that stays on top of the browser while the user creates a
// Google OAuth client, step by step. One at a time.
let guideWindow: BrowserWindow | null = null

function openSetupGuide(): void {
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.focus()
    return
  }
  const url = `${APP_ORIGIN}/guide.html`
  guideWindow = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    title: 'Set up Google sign-in',
    alwaysOnTop: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171b' : '#ffffff',
    webPreferences: { preload: preloadPath('guide'), sandbox: true, contextIsolation: true }
  })
  lockToUrl(guideWindow.webContents, url)
  void guideWindow.loadURL(url)
  guideWindow.on('closed', () => (guideWindow = null))
}

interface PendingSignIn {
  abort: AbortController
  url: string | null
}
let pendingSignIn: PendingSignIn | null = null

function removeAccount(accountId: string): void {
  store.removeAccount(accountId)
  tokens.forget(accountId)
  syncHost.removeAccount(accountId)
  unreadByAccount.delete(accountId)
  for (const w of windows) for (const t of w.tabs) if (t.accountId === accountId) w.bindAccount(t, null)
}

function removePracticeAccounts(): void {
  for (const a of store.accounts()) if (a.provider === 'practice') removeAccount(a.id)
}

function openTabForAccount(accountId: string): { win: AppWindow; tab: Tab } {
  for (const win of windows) {
    const tab = win.tabs.find(t => t.accountId === accountId)
    if (tab) {
      win.activate(tab)
      win.window.focus()
      return { win, tab }
    }
  }
  const win = focusedWindow() ?? createWindow()
  const tab = win.addTab(accountId)
  win.window.focus()
  return { win, tab }
}

// mailto: links open a compose window in the focused (or first) account.
function handleMailto(url: string): void {
  const accountId = focusedWindow()?.activeTab?.accountId ?? store.accounts()[0]?.id
  if (!accountId) {
    pendingMailto = url
    return
  }
  const { tab } = openTabForAccount(accountId)
  const send = () => tab.view.webContents.send('kestrel:command', { type: 'compose', mailto: url })
  if (tab.view.webContents.isLoading()) tab.view.webContents.once('did-finish-load', () => setTimeout(send, 300))
  else send()
}

function registerIpc(): void {
  const handle = (channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted sender')
      return fn(event, ...args)
    })

  handle('kestrel:context', event => {
    const found = findTab(event.sender)
    const account = found?.tab.accountId ? store.account(found.tab.accountId) : undefined
    return {
      account: account ?? null,
      accounts: store.accounts(),
      platform: process.platform,
      demo: isDemo(),
      googleConfigured: !!googleClient(),
      tourDone: store.tourDone(),
      undoSendMs: UNDO_SEND_MS
    }
  })

  // Hands this tab a MessagePort to its account's engine. The account comes
  // from the tab binding in the main process, never from the renderer.
  handle('kestrel:connect', event => {
    const found = findTab(event.sender)
    if (!found?.tab.accountId) return false
    syncHost.connect(found.tab.accountId, event.sender)
    if (pendingMailto) {
      const url = pendingMailto
      pendingMailto = null
      setTimeout(() => handleMailto(url), 300)
    }
    return true
  })

  // A null account returns the tab to the account picker.
  handle('kestrel:useAccount', (event, accountId: string | null) => {
    const found = findTab(event.sender)
    if (!found || (accountId !== null && !store.account(accountId))) return false
    found.win.bindAccount(found.tab, accountId)
    return true
  })

  handle('kestrel:addDemoAccount', event => {
    const id = 'demo'
    addAccount({ id, email: 'you@kestrel.demo', name: 'Demo User', provider: 'demo' })
    const found = findTab(event.sender)
    if (found) found.win.bindAccount(found.tab, id)
    return true
  })

  handle('kestrel:addGoogleAccount', async event => {
    const client = googleClient()
    if (!client) throw new Error('Set KESTREL_GOOGLE_CLIENT_ID and KESTREL_GOOGLE_CLIENT_SECRET to connect Gmail.')
    pendingSignIn?.abort.abort()
    const abort = new AbortController()
    const current: PendingSignIn = { abort, url: null }
    pendingSignIn = current
    let result
    try {
      result = await signInWithGoogle(client, { signal: abort.signal, onAuthUrl: url => (current.url = url) })
    } catch (e) {
      // The code prefix lets the renderer tell a cancel from a real failure.
      if (e instanceof SignInError) throw new Error(`[${e.code}] ${e.message}`)
      throw e
    } finally {
      if (pendingSignIn === current) pendingSignIn = null
    }
    const id = `gmail-${result.email.toLowerCase()}`
    addAccount({ id, email: result.email, name: result.name, provider: 'gmail' }, result)
    const found = findTab(event.sender)
    if (found) found.win.bindAccount(found.tab, id)
    return true
  })

  // Saves a client pasted on the welcome screen, for runs without the environment variables.
  handle('kestrel:setGoogleClient', (_event, clientId: string, clientSecret: string) => {
    const id = String(clientId ?? '').trim()
    const secret = String(clientSecret ?? '').trim()
    if (!isGoogleClientId(id)) throw new Error("[invalid-id] That doesn't look like a client ID. It ends in .apps.googleusercontent.com.")
    if (secret.length < 10 || /\s/.test(secret)) throw new Error("[invalid-secret] That doesn't look like a client secret.")
    store.setGoogleClient(id, secret)
    // Welcome screens re-read the context so Sign in with Google turns on.
    for (const w of windows) for (const t of w.tabs) if (!t.accountId) t.view.webContents.reload()
    return true
  })

  handle('kestrel:openSetupGuide', () => {
    openSetupGuide()
    return true
  })

  handle('kestrel:guideFinish', () => {
    guideWindow?.close()
    focusedWindow()?.window.focus()
    return true
  })

  handle('kestrel:cancelSignIn', () => {
    pendingSignIn?.abort.abort()
    return true
  })

  handle('kestrel:reopenSignIn', () => {
    if (pendingSignIn?.url) openExternalSafely(pendingSignIn.url)
    return !!pendingSignIn?.url
  })

  // Sign out: Google revokes Kestrel's access, then this Mac forgets the account
  // (its token, cached mail, reminders and label corrections). Gmail itself is untouched.
  handle('kestrel:signOut', async (_event, accountId: string) => {
    const refresh = store.account(accountId)?.provider === 'gmail' ? store.getRefreshToken(accountId) : null
    const revoked = refresh ? await revokeToken(refresh) : true
    removeAccount(accountId)
    return { revoked }
  })

  // The tour runs in a fresh practice inbox. A new id each time means a stale
  // cache from an earlier run can never load.
  handle('kestrel:startTour', event => {
    removePracticeAccounts()
    const id = `practice-${Date.now().toString(36)}`
    addAccount({ id, email: 'you@practice.kestrel', name: 'Practice inbox', provider: 'practice' })
    const found = findTab(event.sender)
    if (found) found.win.bindAccount(found.tab, id)
    return true
  })

  // Finishing or skipping both count as done; the tour stays replayable from the welcome screen.
  handle('kestrel:finishTour', () => {
    store.setTourDone()
    removePracticeAccounts()
    return true
  })

  handle('kestrel:openExternal', (_event, url: string) => openExternalSafely(String(url)))

  // Tab strip commands.
  handle('kestrel:strip', (event, cmd: { type: 'switch' | 'close' | 'new'; tabId?: string }) => {
    const win = windows.find(w => w.strip.webContents === event.sender)
    if (!win) return
    const tab = win.tabs.find(t => t.id === cmd.tabId)
    if (cmd.type === 'switch') win.activate(tab)
    else if (cmd.type === 'close') win.closeTab(tab ?? null)
    else win.addTab(null)
  })
  handle('kestrel:stripState', event => windows.find(w => w.strip.webContents === event.sender)?.stripState())
}

function notifyNewMail(accountId: string, threads: { id: string; subject: string; from: string; snippet: string }[]): void {
  if (!Notification.isSupported()) return
  const shown = threads.slice(0, 3)
  for (const t of shown) {
    const n = new Notification({ title: t.from, subtitle: t.subject, body: t.snippet || t.subject, silent: false })
    liveNotifications.add(n)
    n.on('click', () => {
      const { tab } = openTabForAccount(accountId)
      tab.view.webContents.send('kestrel:command', { type: 'openThread', threadId: t.id })
    })
    n.on('close', () => liveNotifications.delete(n))
    n.show()
    setTimeout(() => liveNotifications.delete(n), 5 * 60_000)
  }
}

function sendToActiveTab(command: { type: string }): void {
  focusedWindow()?.activeTab?.view.webContents.send('kestrel:command', command)
}

async function start(): Promise<void> {
  store = new Store()
  registerAppProtocol()
  tokens = new TokenManager(googleClient, id => store.getRefreshToken(id))
  syncHost = new SyncHost({
    token: id => tokens.get(id),
    badge: (id, unread) => {
      unreadByAccount.set(id, unread)
      updateTabBadges()
      broadcastStrip()
    },
    newMail: notifyNewMail,
    fatal: message => dialog.showErrorBox('Kestrel', message)
  })

  if (isDemo() && !store.account('demo')) {
    store.upsertAccount({ id: 'demo', email: 'you@kestrel.demo', name: 'Demo User', provider: 'demo' })
  }
  syncHost.start(store.accounts())
  // A tour left running at quit restarts from the beginning next time.
  removePracticeAccounts()
  registerIpc()

  Menu.setApplicationMenu(
    buildMenu({
      newTab: () => focusedWindow()?.addTab(null),
      newWindow: () => createWindow(),
      closeTab: () => focusedWindow()?.closeTab(),
      reopenTab: () => focusedWindow()?.reopenClosedTab(),
      nextTab: () => focusedWindow()?.cycle(1),
      prevTab: () => focusedWindow()?.cycle(-1),
      goToTab: i => focusedWindow()?.activateIndex(i),
      reload: () => focusedWindow()?.activeTab?.view.webContents.reload(),
      toggleDevTools: () => focusedWindow()?.activeTab?.view.webContents.toggleDevTools(),
      command: type => sendToActiveTab({ type })
    })
  )

  const known = new Set(store.accounts().map(a => a.id))
  const saved = store
    .windows()
    .map(w => ({ ...w, tabs: w.tabs.map(t => ({ accountId: t.accountId && known.has(t.accountId) ? t.accountId : null })) }))
  if (saved.length) saved.forEach(w => createWindow(w))
  else createWindow(store.accounts().length ? { bounds: { x: 80, y: 60, width: 1280, height: 820 }, tabs: store.accounts().map(a => ({ accountId: a.id })), activeIndex: 0 } : undefined)

  if (!app.isDefaultProtocolClient('mailto') && process.env.KESTREL_CLAIM_MAILTO === '1') {
    app.setAsDefaultProtocolClient('mailto')
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  if (!url.startsWith('mailto:')) return
  if (app.isReady() && windows.length) handleMailto(url)
  else pendingMailto = url
})

app.on('second-instance', (_e, argv) => {
  const mailto = argv.find(a => a.startsWith('mailto:'))
  if (mailto) handleMailto(mailto)
  else focusedWindow()?.window.focus()
})

app.on('before-quit', () => {
  persistWindows()
  syncHost?.stop()
})

app.on('activate', () => {
  if (!windows.length) createWindow(store.windows()[0])
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('web-contents-created', (_e, contents) => {
  // No webview tags anywhere in the app.
  contents.on('will-attach-webview', event => event.preventDefault())
})

app.whenReady().then(async () => {
  await start()
  const argvMailto = process.argv.find(a => a.startsWith('mailto:'))
  if (argvMailto) pendingMailto = argvMailto

  if (process.env.KESTREL_SMOKE_SCREENSHOT) {
    const { runSmoke } = await import('./smoke')
    await runSmoke(windows[0], process.env.KESTREL_SMOKE_SCREENSHOT, id => tokens.get(id))
  }
})
