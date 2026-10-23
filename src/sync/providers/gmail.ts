// Gmail REST API provider. Incremental sync uses history.list from the last
// historyId; when that cursor expires Gmail returns 404 and we resnapshot.

import { parseMailto } from '../../shared/mailto'
import { buildRfc2822, fromBase64Url, parseAddress, parseAddressList, toBase64Url } from '../mime'

import type { Address, Draft, MailAction, MailLabel, Message, ThreadSummary, UnsubscribeResult } from '../../shared/types'
import type { DoneFilter, MailProvider, SnapshotProgress, SyncResult, TokenSource } from './provider'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
// What Gmail calls archived: everything that left the inbox and wasn't deleted.
export const DONE_QUERY = '-in:inbox -in:trash -in:spam -in:drafts'
const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Precedence']
const SENT_QUERY = 'in:sent newer_than:30d -in:trash'
// System folders shown in the sidebar, in Gmail's order.
const SYSTEM_FOLDERS: Record<string, string> = { INBOX: 'Inbox', DRAFT: 'Drafts', SENT: 'Sent', STARRED: 'Starred', SPAM: 'Spam', TRASH: 'Trash' }

interface GmailLabel {
  id: string
  name: string
  type?: 'system' | 'user'
  labelListVisibility?: string
  threadsTotal?: number
  threadsUnread?: number
  color?: { backgroundColor?: string }
}

type FetchFn = typeof fetch

interface GmailHeader {
  name: string
  value: string
}

interface GmailPart {
  mimeType?: string
  headers?: GmailHeader[]
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  historyId?: string
  payload?: GmailPart
}

interface GmailThread {
  id: string
  historyId?: string
  messages?: GmailMessage[]
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // True when Google refused because this user's quota for the minute is used up.
    readonly quota = false
  ) {
    super(message)
  }
}

function header(part: GmailPart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase()
  return part?.headers?.find(h => h.name.toLowerCase() === lower)?.value
}

export function summarizeThread(thread: GmailThread): ThreadSummary | null {
  const messages = thread.messages ?? []
  if (!messages.length) return null
  const first = messages[0]
  const last = messages[messages.length - 1]
  const labels = new Set(messages.flatMap(m => m.labelIds ?? []))
  const participants = new Map<string, Address>()
  for (const m of messages) {
    const from = header(m.payload, 'From')
    if (from) {
      const a = parseAddress(from)
      participants.set(a.email.toLowerCase(), a)
    }
  }
  const precedence = (header(last.payload, 'Precedence') ?? '').toLowerCase()
  return {
    id: thread.id,
    historyId: thread.historyId,
    subject: header(first.payload, 'Subject') ?? '(no subject)',
    snippet: decodeEntities(last.snippet ?? ''),
    from: parseAddress(header(last.payload, 'From') ?? ''),
    participants: [...participants.values()],
    date: Number(last.internalDate ?? 0),
    unread: messages.some(m => m.labelIds?.includes('UNREAD')),
    starred: labels.has('STARRED'),
    inInbox: labels.has('INBOX'),
    messageCount: messages.length,
    listUnsubscribe: messages.some(m => !!header(m.payload, 'List-Unsubscribe')),
    bulk: precedence === 'bulk' || precedence === 'list',
    labels: [...labels],
    to: parseAddressList(header(last.payload, 'To'))
      .map(a => a.email.toLowerCase())
      .slice(0, 20)
  }
}

// Splits a multipart/mixed batch reply into its parts, in request order.
export function parseBatchResponse(text: string, contentType: string, count: number): (BatchPart | undefined)[] {
  const boundary = contentType.match(/boundary=("?)([^";]+)\1/)?.[2]
  const out: (BatchPart | undefined)[] = new Array(count).fill(undefined)
  if (!boundary) return out
  for (const raw of text.split(`--${boundary}`)) {
    const id = raw.match(/Content-ID:\s*<response-item(\d+)>/i)?.[1]
    const status = raw.match(/HTTP\/[\d.]+ (\d{3})/)?.[1]
    if (id === undefined || !status) continue
    const afterStatus = raw.slice(raw.search(/HTTP\/[\d.]+ \d{3}/))
    const bodyStart = afterStatus.search(/\r?\n\r?\n/)
    const bodyText = bodyStart < 0 ? '' : afterStatus.slice(bodyStart).trim()
    let body: unknown = null
    try {
      body = bodyText ? JSON.parse(bodyText) : null
    } catch {
      body = null
    }
    out[Number(id)] = { status: Number(status), body, text: bodyText }
  }
  return out
}

