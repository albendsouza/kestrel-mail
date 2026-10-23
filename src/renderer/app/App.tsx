import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { parseMailto } from '../../shared/mailto'
import { forwardSubject, replySubject } from '../../shared/subjects'
import { EngineClient } from './client'
import { AUTO_LABELS } from '../../shared/types'
import { describeWhen, parseWhen, presets } from '../../shared/when'
import { CredentialsFileButton } from './CredentialsFile'
import { BINDINGS, KeyResolver, displayKeys, keyName, type Command } from './keys'
import { MessageBody } from './MessageBody'
import { Sidebar } from './Sidebar'
import { Tour, type TourEvent, type TourSnapshot } from './Tour'

import type {
  Account,
  Address,
  Draft,
  EngineEvent,
  InboxWindow,
  MailLabel,
  SortState,
  SortingSetup,
  RescueState,
  AutoLabel,
  AutoFileState,
  AutoLabelCount,
  SplitCount,
  ThreadDetail,
  ThreadSummary,
  UnsubscribeResult
} from '../../shared/types'
import type { KestrelApi } from '../../preload/tab'

declare global {
  interface Window {
    kestrel: KestrelApi
  }
}

interface Context {
  account: Account | null
  accounts: Account[]
  platform: string
  demo: boolean
  googleConfigured: boolean
  tourDone: boolean
  undoSendMs: number
}

interface ComposeState {
  to: string
  cc: string
  subject: string
  body: string
  replyTo?: Draft['replyTo']
}

// Two slots: a pending send keeps its own toast (its Undo matters for 10 s);
// every other message replaces the one before it, so they never pile up.
type ToastSlot = 'send' | 'action'

interface Toast {
  id: number
  slot: ToastSlot
  text: string
  action?: { label: string; run: () => void }
}

type Overlay = 'palette' | 'help' | 'remind' | 'label' | 'stats' | 'window' | 'signout' | null

// Choices for how far back the inbox reaches; 2 weeks is the default.
const WINDOWS: { days: number | null; label: string }[] = [
  { days: 14, label: 'last 2 weeks' },
  { days: 30, label: 'last month' },
  { days: 90, label: 'last 3 months' },
  { days: null, label: 'everything' }
]
const windowLabel = (w: InboxWindow) =>
  `${WINDOWS.find(o => o.days === w.days)?.label ?? `last ${w.days} days`}${w.keepUnread && w.days !== null ? ' + unread' : ''}`

// Auto labels that ask something of you get the accent colour; the rest stay quiet.
const URGENT_LABELS = new Set(['To respond', 'Important update', 'Calendar', 'Code'])

// Views outside the inbox splits: their title, and what to say when empty.
const FOLDERS: Record<string, { title: string; empty: string; hint: string }> = {
  done: { title: 'Done', empty: 'Nothing marked done yet', hint: 'Mail you read and archived, or marked done here with E.' },
  'done-unopened': { title: 'Never opened', empty: 'Nothing archived unread', hint: 'Mail archived before you opened it, by Gmail or another app.' },
  'done-filed': { title: 'Skipped inbox', empty: 'Nothing filed away', hint: 'Marketing Kestrel marked done for you, labelled Kestrel/Marketing.' },
  'done-rescue': { title: 'From people', empty: 'Nothing left to bring back', hint: 'Mail Laya would have put in Important, To reply or Calendar.' },
  reminders: { title: 'Reminders', empty: 'No reminders', hint: 'Press H on a conversation to bring it back later.' },
  senders: { title: 'Senders', empty: 'No senders', hint: 'Your inbox is empty, so there is nothing to clean up.' },
  waiting: { title: 'Waiting', empty: 'Nothing waiting', hint: 'Mail you sent in the last 30 days has all been answered.' },
  drafts: { title: 'Drafts', empty: 'No drafts', hint: 'Drafts saved in Gmail show here. Editing them in Kestrel comes later.' },
  sent: { title: 'Sent', empty: 'Nothing sent', hint: 'Mail you send shows here.' },
  'all-starred': { title: 'Starred', empty: 'Nothing starred', hint: 'Press S on a conversation to star it.' },
  spam: { title: 'Spam', empty: 'No spam', hint: 'Gmail keeps spam here for 30 days.' },
  trash: { title: 'Trash', empty: 'Trash is empty', hint: 'Gmail deletes trash for good after 30 days.' }
}

// Views that load from the server, so they start empty with a loading state.
const NETWORK_VIEWS = new Set(['done', 'done-unopened', 'done-filed', 'waiting', 'drafts', 'sent', 'all-starred', 'spam', 'trash'])
const isNetworkView = (split: string) => NETWORK_VIEWS.has(split) || split.startsWith('label:')

function folderInfo(split: string, labels: MailLabel[]): { title: string; empty: string; hint: string } | null {
  if (split.startsWith('auto:')) {
    const name = split.slice(5)
    return { title: name, empty: `Nothing labelled ${name}`, hint: 'Laya gives inbox mail this label as it sorts.' }
  }
  if (split.startsWith('label:')) {
    const name = labels.find(l => l.id === split.slice(6))?.name ?? 'Label'
    return { title: name, empty: `Nothing in ${name}`, hint: 'Conversations with this Gmail label show here.' }
  }
  return FOLDERS[split] ?? null
}

const client = new EngineClient()
const isMac = navigator.platform.toLowerCase().includes('mac')

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (now - ms < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const formatAddresses = (list: Address[]) => list.map(a => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email)).join(', ')

function parseAddressInput(value: string): Address[] {
  return value
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const m = s.match(/^(.*)<([^>]+)>$/)
      return m ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() } : { name: s, email: s }
    })
}

