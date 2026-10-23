// In-memory provider with seeded mail, used for demo mode and tests.

import type { Address, Draft, MailAction, MailLabel, Message, ThreadSummary, UnsubscribeResult } from '../../shared/types'
import type { DoneFilter, MailProvider, SnapshotProgress, SyncResult } from './provider'

interface DemoThread {
  summary: ThreadSummary
  messages: Message[]
  trashed: boolean
}

const people: Record<string, Address> = {
  maya: { name: 'Maya Chen', email: 'maya@northwind.io' },
  leo: { name: 'Leo Okafor', email: 'leo@ventures.example' },
  ana: { name: 'Ana Ruiz', email: 'ana.ruiz@example.com' },
  sam: { name: 'Sam Patel', email: 'sam@acme.dev' },
  news: { name: 'The Weekly Byte', email: 'newsletter@weeklybyte.example' },
  gh: { name: 'GitHub', email: 'noreply@github.com' },
  cal: { name: 'Calendar', email: 'calendar-notification@example.com' },
  jake: { name: 'Jake Miller', email: 'jake@growthleads.example' },
  priya: { name: 'Priya Nair', email: 'priya@northwind.io' }
}

// "me" in seed data stands for the account the provider is created for.
type SeedFrom = Address | 'me'

export interface SeedThread {
  from: SeedFrom
  subject: string
  body: string
  hoursAgo: number
  unread?: boolean
  starred?: boolean
  newsletter?: boolean
  html?: string
  labels?: string[] // user labels, like Gmail's
  replies?: Array<{ from: SeedFrom; body: string; hoursAgo: number }>
}

const DEMO_SEED: SeedThread[] = [
  {
    from: people.maya,
    subject: 'Q4 roadmap review',
    body: 'Hi! Can we walk through the Q4 roadmap on Thursday? I added notes on the sync engine and offline mode.',
    hoursAgo: 1,
    unread: true,
    labels: ['Meeting updates'],
    replies: [{ from: people.leo, body: 'Thursday works. 2pm?', hoursAgo: 0.5 }]
  },
  { from: people.leo, subject: 'Term sheet draft', body: 'Attached is the first draft of the term sheet. Let me know your thoughts.', hoursAgo: 3, unread: true, starred: true, labels: ['Investments'] },
  { from: people.ana, subject: 'Design crit notes', body: 'Notes from today: tighten the split tabs, make the command palette searchable by verb.', hoursAgo: 6 },
  { from: people.sam, subject: 'Deploy is green', body: 'v0.9.2 is out. Error rates are flat. Nice work everyone.', hoursAgo: 9, unread: true },
  {
    from: people.news,
    subject: 'This week: local-first apps are back',
    body: 'Five essays on CRDTs, sync engines, and why your app should work offline.',
    html:
      '<h2 style="margin:0 0 8px">The Weekly Byte</h2><p>Five essays on <b>CRDTs</b>, sync engines, and why your app should work offline.</p>' +
      '<p><a href="https://example.com/local-first">Read the issue →</a></p>' +
      '<img src="https://tracker.example/open.gif?u=123" width="1" height="1" alt="">' +
      '<script>alert("never runs")</script>',
    hoursAgo: 12,
    newsletter: true,
    unread: true
  },
  { from: people.gh, subject: '[kestrel] PR #42: Add undo send', body: 'sam requested your review on this pull request.', hoursAgo: 14, unread: true },
  { from: people.cal, subject: 'Invitation: Roadmap review @ Thu 2pm', body: 'Maya Chen invited you to Roadmap review.', hoursAgo: 20 },
  { from: people.news, subject: 'Product Digest #118', body: 'The best launches of the week, curated.', hoursAgo: 30, newsletter: true },
  { from: people.ana, subject: 'Lunch Friday?', body: 'New ramen place opened near the office. Friday 12:30?', hoursAgo: 40 },
  { from: people.gh, subject: '[kestrel] Issue #17: Shortcut conflicts on AZERTY', body: 'A new issue was opened.', hoursAgo: 52 },
  {
    from: people.jake,
    subject: 'Quick question about your pipeline',
    body: 'Would you be open to a 15-minute call this week? We help teams like yours book 3x more demos with our outbound platform.',
    hoursAgo: 16,
    unread: true
  },
  {
    from: people.priya,
    subject: 'Intro: Priya <> Sam',
    body: 'Hi! Would love an intro to Sam about the data platform role.',
    hoursAgo: 72,
    replies: [{ from: 'me', body: 'Happy to. Sam, meet Priya. Priya, meet Sam. I will let you two take it from here.', hoursAgo: 50 }]
  }
]

let nextId = 1
const newId = (prefix: string) => `${prefix}${(nextId++).toString(36)}`