// "<https://…>, <mailto:…>" → the first https link and the first mailto link.
export function parseUnsubscribeHeader(value: string): { web?: string; mailto?: string } {
  const out: { web?: string; mailto?: string } = {}
  for (const m of value.matchAll(/<([^>]+)>/g)) {
    const link = m[1].trim()
    if (!out.web && /^https:\/\//i.test(link)) out.web = link
    if (!out.mailto && /^mailto:/i.test(link)) out.mailto = link
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function findBody(part: GmailPart | undefined, mimeType: string): string | null {
  if (!part) return null
  if (part.mimeType === mimeType && part.body?.data) return fromBase64Url(part.body.data)
  for (const child of part.parts ?? []) {
    const found = findBody(child, mimeType)
    if (found !== null) return found
  }
  return null
}

export function toMessage(m: GmailMessage): Message {
  return {
    id: m.id,
    threadId: m.threadId,
    from: parseAddress(header(m.payload, 'From') ?? ''),
    to: parseAddressList(header(m.payload, 'To')),
    cc: parseAddressList(header(m.payload, 'Cc')),
    subject: header(m.payload, 'Subject') ?? '(no subject)',
    date: Number(m.internalDate ?? 0),
    html: findBody(m.payload, 'text/html'),
    text: findBody(m.payload, 'text/plain'),
    messageIdHeader: header(m.payload, 'Message-ID') ?? header(m.payload, 'Message-Id') ?? null,
    references: header(m.payload, 'References') ?? null
  }
}

// Gmail rate-limits per user (429, or 403 with a quota or rate-limit reason)
// and has brief server errors; both clear up if we wait and try again.
const MAX_ATTEMPTS = 4
const QUOTA_ERROR = /Quota exceeded|RESOURCE_EXHAUSTED|rateLimitExceeded|userRateLimitExceeded|Too many concurrent requests/
const isQuota = (status: number, body: string) => status === 429 || (status === 403 && QUOTA_ERROR.test(body))
// Gmail's quota is counted per minute, so a quota pause lasts the better part of one.
const QUOTA_WAITS_MS = [30_000, 60_000, 120_000]
const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1'
const BATCH_SIZE = 25
const RETRY_BATCH_SIZE = 10

// Quota units Gmail charges per call (developers.google.com/gmail/api/reference/quota).
function costOf(path: string): number {
  if (path.startsWith('/messages/send')) return 100
  if (path.startsWith('/history')) return 2
  if (path.startsWith('/profile') || path.startsWith('/labels')) return 1
  // threads.get, threads.list, modify, trash and untrash.
  return 10
}

export type Priority = 'interactive' | 'background'

// A token bucket over Gmail's per-minute quota. Google now gives new projects 6,000
// units a minute per user (it used to be 15,000; see Gmail API → Quotas in Google
// Cloud), so Kestrel spends 40% of that by default and leaves the rest for Gmail on
// the web, phones and a second copy of Kestrel. The rate still adapts: it halves
// whenever Google says slow down (to an eighth at least), and grows back by a
// quarter for each minute without a complaint. KESTREL_GMAIL_UNITS_PER_MINUTE
// raises it for a project with a higher limit. Background work (syncing,
// label counts) keeps 30% of the bucket free for what you're doing right now.
export class QuotaBudget {
  private tokens: number
  private at: number
  private pausedUntil = 0
  private factor = 1
  private calmSince: number

  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly perMinute = 2_400,
    private readonly burst = 400
  ) {
    this.tokens = burst
    this.at = now()
    this.calmSince = this.at
  }

  // Every caller waits after a quota error, then the rate is halved.
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms)
    this.factor = Math.max(1 / 8, this.factor / 2)
    this.calmSince = this.pausedUntil
  }

  // Current share of the base rate, for logs and tests.
  get speed(): number {
    return this.factor
  }

  private rate(): number {
    const now = this.now()
    while (this.factor < 1 && now - this.calmSince >= 60_000) {
      this.factor = Math.min(1, this.factor * 1.25)
      this.calmSince += 60_000
    }
    return (this.perMinute / 60_000) * this.factor
  }

  async take(units: number, priority: Priority = 'background'): Promise<void> {
    const reserve = priority === 'background' ? this.burst * 0.3 : 0
    for (;;) {
      const now = this.now()
      if (now < this.pausedUntil) {
        await this.sleep(this.pausedUntil - now)
        continue
      }
      const rate = this.rate()
      this.tokens = Math.min(this.burst, this.tokens + (now - this.at) * rate)
      this.at = now
      // A batch can cost more than the bucket holds; it goes once the bucket is full enough.
      const need = Math.min(units, this.burst - reserve)
      if (this.tokens - reserve >= need) {
        this.tokens -= units
        return
      }
      await this.sleep(Math.max(10, (need - (this.tokens - reserve)) / rate))
    }
  }
}

