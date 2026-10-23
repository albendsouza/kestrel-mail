// AccountEngine owns one account's local cache. The UI reads only from the
// cache, so every action is applied locally first (optimistic) and then sent
// to the provider through a retrying outbox.

import { dayKey, sameEmail, senderRows } from './insights'
import { SortUnavailable } from './sorter'
import { DEFAULT_SPLITS, IMPORTANT_SPLIT, inSplit, splitOrder } from './split'

import { labelsFor, verdictFor } from '../shared/sorting'
import { AUTO_LABELS, DEFAULT_INBOX_WINDOW, FILED_LABEL } from '../shared/types'

import type {
  Account,
  InboxWindow,
  Draft,
  EngineEvent,
  MailAction,
  Message,
  SplitCount,
  SplitRule,
  SortState,
  RescueState,
  AutoFileState,
  AutoLabelCount,
  AutoLabel,
  ThreadDetail,
  MailLabel,
  ThreadSummary,
  UnsubscribeResult
} from '../shared/types'
import type { MailProvider } from './providers/provider'
import type { Sorter } from './sorter'
import type { SortInput, SortVerdict } from '../shared/sorting'

// Threads go to Laya a few at a time, so a big first sort shows progress and new mail isn't stuck behind it.
const SORT_BATCH = 8

// Gmail's version of a thread; demo threads without one change version when they get mail.
export const versionOf = (t: ThreadSummary) => t.historyId ?? `${t.date}:${t.messageCount}`

const sortInputOf = (t: ThreadSummary): SortInput => ({
  from: t.from.name && t.from.name !== t.from.email ? `${t.from.name} <${t.from.email}>` : t.from.email,
  subject: t.subject,
  body: t.snippet,
  mailingList: t.listUnsubscribe || t.bulk
})

export interface CacheStorage {
  load(): Promise<PersistedCache | null>
  save(cache: PersistedCache): Promise<void>
}

export interface PersistedCache {
  version: 1
  cursor: string | null
  threads: ThreadSummary[]
  outbox: MailAction[]
  // Added later, so older caches load without them.
  reminders?: Reminder[]
  returned?: [threadId: string, at: number][]
  trusted?: string[]
  stats?: [day: string, counts: DayCounts][]
  inboxWindow?: InboxWindow
  hiddenLabels?: string[]
  // Laya's verdicts, by thread, the thread version and the model they were made with.
  sorted?: [threadId: string, version: string, model: string, verdict: SortVerdict][]
  // Labels you set per sender with L, and the emails you set them on (training data for Laya).
  corrections?: [sender: string, label: AutoLabel][]
  autoFile?: boolean
  doneByYou?: string[]
  correctionLog?: Correction[]
}

export interface Correction {
  from: string
  subject: string
  body: string
  mailing_list: boolean
  label: AutoLabel
  at: number
}

export interface DayCounts {
  done: number
  sent: number
}

export interface MailStats {
  days: { day: string; done: number; sent: number; received: number }[] // the last 7, oldest first
  inbox: number
  unread: number
  pitches: number
  topSenders: { name: string; email: string; count: number }[]
}

// A reminder takes a thread out of the inbox (archived on the server) and brings
// it back at `at`. Kept locally: Gmail has no reminders of its own.
export interface Reminder {
  threadId: string
  at: number
  summary: ThreadSummary
}

interface UndoEntry {
  action: MailAction
  at: number
}

interface ScheduledSend {
  draft: Draft
  timer: ReturnType<typeof setTimeout>
}

export const UNDO_WINDOW_MS = 30_000
const POLL_MS = 30_000
const MAX_BACKOFF_MS = 5 * 60_000
const MESSAGE_CACHE_SIZE = 50
const DONE_LIMIT = 50
// The rescue looks through at most this many unread archived conversations, a batch at a time.
const RESCUE_LIMIT = 1500
const RESCUE_BATCH = 25
// Laya's splits that count as "you'd have wanted to see this".
const RESCUE_SPLITS = new Set(['important', 'to-reply', 'calendar'])

type DoneKind = 'mine' | 'unopened'
interface DoneList {
  ids: string[]
  at: number
  fetch: Promise<void> | null
}
// Done is fetched from the server at most this often; local changes show at once regardless.
const DONE_TTL_MS = 15_000
const REMINDER_CHECK_MS = 15_000
const SENT_LIMIT = 50
const FOLDER_LIMIT = 50
const FOLDER_TTL_MS = 30_000
const LABELS_TTL_MS = 60_000
// Sidebar folders that map straight onto a Gmail system label.
// 'all-starred' is Gmail's Starred folder; the 'starred' split only covers the inbox.
const FOLDER_LABELS: Record<string, string> = { drafts: 'DRAFT', sent: 'SENT', 'all-starred': 'STARRED', spam: 'SPAM', trash: 'TRASH' }

// A folder or label view as last fetched from the server.
interface FolderCache {
  threads: Map<string, ThreadSummary>
  fetchedAt: number
  fetch: Promise<void> | null
}

// "label:Label_12" → "Label_12"; "sent" → "SENT"; anything else → null.
export function folderLabel(split: string): string | null {
  if (split.startsWith('label:')) return split.slice(6)
  return FOLDER_LABELS[split] ?? null
}

export function inverse(action: MailAction): MailAction {
  switch (action.type) {
    case 'archive':
      return { type: 'unarchive', threadId: action.threadId }
    case 'unarchive':
      return { type: 'archive', threadId: action.threadId }
    case 'trash':
      return { type: 'untrash', threadId: action.threadId }
    case 'untrash':
      return { type: 'trash', threadId: action.threadId }
    case 'markRead':
      return { ...action, read: !action.read }
    case 'star':
      return { ...action, starred: !action.starred }
    case 'file':
      return { ...action, type: 'unfile' }
    case 'unfile':
      return { ...action, type: 'file' }
  }
}

// Applies an action to a cached summary. Returns null when the thread leaves the inbox.
export function applyLocal(thread: ThreadSummary, action: MailAction): ThreadSummary | null {
  switch (action.type) {
    case 'archive':
    case 'trash':
    case 'file':
      return null
    case 'unarchive':
    case 'untrash':
    case 'unfile':
      return { ...thread, inInbox: true }
    case 'markRead':
      return { ...thread, unread: !action.read }
    case 'star':
      return { ...thread, starred: action.starred }
  }
}

