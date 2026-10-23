import { describe, expect, it } from 'vitest'

import { senderRows } from '../src/sync/insights'

import type { ThreadSummary } from '../src/shared/types'

const me = 'me@acme.co'
const thread = (from: string, subject: string, snippet = '', extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: `${from}:${subject}`,
  subject,
  snippet,
  from: { name: from.split('@')[0], email: from },
  participants: [{ name: '', email: from }],
  date: 1,
  unread: true,
  starred: false,
  inInbox: true,
  messageCount: 1,
  listUnsubscribe: false,
  bulk: false,
  labels: [],
  ...extra
})

describe('senderRows', () => {
  it('groups by sender, most mail first, and skips your own', () => {
    const rows = senderRows(
      [thread('a@x.io', '1'), thread('b@x.io', '2', '', { listUnsubscribe: true }), thread('b@x.io', '3', '', { unread: false }), thread(me, 'mine')],
      me
    )
    expect(rows.map(r => [r.sender.email, r.count, r.unread, r.newsletter])).toEqual([
      ['b@x.io', 2, 1, true],
      ['a@x.io', 1, 1, false]
    ])
  })
})