export interface GmailOptions {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  unitsPerMinute?: number
  // Told about every rate-limit pause, with Google's reason (for logs).
  onPause?: (ms: number, reason: string) => void
}

interface BatchPart {
  status: number
  body: unknown
  text: string
}

export class GmailProvider implements MailProvider {
  private readonly sleep: (ms: number) => Promise<void>
  private readonly budget: QuotaBudget
  private readonly onPause?: (ms: number, reason: string) => void
  private quotaStrikes = 0
  // Batches run one at a time per lane (Gmail also limits concurrent requests per
  // user). What you asked for has its own lane, so it never waits behind sync.
  private lanes: Record<Priority, Promise<unknown>> = { interactive: Promise.resolve(), background: Promise.resolve() }

  constructor(
    private readonly token: TokenSource,
    private readonly fetchFn: FetchFn = fetch,
    { sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, unitsPerMinute, onPause }: GmailOptions = {}
  ) {
    this.sleep = sleep
    this.onPause = onPause
    this.budget = new QuotaBudget(now, sleep, unitsPerMinute)
  }

  // A quota error pauses every request, for as long as Google asks or 30 s, 60 s, 2 min.
  private quotaWait(res: Response, reason: string): number {
    const after = Number(res.headers.get('retry-after'))
    return this.pauseFor(after > 0 ? after * 1000 : undefined, reason)
  }

  private pauseFor(ms: number | undefined, reason: string): number {
    const wait = ms ?? QUOTA_WAITS_MS[Math.min(this.quotaStrikes, QUOTA_WAITS_MS.length - 1)]
    this.quotaStrikes++
    this.budget.pause(wait + Math.random() * 1000)
    this.onPause?.(wait, reason.replace(/\s+/g, ' ').slice(0, 160))
    return wait
  }