export class AccountEngine {
  private threads = new Map<string, ThreadSummary>()
  // Threads removed locally but kept so undo can restore them instantly.
  private removed = new Map<string, ThreadSummary>()
  // Done (archived) threads as last fetched, plus ones archived here that the
  // server may not show yet. Trashed ids remember where they came from for untrash.
  private done = new Map<string, ThreadSummary>()
  private doneLocal = new Map<string, ThreadSummary>()
  private trashedFrom = new Map<string, 'inbox' | 'done'>()
  private reminders = new Map<string, Reminder>()
  // Threads a reminder brought back, and when; they sort to the top of the inbox.
  private returned = new Map<string, number>()
  private reminderTimer: ReturnType<typeof setInterval> | null = null
  // Per-day counts of mail done and sent here.
  private stats = new Map<string, DayCounts>()
  private sent = new Map<string, ThreadSummary>()
  private sentFetchedAt = -Infinity
  private sentFetch: Promise<void> | null = null
  private inboxWindow: InboxWindow = DEFAULT_INBOX_WINDOW
  // Label ids hidden in the sidebar; labels nested under them hide too.
  private hiddenLabels = new Set<string>()
  // Laya's verdict per thread, for the thread version it saw.
  private sorted = new Map<string, { version: string; model: string; verdict: SortVerdict }>()
  // The model Kestrel Sort runs now; verdicts from any other are redone.
  private sortModel: string | null = null
  private corrections = new Map<string, AutoLabel>()
  private correctionLog: Correction[] = []
  // Marketing filed out of the inbox automatically; undefined until you've been asked.
  private autoFile: boolean | undefined
  private sortRun: Promise<void> | null = null
  private sortState: SortState = { state: 'idle', done: 0, total: 0 }
  private folders = new Map<string, FolderCache>()
  private labelList: MailLabel[] = []
  private labelsFetchedAt = -Infinity
  private labelsFetch: Promise<void> | null = null
  private doneLists = new Map<DoneKind, DoneList>()
  // Conversations you archived yourself in Kestrel: Done, even if you never opened them.
  private doneByYou = new Set<string>()
  private rescue: { state: RescueState['state']; scanned: number; total: number; found: string[]; days: number; error?: string } = { state: 'idle', scanned: 0, total: 0, found: [], days: 0 }
  // Threads acted on while a sync was in flight. Its results for them may predate
  // the action (even once the outbox has flushed), so local state wins until the next sync.
  private actedDuringSync = new Set<string>()
  private cursor: string | null = null
  private outbox: MailAction[] = []
  private undoStack: UndoEntry[] = []
  private sends = new Map<string, ScheduledSend>()
  private messageCache = new Map<string, Message[]>()
  private listeners = new Set<(e: EngineEvent) => void>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private syncing: Promise<void> | null = null
  private failures = 0
  private stopped = false
  private nextSendId = 1

  constructor(
    readonly account: Account,
    private readonly provider: MailProvider,
    private readonly storage: CacheStorage,
    private readonly rules: SplitRule[] = DEFAULT_SPLITS,
    private readonly now: () => number = Date.now,
    // Kestrel Sort; without one every thread stays in Important.
    private readonly sorter: Sorter | null = null
  ) {}

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(e: EngineEvent): void {
    if (e.kind === 'syncState') this.lastSyncState = e
    for (const l of this.listeners) l(e)
  }

  // The latest sync state, so newly connected views can show it immediately.
  lastSyncState: Extract<EngineEvent, { kind: 'syncState' }> = { kind: 'syncState', state: 'syncing' }

  private changed(): void {
    this.emit({ kind: 'changed' })
    this.emit({ kind: 'badge', unread: this.unreadCount() })
  }

  unreadCount(): number {
    let n = 0
    // The dock badge counts what needs you: Important, To reply and invitations, not codes or updates.
    for (const t of this.inboxView()) if (t.unread && ['important', 'to-reply', 'calendar'].some(s => inSplit(t, s))) n++
    return n
  }

  // Inbox threads inside the time window, with Laya's labels applied; splits and lists match on these.
  // A thread Laya hasn't sorted yet shows in Important, so nothing new is ever hidden.
  private inboxView(): ThreadSummary[] {
    return [...this.threads.values()]
      .filter(t => this.inWindow(t))
      .map(t => {
        // Your own latest message is yours, not mail to sort: it stays in Important (and Waiting).
        if (sameEmail(t.from.email, this.account.email)) return { ...t, split: IMPORTANT_SPLIT }
        // A label you set for this sender beats Laya.
        const corrected = this.corrections.get(t.from.email.toLowerCase())
        if (corrected) {
          const { labels, split } = labelsFor(verdictFor(corrected))
          return { ...t, autoLabels: labels, split, labelledByYou: true }
        }
        // A verdict from an older model still shows until the new one replaces it.
        const s = this.sorted.get(t.id)
        if (!s || s.version !== versionOf(t)) return { ...t, split: IMPORTANT_SPLIT }
        const { labels, split } = labelsFor(s.verdict)
        return { ...t, autoLabels: labels, split }
      })
  }

  private inWindow(t: ThreadSummary): boolean {
    const { days, keepUnread } = this.inboxWindow
    if (days === null) return true
    return t.date >= this.now() - days * 86_400_000 || (keepUnread && t.unread) || this.returned.has(t.id)
  }

  // The Gmail search a full snapshot uses, matching the window.
  inboxQuery(): string {
    const { days, keepUnread } = this.inboxWindow
    if (days === null) return 'in:inbox'
    return keepUnread ? `in:inbox {newer_than:${days}d is:unread}` : `in:inbox newer_than:${days}d`
  }

  getInboxWindow(): InboxWindow {
    return this.inboxWindow
  }

  // A new window means a new snapshot: the cache only holds what the old one covered.
  setInboxWindow(window: InboxWindow): void {
    this.inboxWindow = { days: window.days === null ? null : Math.max(1, Math.round(window.days)), keepUnread: !!window.keepUnread }
    this.cursor = null
    this.changed()
    void this.persist().then(() => this.sync())
  }