const validEmail = (a: Address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map(p => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function quote(detail: ThreadDetail): string {
  const last = detail.messages[detail.messages.length - 1]
  const when = new Date(last.date).toLocaleString()
  const text = last.text ?? (last.html ? new DOMParser().parseFromString(last.html, 'text/html').body.textContent ?? '' : '')
  return `\n\nOn ${when}, ${last.from.name || last.from.email} wrote:\n${text
    .trim()
    .split('\n')
    .map(l => `> ${l}`)
    .join('\n')}`
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

// ── App ────────────────────────────────────────────────────────────────────

export function App() {
  const [ctx, setCtx] = useState<Context | null>(null)
  useEffect(() => {
    void window.kestrel.context().then(setCtx)
  }, [])
  if (!ctx) return null
  if (!ctx.account) return <Onboarding ctx={ctx} />
  return <Mailbox ctx={ctx} account={ctx.account} />
}

function Onboarding({ ctx }: { ctx: Context }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(remoteError(e).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    document.title = 'New tab'
  }, [])
  const accounts = ctx.accounts.filter(a => a.provider !== 'practice')
  // First run leads with the tour; Enter starts it.
  useEffect(() => {
    if (ctx.tourDone) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (e.key === 'Enter' && !busy && tag !== 'BUTTON' && tag !== 'INPUT') void run(window.kestrel.startTour)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="logo">K</div>
        <h1>Kestrel</h1>
        <p className="muted">The fastest way through your inbox. Every action has a key.</p>
        {!ctx.tourDone && (
          <button className="primary" disabled={busy} onClick={() => void run(window.kestrel.startTour)}>
            Take the 2-minute tour <kbd>↵</kbd>
          </button>
        )}
        {accounts.length > 0 && (
          <div className="account-list">
            {accounts.map(a => (
              <button key={a.id} className="account-row" onClick={() => void window.kestrel.useAccount(a.id)}>
                <span className="avatar">{initials(a.name)}</span>
                <span>
                  <strong>{a.name}</strong>
                  <span className="muted">{a.email}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <GoogleSignIn configured={ctx.googleConfigured} disabled={busy} />
        {!ctx.accounts.some(a => a.provider === 'demo') && (
          <button className="secondary" disabled={busy} onClick={() => void run(window.kestrel.addDemoAccount)}>
            Try the demo inbox
          </button>
        )}
        {ctx.tourDone && (
          <button className="link" disabled={busy} onClick={() => void run(window.kestrel.startTour)}>
            Replay the tour
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}

// Errors from the main process arrive as "Error invoking remote method …: Error: [code] message".
function remoteError(e: unknown): { code: string | null; message: string } {
  const raw = e instanceof Error ? e.message : String(e)
  const text = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  const m = text.match(/^\[([a-z-]+)\] (.*)$/s)
  return m ? { code: m[1], message: m[2] } : { code: null, message: text }
}

// Shown until a Google OAuth client is known: from the environment, a release
// build, or pasted here (saved on this Mac, the secret encrypted).
function GoogleClientSetup() {
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await window.kestrel.setGoogleClient(clientId, secret)
      location.reload()
    } catch (e) {
      setError(remoteError(e).message)
      setSaving(false)
    }
  }
  return (
    <form
      className="client-setup"
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
    >
      <strong>Set up Google sign-in</strong>
      <p className="muted small">
        Kestrel signs in to Gmail with a client you create in Google Cloud. It takes about 5 minutes and is free.
      </p>
      <button type="button" className="primary guide-button" onClick={() => void window.kestrel.openSetupGuide()}>
        Walk me through it, step by step
      </button>
      <p className="muted small">
        Already have one? Choose the JSON file Google Cloud downloaded, or paste the ID and secret. They're saved on this Mac only,
        with the secret encrypted by your keychain.
      </p>
      <CredentialsFileButton save={window.kestrel.setGoogleClient} onSaved={() => location.reload()} />
      <label>
        <span>Client ID</span>
        <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} autoComplete="off" />
      </label>
      <label>
        <span>Client secret</span>
        <input type="password" value={secret} onChange={e => setSecret(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <button className="secondary" type="submit" disabled={saving || !clientId.trim() || !secret.trim()}>
        Save and continue
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

const GoogleMark = () => (
  <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
)

// Sign in with Google: opens the system browser, waits with a way to cancel
// or reopen it, and explains failures. Success rebinds the tab to the account.
function GoogleSignIn({ configured, disabled }: { configured: boolean; disabled: boolean }) {
  const [state, setState] = useState<'idle' | 'waiting'>('idle')
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    setError(null)
    setState('waiting')
    try {
      await window.kestrel.addGoogleAccount()
    } catch (e) {
      const { code, message } = remoteError(e)
      if (code !== 'cancelled') setError(message)
    } finally {
      setState('idle')
    }
  }
  if (state === 'waiting') {
    return (
      <div className="signin-waiting" role="status">
        <div className="spinner" aria-hidden="true" />
        <div>
          <strong>Finish signing in in your browser</strong>
          <p className="muted small">Google opened in your default browser. Come back here when you are done.</p>
          <div className="signin-actions">
            <button className="link" onClick={() => void window.kestrel.reopenSignIn()}>
              Open the browser again
            </button>
            <button className="secondary" onClick={() => void window.kestrel.cancelSignIn()}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }
  if (!configured) return <GoogleClientSetup />
  return (
    <div className="signin">
      <button className="google-button" disabled={disabled} onClick={() => void start()}>
        <GoogleMark />
        <span>Sign in with Google</span>
      </button>
      <p className="muted small">
        Your mail stays on this Mac and goes only to Google. Kestrel asks to read, send, label and archive mail; it can't delete
        anything permanently.
      </p>
      {error && (
        <div className="signin-error" role="alert">
          <span>{error}</span>
          <button className="link" onClick={() => void start()}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

function Mailbox({ ctx, account }: { ctx: Context; account: Account }) {
  const dark = useDarkMode()
  const [splits, setSplits] = useState<SplitCount[]>([])
  const [split, setSplit] = useState('important')
  const [query, setQuery] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [open, setOpen] = useState<ThreadDetail | null>(null)
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [syncState, setSyncState] = useState<string>('syncing')
  const [sortState, setSortState] = useState<SortState | null>(null)
  // Turning on smart sorting (laya-mps and Laya's model), offered on Macs with Apple silicon.
  const [sortingSetup, setSortingSetup] = useState<SortingSetup | null>(null)
  useEffect(() => {
    void window.kestrel.sortingSetup().then(setSortingSetup)
    return window.kestrel.onSortingSetup(setSortingSetup)
  }, [])
  const turnOnSorting = useCallback(() => void window.kestrel.startSortingSetup().then(setSortingSetup), [])
  const [autoLabels, setAutoLabels] = useState<AutoLabelCount[]>([])
  const [autoFile, setAutoFileState] = useState<AutoFileState | null>(null)
  const [rescue, setRescue] = useState<RescueState | null>(null)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // Done has tabs: yours, never opened, filed away, and what the rescue found.
  const inDone = split === 'done' || split.startsWith('done-')
  const inReminders = split === 'reminders'
  // Folders sit outside the inbox splits: Tab leaves them, Shift+E sends mail back to the inbox.
  const inSenders = split === 'senders'
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [inboxWindow, setInboxWindow] = useState<InboxWindow>({ days: 14, keepUnread: false })
  const [resyncing, setResyncing] = useState(false)
  // Checks labels, folders and the inbox against Gmail, fetching only what changed.
  const resync = async () => {
    if (resyncing) return
    setResyncing(true)
    try {
      const r = await client.request<{ checked: number; updated: number; removed: number; labels: number }>({ kind: 'resync' })
      setLabels(await client.request<MailLabel[]>({ kind: 'labels' }))
      const changes = [r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean).join(', ')
      toast(`In step with Gmail: ${r.checked} conversations checked${changes ? `, ${changes}` : ', nothing changed'}; ${r.labels} labels.`, undefined, 6000)
    } catch (e) {
      toast(`Couldn't resync: ${e instanceof Error ? e.message.replace(/^Error: /, '').slice(0, 140) : e}`, undefined, 8000)
    } finally {
      setResyncing(false)
    }
  }
  useEffect(() => {
    void client.ready().then(() => client.request<InboxWindow>({ kind: 'getInboxWindow' }).then(setInboxWindow))
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem('kestrel.sidebar') !== '0'
    } catch {
      return true
    }
  })
  const toggleSidebar = () =>
    setSidebarOpen(v => {
      try {
        localStorage.setItem('kestrel.sidebar', v ? '0' : '1')
      } catch {
        // Not remembered, but still toggles.
      }
      return !v
    })
  const folder = folderInfo(split, labels)
  const inFolder = folder !== null
  // Only Done and Reminders hold mail that is out of the inbox.
  const inArchive = inDone || inReminders
  const [remoteAllowed, setRemoteAllowed] = useState<Set<string>>(new Set())
  const [blockedCount, setBlockedCount] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const pendingSends = useRef(new Map<string, Draft>())
  const touring = account.provider === 'practice'
  const tourListeners = useRef(new Set<(e: TourEvent) => void>())
  const emitTour = (e: TourEvent) => tourListeners.current.forEach(fn => fn(e))
  const subscribeTour = useCallback((fn: (e: TourEvent) => void) => {
    tourListeners.current.add(fn)
    return () => void tourListeners.current.delete(fn)
  }, [])
  const finishTour = useCallback(() => void window.kestrel.finishTour(), [])
  const resolver = useRef(new KeyResolver())
  const nextToast = useRef(1)

  const toast = useCallback((text: string, action?: Toast['action'], ms = 4000, slot: ToastSlot = 'action') => {
    const id = nextToast.current++
    setToasts(t => [...t.filter(x => x.slot !== slot), { id, slot, text, action }].sort((a, b) => (a.slot === 'send' ? -1 : b.slot === 'send' ? 1 : 0)))
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ms)
    return id
  }, [])

  // Only the newest request may update the screen: Done and search answer from the
  // network, so an older answer can arrive after a newer one.
  const reloadSeq = useRef(0)
  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current
    const [s, list] = await Promise.all([
      client.request<SplitCount[]>({ kind: 'getSplits' }),
      client.request<ThreadSummary[]>({ kind: 'listThreads', split, query: query ?? undefined })
    ])
    if (seq !== reloadSeq.current) return
    setSplits(s)
    // Labels load on their own: a slow first fetch must not hold up the list.
    void client.request<MailLabel[]>({ kind: 'labels' }).then(setLabels).catch(() => {})
    void client.request<AutoLabelCount[]>({ kind: 'autoLabels' }).then(setAutoLabels).catch(() => {})
    void client.request<AutoFileState>({ kind: 'getAutoFile' }).then(setAutoFileState).catch(() => {})
    void client.request<RescueState>({ kind: 'getRescue' }).then(setRescue).catch(() => {})
    setThreads(prev => {
      setSelectedId(sel => {
        if (sel && list.some(t => t.id === sel)) return sel
        // Keep the cursor at the same position when the selected thread leaves.
        const oldIndex = sel ? prev.findIndex(t => t.id === sel) : 0
        return list[Math.min(Math.max(oldIndex, 0), list.length - 1)]?.id ?? null
      })
      return list
    })
    setLoaded(true)
  }, [split, query])

  // A new split or search starts at the top. Views that load from the network
  // start empty, so the previous view's threads never show under the new heading.
  useEffect(() => {
    setSelectedId(null)
    if (isNetworkView(split) || query !== null) {
      setThreads([])
      setLoaded(false)
    }
  }, [split, query])

  // Connect once, then follow engine events.
  useEffect(() => {
    void window.kestrel.connect()
  }, [])

  useEffect(() => {
    void client.request<SortState>({ kind: 'getSortState' }).then(setSortState, () => {})
  }, [client])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = client.on((e: EngineEvent) => {
      if (e.kind === 'changed') {
        if (!timer) timer = setTimeout(() => ((timer = null), void reload()), 30)
      } else if (e.kind === 'syncState') {
        setSyncState(e.state)
        if (e.state !== 'syncing') setProgress(null)
        if (e.state === 'error' || e.state === 'offline') setSyncMessage(e.message ?? null)
        else if (e.state === 'idle') setSyncMessage(null)
      } else if (e.kind === 'sortState') {
        setSortState(e.state)
      } else if (e.kind === 'syncProgress') {
        setProgress(e.done < e.total ? { done: e.done, total: e.total } : null)
      } else if (e.kind === 'sendState') {
        if (e.state === 'sent') toast('Message sent', undefined, 2500, 'send')
        if (e.state === 'failed') toast(`Send failed: ${e.message ?? 'unknown error'}`, undefined, 8000, 'send')
        if (e.state !== 'scheduled') pendingSends.current.delete(e.sendId)
      }
    })
    void client.ready().then(reload)
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [reload, toast])

  useEffect(() => {
    // The tab strip shows the unread badge, so the title stays plain.
    document.title = account.email
  }, [account.email])

  const selectedIndex = threads.findIndex(t => t.id === selectedId)
  const selected = selectedIndex >= 0 ? threads[selectedIndex] : null

  const openThread = useCallback(
    async (id: string) => {
      setSelectedId(id)
      setBlockedCount(0)
      const detail = await client.request<ThreadDetail>({ kind: 'getThread', threadId: id })
      setOpen(detail)
      if (detail.summary.unread) void client.request({ kind: 'act', action: { type: 'markRead', threadId: id, read: true } })
    },
    []
  )

  // Applies an action that removes or changes a thread, then advances like Superhuman: to the next conversation.
  const actOn = useCallback(
    (type: 'archive' | 'unarchive' | 'trash' | 'star' | 'toggleRead') => {
      const target = open?.summary ?? selected
      if (!target) return
      if (type === 'archive' && inDone) return void toast('Already done. Press Shift+E to move it back to the inbox.', undefined, 3000)
      if (type === 'unarchive' && !inArchive) return
      // A Senders row stands for everyone's mail from that sender.
      if (inSenders) {
        if (type !== 'archive' || !target.senderOf) return void toast("Press Enter to see this sender's mail.")
        const { email } = target.senderOf
        const who = target.from.name || email
        void client.request<number>({ kind: 'archiveSender', email }).then(n => toast(`Marked ${n} from ${who} done`, { label: 'Undo (Z)', run: () => void undo() }))
        return
      }
      const live = threads.find(t => t.id === target.id) ?? target
      if (type === 'star') {
        void client.request({ kind: 'act', action: { type: 'star', threadId: live.id, starred: !live.starred } })
        if (open) setOpen({ ...open, summary: { ...open.summary, starred: !live.starred } })
        return
      }
      if (type === 'toggleRead') {
        void client.request({ kind: 'act', action: { type: 'markRead', threadId: live.id, read: live.unread } })
        if (open) setOpen(null)
        return
      }
      const neighbor = threads[selectedIndex + 1] ?? threads[selectedIndex - 1]
      void client.request({ kind: 'act', action: { type, threadId: live.id } })
      toast(type === 'archive' ? 'Marked done' : type === 'unarchive' ? 'Moved to inbox' : 'Moved to trash', {
        label: 'Undo (Z)',
        run: () => void undo()
      })
      if (open) {
        if (neighbor) void openThread(neighbor.id)
        else setOpen(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, selected, threads, selectedIndex, toast, openThread, inDone, inArchive, inSenders]
  )

  const goTo = (view: string) => {
    setSplit(view)
    setQuery(null)
    setOpen(null)
  }

  // Unsubscribes from the list the selected mail (or sender) came from, then clears that sender.
  const unsubscribe = async () => {
    const target = open?.summary ?? selected
    if (!target) return
    const threadId = target.senderOf?.latestThreadId ?? target.id
    try {
      const { result, archived, sender } = await client.request<{ result: UnsubscribeResult; archived: number; sender: string }>({
        kind: 'unsubscribe',
        threadId
      })
      const cleared = archived ? `, and ${archived} marked done` : ''
      if (result.method === 'browser') {
        void window.kestrel.openExternal(result.url)
        toast(`Finish unsubscribing from ${sender} in your browser${cleared}`, undefined, 6000)
      } else if (result.method === 'none') {
        toast(`${sender} has no unsubscribe link. Press E on a Senders row to clear their mail.`, undefined, 6000)
      } else {
        toast(`Unsubscribed from ${sender}${cleared}`, archived ? { label: 'Undo (Z)', run: () => void undo() } : undefined)
      }
      if (open) setOpen(null)
    } catch (e) {
      toast(`Couldn't unsubscribe: ${e instanceof Error ? e.message.replace(/^Error: /, '') : e}`, undefined, 6000)
    }
  }

  // Sets (or, in Reminders, moves) a reminder, then advances like mark done.
  // Laya looks through mail archived unread for anything from people, invitations or urgent notices.
  const startRescue = async (days: number) => {
    setRescue(await client.request<RescueState>({ kind: 'rescueScan', days }))
    goTo('done-unopened')
  }
  const bringBack = async () => {
    const { moved } = await client.request<{ moved: number }>({ kind: 'bringBack' })
    toast(`${moved} ${moved === 1 ? 'conversation' : 'conversations'} back in the inbox, still unread.`)
    goTo('important')
  }

  // Marketing: marked done in Gmail with the Kestrel/Marketing label, now and as it arrives.
  const chooseAutoFile = async (on: boolean) => {
    const { filed } = await client.request<{ filed: number }>({ kind: 'setAutoFile', on })
    setAutoFileState(s => (s ? { ...s, on } : s))
    toast(
      on
        ? `${filed ? `${filed} marketing ${filed === 1 ? 'email' : 'emails'} marked done and labelled Kestrel/Marketing. ` : ''}New marketing will skip the inbox.`
        : 'Marketing stays in your inbox, under Other.'
    )
  }

  // L: you set the label for everything from this sender; Laya learns from it next time it's trained.
  const setSenderLabel = async (label: AutoLabel | null) => {
    const target = open?.summary ?? selected
    if (!target || target.senderOf) return
    const { sender, count } = await client.request<{ sender: string; count: number }>({ kind: 'setLabel', threadId: target.id, label })
    toast(label ? `${sender}: ${label} from now on (${count} in the inbox)` : `${sender} is back to Laya's labels`)
  }

  const remindAt = useCallback(
    (at: Date) => {
      const target = open?.summary ?? selected
      if (!target) return
      const neighbor = threads[selectedIndex + 1] ?? threads[selectedIndex - 1]
      void client.request({ kind: 'remind', threadId: target.id, at: at.getTime() })
      toast(`Reminder: ${describeWhen(at)}`, inReminders ? undefined : { label: 'Undo (Z)', run: () => void undo() })
      if (open) {
        if (neighbor && !inReminders) void openThread(neighbor.id)
        else setOpen(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, selected, threads, selectedIndex, toast, openThread, inReminders]
  )

  const undo = useCallback(async () => {
    const reversed = await client.request<{ threadId: string } | null>({ kind: 'undo' })
    if (reversed) {
      setSelectedId(reversed.threadId)
      toast('Undone')
    } else toast('Nothing to undo')
  }, [toast])

  const startCompose = useCallback(
    (kind: 'new' | 'reply' | 'replyAll' | 'forward', preset?: Partial<ComposeState>) => {
      if (kind === 'new' || !open) {
        setCompose({ to: '', cc: '', subject: '', body: '', ...preset })
        return
      }
      const last = open.messages[open.messages.length - 1]
      const me = account.email.toLowerCase()
      const replyTarget = last.from.email.toLowerCase() === me ? last.to : [last.from]
      const others =
        kind === 'replyAll'
          ? [...last.to, ...last.cc].filter(a => a.email.toLowerCase() !== me && !replyTarget.some(r => r.email === a.email))
          : []
      setCompose({
        to: kind === 'forward' ? '' : formatAddresses(replyTarget),
        cc: formatAddresses(others),
        subject: kind === 'forward' ? forwardSubject(open.summary.subject) : replySubject(open.summary.subject),
        body: quote(open),
        replyTo:
          kind === 'forward' ? undefined : { threadId: open.summary.id, messageIdHeader: last.messageIdHeader, references: last.references }
      })
    },
    [open, account.email]
  )

  const send = useCallback(
    async (state: ComposeState) => {
      const draft: Draft = {
        to: parseAddressInput(state.to),
        cc: parseAddressInput(state.cc),
        subject: state.subject,
        body: state.body,
        replyTo: state.replyTo
      }
      const bad = [...draft.to, ...draft.cc].find(a => !validEmail(a))
      if (!draft.to.length) return toast('Add at least one recipient')
      if (bad) return toast(`“${bad.email}” is not a valid address`)
      setCompose(null)
      const sendId = await client.request<string>({ kind: 'send', draft, delayMs: ctx.undoSendMs })
      pendingSends.current.set(sendId, draft)
      emitTour({ kind: 'sent' })
      toast(
        `Sending in ${Math.round(ctx.undoSendMs / 1000)}s…`,
        {
          label: 'Undo',
          run: async () => {
            const back = await client.request<Draft | null>({ kind: 'cancelSend', sendId })
            if (back) {
              setCompose({ ...state })
              toast('Send cancelled', undefined, 2500, 'send')
            }
          }
        },
        ctx.undoSendMs,
        'send'
      )
    },
    [ctx.undoSendMs, toast]
  )

  const splitIds = splits.map(s => s.id)
  const moveSplit = (delta: number) => {
    if (!splitIds.length) return
    // From Done, Tab goes back into the inbox splits.
    const i = inFolder ? (delta > 0 ? -1 : 0) : Math.max(0, splitIds.indexOf(split))
    setSplit(splitIds[(i + delta + splitIds.length) % splitIds.length])
    setQuery(null)
    setOpen(null)
  }

  const run = (command: Command) => {
    emitTour({ kind: 'command', command })
    switch (command) {
      case 'next': {
        const next = threads[selectedIndex + 1]
        if (!next) return
        if (open) void openThread(next.id)
        else setSelectedId(next.id)
        return
      }
      case 'prev': {
        const prev = threads[selectedIndex - 1]
        if (!prev) return
        if (open) void openThread(prev.id)
        else setSelectedId(prev.id)
        return
      }
      case 'open':
        // A sender opens as a search for their mail.
        if (selected?.senderOf) {
          setQuery(`from:${selected.senderOf.email}`)
          return
        }
        if (selected && !open) void openThread(selected.id)
        return
      case 'goSenders':
      case 'goToReply':
      case 'goWaiting':
      case 'goDrafts':
      case 'goSent':
        goTo({ goSenders: 'senders', goToReply: 'to-reply', goWaiting: 'waiting', goDrafts: 'drafts', goSent: 'sent' }[command])
        return
      case 'stats':
        setOverlay('stats')
        return
      case 'resync':
        void resync()
        return
      case 'unsubscribe':
        void unsubscribe()
        return
      case 'back':
        if (open) setOpen(null)
        else if (query !== null) setQuery(null)
        return
      case 'archive':
      case 'trash':
      case 'star':
      case 'toggleRead':
        return actOn(command)
      case 'moveToInbox':
        return actOn('unarchive')
      case 'remind':
        if (open || selected) setOverlay('remind')
        return
      case 'setLabel':
        if (open || (selected && !selected.senderOf)) setOverlay('label')
        return
      case 'goReminders':
        setSplit('reminders')
        setQuery(null)
        setOpen(null)
        return
      case 'reply':
      case 'replyAll':
      case 'forward':
        if (!open && selected) {
          void openThread(selected.id).then(() => setTimeout(() => document.dispatchEvent(new CustomEvent('kestrel:compose', { detail: command })), 0))
          return
        }
        return startCompose(command)
      case 'compose':
        return startCompose('new')
      case 'search':
        setSearchOpen(true)
        return
      case 'palette':
        setOverlay('palette')
        return
      case 'help':
        setOverlay(o => (o === 'help' ? null : 'help'))
        return
      case 'undo':
        void undo()
        return
      case 'nextSplit':
        return moveSplit(1)
      case 'prevSplit':
        return moveSplit(-1)
      case 'goImportant':
        setSplit('important')
        setQuery(null)
        setOpen(null)
        return
      case 'goStarred':
        setSplit('starred')
        setQuery(null)
        setOpen(null)
        return
      case 'goDone':
        setSplit('done')
        setQuery(null)
        setOpen(null)
        return
      case 'refresh':
        void client.request({ kind: 'refresh' })
        toast('Refreshing…', undefined, 1500)
        return
      case 'loadImages':
        if (open) setRemoteAllowed(s => new Set(s).add(open.summary.id))
        return
    }
  }

  // The key handler always sees the latest render's state.
  const runRef = useRef(run)
  runRef.current = run
  const startComposeRef = useRef(startCompose)
  startComposeRef.current = startCompose

  useEffect(() => {
    const onCompose = (e: Event) => startComposeRef.current((e as CustomEvent).detail)
    document.addEventListener('kestrel:compose', onCompose)
    return () => document.removeEventListener('kestrel:compose', onCompose)
  }, [])

  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  const blocking = compose !== null || overlay !== null || searchOpen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      const name = keyName(e, isMac)
      if (name === 'Mod+k') {
        e.preventDefault()
        setOverlay(o => (o === 'palette' ? null : 'palette'))
        return
      }
      if (overlayRef.current === 'help' && (name === 'Escape' || name === '?')) {
        e.preventDefault()
        setOverlay(null)
        return
      }
      if (typing || blocking) return
      const command = resolver.current.press(name)
      if (command) {
        e.preventDefault()
        runRef.current(command)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [blocking])

  // Commands from the native menu, notifications and mailto links.
  useEffect(
    () =>
      window.kestrel.onCommand(cmd => {
        if (cmd.type === 'compose' && typeof cmd.mailto === 'string') {
          const m = parseMailto(cmd.mailto)
          setCompose({ to: formatAddresses(m.to), cc: formatAddresses(m.cc), subject: m.subject, body: m.body })
        } else if (cmd.type === 'openThread' && typeof cmd.threadId === 'string') {
          void openThread(cmd.threadId)
        } else if (['compose', 'search', 'palette', 'help'].includes(cmd.type)) {
          runRef.current(cmd.type as Command)
        }
      }),
    [openThread]
  )

  // Keep the selected row visible.
  useEffect(() => {
    document.querySelector('.thread-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const onBlocked = useCallback((n: number) => setBlockedCount(c => Math.max(c, n)), [])
  const openLink = useCallback((url: string) => void window.kestrel.openExternal(url), [])

  return (
    <div className={`mailbox ${dark ? 'dark' : ''} ${touring ? 'touring' : ''}`}>
      {/* The tour keeps the screen simple, so the sidebar waits until it's over. */}
      {sidebarOpen && !touring && (
        <Sidebar
          account={account}
          split={split}
          labels={labels}
          autoLabels={autoLabels}
          autoFile={autoFile?.on ?? null}
          onToggleAutoFile={() => void chooseAutoFile(!autoFile?.on)}
          inboxUnread={labels.find(l => l.id === 'INBOX')?.unread ?? splits.reduce((n, s) => (s.id === 'starred' ? n : n + s.unread), 0)}
          onGo={goTo}
          onCompose={() => startCompose('new')}
          onStats={() => setOverlay('stats')}
          onSwitchAccount={() => void window.kestrel.useAccount(null)}
          onSignOut={() => setOverlay('signout')}
          onCollapse={toggleSidebar}
          windowLabel={windowLabel(inboxWindow)}
          onWindow={() => setOverlay('window')}
          onResync={() => void resync()}
          onHideLabel={(labelId, hidden) =>
            void client.request<MailLabel[]>({ kind: 'setLabelHidden', labelId, hidden }).then(list => {
              setLabels(list)
              // A label hidden while open goes back to the inbox.
              if (hidden && split.startsWith('label:') && list.find(l => `label:${l.id}` === split)?.hidden) goTo('important')
            })
          }
          resyncing={resyncing}
        />
      )}
      <div className="mailbox-main">
      <header className="topbar">
        {!sidebarOpen && !touring && (
          <button className="ghost side-open" onClick={toggleSidebar} title="Show the sidebar" aria-label="Show the sidebar">
            ☰
          </button>
        )}
        <nav className="splits">
          {query !== null ? (
            <span className="split active">
              Search: “{query}” <button className="link" onClick={() => setQuery(null)}>clear</button>
            </span>
          ) : inDone ? (
            <>
              {[
                ['done', 'Done'],
                ['done-unopened', 'Never opened'],
                ['done-filed', 'Skipped inbox'],
                ...(rescue?.found ? [['done-rescue', `From people`]] : [])
              ].map(([id, name]) => (
                <button key={id} className={`split ${split === id ? 'active' : ''}`} onClick={() => setSplit(id)}>
                  {name}
                  {id === 'done-rescue' && <span className="count">{rescue?.found}</span>}
                </button>
              ))}
              <button className="split" onClick={() => setSplit('important')}>
                Back to inbox <kbd>G</kbd>
                <kbd>I</kbd>
              </button>
            </>
          ) : inFolder ? (
            <>
              <span className="split active">{folder!.title}</span>
              <button className="split" onClick={() => setSplit('important')}>
                Back to inbox <kbd>G</kbd>
                <kbd>I</kbd>
              </button>
            </>
          ) : (
            splits.map(s => (
              <button
                key={s.id}
                className={`split ${s.id === split ? 'active' : ''}`}
                onClick={() => {
                  setSplit(s.id)
                  setOpen(null)
                }}
              >
                {s.name}
                {s.unread > 0 && <span className="count">{s.unread}</span>}
              </button>
            ))
          )}
        </nav>
        <div className="topbar-right">

          <span className={`sync-dot ${syncState}`} title={`Sync: ${syncState}`} />
          <button className="ghost" onClick={() => setOverlay('palette')} title="Command palette">
            {displayKeys('Mod+k', isMac)}
          </button>
          <button className="ghost" onClick={() => startCompose('new')}>
            Compose <kbd>C</kbd>
          </button>
        </div>
      </header>
      {(split === 'done-unopened' || split === 'done-rescue') && (
        <div className="file-banner">
          {rescue?.state === 'scanning' ? (
            <span>
              Laya is reading mail archived unread from the last {rescue.days} days: {rescue.scanned} of {rescue.total || '…'}. Found{' '}
              <strong>{rescue.found}</strong> from people so far.
            </span>
          ) : rescue?.found ? (
            <>
              <span>
                <strong>{rescue.found}</strong> {rescue.found === 1 ? 'conversation' : 'conversations'} from people, invitations or urgent notices were archived before
                you opened them.
              </span>
              {split !== 'done-rescue' && (
                <button className="ghost" onClick={() => setSplit('done-rescue')}>
                  Show them
                </button>
              )}
              <button className="primary" onClick={() => void bringBack()}>
                Bring all {rescue.found} back
              </button>
            </>
          ) : (
            <>
              <span>
                {rescue?.state === 'done'
                  ? `Laya read ${rescue.scanned} archived conversations from the last ${rescue.days} days and found nothing from people.`
                  : 'Some of this may be mail from people that was archived before you saw it. Laya can find it.'}
              </span>
              <button className="primary" onClick={() => void startRescue(Math.max(90, inboxWindow.days ?? 90))}>
                {rescue?.state === 'done' ? 'Look again' : `Find mail from people (last ${Math.max(90, inboxWindow.days ?? 90)} days)`}
              </button>
            </>
          )}
        </div>
      )}
      {sortingSetup?.running ? (
        <div className="file-banner sorting-setup" role="status">
          <span>
            Setting up smart sorting: {sortingSetup.label}… <strong>{sortingSetup.percent ?? 0}%</strong>. Kestrel keeps working meanwhile.
          </span>
          <progress max={100} value={sortingSetup.percent ?? 0} />
        </div>
      ) : sortingSetup?.error ? (
        <div className="file-banner sorting-setup" role="alert">
          <span>Smart sorting setup stopped: {sortingSetup.error}</span>
          <button className="primary" onClick={turnOnSorting}>
            Try again
          </button>
        </div>
      ) : (
        sortingSetup?.offer &&
        !sortingSetup.dismissed && (
          <div className="file-banner sorting-setup">
            <span>
              <strong>Turn on smart sorting?</strong> Kestrel downloads Laya's model and{' '}
              <a href="https://github.com/afshinm/laya-mps" onClick={e => (e.preventDefault(), void window.kestrel.openExternal('https://github.com/afshinm/laya-mps'))}>
                laya-mps
              </a>
              , which runs it on your Mac's GPU: about 2 GB, once. Sorting then happens on this Mac, and your mail never leaves it.
            </span>
            <button className="primary" onClick={turnOnSorting}>
              Turn on
            </button>
            <button className="ghost" onClick={() => void window.kestrel.dismissSortingSetup().then(setSortingSetup)}>
              Not now
            </button>
          </div>
        )
      )}
      {autoFile?.on === null && autoFile.waiting > 0 && !folder && (
        <div className="file-banner">
          <span>
            Laya found <strong>{autoFile.waiting}</strong> marketing {autoFile.waiting === 1 ? 'email' : 'emails'} in your inbox. Mark them done with the label{' '}
            <code>Kestrel/Marketing</code>, and do the same for new marketing as it arrives?
          </span>
          <button className="primary" onClick={() => void chooseAutoFile(true)}>
            File them away
          </button>
          <button className="ghost" onClick={() => void chooseAutoFile(false)}>
            Keep in inbox
          </button>
        </div>
      )}
      {(syncState === 'error' || syncState === 'offline') && (
        <div className="sync-banner" role="status" title={syncMessage ?? undefined}>
          {syncState === 'offline'
            ? "You're offline. Changes are saved here and sent when you reconnect."
            : syncMessage && /Quota exceeded|RESOURCE_EXHAUSTED|rateLimit| 429 /.test(syncMessage)
              ? 'Gmail asked Kestrel to slow down for a minute. Your changes are saved and will sync automatically.'
              : "Couldn't sync with Gmail."}
          {syncState === 'error' && syncMessage && !/Quota exceeded|RESOURCE_EXHAUSTED|rateLimit| 429 /.test(syncMessage) && (
            <span className="muted"> {syncMessage.replace(/^Gmail /, '').slice(0, 140)}</span>
          )}{' '}
          <button className="link" onClick={() => void client.request({ kind: 'refresh' })}>
            Try now
          </button>
        </div>
      )}
      {progress && (
        <div className="sync-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <div style={{ width: `${(100 * progress.done) / progress.total}%` }} />
        </div>
      )}

      {open ? (
        <ThreadView
          detail={open}
          dark={dark}
          remoteAllowed={remoteAllowed.has(open.summary.id)}
          blockedCount={blockedCount}
          onBlocked={onBlocked}
          onLink={openLink}
          onLoadImages={() => run('loadImages')}
        />
      ) : (
        <main className="thread-list" role="listbox" aria-label="Conversations">
          {!loaded && !progress && (isNetworkView(split) || query !== null) && (
            <div className="inbox-zero">
              <div className="spinner" aria-hidden="true" />
              <p className="muted">{query !== null ? 'Searching…' : `Loading ${folder?.title ?? ''}…`}</p>
            </div>
          )}
          {threads.length === 0 && progress && (
            <div className="inbox-zero">
              <div className="spinner" aria-hidden="true" />
              <h2>Fetching your inbox</h2>
              <p className="muted">
                {progress.done} of {progress.total} conversations
              </p>
            </div>
          )}
          {loaded && threads.length === 0 && !progress && (
            <div className="inbox-zero">
              <div className="zero-mark">✓</div>
              <h2>{query !== null ? 'No results' : folder ? folder.empty : 'Inbox zero'}</h2>
              <p className="muted">{query !== null ? 'Try a different search.' : folder ? folder.hint : 'Nothing left in this split.'}</p>
            </div>
          )}
          {threads.map(t => (
            <div
              key={t.id}
              role="option"
              aria-selected={t.id === selectedId}
              className={`thread-row ${t.id === selectedId ? 'selected' : ''} ${t.unread ? 'unread' : ''}`}
              onClick={() => setSelectedId(t.id)}
              onDoubleClick={() => void openThread(t.id)}
            >
              <span className="from">
                {t.participants.length > 1 ? t.participants.map(p => p.name.split(' ')[0]).join(', ') : t.from.name || t.from.email}
                {t.messageCount > 1 && <span className="msg-count">{t.messageCount}</span>}
              </span>
              <span className="subject-line">
                <span className="subject">{t.subject}</span>
                <span className="snippet"> — {t.snippet}</span>
              </span>
              <span className="meta">
                {t.returnedAt && <span className="tag">Reminder</span>}
                {t.autoLabels?.slice(0, 2).map(l => (
                  <span key={l} className={`tag auto ${URGENT_LABELS.has(l) ? 'urgent' : ''} ${t.labelledByYou ? 'yours' : ''}`} title={t.labelledByYou ? 'You set this for the sender (L to change)' : 'Auto label, set by Laya on this Mac (L to change)'}>
                    {l}
                  </span>
                ))}
                {t.starred && <span className="star">★</span>}
                {inReminders && t.remindAt ? (
                  <span className="date remind-at">{describeWhen(t.remindAt)}</span>
                ) : (
                  <span className="date">{formatDate(t.date)}</span>
                )}
              </span>
            </div>
          ))}
        </main>
      )}

      {touring ? (
        <Tour
          snapshot={{
            loaded,
            split,
            query,
            threads: threads.length,
            open: open !== null,
            composing: compose ? (compose.replyTo ? 'reply' : 'new') : null,
            overlay,
            searchOpen
          } satisfies TourSnapshot}
          subscribe={subscribeTour}
          onFinish={finishTour}
          isMac={isMac}
        />
      ) : (
        <footer className="statusbar">
          <span>
            {account.email}
            {sortState?.state === 'sorting' && (
              <span className="sort-note" title="Laya sorts new mail on this Mac; nothing leaves it">
                {' '}
                · Sorting {sortState.done} of {sortState.total}
              </span>
            )}
            {sortingSetup?.running ? (
              <span className="sort-note">
                {' '}
                · Setting up smart sorting {sortingSetup.percent ?? 0}%
              </span>
            ) : (
              sortState?.state === 'unavailable' && (
                <span className="sort-note off" title={sortState.message}>
                  {' '}
                  · Smart sorting is off
                  {sortingSetup?.offer && (
                    <>
                      {' '}
                      <button className="link" onClick={turnOnSorting}>
                        Turn on
                      </button>
                    </>
                  )}
                </span>
              )
            )}
          </span>
          <span className="muted">
            {inSenders
              ? 'E mark all done · ⌘U unsubscribe · Enter see their mail · G I back to inbox'
              : inDone
              ? 'Shift+E move to inbox · Enter open · G I back to inbox · ? shortcuts'
              : inReminders
                ? 'H change time · Shift+E back to inbox now · E done · G I back to inbox'
                : open
                  ? 'E done · H remind · R reply · J/K next/prev · Esc back'
                  : 'J/K move · Enter open · E done · H remind · L label · Tab next split · ? shortcuts'}
          </span>
        </footer>
      )}

      {searchOpen && (
        <SearchBox
          onSubmit={q => {
            setSearchOpen(false)
            setOpen(null)
            setQuery(q.trim() ? q.trim() : null)
          }}
          onCancel={() => setSearchOpen(false)}
        />
      )}
      {compose && <Composer state={compose} onChange={setCompose} onSend={send} onClose={() => setCompose(null)} isMac={isMac} />}
      {overlay === 'help' && <Help onClose={() => setOverlay(null)} />}
      {overlay === 'stats' && <StatsPanel onClose={() => setOverlay(null)} />}
      {overlay === 'window' && (
        <InboxWindowPicker
          current={inboxWindow}
          onClose={() => setOverlay(null)}
          onPick={w => {
            setOverlay(null)
            setInboxWindow(w)
            void client.request({ kind: 'setInboxWindow', window: w })
            // A wider window only shows what's still in Gmail's inbox; mail archived unread
            // in that stretch stays in Done unless you bring it back.
            const wider = w.days === null || (inboxWindow.days !== null && w.days > inboxWindow.days)
            toast(
              `Inbox now shows ${windowLabel(w)}.${wider ? ' Mail archived before stays in Done.' : ' Older mail stays in Done and search.'}`,
              wider ? { label: 'Find mail from people', run: () => void startRescue(w.days ?? 365) } : undefined,
              8000
            )
          }}
        />
      )}
      {overlay === 'signout' && <SignOutConfirm account={account} onClose={() => setOverlay(null)} toast={toast} />}
      {overlay === 'label' && (open?.summary ?? selected) && (
        <LabelPicker
          thread={(open?.summary ?? selected)!}
          onClose={() => setOverlay(null)}
          onPick={label => {
            setOverlay(null)
            void setSenderLabel(label)
          }}
        />
      )}
      {overlay === 'remind' && (
        <RemindPicker
          onClose={() => setOverlay(null)}
          onPick={at => {
            setOverlay(null)
            remindAt(at)
          }}
        />
      )}
      {overlay === 'palette' && (
        <Palette
          ctx={ctx}
          account={account}
          splits={splits}
          onTurnOnSorting={sortingSetup?.offer && !sortingSetup.running ? turnOnSorting : undefined}
          onClose={() => setOverlay(null)}
          run={command => {
            setOverlay(null)
            setTimeout(() => runRef.current(command), 0)
          }}
          goSplit={id => {
            setOverlay(null)
            setSplit(id)
            setQuery(null)
            setOpen(null)
          }}
          onSignOut={() => setOverlay('signout')}
        />
      )}
      </div>
      <div className="toasts" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className="toast">
            {t.text}
            {t.action && (
              <button
                className="link"
                onClick={() => {
                  t.action!.run()
                  setToasts(ts => ts.filter(x => x.id !== t.id))
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ThreadView({
  detail,
  dark,
  remoteAllowed,
  blockedCount,
  onBlocked,
  onLink,
  onLoadImages
}: {
  detail: ThreadDetail
  dark: boolean
  remoteAllowed: boolean
  blockedCount: number
  onBlocked: (n: number) => void
  onLink: (url: string) => void
  onLoadImages: () => void
}) {
  return (
    <main className="thread-view">
      <h1 className="thread-subject">
        {detail.summary.subject}
        {detail.summary.starred && <span className="star"> ★</span>}
      </h1>
      {!remoteAllowed && blockedCount > 0 && (
        <div className="images-banner">
          Remote images blocked to stop tracking pixels.{' '}
          <button className="link" onClick={onLoadImages}>
            Load images <kbd>I</kbd>
          </button>
        </div>
      )}
      {detail.messages.map((m, i) => (
        <article key={m.id} className={`message ${i === detail.messages.length - 1 ? 'latest' : ''}`}>
          <header className="message-header">
            <span className="avatar">{initials(m.from.name || m.from.email)}</span>
            <div>
              <div>
                <strong>{m.from.name || m.from.email}</strong> <span className="muted">&lt;{m.from.email}&gt;</span>
              </div>
              <div className="muted small">to {formatAddresses(m.to) || 'undisclosed recipients'}</div>
            </div>
            <span className="muted small date">{new Date(m.date).toLocaleString()}</span>
          </header>
          <MessageBody message={m} allowRemote={remoteAllowed} dark={dark} onBlocked={onBlocked} onLink={onLink} />
        </article>
      ))}
    </main>
  )
}

function SearchBox({ onSubmit, onCancel }: { onSubmit: (q: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="overlay" onMouseDown={onCancel}>
      <form
        className="search-box"
        onMouseDown={e => e.stopPropagation()}
        onSubmit={e => {
          e.preventDefault()
          onSubmit(value)
        }}
      >
        <input
          autoFocus
          placeholder="Search mail (Gmail search syntax works: from:, has:attachment, older_than:)"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Escape' && onCancel()}
        />
      </form>
    </div>
  )
}

function Composer({
  state,
  onChange,
  onSend,
  onClose,
  isMac
}: {
  state: ComposeState
  onChange: (s: ComposeState) => void
  onSend: (s: ComposeState) => void
  onClose: () => void
  isMac: boolean
}) {
  const [showCc, setShowCc] = useState(!!state.cc)
  const set = (patch: Partial<ComposeState>) => onChange({ ...state, ...patch })
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      onSend(state)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      const dirty = state.body.trim() && !state.body.startsWith('\n\nOn ')
      if (!dirty || confirm('Discard this draft?')) onClose()
    }
  }
  return (
    <div className="composer" onKeyDown={onKeyDown}>
      <div className="composer-title">{state.replyTo ? 'Reply' : 'New message'}</div>
      <label>
        <span>To</span>
        <input autoFocus={!state.to} value={state.to} onChange={e => set({ to: e.target.value })} placeholder="name@example.com" />
        {!showCc && (
          <button className="link" type="button" onClick={() => setShowCc(true)}>
            Cc
          </button>
        )}
      </label>
      {showCc && (
        <label>
          <span>Cc</span>
          <input value={state.cc} onChange={e => set({ cc: e.target.value })} />
        </label>
      )}
      <label>
        <span>Subject</span>
        <input value={state.subject} onChange={e => set({ subject: e.target.value })} />
      </label>
      <textarea
        autoFocus={!!state.to}
        value={state.body}
        onChange={e => set({ body: e.target.value })}
        ref={el => {
          // Replies start with the cursor above the quoted text.
          if (el && state.replyTo && el.selectionStart === el.value.length && el.dataset.placed !== '1') {
            el.dataset.placed = '1'
            el.setSelectionRange(0, 0)
            el.scrollTop = 0
          }
        }}
      />
      <div className="composer-actions">
        <button className="primary" onClick={() => onSend(state)}>
          Send <kbd>{displayKeys('Mod+Enter', isMac)}</kbd>
        </button>
        <button className="ghost" onClick={onClose}>
          Discard <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  )
}

// How far back the inbox goes, and whether unread mail stays regardless.
function InboxWindowPicker({ current, onPick, onClose }: { current: InboxWindow; onPick: (w: InboxWindow) => void; onClose: () => void }) {
  const [days, setDays] = useState(current.days)
  const [keepUnread, setKeepUnread] = useState(current.keepUnread)
  return (
    <div className="overlay" onMouseDown={onClose} onKeyDown={e => e.key === 'Escape' && onClose()}>
      <form
        className="help window-picker"
        onMouseDown={e => e.stopPropagation()}
        onSubmit={e => {
          e.preventDefault()
          onPick({ days, keepUnread })
        }}
      >
        <h2>Inbox shows</h2>
        <p className="muted small">Older mail isn't touched: it stays in Gmail, in Done and in search.</p>
        {WINDOWS.map(o => (
          <label key={String(o.days)} className="window-option">
            <input type="radio" name="days" checked={days === o.days} onChange={() => setDays(o.days)} autoFocus={days === o.days} />
            <span>{o.label[0].toUpperCase() + o.label.slice(1)}</span>
            {o.days === 14 && <span className="muted small">default</span>}
          </label>
        ))}
        <label className="window-option check">
          <input type="checkbox" checked={keepUnread || days === null} disabled={days === null} onChange={e => setKeepUnread(e.target.checked)} />
          <span>Also keep all unread mail in the inbox</span>
        </label>
        <p className="muted small">A longer reach loads more mail the first time, paced to stay within Gmail's limits.</p>
        <div className="window-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Apply
          </button>
        </div>
      </form>
    </div>
  )
}

interface Stats {
  days: { day: string; done: number; sent: number; received: number }[]
  inbox: number
  unread: number
  pitches: number
  topSenders: { name: string; email: string; count: number }[]
}

const weekday = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short' })

// Your week: a few numbers, mail done and sent per day, and who fills your inbox.
function StatsPanel({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    void client.request<Stats>({ kind: 'stats' }).then(setStats)
  }, [])
  const W = 520
  const H = 150
  const top = 10
  const base = 124
  const max = Math.max(4, ...(stats?.days ?? []).flatMap(d => [d.done, d.sent]))
  const step = max <= 8 ? 2 : max <= 20 ? 5 : max <= 50 ? 10 : 25
  const ceiling = Math.ceil(max / step) * step
  const y = (v: number) => base - ((base - top) * v) / ceiling
  const slot = (W - 32) / 7
  const bar = Math.min(18, (slot - 14) / 2)
  // Rounded on the top only, so each bar stands on the baseline.
  const column = (x: number, v: number) => {
    const h = base - y(v)
    if (h <= 0) return ''
    const r = Math.min(4, h)
    return `M${x} ${base}V${base - h + r}Q${x} ${base - h} ${x + r} ${base - h}H${x + bar - r}Q${x + bar} ${base - h} ${x + bar} ${base - h + r}V${base}Z`
  }
  const week = stats?.days.reduce((n, d) => n + d.received, 0) ?? 0
  return (
    <div className="overlay" onMouseDown={onClose} onKeyDown={e => e.key === 'Escape' && onClose()}>
      <div className="help stats" onMouseDown={e => e.stopPropagation()} tabIndex={-1} ref={el => el?.focus()}>
        <h2>Your week</h2>
        {!stats ? (
          <p className="muted">Counting…</p>
        ) : (
          <>
            <div className="stat-tiles">
              <div><strong>{stats.inbox}</strong><span>in the inbox</span></div>
              <div><strong>{stats.unread}</strong><span>unread</span></div>
              <div><strong>{week}</strong><span>new this week</span></div>
              <div><strong>{stats.pitches}</strong><span>pitches</span></div>
            </div>
            <div className="viz-root">
              <div className="stat-legend">
                <span><i className="sw done" />Marked done</span>
                <span><i className="sw sent" />Sent</span>
              </div>
              <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Mail marked done and sent per day, last 7 days" onMouseLeave={() => setHover(null)}>
                {Array.from({ length: ceiling / step + 1 }, (_, i) => i * step).map(v => (
                  <g key={v}>
                    <line x1="28" x2={W} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis' : 'grid'} />
                    <text x="20" y={y(v) + 3.5} textAnchor="end" className="tick">{v}</text>
                  </g>
                ))}
                {stats.days.map((d, i) => {
                  const x0 = 32 + i * slot + (slot - 2 * bar - 2) / 2
                  return (
                    <g key={d.day} onMouseEnter={() => setHover(i)}>
                      <rect x={32 + i * slot} y={top} width={slot} height={H - top} fill="transparent" />
                      {hover === i && <rect x={32 + i * slot + 2} y={top} width={slot - 4} height={base - top} className="hover-band" />}
                      <path d={column(x0, d.done)} className="bar done" />
                      <path d={column(x0 + bar + 2, d.sent)} className="bar sent" />
                      <text x={32 + i * slot + slot / 2} y={H - 8} textAnchor="middle" className="tick">{i === 6 ? 'Today' : weekday(d.day)}</text>
                    </g>
                  )
                })}
              </svg>
              {hover !== null && (
                <div className="stat-tip" style={{ left: `${((32 + hover * slot + slot / 2) / W) * 100}%` }}>
                  <strong>{hover === 6 ? 'Today' : weekday(stats.days[hover].day)}</strong>
                  <span><i className="sw done" />{stats.days[hover].done} marked done</span>
                  <span><i className="sw sent" />{stats.days[hover].sent} sent</span>
                  <span className="muted">{stats.days[hover].received} new conversations</span>
                </div>
              )}
              <details className="stat-table">
                <summary>Show as a table</summary>
                <table>
                  <thead><tr><th>Day</th><th>Marked done</th><th>Sent</th><th>New</th></tr></thead>
                  <tbody>
                    {stats.days.map(d => (
                      <tr key={d.day}><td>{d.day}</td><td>{d.done}</td><td>{d.sent}</td><td>{d.received}</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
            <h3>Most mail in your inbox from</h3>
            <ol className="top-senders">
              {stats.topSenders.map(s => (
                <li key={s.email}><span>{s.name || s.email}</span><span className="muted">{s.count}</span></li>
              ))}
            </ol>
            <p className="muted small">Clean them up in Senders (G then U). Counts of mail done and sent start from when you began using this version.</p>
          </>
        )}
      </div>
    </div>
  )
}

// Typed times ("2d", "fri 3pm", "oct 30") or a preset; Enter picks.
// Signing out revokes Kestrel's access with Google and forgets the account on this Mac.
function SignOutConfirm({ account, onClose, toast }: { account: Account; onClose: () => void; toast: (text: string) => void }) {
  const [busy, setBusy] = useState(false)
  const gmail = account.provider === 'gmail'
  const signOut = async () => {
    setBusy(true)
    const { revoked } = await window.kestrel.signOut(account.id)
    // This tab goes to the welcome screen, where you can sign in again.
    if (gmail && !revoked) toast("Signed out. Google couldn't be reached to revoke access; remove Kestrel at myaccount.google.com/permissions.")
  }
  return (
    <div className="overlay" onMouseDown={busy ? undefined : onClose} onKeyDown={e => e.key === 'Escape' && !busy && onClose()}>
      <div className="help signout" onMouseDown={e => e.stopPropagation()}>
        <h2>Sign out of {account.email}?</h2>
        <p className="muted">
          {gmail ? 'Google stops letting Kestrel read this account, and ' : ''}this Mac forgets it: its sign-in, cached mail, reminders and the labels you set
          with L. Nothing in Gmail changes, and you can sign in again any time.
        </p>
        <div className="signout-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary danger" autoFocus onClick={() => void signOut()} disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    </div>
  )
}

function LabelPicker({ thread, onPick, onClose }: { thread: ThreadSummary; onPick: (label: AutoLabel | null) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const q = text.trim().toLowerCase()
  const options: { label: AutoLabel | null; name: string }[] = [
    ...AUTO_LABELS.filter(l => l.toLowerCase().includes(q)).map(l => ({ label: l, name: l })),
    ...(thread.labelledByYou && (!q || 'laya'.includes(q)) ? [{ label: null, name: "Let Laya decide again" }] : [])
  ]
  const current = options[Math.min(index, options.length - 1)]
  const now = thread.autoLabels?.[thread.autoLabels.length - 1]
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette remind label-picker" onMouseDown={e => e.stopPropagation()}>
        <div className="remind-title">Label mail from {thread.from.name || thread.from.email}</div>
        <input
          autoFocus
          placeholder="Marketing, News, To respond…"
          value={text}
          onChange={e => {
            setText(e.target.value)
            setIndex(0)
          }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setIndex(i => Math.min(i + 1, options.length - 1))
            else if (e.key === 'ArrowUp') setIndex(i => Math.max(i - 1, 0))
            else if (e.key === 'Enter' && current) onPick(current.label)
            else return
            e.preventDefault()
          }}
        />
        <ul>
          {options.map((o, i) => (
            <li key={o.name} className={o === current ? 'active' : ''} onMouseEnter={() => setIndex(i)} onClick={() => onPick(o.label)}>
              <span>{o.name}</span>
              {o.label && (thread.autoLabels ?? []).includes(o.label) && <span className="muted small">{thread.labelledByYou ? 'set by you' : o.label === now ? "Laya's pick" : 'now'}</span>}
            </li>
          ))}
        </ul>
        <div className="muted small label-picker-note">Applies to everything from this sender, and Laya learns from it.</div>
      </div>
    </div>
  )
}

function RemindPicker({ onPick, onClose }: { onPick: (at: Date) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const now = new Date()
  const parsed = text.trim() ? parseWhen(text, now) : null
  const options = text.trim() ? (parsed ? [{ label: 'Remind me', at: parsed }] : []) : presets(now)
  const current = options[Math.min(index, options.length - 1)]
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette remind" onMouseDown={e => e.stopPropagation()}>
        <div className="remind-title">Remind me</div>
        <input
          autoFocus
          placeholder='Try "tomorrow", "2d", "fri 3pm" or "oct 30"'
          value={text}
          onChange={e => {
            setText(e.target.value)
            setIndex(0)
          }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setIndex(i => Math.min(i + 1, options.length - 1))
            else if (e.key === 'ArrowUp') setIndex(i => Math.max(i - 1, 0))
            else if (e.key === 'Enter' && current) onPick(current.at)
            else return
            e.preventDefault()
          }}
        />
        <ul>
          {options.map((o, i) => (
            <li key={o.label} className={o === current ? 'active' : ''} onMouseEnter={() => setIndex(i)} onClick={() => onPick(o.at)}>
              <span>{o.label}</span>
              <span className="muted small">{describeWhen(o.at, now)}</span>
            </li>
          ))}
          {text.trim() && !parsed && <li className="muted">Can't read that. Try "3d", "fri 2pm" or "nov 3".</li>}
        </ul>
      </div>
    </div>
  )
}

function Help({ onClose }: { onClose: () => void }) {
  const seen = new Set<string>()
  const rows = BINDINGS.filter(b => {
    if (seen.has(b.label)) return false
    seen.add(b.label)
    return true
  })
  return (
    <div className="overlay" onMouseDown={onClose} onKeyDown={e => e.key === 'Escape' && onClose()}>
      <div className="help" onMouseDown={e => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <div className="help-grid">
          {rows.map(b => (
            <div key={b.label} className="help-row">
              <span>{b.label}</span>
              <kbd>{displayKeys(BINDINGS.filter(x => x.label === b.label).map(x => x.keys)[0], isMac)}</kbd>
            </div>
          ))}
          <div className="help-row">
            <span>Send</span>
            <kbd>{displayKeys('Mod+Enter', isMac)}</kbd>
          </div>
          <div className="help-row">
            <span>New tab / switch tab</span>
            <kbd>{isMac ? '⌘T / ⌘1–9' : 'Ctrl+T / Ctrl+1–9'}</kbd>
          </div>
        </div>
        <p className="muted small">Press ? or Esc to close.</p>
      </div>
    </div>
  )
}

interface PaletteItem {
  label: string
  hint?: string
  run: () => void
}

function Palette({
  ctx,
  account,
  splits,
  run,
  goSplit,
  onSignOut,
  onTurnOnSorting,
  onClose
}: {
  ctx: Context
  account: Account
  splits: SplitCount[]
  run: (c: Command) => void
  goSplit: (id: string) => void
  onSignOut: () => void
  onTurnOnSorting?: () => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const items = useMemo<PaletteItem[]>(() => {
    const commands: PaletteItem[] = BINDINGS.filter((b, i, all) => all.findIndex(x => x.command === b.command) === i)
      .filter(b => b.command !== 'palette')
      .map(b => ({ label: b.label, hint: displayKeys(b.keys, isMac), run: () => run(b.command) }))
    const splitItems = splits.map(s => ({ label: `Go to ${s.name}`, hint: s.unread ? `${s.unread} unread` : undefined, run: () => goSplit(s.id) }))
    const accountItems: PaletteItem[] = ctx.accounts
      .filter(a => a.id !== account.id && a.provider !== 'practice')
      .map(a => ({ label: `Switch this tab to ${a.email}`, run: () => void window.kestrel.useAccount(a.id) }))
    return [
      ...commands,
      ...splitItems,
      ...accountItems,
      { label: 'Add or switch account in this tab', run: () => void window.kestrel.useAccount(null) },
      { label: 'Take the guided tour', run: () => void window.kestrel.startTour() },
      ...(onTurnOnSorting ? [{ label: 'Turn on smart sorting (laya-mps on the GPU)', run: onTurnOnSorting }] : []),
      { label: 'Sign in to another account', run: () => void window.kestrel.useAccount(null) },
      { label: `Sign out of ${account.email}`, run: onSignOut }
    ]
  }, [ctx.accounts, account, splits, run, goSplit, onSignOut, onTurnOnSorting])

  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const filtered = items.filter(i => words.every(w => i.label.toLowerCase().includes(w)))
  const current = filtered[Math.min(index, filtered.length - 1)]

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={e => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Type a command…"
          value={text}
          onChange={e => {
            setText(e.target.value)
            setIndex(0)
          }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setIndex(i => Math.min(i + 1, filtered.length - 1))
            else if (e.key === 'ArrowUp') setIndex(i => Math.max(i - 1, 0))
            else if (e.key === 'Enter' && current) {
              onClose()
              current.run()
            } else return
            e.preventDefault()
          }}
        />
        <ul>
          {filtered.slice(0, 12).map((item, i) => (
            <li
              key={item.label}
              className={item === current ? 'active' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                onClose()
                item.run()
              }}
            >
              <span>{item.label}</span>
              {item.hint && <span className="muted small">{item.hint}</span>}
            </li>
          ))}
          {!filtered.length && <li className="muted">No matching commands</li>}
        </ul>
      </div>
    </div>
  )
}
