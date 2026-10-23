// Types shared by the main process, the sync engine and the renderers.

// 'practice' is the throwaway inbox used by the guided tour.
export type ProviderKind = 'demo' | 'gmail' | 'practice'

export interface Account {
  id: string
  email: string
  name: string
  provider: ProviderKind
}

export interface Address {
  name: string
  email: string
}

export interface ThreadSummary {
  id: string
  subject: string
  snippet: string
  from: Address
  participants: Address[]
  date: number // epoch ms of the latest message
  unread: boolean
  starred: boolean
  inInbox: boolean
  messageCount: number
  // Header facts used by split-inbox rules.
  listUnsubscribe: boolean
  bulk: boolean
  labels: string[]
  // Who the latest message went to (lowercase emails), for telling "to you" from "copied in".
  to?: string[]
  // Gmail's version of the thread: it changes whenever the thread does (resync compares it).
  historyId?: string
  // Set by the engine for views: when a pending reminder is due, and when a reminder brought the thread back.
  remindAt?: number
  returnedAt?: number
  // Set by the engine: a pitch from a stranger, for the Cold split.
  cold?: boolean
  // Set by the engine from Laya's verdict: auto labels, and whether the thread is Important.
  // Unset until the thread is sorted; unsorted mail shows in Important so nothing hides.
  autoLabels?: AutoLabel[]
  split?: string // the inbox split it sorts into (src/shared/sorting.ts)
  labelledByYou?: boolean // its sender's label is one you set with L, not Laya's
  // Rows of the Senders view stand for a sender, not a thread.
  senderOf?: { email: string; count: number; latestThreadId: string }
}

// Labels Laya gives each thread (see src/shared/sorting.ts).
export const AUTO_LABELS = [
  'To respond',
  'FYI',
  'Important update',
  'Calendar',
  'Code',
  'Security',
  'Finance',
  'Purchase',
  'Travel',
  'Notification',
  'Pitch',
  'Marketing',
  'News',
  'Social'
] as const
export type AutoLabel = (typeof AUTO_LABELS)[number]

// How far back the inbox reaches. Older mail stays in Gmail, Done and search.
export interface InboxWindow {
  days: number | null // null: everything in the inbox
  keepUnread: boolean // unread mail stays in the inbox however old
}

export const DEFAULT_INBOX_WINDOW: InboxWindow = { days: 14, keepUnread: false }

// A Gmail label or system folder, with counts for the sidebar.
export interface MailLabel {
  id: string // Gmail label id: INBOX, DRAFT, SENT, STARRED, SPAM, TRASH, or Label_…
  name: string
  system: boolean
  total: number
  unread: number
  color?: string // the label's colour in Gmail, for user labels
  hidden?: boolean // hidden in Kestrel's sidebar (itself or a parent); still in Gmail
}

// How an unsubscribe went: done for you (one-click or an email to the list),
// a page the user must finish in the browser, or no way to unsubscribe.
export type UnsubscribeResult = { method: 'one-click' | 'email' } | { method: 'browser'; url: string } | { method: 'none' }

export interface Message {
  id: string
  threadId: string
  from: Address
  to: Address[]
  cc: Address[]
  subject: string
  date: number
  html: string | null
  text: string | null
  messageIdHeader: string | null
  references: string | null
}

export interface ThreadDetail {
  summary: ThreadSummary
  messages: Message[]
}

export interface Draft {
  to: Address[]
  cc: Address[]
  subject: string
  body: string // plain text
  replyTo?: { threadId: string; messageIdHeader: string | null; references: string | null }
}

export type MailAction =
  | { type: 'archive'; threadId: string }
  | { type: 'unarchive'; threadId: string }
  | { type: 'trash'; threadId: string }
  | { type: 'untrash'; threadId: string }
  | { type: 'markRead'; threadId: string; read: boolean }
  | { type: 'star'; threadId: string; starred: boolean }
  // Out of the inbox with a Gmail label (Kestrel/Marketing): how auto-filed mail is marked done.
  | { type: 'file'; threadId: string; label: string }
  | { type: 'unfile'; threadId: string; label: string }

export interface SplitRule {
  id: string
  name: string
}

// ── Port protocol between a tab renderer and the sync engine ──────────────

export type TabRequest =
  | { kind: 'listThreads'; split: string; query?: string }
  | { kind: 'getThread'; threadId: string }
  | { kind: 'act'; action: MailAction }
  | { kind: 'remind'; threadId: string; at: number }
  | { kind: 'unsubscribe'; threadId: string }
  | { kind: 'archiveSender'; email: string }
  | { kind: 'stats' }
  | { kind: 'labels' }
  | { kind: 'getInboxWindow' }
  | { kind: 'resync' }
  | { kind: 'setLabelHidden'; labelId: string; hidden: boolean }
  | { kind: 'setInboxWindow'; window: InboxWindow }
  | { kind: 'undo' }
  | { kind: 'send'; draft: Draft; delayMs?: number }
  | { kind: 'cancelSend'; sendId: string }
  | { kind: 'getSplits' }
  | { kind: 'getSortState' }
  | { kind: 'autoLabels' }
  | { kind: 'setLabel'; threadId: string; label: AutoLabel | null } // null hands the sender back to Laya
  | { kind: 'getAutoFile' }
  | { kind: 'getRescue' }
  | { kind: 'rescueScan'; days: number }
  | { kind: 'bringBack' }
  | { kind: 'setAutoFile'; on: boolean }
  | { kind: 'refresh' }

export interface SplitCount {
  id: string
  name: string
  unread: number
  total: number
}

// Looking through mail archived unread for anything from people.
export interface RescueState {
  state: 'idle' | 'scanning' | 'done'
  scanned: number
  total: number
  found: number
  days: number
}

// Marketing filed out of the inbox: on, off, or not asked yet (null), and how many wait in the inbox.
export interface AutoFileState {
  on: boolean | null
  waiting: number
}

// The Gmail label auto-filed marketing gets.
export const FILED_LABEL = 'Kestrel/Marketing'

// An auto label Laya gave inbox mail, with counts for the sidebar.
export interface AutoLabelCount {
  label: AutoLabel
  total: number
  unread: number
}

export interface SortState {
  state: 'idle' | 'sorting' | 'unavailable'
  done: number
  total: number
  message?: string
}

export type EngineEvent =
  | { kind: 'changed' } // thread list may have changed; re-query
  | { kind: 'syncState'; state: 'idle' | 'syncing' | 'offline' | 'error'; message?: string }
  | { kind: 'syncProgress'; done: number; total: number } // first sync only
  | { kind: 'sendState'; sendId: string; state: 'scheduled' | 'sent' | 'cancelled' | 'failed'; message?: string }
  | { kind: 'badge'; unread: number }
  | { kind: 'newMail'; threads: ThreadSummary[] }
  // Laya sorting the inbox: how far along it is, or why it can't run.
  | { kind: 'sortState'; state: SortState }

export interface RequestEnvelope {
  id: number
  request: TabRequest
}

export interface ResponseEnvelope {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

export interface EventEnvelope {
  event: EngineEvent
}
