import { describe, expect, it } from 'vitest'

import { KeyResolver, keyName } from '../src/renderer/app/keys'
import { parseMailto } from '../src/shared/mailto'
import { buildRfc2822, encodeHeaderWord, parseAddressList } from '../src/sync/mime'
import { DEFAULT_SPLITS, splitFor } from '../src/sync/split'

import type { ThreadSummary } from '../src/shared/types'

describe('mime', () => {
  it('parses address lists with commas inside quotes', () => {
    expect(parseAddressList('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual([
      { name: 'Doe, Jane', email: 'jane@x.com' },
      { name: 'bob@y.com', email: 'bob@y.com' }
    ])
  })

  it('encodes non-ASCII subjects and strips header injection', () => {
    expect(encodeHeaderWord('Café')).toMatch(/^=\?UTF-8\?B\?/)
    const raw = buildRfc2822(
      { to: [{ name: 'A', email: 'a@x.com' }], cc: [], subject: 'Hi\r\nBcc: evil@x.com', body: 'x' },
      { name: 'Me', email: 'me@x.com' }
    )
    expect(raw).not.toMatch(/\r\nBcc:/)
    expect(raw).toContain('Subject: Hi Bcc: evil@x.com')
  })
})

describe('splits', () => {
  const base: ThreadSummary = {
    id: 't',
    subject: '',
    snippet: '',
    from: { name: 'A', email: 'a@corp.example' },
    participants: [],
    date: 0,
    unread: false,
    starred: false,
    inInbox: true,
    messageCount: 1,
    listUnsubscribe: false,
    bulk: false,
    labels: []
  }
  it('uses the split Laya chose, and Important until it has', () => {
    expect(DEFAULT_SPLITS.map(s => s.id)).toEqual(['important', 'to-reply', 'calendar', 'codes', 'updates', 'other'])
    expect(splitFor({ ...base, split: 'codes' })).toBe('codes')
    expect(splitFor(base)).toBe('important')
  })
})

describe('keys', () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })
  it('names keys per platform', () => {
    expect(keyName(ev('k', { metaKey: true }), true)).toBe('Mod+k')
    expect(keyName(ev('k', { ctrlKey: true }), false)).toBe('Mod+k')
    expect(keyName(ev('#', { shiftKey: true }), true)).toBe('#')
    expect(keyName(ev('Tab', { shiftKey: true }), true)).toBe('Shift+Tab')
  })

  it('resolves sequences like "g i"', () => {
    let now = 0
    const r = new KeyResolver(() => now)
    expect(r.press('g')).toBeNull()
    expect(r.press('i')).toBe('goImportant')
    expect(r.press('e')).toBe('archive')
    r.press('g')
    now = 5000
    // Prefix expired, so "s" is star rather than "go starred".
    expect(r.press('s')).toBe('star')
  })
})

describe('mailto', () => {
  it('parses recipients, subject and body', () => {
    expect(parseMailto('mailto:a@x.com,b@y.com?subject=Hello%20there&CC=c@z.com&body=Line%201')).toEqual({
      to: [
        { name: 'a@x.com', email: 'a@x.com' },
        { name: 'b@y.com', email: 'b@y.com' }
      ],
      cc: [{ name: 'c@z.com', email: 'c@z.com' }],
      subject: 'Hello there',
      body: 'Line 1'
    })
  })
})

describe('address formatting', () => {
  it('quotes display names with specials but leaves subjects alone', () => {
    const raw = buildRfc2822(
      { to: [{ name: 'Doe, Jane', email: 'jane@x.com' }], cc: [], subject: 'Lunch, Friday?', body: '' },
      { name: 'Me', email: 'me@x.com' }
    )
    expect(raw).toContain('To: "Doe, Jane" <jane@x.com>')
    expect(raw).toContain('Subject: Lunch, Friday?')
  })
})
