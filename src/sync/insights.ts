// Helpers behind the Senders view and stats. Ideas
// inspired by Inbox Zero (github.com/elie222/inbox-zero); the code is Kestrel's own.

import type { Address, ThreadSummary } from '../shared/types'

export const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export interface SenderRow {
  sender: Address
  count: number
  unread: number
  newsletter: boolean
  latest: ThreadSummary
}

// Senders of the given threads, most mail first.
export function senderRows(threads: Iterable<ThreadSummary>, me: string): SenderRow[] {
  const rows = new Map<string, SenderRow>()
  for (const t of threads) {
    if (!t.from.email || sameEmail(t.from.email, me)) continue
    const key = t.from.email.toLowerCase()
    const row = rows.get(key) ?? { sender: t.from, count: 0, unread: 0, newsletter: false, latest: t }
    row.count++
    if (t.unread) row.unread++
    if (t.listUnsubscribe) row.newsletter = true
    if (t.date > row.latest.date) row.latest = t
    rows.set(key, row)
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || b.latest.date - a.latest.date)
}

// Local calendar day, "2026-10-22".
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