export class DemoProvider implements MailProvider {
  private threads = new Map<string, DemoThread>()
  private version = 0
  private changedAt = new Map<string, number>()
  readonly sent: Draft[] = []
  readonly unsubscribed: string[] = []

  constructor(
    private readonly me: Address,
    now = Date.now(),
    seed: SeedThread[] = DEMO_SEED
  ) {
    for (const s of seed) {
      const threadId = newId('t')
      const msgs: Message[] = [s, ...(s.replies ?? [])].map(m => ({
        id: newId('m'),
        threadId,
        from: m.from === 'me' ? me : m.from,
        to: [me],
        cc: [],
        subject: s.subject,
        date: now - m.hoursAgo * 3600_000,
        html: m === s && s.html ? s.html : null,
        text: m.body,
        messageIdHeader: `<${threadId}.${m.hoursAgo}@demo.kestrel>`,
        references: null
      }))
      const last = msgs[msgs.length - 1]
      this.threads.set(threadId, {
        trashed: false,
        messages: msgs,
        summary: {
          id: threadId,
          subject: s.subject,
          snippet: last.text!.slice(0, 120),
          from: last.from,
          participants: [...new Map(msgs.map(m => [m.from.email, m.from])).values()],
          date: last.date,
          unread: !!s.unread,
          starred: !!s.starred,
          inInbox: true,
          messageCount: msgs.length,
          listUnsubscribe: !!s.newsletter,
          bulk: !!s.newsletter,
          labels: s.labels ?? [],
          to: last.to.map(a => a.email.toLowerCase())
        }
      })
      this.touch(threadId)
    }
  }

  private touch(id: string): void {
    this.changedAt.set(id, ++this.version)
  }

  // A copy for callers, with a version that changes whenever the thread does (like Gmail's historyId).
  private snap(t: DemoThread): ThreadSummary {
    return { ...t.summary, historyId: String(this.changedAt.get(t.summary.id) ?? 0) }
  }

  async listInboxIndex(): Promise<{ id: string; historyId: string }[]> {
    return [...this.threads.values()].filter(t => !t.trashed && t.summary.inInbox).map(t => ({ id: t.summary.id, historyId: this.snap(t).historyId! }))
  }

  private visible(): ThreadSummary[] {
    return [...this.threads.values()].filter(t => !t.trashed && t.summary.inInbox).map(t => this.snap(t))
  }

  // The demo returns every thread; the engine applies the inbox window itself.
  async sync(cursor: string | null, _onProgress?: SnapshotProgress, _inboxQuery?: string): Promise<SyncResult> {
    const since = cursor ? Number(cursor) : -1
    if (since < 0) return { upserts: this.visible(), removals: [], cursor: String(this.version), full: true }
    const upserts: ThreadSummary[] = []
    const removals: string[] = []
    for (const [id, v] of this.changedAt) {
      if (v <= since) continue
      const t = this.threads.get(id)!
      if (t.trashed || !t.summary.inInbox) removals.push(id)
      else upserts.push(this.snap(t))
    }
    return { upserts, removals, cursor: String(this.version), full: false }
  }

  async getMessages(threadId: string): Promise<Message[]> {
    const t = this.threads.get(threadId)
    if (!t) throw new Error(`Unknown thread ${threadId}`)
    return t.messages.map(m => ({ ...m }))
  }

  async apply(action: MailAction): Promise<void> {
    const t = this.threads.get(action.threadId)
    if (!t) throw new Error(`Unknown thread ${action.threadId}`)
    switch (action.type) {
      case 'archive':
        t.summary.inInbox = false
        break
      case 'unarchive':
        t.summary.inInbox = true
        break
      case 'trash':
        t.trashed = true
        break
      case 'untrash':
        t.trashed = false
        break
      case 'markRead':
        t.summary.unread = !action.read
        break
      case 'star':
        t.summary.starred = action.starred
        break
      case 'file':
        t.summary.inInbox = false
        if (!t.summary.labels.includes(action.label)) t.summary.labels = [...t.summary.labels, action.label]
        break
      case 'unfile':
        t.summary.inInbox = true
        t.summary.labels = t.summary.labels.filter(l => l !== action.label)
        break
    }
    this.touch(action.threadId)
  }

  async send(draft: Draft, from: Address): Promise<void> {
    this.sent.push(draft)
    const target = draft.replyTo && this.threads.get(draft.replyTo.threadId)
    if (!target) return
    target.messages.push({
      id: newId('m'),
      threadId: target.summary.id,
      from,
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      date: Date.now(),
      html: null,
      text: draft.body,
      messageIdHeader: `<${newId('sent')}@demo.kestrel>`,
      references: draft.replyTo!.messageIdHeader
    })
    target.summary.messageCount = target.messages.length
    target.summary.date = Date.now()
    target.summary.snippet = draft.body.slice(0, 120)
    this.touch(target.summary.id)
  }

