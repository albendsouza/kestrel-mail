import { describe, expect, it } from 'vitest'

import { fromBase64Url, toBase64Url } from '../src/sync/mime'
import { GmailProvider, QuotaBudget, summarizeThread, toMessage } from '../src/sync/providers/gmail'

const b64 = (s: string) => toBase64Url(s)

const thread = {
  id: 't1',
  historyId: '50',
  messages: [
    {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      snippet: 'first',
      internalDate: '1000',
      payload: {
        headers: [
          { name: 'From', value: 'Ana Ruiz <ana@example.com>' },
          { name: 'Subject', value: 'Plans' },
          { name: 'Message-ID', value: '<m1@example.com>' }
        ]
      }
    },
    {
      id: 'm2',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD', 'STARRED'],
      snippet: 'Tom &amp; Jerry&#39;s',
      internalDate: '2000',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: '"Leo, O." <leo@example.com>' },
          { name: 'To', value: 'Me <me@example.com>, "Doe, Jane" <jane@example.com>' },
          { name: 'Subject', value: 'Re: Plans' },
          { name: 'List-Unsubscribe', value: '<mailto:u@example.com>' }
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('plain body') } },
          { mimeType: 'text/html', body: { data: b64('<p>html body ✓</p>') } }
        ]
      }
    }
  ]
}