  async start({ poll = true }: { poll?: boolean } = {}): Promise<void> {
    const cached = await this.storage.load().catch(() => null)
    if (cached?.version === 1) {
      this.cursor = cached.cursor
      for (const t of cached.threads) this.threads.set(t.id, t)
      this.outbox = cached.outbox
      for (const r of cached.reminders ?? []) this.reminders.set(r.threadId, r)
      for (const [id, at] of cached.returned ?? []) this.returned.set(id, at)
      for (const [day, counts] of cached.stats ?? []) this.stats.set(day, counts)
      if (cached.inboxWindow) this.inboxWindow = cached.inboxWindow
      for (const id of cached.hiddenLabels ?? []) this.hiddenLabels.add(id)
      for (const [sender, label] of cached.corrections ?? []) this.corrections.set(sender, label)
      this.correctionLog = cached.correctionLog ?? []
      this.autoFile = cached.autoFile
      for (const id of cached.doneByYou ?? []) this.doneByYou.add(id)
      if (Array.isArray(cached.sorted)) for (const [id, version, model, verdict] of cached.sorted) this.sorted.set(id, { version, model, verdict })
      // Pending actions already shaped the saved cache, so nothing to re-apply here.
      this.changed()
      void this.sortInbox()
    }
    await this.sync()
    // Reminders that came due while Kestrel was closed fire now.
    this.checkReminders()
    if (poll) {
      this.schedulePoll()
      this.reminderTimer = setInterval(() => this.checkReminders(), REMINDER_CHECK_MS)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.reminderTimer) clearInterval(this.reminderTimer)
    for (const s of this.sends.values()) clearTimeout(s.timer)
  }

  private schedulePoll(delay = POLL_MS): void {
    if (this.stopped) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(async () => {
      await this.sync()
      const backoff = this.failures ? Math.min(POLL_MS * 2 ** this.failures, MAX_BACKOFF_MS) : POLL_MS
      this.schedulePoll(backoff)
    }, delay)
  }