  private async call<T>(path: string, init: RequestInit = {}, priority: Priority = 'interactive'): Promise<T> {
    const method = init.method ?? 'GET'
    for (let attempt = 1; ; attempt++) {
      await this.budget.take(costOf(path), priority)
      const res = await this.fetchFn(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {})
        }
      })
      if (res.ok) {
        this.quotaStrikes = 0
        return (res.status === 204 ? undefined : await res.json()) as T
      }
      const body = await res.text().catch(() => '')
      const quota = isQuota(res.status, body)
      if (attempt < MAX_ATTEMPTS && (quota || res.status >= 500)) {
        if (quota) this.quotaWait(res, `${res.status} ${body}`)
        else await this.sleep(500 * 2 ** (attempt - 1) + Math.random() * 250)
        continue
      }
      throw new GmailApiError(`Gmail ${method} ${path.split('?')[0]} failed: ${res.status} ${body.slice(0, 200)}`, res.status, quota)
    }
  }

  // Many GETs in one HTTP request through Gmail's batch endpoint (each still costs
  // its own quota). Parts that were rate-limited or failed on the server are retried
  // after a pause in smaller batches; 404s come back as null.
  private batchGet<T>(paths: string[], priority: Priority): Promise<(T | null)[]> {
    const run = this.lanes[priority].then(() => this.runBatches<T>(paths, priority))
    this.lanes[priority] = run.catch(() => {})
    return run
  }

  private async runBatches<T>(paths: string[], priority: Priority): Promise<(T | null)[]> {
    const results = new Map<number, T | null>()
    let pending = paths.map((path, i) => ({ path, i }))
    for (let round = 0; pending.length; round++) {
      const size = round === 0 ? BATCH_SIZE : RETRY_BATCH_SIZE
      const retry: typeof pending = []
      for (let k = 0; k < pending.length; k += size) {
        const chunk = pending.slice(k, k + size)
        await this.budget.take(chunk.reduce((n, p) => n + costOf(p.path), 0), priority)
        const parts = await this.postBatch(chunk.map(p => p.path))
        let limited: BatchPart | null = null
        chunk.forEach((p, j) => {
          const part = parts[j]
          if (part && part.status >= 200 && part.status < 300) results.set(p.i, part.body as T)
          else if (part?.status === 404) results.set(p.i, null)
          else if (!part || part.status >= 500 || isQuota(part.status, part.text)) {
            if (part && isQuota(part.status, part.text)) limited = part
            retry.push(p)
          } else throw new GmailApiError(`Gmail GET ${p.path.split('?')[0]} failed: ${part.status} ${part.text.slice(0, 200)}`, part.status)
        })
        if (limited) this.pauseFor(undefined, `batch part ${(limited as BatchPart).status} ${(limited as BatchPart).text}`)
        else if (retry.length === 0) this.quotaStrikes = 0
      }
      if (retry.length && round + 1 >= MAX_ATTEMPTS) {
        throw new GmailApiError(`Gmail batch: ${retry.length} requests still rate-limited after ${MAX_ATTEMPTS} tries`, 429, true)
      }
      pending = retry
    }
    return paths.map((_, i) => results.get(i) ?? null)
  }

  private async postBatch(paths: string[]): Promise<(BatchPart | undefined)[]> {
    const boundary = `kestrel_${Math.random().toString(36).slice(2)}`
    const body =
      paths.map((p, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\nGET /gmail/v1/users/me${p}\r\n\r\n`).join('') +
      `--${boundary}--`
    const res = await this.fetchFn(BATCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` },
      body
    })
    const text = await res.text()
    if (!res.ok) {
      // The whole batch was refused: treat every part the same way.
      return paths.map(() => ({ status: res.status, body: null, text }))
    }
    return parseBatchResponse(text, res.headers.get('content-type') ?? '', paths.length)
  }

  private metadataQuery(): string {
    return 'format=metadata&' + METADATA_HEADERS.map(h => `metadataHeaders=${encodeURIComponent(h)}`).join('&')
  }

  private async fetchSummaries(
    ids: string[],
    onBatch?: (batch: ThreadSummary[], done: number) => void,
    priority: Priority = 'interactive'
  ): Promise<ThreadSummary[]> {
    const out: ThreadSummary[] = []
    // Chunks of a few batches, so the inbox fills in as they arrive.
    const step = BATCH_SIZE * 2
    for (let i = 0; i < ids.length; i += step) {
      const threads = await this.batchGet<GmailThread>(
        ids.slice(i, i + step).map(id => `/threads/${id}?${this.metadataQuery()}`),
        priority
      )
      const summaries = threads.map(t => t && summarizeThread(t)).filter((s): s is ThreadSummary => !!s)
      out.push(...summaries)
      onBatch?.(summaries, Math.min(i + step, ids.length))
    }
    return out
  }

  // Every inbox thread the query covers, newest first; no cap on how many.
  // Threads the caller already holds at the same version are skipped, so widening
  // the inbox window only fetches the mail it adds.
  private async snapshot(onProgress?: SnapshotProgress, query = 'in:inbox', known?: Map<string, string>): Promise<SyncResult> {
    const profile = await this.call<{ historyId: string }>('/profile', {}, 'background')
    const ids: string[] = []
    const unchanged: string[] = []
    let pageToken: string | undefined
    do {
      const page = await this.call<{ threads?: { id: string; historyId?: string }[]; nextPageToken?: string }>(
        `/threads?q=${encodeURIComponent(query)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`,
        {},
        'background'
      )
      for (const t of page.threads ?? []) {
        if (t.historyId && known?.get(t.id) === t.historyId) unchanged.push(t.id)
        else ids.push(t.id)
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    const upserts = await this.fetchSummaries(ids, (batch, done) => onProgress?.(batch, done, ids.length), 'background')
    return { upserts, removals: [], cursor: profile.historyId, full: true, unchanged }
  }

  async sync(cursor: string | null, onProgress?: SnapshotProgress, inboxQuery?: string, known?: Map<string, string>): Promise<SyncResult> {
    if (!cursor) return this.snapshot(onProgress, inboxQuery, known)
    const changed = new Set<string>()
    let pageToken: string | undefined
    let latest = cursor
    try {
      do {
        const page = await this.call<{
          history?: { messages?: { threadId: string }[] }[]
          historyId: string
          nextPageToken?: string
        }>(`/history?startHistoryId=${cursor}${pageToken ? `&pageToken=${pageToken}` : ''}`, {}, 'background')
        for (const h of page.history ?? []) for (const m of h.messages ?? []) changed.add(m.threadId)
        latest = page.historyId
        pageToken = page.nextPageToken
      } while (pageToken)
    } catch (e) {
      // An expired historyId means we must take a fresh snapshot.
      if (e instanceof GmailApiError && e.status === 404) return this.snapshot(onProgress, inboxQuery, known)
      throw e
    }
    const upserts = await this.fetchSummaries([...changed], undefined, 'background')
    const found = new Set(upserts.map(u => u.id))
    return { upserts, removals: [...changed].filter(id => !found.has(id)), cursor: latest, full: false }
  }

  async listDoneIds(limit: number, filter: DoneFilter = {}): Promise<string[]> {
    // Gmail spells the label Kestrel/Marketing as kestrel-marketing in searches.
    let q = `${DONE_QUERY} -label:kestrel-marketing`
    if (filter.unread !== undefined) q += filter.unread ? ' is:unread' : ' -is:unread'
    if (filter.newerThanDays) q += ` newer_than:${filter.newerThanDays}d`
    const out: string[] = []
    let pageToken: string | undefined
    do {
      const page = await this.call<{ threads?: { id: string }[]; nextPageToken?: string }>(
        `/threads?q=${encodeURIComponent(q)}&maxResults=${Math.min(limit - out.length, 500)}${pageToken ? `&pageToken=${pageToken}` : ''}`
      )
      out.push(...(page.threads ?? []).map(t => t.id))
      pageToken = page.nextPageToken
    } while (pageToken && out.length < limit)
    return out
  }

  // Every inbox thread the query covers as id + version only: 10 units per 500 threads.
  async listInboxIndex(query: string): Promise<{ id: string; historyId: string }[]> {
    const out: { id: string; historyId: string }[] = []
    let pageToken: string | undefined
    do {
      const page = await this.call<{ threads?: { id: string; historyId: string }[]; nextPageToken?: string }>(
        `/threads?q=${encodeURIComponent(query)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`
      )
      out.push(...(page.threads ?? []).map(t => ({ id: t.id, historyId: t.historyId })))
      pageToken = page.nextPageToken
    } while (pageToken)
    return out
  }

  async listSentIds(limit: number): Promise<string[]> {
    const page = await this.call<{ threads?: { id: string }[] }>(`/threads?q=${encodeURIComponent(SENT_QUERY)}&maxResults=${Math.min(limit, 500)}`)
    return (page.threads ?? []).map(t => t.id)
  }

  // Prefers RFC 8058 one-click (a POST Gmail itself uses), then an unsubscribe email,
  // then a web page the user finishes in the browser.
  async unsubscribe(threadId: string, from: { name: string; email: string }): Promise<UnsubscribeResult> {
    const thread = await this.call<GmailThread>(`/threads/${threadId}?${this.metadataQuery()}`)
    const withHeader = [...(thread.messages ?? [])].reverse().find(m => header(m.payload, 'List-Unsubscribe'))
    const links = parseUnsubscribeHeader(withHeader ? header(withHeader.payload, 'List-Unsubscribe')! : '')
    const oneClick = /One-Click/i.test(withHeader ? (header(withHeader.payload, 'List-Unsubscribe-Post') ?? '') : '')
    if (oneClick && links.web) {
      const res = await this.fetchFn(links.web, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click'
      }).catch(() => null)
      if (res?.ok) return { method: 'one-click' }
    }
    if (links.mailto) {
      const m = parseMailto(links.mailto)
      if (m.to.length) {
        await this.send({ to: m.to, cc: [], subject: m.subject || 'unsubscribe', body: m.body || 'unsubscribe' }, from)
        return { method: 'email' }
      }
    }
    return links.web ? { method: 'browser', url: links.web } : { method: 'none' }
  }

  summaries(threadIds: string[]): Promise<ThreadSummary[]> {
    return this.fetchSummaries(threadIds)
  }

  // labels.list has no counts, so each shown label is read once (1 quota unit each).
  async listLabels(): Promise<MailLabel[]> {
    const { labels = [] } = await this.call<{ labels?: GmailLabel[] }>('/labels')
    const shown = labels.filter(l => (l.type === 'user' ? l.labelListVisibility !== 'labelHide' : l.id in SYSTEM_FOLDERS))
    const out: MailLabel[] = []
    {
      const batch = (await this.batchGet<GmailLabel>(shown.map(l => `/labels/${encodeURIComponent(l.id)}`), 'background')).filter(
        (l): l is GmailLabel => !!l
      )
      for (const l of batch) {
        const system = l.type !== 'user'
        out.push({
          id: l.id,
          name: system ? SYSTEM_FOLDERS[l.id] : l.name,
          system,
          total: l.threadsTotal ?? 0,
          unread: l.threadsUnread ?? 0,
          color: l.color?.backgroundColor
        })
      }
    }
    return out
  }

  async listLabelThreadIds(labelId: string, limit: number): Promise<string[]> {
    const spamOrTrash = labelId === 'SPAM' || labelId === 'TRASH'
    const page = await this.call<{ threads?: { id: string }[] }>(
      `/threads?labelIds=${encodeURIComponent(labelId)}&maxResults=${Math.min(limit, 500)}${spamOrTrash ? '&includeSpamTrash=true' : ''}`
    )
    return (page.threads ?? []).map(t => t.id)
  }

  async getMessages(threadId: string): Promise<Message[]> {
    const t = await this.call<GmailThread>(`/threads/${threadId}?format=full`)
    return (t.messages ?? []).map(toMessage)
  }

  async apply(action: MailAction): Promise<void> {
    const modify = (add: string[], remove: string[]) =>
      this.call(`/threads/${action.threadId}/modify`, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove })
      })
    switch (action.type) {
      case 'archive':
        return void (await modify([], ['INBOX']))
      case 'unarchive':
        return void (await modify(['INBOX'], []))
      case 'trash':
        return void (await this.call(`/threads/${action.threadId}/trash`, { method: 'POST' }))
      case 'untrash':
        return void (await this.call(`/threads/${action.threadId}/untrash`, { method: 'POST' }))
      case 'markRead':
        return void (await (action.read ? modify([], ['UNREAD']) : modify(['UNREAD'], [])))
      case 'star':
        return void (await (action.starred ? modify(['STARRED'], []) : modify([], ['STARRED'])))
      case 'file':
        return void (await modify([await this.labelId(action.label)], ['INBOX']))
      case 'unfile':
        return void (await modify(['INBOX'], [await this.labelId(action.label)]))
    }
  }

  // Kestrel's own Gmail labels (Kestrel/Marketing), by name; made the first time one is needed.
  private labelIds = new Map<string, Promise<string>>()
  private labelId(name: string): Promise<string> {
    let id = this.labelIds.get(name)
    if (!id) {
      id = (async () => {
        const { labels } = (await this.call('/labels')) as { labels?: GmailLabel[] }
        const found = labels?.find(l => l.name === name)
        if (found) return found.id
        const made = (await this.call('/labels', {
          method: 'POST',
          body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' })
        })) as GmailLabel
        return made.id
      })()
      // A failure is retried next time rather than remembered.
      id.catch(() => this.labelIds.delete(name))
      this.labelIds.set(name, id)
    }
    return id
  }

  async send(draft: Draft, from: { name: string; email: string }): Promise<void> {
    const raw = toBase64Url(buildRfc2822(draft, from))
    await this.call('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw, ...(draft.replyTo ? { threadId: draft.replyTo.threadId } : {}) })
    })
  }

  async search(query: string): Promise<ThreadSummary[]> {
    const page = await this.call<{ threads?: { id: string }[] }>(`/threads?q=${encodeURIComponent(query)}&maxResults=50`)
    return this.fetchSummaries((page.threads ?? []).map(t => t.id))
  }
}