function fakeGmail(routes: Record<string, (init?: RequestInit) => { status?: number; body?: unknown }>) {
  const calls: string[] = []
  const route = (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    const key = Object.keys(routes).find(k => path.startsWith(k))
    return key ? routes[key](init) : { status: 404, body: { error: 'not found' } }
  }
  const fetchFn = (async (url: string, init?: RequestInit) => {
    // Gmail's batch endpoint: answer each part through the same routes.
    if (url === 'https://gmail.googleapis.com/batch/gmail/v1') {
      const paths = [...String(init?.body).matchAll(/GET \/gmail\/v1\/users\/me(\S+)/g)].map(m => m[1])
      const parts = paths.map((p, i) => {
        const { status = 200, body } = route(p)
        return `--resp\r\nContent-Type: application/http\r\nContent-ID: <response-item${i}>\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body ?? {})}\r\n`
      })
      return new Response(parts.join('') + '--resp--', { status: 200, headers: { 'content-type': 'multipart/mixed; boundary=resp' } })
    }
    const path = url.replace('https://gmail.googleapis.com/gmail/v1/users/me', '')
    const { status = 200, body } = route(path, init)
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status })
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('Gmail mapping', () => {
  it('summarizes a thread from metadata', () => {
    const s = summarizeThread(thread)!
    expect(s.subject).toBe('Plans')
    expect(s.from).toEqual({ name: 'Leo, O.', email: 'leo@example.com' })
    expect(s.unread).toBe(true)
    expect(s.starred).toBe(true)
    expect(s.inInbox).toBe(true)
    expect(s.listUnsubscribe).toBe(true)
    expect(s.snippet).toBe("Tom & Jerry's")
    expect(s.participants.map(p => p.email)).toEqual(['ana@example.com', 'leo@example.com'])
  })

  it('extracts bodies and recipients from a full message', () => {
    const m = toMessage(thread.messages[1])
    expect(m.text).toBe('plain body')
    expect(m.html).toBe('<p>html body ✓</p>')
    expect(m.to.map(a => a.email)).toEqual(['me@example.com', 'jane@example.com'])
  })
})

describe('GmailProvider', () => {
  it('takes a snapshot, then syncs incrementally from history', async () => {
    const { fetchFn, calls } = fakeGmail({
      '/profile': () => ({ body: { historyId: '100' } }),
      '/threads?q=in%3Ainbox': () => ({ body: { threads: [{ id: 't1' }] } }),
      '/threads/t1': () => ({ body: thread }),
      '/history?startHistoryId=100': () => ({ body: { historyId: '120', history: [{ messages: [{ threadId: 't1' }, { threadId: 'gone' }] }] } })
    })
    const gmail = new GmailProvider(async () => 'token', fetchFn)
    const first = await gmail.sync(null)
    expect(first).toMatchObject({ cursor: '100', full: true })
    expect(first.upserts.map(t => t.id)).toEqual(['t1'])

    const next = await gmail.sync('100')
    expect(next).toMatchObject({ cursor: '120', full: false, removals: ['gone'] })
    expect(calls).toContain('GET /history?startHistoryId=100')
  })

  it('falls back to a snapshot when the history cursor expired', async () => {
    const { fetchFn } = fakeGmail({
      '/history': () => ({ status: 404, body: {} }),
      '/profile': () => ({ body: { historyId: '900' } }),
      '/threads?q=in%3Ainbox': () => ({ body: { threads: [] } })
    })
    const result = await new GmailProvider(async () => 't', fetchFn).sync('1')
    expect(result).toMatchObject({ full: true, cursor: '900' })
  })

  it('reports snapshot progress batch by batch', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => ({ id: `t${i}` }))
    const { fetchFn } = fakeGmail({
      '/profile': () => ({ body: { historyId: '100' } }),
      '/threads?q=': () => ({ body: { threads: ids } }),
      '/threads/': () => ({ body: thread })
    })
    let clock = 0
    const gmail = new GmailProvider(async () => 'token', fetchFn, { now: () => clock, sleep: async ms => void (clock += ms) })
    const progress: [number, number, number][] = []
    await gmail.sync(null, (batch, done, total) => progress.push([batch.length, done, total]))
    expect(progress).toEqual([
      [50, 50, 120],
      [50, 100, 120],
      [20, 120, 120]
    ])
  })

  it('retries rate-limited and failed requests, then gives up', async () => {
    let profileCalls = 0
    const { fetchFn } = fakeGmail({
      '/profile': () => (++profileCalls < 3 ? { status: 429, body: { error: 'rateLimitExceeded' } } : { body: { historyId: '1' } }),
      '/threads?q=in%3Ainbox': () => ({ body: { threads: [] } }),
      '/threads/bad': () => ({ status: 400, body: { error: 'bad' } })
    })
    const waits: number[] = []
    let clock = 0
    const gmail = new GmailProvider(async () => 'token', fetchFn, {
      now: () => clock,
      sleep: async ms => {
        waits.push(ms)
        clock += ms
      }
    })
    await gmail.sync(null)
    expect(profileCalls).toBe(3)
    // Quota waits start at 2 s, then 5 s (plus jitter under 250 ms).
    expect(waits.length).toBe(2)
    expect(waits[0]).toBeGreaterThanOrEqual(2_000)
    expect(waits[1]).toBeGreaterThanOrEqual(5_000)
    // A 400 is the caller's fault: no retry.
    await expect(gmail.summaries(['bad'])).rejects.toThrow(/400/)
    expect(waits.length).toBe(2)
  })

  it('stops retrying after four attempts', async () => {
    let calls = 0
    const { fetchFn } = fakeGmail({ '/profile': () => (calls++, { status: 503 }) })
    const gmail = new GmailProvider(async () => 'token', fetchFn, { sleep: async () => {} })
    await expect(gmail.sync(null)).rejects.toThrow(/503/)
    expect(calls).toBe(4)
  })

  it('treats "Quota exceeded" 403s as quota errors and waits them out', async () => {
    let calls = 0
    const quotaBody = { error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost'", status: 'RESOURCE_EXHAUSTED' } }
    const { fetchFn } = fakeGmail({
      '/profile': () => (++calls === 1 ? { status: 403, body: quotaBody } : { body: { historyId: '1' } }),
      '/threads?q=in%3Ainbox': () => ({ body: { threads: [] } })
    })
    let clock = 0
    const gmail = new GmailProvider(async () => 'token', fetchFn, { now: () => clock, sleep: async ms => void (clock += ms) })
    await gmail.sync(null)
    expect(calls).toBe(2)
    expect(clock).toBeGreaterThanOrEqual(2_000)
  })

  it('lists Done with the archived-mail query', async () => {
    const { fetchFn, calls } = fakeGmail({ '/threads?q=': () => ({ body: { threads: [{ id: 't9' }] } }) })
    const gmail = new GmailProvider(async () => 'token', fetchFn)
    expect(await gmail.listDoneIds(50)).toEqual(['t9'])
    expect(decodeURIComponent(calls[0])).toBe('GET /threads?q=-in:inbox -in:trash -in:spam -in:drafts -label:kestrel-marketing&maxResults=50')
    await gmail.listDoneIds(50, { unread: true, newerThanDays: 90 })
    expect(decodeURIComponent(calls[1])).toBe('GET /threads?q=-in:inbox -in:trash -in:spam -in:drafts -label:kestrel-marketing is:unread newer_than:90d&maxResults=50')
  })

  it('maps actions to label changes', async () => {
    const bodies: unknown[] = []
    const { fetchFn, calls } = fakeGmail({
      '/threads/t1/modify': init => (bodies.push(JSON.parse(String(init?.body))), { body: {} }),
      '/threads/t1/trash': () => ({ body: {} })
    })
    const gmail = new GmailProvider(async () => 't', fetchFn)
    await gmail.apply({ type: 'archive', threadId: 't1' })
    await gmail.apply({ type: 'markRead', threadId: 't1', read: true })
    await gmail.apply({ type: 'star', threadId: 't1', starred: true })
    await gmail.apply({ type: 'trash', threadId: 't1' })
    expect(bodies).toEqual([
      { addLabelIds: [], removeLabelIds: ['INBOX'] },
      { addLabelIds: [], removeLabelIds: ['UNREAD'] },
      { addLabelIds: ['STARRED'], removeLabelIds: [] }
    ])
    expect(calls).toContain('POST /threads/t1/trash')
  })

  it('sends replies into the original thread', async () => {
    let sent: { raw: string; threadId?: string } | null = null
    const { fetchFn } = fakeGmail({ '/messages/send': init => ((sent = JSON.parse(String(init?.body))), { body: {} }) })
    await new GmailProvider(async () => 't', fetchFn).send(
      {
        to: [{ name: 'Ana', email: 'ana@example.com' }],
        cc: [],
        subject: 'Re: Plans',
        body: 'Sounds good',
        replyTo: { threadId: 't1', messageIdHeader: '<m1@example.com>', references: null }
      },
      { name: 'Me', email: 'me@example.com' }
    )
    expect(sent!.threadId).toBe('t1')
    const raw = fromBase64Url(sent!.raw)
    expect(raw).toContain('In-Reply-To: <m1@example.com>')
    expect(raw).toContain('To: Ana <ana@example.com>')
  })
})

