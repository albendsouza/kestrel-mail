import type { Draft, MailAction, MailLabel, Message, ThreadSummary, UnsubscribeResult } from '../../shared/types'

export interface SyncResult {
  // Threads added or changed since the last cursor.
  upserts: ThreadSummary[]
  // Thread ids that should be dropped from the local cache.
  removals: string[]
  cursor: string
  // True when the provider could not resume from the cursor and returned everything.
  full: boolean
  // In a full snapshot: threads the caller already had at the same version, so
  // they were not fetched again. Keep them as they are.
  unchanged?: string[]
}

// Called while a full snapshot loads, with each batch as it arrives.
export type SnapshotProgress = (batch: ThreadSummary[], done: number, total: number) => void

export interface MailProvider {
  // Fetch changes since `cursor`, or a full snapshot when cursor is null.
  // inboxQuery narrows a full snapshot (Gmail search syntax), e.g. "in:inbox newer_than:14d".
  // known: thread id → version (historyId) the caller already holds; a snapshot skips those.
  sync(cursor: string | null, onProgress?: SnapshotProgress, inboxQuery?: string, known?: Map<string, string>): Promise<SyncResult>
  getMessages(threadId: string): Promise<Message[]>
  apply(action: MailAction): Promise<void>
  send(draft: Draft, from: { name: string; email: string }): Promise<void>
  search(query: string): Promise<ThreadSummary[]>
  // Done = archived: out of the inbox, not trashed or spam, and not filed away by Kestrel
  // (Kestrel/Marketing). Newest first; optionally only unread or only read, and only recent.
  listDoneIds(limit: number, filter?: DoneFilter): Promise<string[]>
  // Every inbox thread a query covers, as id + version only (no contents): cheap to compare.
  listInboxIndex(query: string): Promise<{ id: string; historyId: string }[]>
  // Threads you sent to in the last 30 days, newest first (for "waiting on a reply").
  listSentIds(limit: number): Promise<string[]>
  // Unsubscribes from the list a thread came from, using its List-Unsubscribe header.
  unsubscribe(threadId: string, from: { name: string; email: string }): Promise<UnsubscribeResult>
  summaries(threadIds: string[]): Promise<ThreadSummary[]>
  // Labels and system folders with their counts.
  listLabels(): Promise<MailLabel[]>
  // Threads carrying a label (a folder like SENT, or a user label), newest first.
  listLabelThreadIds(labelId: string, limit: number): Promise<string[]>
}

export interface DoneFilter {
  unread?: boolean
  newerThanDays?: number
}

// Supplies a fresh OAuth access token; implemented by the main process.
export type TokenSource = () => Promise<string>