  async search(query: string): Promise<ThreadSummary[]> {
    const q = query.toLowerCase()
    return [...this.threads.values()]
      .filter(t => !t.trashed)
      .filter(t =>
        [t.summary.subject, t.summary.from.name, t.summary.from.email, ...t.messages.map(m => m.text ?? '')]
          .join(' ')
          .toLowerCase()
          .includes(q)
      )
      .map(t => this.snap(t))
  }

  async listDoneIds(limit: number, filter: DoneFilter = {}): Promise<string[]> {
    const since = filter.newerThanDays ? Date.now() - filter.newerThanDays * 86_400_000 : -Infinity
    return [...this.threads.values()]
      .filter(t => !t.trashed && !t.summary.inInbox && !t.summary.labels.includes('Kestrel/Marketing'))
      .filter(t => (filter.unread === undefined || t.summary.unread === filter.unread) && t.summary.date >= since)
      .sort((a, b) => b.summary.date - a.summary.date)
      .slice(0, limit)
      .map(t => t.summary.id)
  }

  async listSentIds(limit: number): Promise<string[]> {
    return [...this.threads.values()]
      .filter(t => !t.trashed && t.messages.some(m => m.from.email === this.me.email))
      .sort((a, b) => b.summary.date - a.summary.date)
      .slice(0, limit)
      .map(t => t.summary.id)
  }

  async unsubscribe(threadId: string): Promise<UnsubscribeResult> {
    const t = this.threads.get(threadId)
    if (!t?.summary.listUnsubscribe) return { method: 'none' }
    this.unsubscribed.push(t.summary.from.email)
    return { method: 'one-click' }
  }

  async listLabels(): Promise<MailLabel[]> {
    const all = [...this.threads.values()]
    const count = (list: DemoThread[]) => ({ total: list.length, unread: list.filter(t => t.summary.unread).length })
    const system: MailLabel[] = [
      { id: 'INBOX', name: 'Inbox', system: true, ...count(all.filter(t => !t.trashed && t.summary.inInbox)) },
      { id: 'DRAFT', name: 'Drafts', system: true, total: 0, unread: 0 },
      { id: 'SENT', name: 'Sent', system: true, ...count(all.filter(t => this.isSent(t))) },
      { id: 'STARRED', name: 'Starred', system: true, ...count(all.filter(t => !t.trashed && t.summary.starred)) },
      { id: 'SPAM', name: 'Spam', system: true, total: 0, unread: 0 },
      { id: 'TRASH', name: 'Trash', system: true, ...count(all.filter(t => t.trashed)) }
    ]
    const names = [...new Set(all.flatMap(t => t.summary.labels))].sort()
    return [
      ...system,
      ...names.map(name => ({ id: name, name, system: false, ...count(all.filter(t => !t.trashed && t.summary.labels.includes(name))) }))
    ]
  }

  async listLabelThreadIds(labelId: string, limit: number): Promise<string[]> {
    const match = (t: DemoThread) =>
      labelId === 'TRASH'
        ? t.trashed
        : !t.trashed &&
          (labelId === 'INBOX' ? t.summary.inInbox : labelId === 'SENT' ? this.isSent(t) : labelId === 'STARRED' ? t.summary.starred : t.summary.labels.includes(labelId))
    return [...this.threads.values()]
      .filter(match)
      .sort((a, b) => b.summary.date - a.summary.date)
      .slice(0, limit)
      .map(t => t.summary.id)
  }

  private isSent(t: DemoThread): boolean {
    return t.messages.some(m => m.from.email === this.me.email)
  }

  async summaries(threadIds: string[]): Promise<ThreadSummary[]> {
    return threadIds.flatMap(id => {
      const t = this.threads.get(id)
      return t ? [this.snap(t)] : []
    })
  }

  // Simulates a new message arriving, for demo mode.
  receive(fromKey: keyof typeof people, subject: string, body: string): string {
    const threadId = newId('t')
    const msg: Message = {
      id: newId('m'),
      threadId,
      from: people[fromKey],
      to: [this.me],
      cc: [],
      subject,
      date: Date.now(),
      html: null,
      text: body,
      messageIdHeader: `<${threadId}@demo.kestrel>`,
      references: null
    }
    this.threads.set(threadId, {
      trashed: false,
      messages: [msg],
      summary: {
        id: threadId,
        subject,
        snippet: body.slice(0, 120),
        from: msg.from,
        participants: [msg.from],
        date: msg.date,
        unread: true,
        starred: false,
        inInbox: true,
        messageCount: 1,
        listUnsubscribe: false,
        bulk: false,
        labels: [],
        to: [this.me.email.toLowerCase()]
      }
    })
    this.touch(threadId)
    return threadId
  }
}