describe('QuotaBudget', () => {
  it('spends a burst at once, then refills at the per-minute rate', async () => {
    let clock = 0
    const budget = new QuotaBudget(() => clock, async ms => void (clock += ms), 6_000, 1_000)
    // Background work keeps 30% of the bucket free: 700 units go at once.
    for (let i = 0; i < 70; i++) await budget.take(10)
    expect(clock).toBe(0)
    await budget.take(10)
    // 6,000 a minute is 100 a second, so 10 more units take about 100 ms.
    expect(clock).toBeGreaterThanOrEqual(90)
    expect(clock).toBeLessThan(200)
  })

  it('lets what you are doing now use the reserve background work leaves', async () => {
    let clock = 0
    const budget = new QuotaBudget(() => clock, async ms => void (clock += ms), 6_000, 1_000)
    for (let i = 0; i < 70; i++) await budget.take(10)
    await budget.take(250, 'interactive')
    expect(clock).toBe(0)
  })

  it('pauses everyone on a quota error, halves its rate, and recovers when calm', async () => {
    let clock = 0
    const budget = new QuotaBudget(() => clock, async ms => void (clock += ms), 6_000, 1_000)
    budget.pause(30_000)
    await budget.take(1)
    expect(clock).toBeGreaterThanOrEqual(30_000)
    expect(budget.speed).toBe(0.5)
    budget.pause(30_000)
    budget.pause(30_000)
    budget.pause(30_000)
    expect(budget.speed).toBe(1 / 8) // never slower than an eighth
    clock += 12 * 60_000 // an eighth needs 10 calm minutes to grow back to full speed
    await budget.take(1)
    expect(budget.speed).toBe(1)
  })
})

describe('batch requests', () => {
  it('skips threads the caller already has at the same version', async () => {
    const { fetchFn, calls } = fakeGmail({
      '/profile': () => ({ body: { historyId: '10' } }),
      '/threads?q=': () => ({ body: { threads: [{ id: 't1', historyId: '50' }, { id: 't2', historyId: '9' }, { id: 't3', historyId: '4' }] } }),
      '/threads/': () => ({ body: thread })
    })
    const gmail = new GmailProvider(async () => 'token', fetchFn, { sleep: async () => {} })
    const result = await gmail.sync(null, undefined, 'in:inbox newer_than:90d', new Map([['t1', '50'], ['t2', '8']]))
    expect(result.unchanged).toEqual(['t1'])
    expect(calls.filter(c => c.startsWith('GET /threads/')).map(c => c.split('?')[0])).toEqual(['GET /threads/t2', 'GET /threads/t3'])
  })

  it('fetches summaries 25 to a request and retries only rate-limited parts', async () => {
    let first = true
    const ids = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}` }))
    const { fetchFn, calls } = fakeGmail({
      '/profile': () => ({ body: { historyId: '1' } }),
      '/threads?q=': () => ({ body: { threads: ids } }),
      '/threads/t3?': () => (first ? ((first = false), { status: 429, body: { error: 'rateLimitExceeded' } }) : { body: { ...thread, id: 't3' } }),
      '/threads/': () => ({ body: thread })
    })
    let clock = 0
    const gmail = new GmailProvider(async () => 'token', fetchFn, { now: () => clock, sleep: async ms => void (clock += ms) })
    const result = await gmail.sync(null, undefined, 'in:inbox newer_than:14d')
    expect(result.upserts).toHaveLength(30)
    expect(calls.filter(c => c.startsWith('GET /threads/t3'))).toHaveLength(2)
    // One quota pause of at least 30 s before the retry.
    expect(clock).toBeGreaterThanOrEqual(30_000)
    expect(decodeURIComponent(calls.find(c => c.startsWith('GET /threads?q='))!)).toContain('in:inbox newer_than:14d')
  })
})