  sync(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => {
        this.syncing = null
      })
    }
    return this.syncing
  }

  private async doSync(): Promise<void> {
    this.emit({ kind: 'syncState', state: 'syncing' })
    try {
      await this.flushOutbox()
      const known = new Set(this.threads.keys())
      const firstSync = this.cursor === null
      // On the first sync, show the inbox batch by batch instead of all at the end.
      const onProgress = (batch: ThreadSummary[], done: number, total: number) => {
        for (const t of batch) if (t.inInbox) this.threads.set(t.id, t)
        this.emit({ kind: 'syncProgress', done, total })
        this.changed()
      }
      this.actedDuringSync.clear()
      // What we already hold, by version, so a fresh snapshot can skip it.
      const versions = new Map([...this.threads.values()].filter(t => t.historyId).map(t => [t.id, t.historyId!]))
      const result = await this.provider.sync(this.cursor, firstSync ? onProgress : undefined, this.inboxQuery(), versions)
      const keepLocal = new Map([...this.actedDuringSync].map(id => [id, this.threads.get(id)]))
      if (result.full) {
        const kept = (result.unchanged ?? []).map(id => this.threads.get(id)).filter((t): t is ThreadSummary => !!t)
        this.threads.clear()
        for (const t of kept) this.threads.set(t.id, t)
      }
      for (const id of result.removals) if (!keepLocal.has(id)) this.threads.delete(id)
      for (const [id, local] of keepLocal) if (local) this.threads.set(id, local)
      for (const summary of result.upserts) {
        if (keepLocal.has(summary.id)) continue
        // Re-apply actions the server hasn't seen yet so it doesn't undo them on screen.
        let local: ThreadSummary | null = summary.inInbox ? summary : null
        for (const pending of this.outbox) {
          if (local && pending.threadId === summary.id) local = applyLocal(local, pending)
        }
        if (local) this.threads.set(summary.id, local)
        else this.threads.delete(summary.id)
        // Back in the inbox on the server (usually a reply): the reminder has done its job.
        if (local && this.reminders.delete(summary.id)) this.returned.set(summary.id, this.now())
        this.messageCache.delete(summary.id)
      }
      this.cursor = result.cursor
      this.failures = 0
      await this.persist()
      this.changed()
      if (!firstSync) {
        const arrivals = result.upserts.filter(t => t.unread && !known.has(t.id) && this.threads.has(t.id))
        if (arrivals.length) this.emit({ kind: 'newMail', threads: arrivals })
      }
      this.emit({ kind: 'syncState', state: 'idle' })
      void this.sortInbox()
    } catch (e) {
      this.failures++
      const message = e instanceof Error ? e.message : String(e)
      const offline = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)
      this.emit({ kind: 'syncState', state: offline ? 'offline' : 'error', message })
    }
  }

  private async persist(): Promise<void> {
    await this.storage.save({
      version: 1,
      cursor: this.cursor,
      threads: [...this.threads.values()],
      outbox: this.outbox,
      reminders: [...this.reminders.values()],
      returned: [...this.returned],
      corrections: [...this.corrections],
      autoFile: this.autoFile,
      doneByYou: [...this.doneByYou].slice(-5000),
      correctionLog: this.correctionLog.slice(-2000),
      sorted: [...this.sorted].filter(([id]) => this.threads.has(id)).map(([id, s]) => [id, s.version, s.model, s.verdict]),
      stats: [...this.stats].slice(-60),
      inboxWindow: this.inboxWindow,
      hiddenLabels: [...this.hiddenLabels]
    })
  }

  // ── Sorting ─────────────────────────────────────────────────────────────

  getSortState(): SortState {
    return this.sortState
  }

  private setSortState(state: SortState): void {
    this.sortState = state
    this.emit({ kind: 'sortState', state })
  }

  // Sorts inbox threads Laya hasn't seen, or that changed since, newest first.
  sortInbox(): Promise<void> {
    if (!this.sorter) return Promise.resolve()
    this.sortRun ??= this.runSort().finally(() => (this.sortRun = null))
    return this.sortRun
  }

  private async runSort(): Promise<void> {
    const fresh = (t: ThreadSummary) => {
      const s = this.sorted.get(t.id)
      return !!s && s.version === versionOf(t) && s.model === this.sortModel
    }
    const pending = () =>
      [...this.threads.values()].filter(t => this.inWindow(t) && !fresh(t) && !sameEmail(t.from.email, this.account.email)).sort((a, b) => b.date - a.date)
    let todo: ThreadSummary[] = []
    let done = 0
    try {
      // Which model is installed decides what still needs sorting; asking costs nothing.
      if (!this.sortModel) this.sortModel = (await this.sorter!.sort([])).model
      todo = pending()
      if (!todo.length) return
      this.setSortState({ state: 'sorting', done, total: todo.length })
      while (todo.length && !this.stopped) {
        const batch = todo.slice(0, SORT_BATCH)
        const { model, verdicts } = await this.sorter!.sort(batch.map(sortInputOf))
        this.sortModel = model
        batch.forEach((t, i) => this.sorted.set(t.id, { version: versionOf(t), model, verdict: verdicts[i] }))
        done += batch.length
        // Mail that arrived meanwhile joins the queue.
        todo = pending()
        this.setSortState({ state: 'sorting', done, total: done + todo.length })
        this.changed()
        this.runAutoFile()
      }
      this.setSortState({ state: 'idle', done, total: done })
      await this.persist()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!(e instanceof SortUnavailable)) console.error(`[sort] ${this.account.id}: ${message}`)
      this.setSortState({ state: e instanceof SortUnavailable ? 'unavailable' : 'idle', done, total: done + todo.length, message })
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  splits(): SplitCount[] {
    return splitOrder(this.rules).map(({ id, name }) => {
      let unread = 0
      let total = 0
      for (const t of this.inboxView()) {
        if (!inSplit(t, id)) continue
        total++
        if (t.unread) unread++
      }
      return { id, name, unread, total }
    })
  }

  // ── Filing marketing away ────────────────────────────────────────────────

  filedLabelId(): string | undefined {
    return this.labelList.find(l => l.name === FILED_LABEL)?.id
  }

  // Inbox marketing Kestrel may file: Laya's call when it's at least 80% sure, or your own
  // label for the sender. Starred mail is yours to keep, so it's never filed.
  private fileCandidates(): ThreadSummary[] {
    return this.inboxView().filter(t => {
      if (!t.autoLabels?.includes('Marketing') || t.starred) return false
      return t.labelledByYou || (this.sorted.get(t.id)?.verdict.confidence ?? 0) >= 0.8
    })
  }

  getAutoFile(): AutoFileState {
    return { on: this.autoFile ?? null, waiting: this.fileCandidates().length }
  }

  // Turning it on files what's already waiting, then every new marketing email as it's sorted.
  setAutoFile(on: boolean): { filed: number } {
    this.autoFile = on
    void this.persist()
    return { filed: this.runAutoFile() }
  }

  private runAutoFile(): number {
    if (!this.autoFile) return 0
    const candidates = this.fileCandidates()
    if (!candidates.length) return 0
    // One save and one flush for the lot, however many there are.
    for (const t of candidates) {
      const action: MailAction = { type: 'file', threadId: t.id, label: FILED_LABEL }
      if (this.syncing) this.actedDuringSync.add(t.id)
      this.applyToViews(action)
      this.outbox.push(action)
    }
    this.changed()
    void this.persist().then(() => this.flushOutbox())
    return candidates.length
  }

  // You set a label with L: it applies to everything from that sender at once, now and
  // later, and the email is kept as a training example for the next Laya fine-tune.
  // On mail that was filed away, any other label brings it back to the inbox.
  setLabel(threadId: string, label: AutoLabel | null): { sender: string; count: number } {
    const filed = this.doneLocal.get(threadId) ?? this.done.get(threadId) ?? [...this.folders.values()].find(f => f.threads.has(threadId))?.threads.get(threadId)
    const t = this.threads.get(threadId) ?? filed
    if (!t) throw new Error('That conversation is no longer here.')
    if (!this.threads.has(threadId) && label !== 'Marketing' && t.labels.some(l => l === FILED_LABEL || l === this.filedLabelId())) {
      this.act({ type: 'unfile', threadId, label: FILED_LABEL }, { recordUndo: false, countDone: false })
    }
    const sender = t.from.email.toLowerCase()
    if (label) {
      this.corrections.set(sender, label)
      this.correctionLog.push({ from: sortInputOf(t).from, subject: t.subject, body: t.snippet, mailing_list: t.listUnsubscribe || t.bulk, label, at: this.now() })
    } else this.corrections.delete(sender)
    this.changed()
    void this.persist()
    this.runAutoFile()
    const count = [...this.threads.values()].filter(x => this.inWindow(x) && sameEmail(x.from.email, sender)).length
    return { sender: t.from.name || t.from.email, count }
  }

  // Laya's labels on inbox mail, in AUTO_LABELS order, skipping ones nothing has.
  autoLabelCounts(): AutoLabelCount[] {
    const counts = new Map<AutoLabel, AutoLabelCount>()
    for (const t of this.inboxView()) {
      for (const label of t.autoLabels ?? []) {
        const c = counts.get(label) ?? { label, total: 0, unread: 0 }
        c.total++
        if (t.unread) c.unread++
        counts.set(label, c)
      }
    }
    // Filed marketing counts too: it's out of the inbox, not gone.
    const filed = this.labelList.find(l => l.name === FILED_LABEL)
    if (filed?.total) {
      const c = counts.get('Marketing') ?? { label: 'Marketing' as const, total: 0, unread: 0 }
      counts.set('Marketing', { ...c, total: c.total + filed.total, unread: c.unread + filed.unread })
    }
    return AUTO_LABELS.flatMap(l => counts.get(l) ?? [])
  }

  async listThreads(split: string, query?: string): Promise<ThreadSummary[]> {
    // "auto:Code": inbox mail Laya labelled Code, newest first, across every split.
    // Marketing also lists what was filed away, from its Gmail label.
    if (split.startsWith('auto:') && !query?.trim()) {
      const label = split.slice(5)
      const inbox = this.inboxView().filter(t => t.autoLabels?.some(l => l === label))
      const filedId = label === 'Marketing' ? (await this.labels(), this.filedLabelId()) : undefined
      const filed = filedId ? (await this.listFolder(filedId)).filter(t => !inbox.some(i => i.id === t.id)).map(t => ({ ...t, autoLabels: ['Marketing' as const] })) : []
      return [...inbox, ...filed].sort((a, b) => b.date - a.date)
    }
    if (split === 'done' && !query?.trim()) return this.listDone('mine')
    if (split === 'done-unopened' && !query?.trim()) return this.listDone('unopened')
    if (split === 'done-rescue' && !query?.trim()) return this.listRescue()
    if (split === 'done-filed' && !query?.trim()) {
      await this.labels()
      const id = this.filedLabelId()
      const local = [...this.doneLocal.values()].filter(t => this.isFiled(t))
      const remote = id ? await this.listFolder(id) : []
      const byId = new Map([...remote, ...local].map(t => [t.id, this.withVerdict({ ...t, inInbox: false })]))
      return [...byId.values()].filter(t => !this.threads.has(t.id)).sort((a, b) => b.date - a.date)
    }
    const labelId = folderLabel(split)
    if (labelId && !query?.trim()) return this.listFolder(labelId)
    if (split === 'senders' && !query?.trim()) return this.listSenders()
    if (split === 'to-reply' && !query?.trim()) {
      // Reply Zero: mail a person sent you that needs an answer, oldest first.
      return this.inboxView()
        .filter(t => inSplit(t, 'to-reply'))
        .sort((a, b) => a.date - b.date)
    }
    if (split === 'waiting' && !query?.trim()) return this.listWaiting()
    if (split === 'reminders' && !query?.trim()) {
      return [...this.reminders.values()].map(r => ({ ...r.summary, inInbox: false, remindAt: r.at })).sort((a, b) => a.remindAt - b.remindAt)
    }
    if (query?.trim()) {
      // Search local cache first; fall back to the server for anything older.
      const q = query.trim().toLowerCase()
      const local = [...this.threads.values()].filter(t =>
        `${t.subject} ${t.snippet} ${t.from.name} ${t.from.email}`.toLowerCase().includes(q)
      )
      try {
        const remote = await this.provider.search(query.trim())
        const byId = new Map(local.map(t => [t.id, t]))
        for (const t of remote) if (!byId.has(t.id)) byId.set(t.id, t)
        return [...byId.values()].sort((a, b) => b.date - a.date)
      } catch {
        return local.sort((a, b) => b.date - a.date)
      }
    }
    // Threads a reminder brought back sort by when they came back, so they show on top.
    const sortKey = (t: ThreadSummary) => Math.max(t.date, this.returned.get(t.id) ?? 0)
    return this.inboxView()
      .filter(t => inSplit(t, split))
      .map(t => (this.returned.has(t.id) ? { ...t, returnedAt: this.returned.get(t.id) } : t))
      .sort((a, b) => sortKey(b) - sortKey(a))
  }

  // Done comes from the server each time it is shown, so mail archived elsewhere
  // appears too. Offline, it falls back to the last list plus local archives.
  // Two kinds: "mine" (you read it, or archived it yourself here) and "unopened"
  // (archived while unread, by something else). Filed-away mail has its own view.
  private async listDone(kind: DoneKind): Promise<ThreadSummary[]> {
    const list = this.doneLists.get(kind) ?? { ids: [], at: -Infinity, fetch: null }
    this.doneLists.set(kind, list)
    if (this.now() - list.at > DONE_TTL_MS) {
      // Views reload on every change; they all wait on one fetch instead of starting their own.
      list.fetch ??= this.refreshDone(kind, list).finally(() => (list.fetch = null))
      await list.fetch
    }
    const me = this.account.email.toLowerCase()
    const out = new Map<string, ThreadSummary>()
    for (const id of list.ids) {
      const t = this.done.get(id)
      if (t) out.set(id, t)
    }
    // Your own archives here show at once, before Gmail lists them.
    for (const [id, t] of this.doneLocal) if (!this.isFiled(t) && this.doneKind(t) === kind) out.set(id, t)
    for (const [id, t] of [...out]) {
      // Threads that are only your own sent mail aren't "done" in any useful sense.
      const sentOnly = t.participants.length > 0 && t.participants.every(p => p.email.toLowerCase() === me)
      const local = this.doneLocal.get(id)
      if (this.threads.has(id) || this.trashedFrom.has(id) || this.reminders.has(id) || sentOnly || (local && this.isFiled(local))) out.delete(id)
      // Reading or archiving it here moves it between the two.
      else if (this.doneKind(local ?? t) !== kind) out.delete(id)
    }
    return [...out.values()].map(t => this.withVerdict({ ...t, inInbox: false })).sort((a, b) => b.date - a.date)
  }

  private doneKind(t: ThreadSummary): DoneKind {
    return !t.unread || this.doneByYou.has(t.id) ? 'mine' : 'unopened'
  }

  private isFiled(t: ThreadSummary): boolean {
    const id = this.filedLabelId()
    return t.labels.some(l => l === FILED_LABEL || (!!id && l === id))
  }

  // Laya's labels on mail outside the inbox it has sorted (Never opened, the rescue).
  private withVerdict(t: ThreadSummary): ThreadSummary {
    const s = this.sorted.get(t.id)
    if (!s) return t
    const { labels, split } = labelsFor(s.verdict)
    return { ...t, autoLabels: labels, split }
  }

  private async refreshDone(kind: DoneKind, list: DoneList): Promise<void> {
    try {
      let ids = await this.provider.listDoneIds(DONE_LIMIT, { unread: kind === 'unopened' })
      // Unread mail you archived yourself belongs with yours, not with "never opened".
      if (kind === 'unopened') ids = ids.filter(id => !this.doneByYou.has(id))
      else {
        const unreadMine = await this.provider.listDoneIds(DONE_LIMIT, { unread: true })
        ids = [...ids, ...unreadMine.filter(id => this.doneByYou.has(id))]
      }
      const missing = ids.filter(id => !this.done.has(id))
      for (const t of missing.length ? await this.provider.summaries(missing) : []) this.done.set(t.id, t)
      list.ids = ids
      // Keep only what some list still shows.
      const shown = new Set([...this.doneLists.values()].flatMap(l => l.ids).concat(this.rescue.found))
      for (const id of [...this.done.keys()]) if (!shown.has(id)) this.done.delete(id)
      // Local archives the server already reflects no longer need tracking.
      const pending = new Set(this.outbox.map(a => a.threadId))
      for (const id of [...this.doneLocal.keys()]) if (shown.has(id) && !pending.has(id)) this.doneLocal.delete(id)
      list.at = this.now()
    } catch {
      // Offline or failing: keep the last list and try again on the next view.
    }
  }

  // ── Rescue: mail from people that was archived without being opened ──────────

  getRescue(): RescueState {
    return { state: this.rescue.state, scanned: this.rescue.scanned, total: this.rescue.total, found: this.rescue.found.length, days: this.rescue.days }
  }

  // Laya reads unread archived mail from the last `days` and keeps what it would have
  // put in Important, To reply or Calendar. Gmail summaries come through the background
  // budget, so a big Done takes a few minutes, with progress shown.
  rescueScan(days: number): RescueState {
    if (this.rescue.state !== 'scanning' && this.sorter) {
      this.rescue = { state: 'scanning', scanned: 0, total: 0, found: [], days }
      void this.runRescue(days)
    }
    return this.getRescue()
  }

  private async runRescue(days: number): Promise<void> {
    const sorter = this.sorter!
    try {
      const ids = (await this.provider.listDoneIds(RESCUE_LIMIT, { unread: true, newerThanDays: days })).filter(id => !this.doneByYou.has(id))
      this.rescue.total = ids.length
      this.changed()
      if (!this.sortModel) this.sortModel = (await sorter.sort([])).model
      for (let i = 0; i < ids.length && !this.stopped; i += RESCUE_BATCH) {
        const chunk = ids.slice(i, i + RESCUE_BATCH)
        const missing = chunk.filter(id => !this.done.has(id))
        for (const t of missing.length ? await this.provider.summaries(missing) : []) this.done.set(t.id, t)
        const todo = chunk.map(id => this.done.get(id)).filter((t): t is ThreadSummary => !!t && !(this.sorted.get(t.id)?.model === this.sortModel && this.sorted.get(t.id)?.version === versionOf(t)))
        if (todo.length) {
          const { model, verdicts } = await sorter.sort(todo.map(sortInputOf))
          todo.forEach((t, k) => this.sorted.set(t.id, { version: versionOf(t), model, verdict: verdicts[k] }))
        }
        for (const id of chunk) {
          const t = this.done.get(id)
          const split = t && this.withVerdict(t).split
          if (split && RESCUE_SPLITS.has(split)) this.rescue.found.push(id)
        }
        this.rescue.scanned = Math.min(i + RESCUE_BATCH, ids.length)
        this.changed()
      }
      this.rescue.state = 'done'
    } catch (e) {
      this.rescue.state = 'done'
      this.rescue.error = e instanceof Error ? e.message : String(e)
    }
    this.changed()
    void this.persist()
  }

  private listRescue(): ThreadSummary[] {
    return this.rescue.found
      .map(id => this.done.get(id))
      .filter((t): t is ThreadSummary => !!t && !this.threads.has(t.id) && !this.trashedFrom.has(t.id))
      .map(t => this.withVerdict({ ...t, inInbox: false }))
      .sort((a, b) => b.date - a.date)
  }

  // Puts every rescued conversation back in the inbox. Unread stays unread.
  bringBack(): { moved: number } {
    const list = this.listRescue()
    for (const t of list) {
      const action: MailAction = { type: 'unarchive', threadId: t.id }
      if (this.syncing) this.actedDuringSync.add(t.id)
      this.applyToViews(action)
      this.outbox.push(action)
    }
    this.rescue.found = []
    // They're inbox mail again; the window must reach them for them to show.
    this.changed()
    void this.persist().then(() => this.flushOutbox())
    return { moved: list.length }
  }

  // Any Gmail folder or label (Sent, Drafts, Starred, Spam, Trash, user labels).
  private async listFolder(labelId: string): Promise<ThreadSummary[]> {
    let cache = this.folders.get(labelId)
    if (!cache) this.folders.set(labelId, (cache = { threads: new Map(), fetchedAt: -Infinity, fetch: null }))
    if (this.now() - cache.fetchedAt > FOLDER_TTL_MS) {
      const c = cache
      c.fetch ??= this.refreshFolder(labelId, c).finally(() => (c.fetch = null))
      await c.fetch
    }
    const out = [...cache.threads.values()]
      // Local changes the server may not show yet.
      .filter(t => (labelId === 'TRASH' ? true : !this.trashedFrom.has(t.id)))
      .map(t => this.threads.get(t.id) ?? t)
      .filter(t => (labelId === 'STARRED' ? t.starred : true))
    return out.sort((a, b) => b.date - a.date)
  }

  private async refreshFolder(labelId: string, cache: FolderCache): Promise<void> {
    try {
      const ids = await this.provider.listLabelThreadIds(labelId, FOLDER_LIMIT)
      // Reuse summaries we already hold; only fetch the rest.
      const known = (id: string) => cache.threads.get(id) ?? this.threads.get(id) ?? this.done.get(id) ?? this.sent.get(id)
      const missing = ids.filter(id => !known(id))
      const fetched = new Map((missing.length ? await this.provider.summaries(missing) : []).map(t => [t.id, t]))
      const next = new Map<string, ThreadSummary>()
      for (const id of ids) {
        const t = fetched.get(id) ?? known(id)
        if (t) next.set(id, t)
      }
      cache.threads = next
      cache.fetchedAt = this.now()
    } catch {
      // Offline or failing: keep the last list.
    }
  }

  // Brings Kestrel back in line with Gmail without refetching everything. The inbox
  // is compared by thread version (Gmail's historyId): only threads that changed,
  // appeared or vanished are touched. Labels reload; folders reload when next shown.
  async resync(): Promise<{ checked: number; updated: number; removed: number; labels: number }> {
    await this.sync()
    // Unlike the quiet refresh, a resync reports a failure.
    this.labelList = await this.provider.listLabels()
    this.labelsFetchedAt = this.now()
    this.folders.clear()
    this.done.clear()
    this.doneLists.clear()
    this.sent.clear()
    this.sentFetchedAt = -Infinity
    this.messageCache.clear()

    const index = await this.provider.listInboxIndex(this.inboxQuery())
    const versions = new Map(index.map(t => [t.id, t.historyId]))
    const pending = new Set(this.outbox.map(a => a.threadId))
    let removed = 0
    for (const id of [...this.threads.keys()]) {
      if (versions.has(id) || pending.has(id) || this.returned.has(id)) continue
      this.threads.delete(id)
      removed++
    }
    const stale = index.filter(t => !pending.has(t.id) && this.threads.get(t.id)?.historyId !== t.historyId).map(t => t.id)
    const fresh = stale.length ? await this.provider.summaries(stale) : []
    for (const t of fresh) {
      if (t.inInbox) this.threads.set(t.id, t)
      else this.threads.delete(t.id)
    }
    await this.persist()
    this.changed()
    return { checked: index.length, updated: fresh.length, removed, labels: this.labelList.filter(l => !l.system).length }
  }

  // Gmail labels and folders with counts, for the sidebar.
  async labels(): Promise<MailLabel[]> {
    if (this.now() - this.labelsFetchedAt > LABELS_TTL_MS) {
      this.labelsFetch ??= this.provider
        .listLabels()
        .then(list => {
          this.labelList = list
          this.labelsFetchedAt = this.now()
        })
        .catch(() => {})
        .finally(() => (this.labelsFetch = null))
      await this.labelsFetch
    }
    return this.withHidden(this.labelList)
  }

  // Marks labels hidden by their own setting or a hidden parent ("A" hides "A/B").
  private withHidden(list: MailLabel[]): MailLabel[] {
    const hiddenNames = list.filter(l => this.hiddenLabels.has(l.id)).map(l => l.name)
    return list.map(l => (l.system ? l : { ...l, hidden: hiddenNames.some(n => l.name === n || l.name.startsWith(`${n}/`)) }))
  }

  setLabelHidden(labelId: string, hidden: boolean): MailLabel[] {
    if (hidden) this.hiddenLabels.add(labelId)
    else {
      // Showing a label also clears any parent that was hiding it.
      const label = this.labelList.find(l => l.id === labelId)
      this.hiddenLabels.delete(labelId)
      if (label) for (const l of this.labelList) if (label.name.startsWith(`${l.name}/`)) this.hiddenLabels.delete(l.id)
    }
    void this.persist()
    return this.withHidden(this.labelList)
  }

  // One row per sender in the inbox, shaped like a thread so the list can show it.
  private listSenders(): ThreadSummary[] {
    return senderRows(this.threads.values(), this.account.email).map(r => ({
      ...r.latest,
      id: `sender:${r.sender.email}`,
      subject: `${r.count} conversation${r.count === 1 ? '' : 's'}`,
      snippet: [r.unread ? `${r.unread} unread` : '', r.newsletter ? 'newsletter' : '', r.sender.email].filter(Boolean).join(' · '),
      from: r.sender,
      participants: [r.sender],
      messageCount: 1,
      unread: false,
      starred: false,
      senderOf: { email: r.sender.email, count: r.count, latestThreadId: r.latest.id }
    }))
  }

  // Reply Zero: threads you wrote last in, in the past 30 days, oldest first.
  private async listWaiting(): Promise<ThreadSummary[]> {
    if (this.now() - this.sentFetchedAt > DONE_TTL_MS) {
      this.sentFetch ??= this.refreshSent().finally(() => (this.sentFetch = null))
      await this.sentFetch
    }
    const me = this.account.email
    const byId = new Map(this.sent)
    // The inbox copy is fresher when a thread is in both.
    for (const t of this.threads.values()) if (byId.has(t.id)) byId.set(t.id, t)
    return [...byId.values()]
      .filter(t => sameEmail(t.from.email, me) && t.participants.length > 0 && !this.trashedFrom.has(t.id))
      .sort((a, b) => a.date - b.date)
  }

  private async refreshSent(): Promise<void> {
    try {
      const ids = await this.provider.listSentIds(SENT_LIMIT)
      const missing = ids.filter(id => !this.sent.has(id))
      const fetched = missing.length ? await this.provider.summaries(missing) : []
      const next = new Map<string, ThreadSummary>()
      for (const t of fetched) this.sent.set(t.id, t)
      for (const id of ids) {
        const t = this.sent.get(id)
        if (t) next.set(id, t)
      }
      this.sent = next
      this.sentFetchedAt = this.now()
    } catch {
      // Offline or failing: keep the last list.
    }
  }

  async getThread(threadId: string): Promise<ThreadDetail> {
    const summary =
      this.threads.get(threadId) ??
      this.removed.get(threadId) ??
      this.reminders.get(threadId)?.summary ??
      this.doneLocal.get(threadId) ??
      this.done.get(threadId) ??
      this.sent.get(threadId) ??
      [...this.folders.values()].find(f => f.threads.has(threadId))?.threads.get(threadId)
    let messages = this.messageCache.get(threadId)
    if (!messages) {
      messages = await this.provider.getMessages(threadId)
      this.messageCache.set(threadId, messages)
      if (this.messageCache.size > MESSAGE_CACHE_SIZE) {
        this.messageCache.delete(this.messageCache.keys().next().value!)
      }
    }
    const last = messages[messages.length - 1]
    return {
      summary: summary ?? {
        id: threadId,
        subject: messages[0]?.subject ?? '',
        snippet: '',
        from: last?.from ?? { name: '', email: '' },
        participants: [],
        date: last?.date ?? 0,
        unread: false,
        starred: false,
        inInbox: false,
        messageCount: messages.length,
        listUnsubscribe: false,
        bulk: false,
        labels: []
      },
      messages
    }
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  act(action: MailAction, { recordUndo = true, countDone = true }: { recordUndo?: boolean; countDone?: boolean } = {}): void {
    if (this.syncing) this.actedDuringSync.add(action.threadId)
    if (action.type === 'archive' && recordUndo && countDone && this.threads.has(action.threadId)) this.count('done')
    // What you archive here is Done by you, opened or not; moving it back undoes that.
    if (action.type === 'archive' && countDone) this.doneByYou.add(action.threadId)
    if (action.type === 'unarchive') this.doneByYou.delete(action.threadId)
    this.applyToViews(action)
    if (recordUndo && action.type !== 'markRead') {
      this.undoStack.push({ action, at: this.now() })
      if (this.undoStack.length > 20) this.undoStack.shift()
    }
    this.outbox.push(action)
    this.changed()
    void this.persist().then(() => this.flushOutbox())
  }

  // Moves a thread between the inbox, Done and trash on screen, ahead of the server.
  private applyToViews(action: MailAction): void {
    const id = action.threadId
    const inInbox = this.threads.get(id)
    const current =
      inInbox ??
      this.removed.get(id) ??
      this.reminders.get(id)?.summary ??
      this.doneLocal.get(id) ??
      this.done.get(id) ??
      this.sent.get(id) ??
      [...this.folders.values()].find(f => f.threads.has(id))?.threads.get(id)
    if (!current) return
    // Any move ends a pending reminder and the "came back" marker; read and star don't.
    if (action.type !== 'markRead' && action.type !== 'star') {
      this.reminders.delete(id)
      this.returned.delete(id)
    }
    const toInbox = () => {
      this.threads.set(id, { ...current, inInbox: true })
      this.removed.delete(id)
      this.doneLocal.delete(id)
      this.done.delete(id)
    }
    const leaveInbox = () => {
      if (inInbox) this.removed.set(id, inInbox)
      this.threads.delete(id)
    }
    switch (action.type) {
      case 'archive':
        leaveInbox()
        this.trashedFrom.delete(id)
        this.doneLocal.set(id, { ...current, inInbox: false })
        return
      case 'unarchive':
      case 'unfile':
        return toInbox()
      case 'file':
        leaveInbox()
        this.doneLocal.set(id, { ...current, inInbox: false, labels: [...current.labels.filter(l => l !== action.label), action.label] })
        // The label is new or its count changed; the sidebar should ask Gmail again.
        this.labelsFetchedAt = -Infinity
        this.folders.delete(this.filedLabelId() ?? '')
        return
      case 'trash':
        this.trashedFrom.set(id, inInbox ? 'inbox' : 'done')
        leaveInbox()
        return
      case 'untrash': {
        const from = this.trashedFrom.get(id) ?? 'inbox'
        this.trashedFrom.delete(id)
        if (from === 'inbox') toInbox()
        else this.doneLocal.set(id, { ...current, inInbox: false })
        return
      }
      case 'markRead':
      case 'star':
        for (const map of [this.threads, this.removed, this.doneLocal, this.done, this.sent, ...[...this.folders.values()].map(f => f.threads)]) {
          const t = map.get(id)
          if (t) map.set(id, applyLocal(t, action)!)
        }
        {
          const r = this.reminders.get(id)
          if (r) this.reminders.set(id, { ...r, summary: applyLocal(r.summary, action)! })
        }
    }
  }

  // Takes a thread out of the inbox until `at`. From the inbox it is archived on the
  // server, so undo brings it straight back; from Done or Reminders it just gets a new time.
  remind(threadId: string, at: number): void {
    const summary =
      this.threads.get(threadId) ??
      this.reminders.get(threadId)?.summary ??
      this.removed.get(threadId) ??
      this.doneLocal.get(threadId) ??
      this.done.get(threadId)
    if (!summary) return
    if (this.threads.has(threadId)) this.act({ type: 'archive', threadId }, { countDone: false })
    this.reminders.set(threadId, { threadId, at, summary: { ...summary, inInbox: false } })
    this.returned.delete(threadId)
    this.changed()
    void this.persist()
  }

  // Brings back every reminder that is due. Runs on start and every 15 s.
  checkReminders(): void {
    const due = [...this.reminders.values()].filter(r => r.at <= this.now())
    if (!due.length) return
    for (const r of due) {
      this.act({ type: 'unarchive', threadId: r.threadId }, { recordUndo: false })
      this.returned.set(r.threadId, this.now())
    }
    this.emit({ kind: 'newMail', threads: due.map(r => ({ ...r.summary, inInbox: true, returnedAt: this.now() })) })
    this.changed()
    void this.persist()
  }

  // Marks every inbox thread from a sender done. Returns how many.
  archiveSender(email: string): number {
    const ids = [...this.threads.values()].filter(t => sameEmail(t.from.email, email)).map(t => t.id)
    for (const id of ids) this.act({ type: 'archive', threadId: id })
    return ids.length
  }

  // Unsubscribes using the thread's list headers, then clears that sender from the inbox.
  async unsubscribe(threadId: string): Promise<{ result: UnsubscribeResult; archived: number; sender: string }> {
    const summary = this.threads.get(threadId) ?? this.removed.get(threadId) ?? this.done.get(threadId) ?? this.doneLocal.get(threadId)
    if (!summary) throw new Error('That conversation is no longer here.')
    const result = await this.provider.unsubscribe(threadId, { name: this.account.name, email: this.account.email })
    const archived = result.method === 'none' ? 0 : this.archiveSender(summary.from.email)
    return { result, archived, sender: summary.from.name || summary.from.email }
  }

  getStats(): MailStats {
    const view = this.inboxView()
    const days = Array.from({ length: 7 }, (_, i) => dayKey(this.now() - (6 - i) * 86_400_000))
    const received = new Map<string, number>()
    for (const t of [...this.threads.values(), ...this.done.values(), ...this.doneLocal.values()]) {
      if (sameEmail(t.from.email, this.account.email)) continue
      const day = dayKey(t.date)
      received.set(day, (received.get(day) ?? 0) + 1)
    }
    return {
      days: days.map(day => ({ day, done: this.stats.get(day)?.done ?? 0, sent: this.stats.get(day)?.sent ?? 0, received: received.get(day) ?? 0 })),
      inbox: view.length,
      unread: view.filter(t => t.unread).length,
      pitches: view.filter(t => t.autoLabels?.includes('Pitch')).length,
      topSenders: senderRows(this.threads.values(), this.account.email)
        .slice(0, 5)
        .map(r => ({ name: r.sender.name, email: r.sender.email, count: r.count }))
    }
  }

  private count(kind: keyof DayCounts): void {
    const day = dayKey(this.now())
    const counts = this.stats.get(day) ?? { done: 0, sent: 0 }
    counts[kind]++
    this.stats.set(day, counts)
  }

  // Reverses the most recent action if it is still inside the undo window.
  undo(): MailAction | null {
    const entry = this.undoStack.pop()
    if (!entry || this.now() - entry.at > UNDO_WINDOW_MS) return null
    const reverse = inverse(entry.action)
    this.act(reverse, { recordUndo: false })
    return reverse
  }

  async flushOutbox(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.outbox.length) {
        await this.provider.apply(this.outbox[0])
        this.outbox.shift()
        await this.persist()
      }
    } catch (e) {
      // Leave the action queued; the next sync retries it.
      this.emit({ kind: 'syncState', state: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.flushing = false
    }
  }

  // Sends after `delayMs` so the user can cancel ("undo send").
  scheduleSend(draft: Draft, delayMs: number): string {
    const sendId = `s${this.nextSendId++}`
    const timer = setTimeout(async () => {
      this.sends.delete(sendId)
      try {
        await this.provider.send(draft, { name: this.account.name, email: this.account.email })
        if (draft.replyTo) this.messageCache.delete(draft.replyTo.threadId)
        this.count('sent')
        this.sentFetchedAt = -Infinity
        this.emit({ kind: 'sendState', sendId, state: 'sent' })
        void this.sync()
      } catch (e) {
        this.emit({ kind: 'sendState', sendId, state: 'failed', message: e instanceof Error ? e.message : String(e) })
      }
    }, delayMs)
    this.sends.set(sendId, { draft, timer })
    this.emit({ kind: 'sendState', sendId, state: 'scheduled' })
    return sendId
  }

  cancelSend(sendId: string): Draft | null {
    const s = this.sends.get(sendId)
    if (!s) return null
    clearTimeout(s.timer)
    this.sends.delete(sendId)
    this.emit({ kind: 'sendState', sendId, state: 'cancelled' })
    return s.draft
  }
}
