import { describe, expect, it, vi } from 'vitest'

import { AccountEngine, UNDO_WINDOW_MS, inverse, type PersistedCache } from '../src/sync/engine'
import { DemoProvider } from '../src/sync/providers/demo'

import { SortUnavailable } from '../src/sync/sorter'

import type { SortInput, SortVerdict } from '../src/shared/sorting'
import type { EngineEvent, MailAction } from '../src/shared/types'
import type { Sorter, SortResult } from '../src/sync/sorter'

const me = { name: 'Me', email: 'me@example.com' }
const account = { id: 'a1', email: me.email, name: me.name, provider: 'demo' as const }

function memoryStorage(initial: PersistedCache | null = null) {
  let saved = initial
  return {
    load: async () => saved,
    save: async (c: PersistedCache) => {
      saved = JSON.parse(JSON.stringify(c))
    },
    get saved() {
      return saved
    }
  }
}

// Stands in for Laya: a fixed answer per demo sender, and a count of what it was asked.
class FakeSorter implements Sorter {
  asked: SortInput[] = []
  constructor(readonly model = 'fake-1') {}
  async sort(items: SortInput[]): Promise<SortResult> {
    this.asked.push(...items)
    return { model: this.model, verdicts: items.map(i => {
      const v = (kind: SortVerdict['kind'], needsReply = 0, urgent = 0) => ({ kind, confidence: 0.9, needsReply, urgent })
      if (/% off/.test(i.subject)) return v('marketing')
      if (i.mailingList) return v('newsletter')
      if (/github/.test(i.from)) return v('notification')
      if (/calendar/.test(i.from)) return v('calendar')
      if (/pipeline/.test(i.subject)) return v('pitch', 1)
      return v('person', i.body.includes('?') ? 1 : 0)
    }) }
  }
}

async function setup(now = () => Date.now(), sorter: Sorter | null = new FakeSorter()) {
  const provider = new DemoProvider(me)
  const storage = memoryStorage()
  const engine = new AccountEngine(account, provider, storage, undefined, now, sorter)
  const events: EngineEvent[] = []
  engine.on(e => events.push(e))
  await engine.start({ poll: false })
  await engine.sortInbox()
  return { provider, storage, engine, events, sorter }
}

describe('AccountEngine', () => {
  it('loads the inbox and sorts newest first', async () => {
    const { engine } = await setup()
    const list = await engine.listThreads('important')
    expect(list.length).toBeGreaterThan(0)
    expect(list.map(t => t.date)).toEqual([...list.map(t => t.date)].sort((a, b) => b - a))
  })

  it('splits the inbox Superhuman-style with Laya\'s labels', async () => {
    const { engine } = await setup()
    expect(engine.splits().map(s => s.id)).toEqual(['important', 'to-reply', 'calendar', 'codes', 'updates', 'other'])
    const other = await engine.listThreads('other')
    expect(other.filter(t => t.listUnsubscribe).every(t => t.autoLabels?.includes('News'))).toBe(true)
    expect(other.find(t => t.subject === 'Quick question about your pipeline')?.autoLabels).toEqual(['Pitch'])
    expect((await engine.listThreads('updates')).find(t => t.from.email === 'noreply@github.com')?.autoLabels).toEqual(['Notification'])
    expect((await engine.listThreads('to-reply')).find(t => t.subject === 'Lunch Friday?')?.autoLabels).toEqual(['To respond'])
    const important = await engine.listThreads('important')
    expect(important.some(t => t.listUnsubscribe)).toBe(false)
    expect((await engine.listThreads('calendar')).find(t => t.subject === 'Invitation: Roadmap review @ Thu 2pm')?.autoLabels).toEqual(['Calendar'])
    expect(important.some(t => t.autoLabels?.includes('Calendar'))).toBe(false)
    // Your own last word isn't sorted; it stays in Important.
    expect(important.find(t => t.subject === 'Intro: Priya <> Sam')?.autoLabels).toBeUndefined()
  })

  it('lets you relabel a sender: everything from them follows, and it is kept for training', async () => {
    const { engine, storage } = await setup()
    const pitch = (await engine.listThreads('other')).find(t => t.autoLabels?.includes('Pitch'))!
    expect(engine.setLabel(pitch.id, 'Marketing')).toEqual({ sender: 'Jake Miller', count: 1 })
    const relabelled = (await engine.listThreads('other')).find(t => t.id === pitch.id)!
    expect(relabelled).toMatchObject({ autoLabels: ['Marketing'], labelledByYou: true })
    const ana = (await engine.listThreads('to-reply')).find(t => t.from.email === 'ana.ruiz@example.com')!
    engine.setLabel(ana.id, 'FYI')
    expect((await engine.listThreads('important')).filter(t => t.from.email === 'ana.ruiz@example.com')).toHaveLength(2)
    await engine.flushOutbox()
    expect(storage.saved!.corrections).toContainEqual(['jake@growthleads.example', 'Marketing'])
    expect(storage.saved!.correctionLog!.map(c => c.label)).toEqual(['Marketing', 'FYI'])
    engine.setLabel(pitch.id, null)
    expect((await engine.listThreads('other')).find(t => t.id === pitch.id)?.autoLabels).toEqual(['Pitch'])
  })

  it('files marketing away once you say so: done in Gmail, labelled, out of every split', async () => {
    const { engine, provider } = await setup()
    provider.receive('news', 'Diwali sale: 40% off', 'Everything on the site is 40% off this week.')
    await engine.sync()
    await engine.sortInbox()
    expect(engine.getAutoFile()).toEqual({ on: null, waiting: 1 })
    const sale = (await engine.listThreads('other')).find(t => t.subject === 'Diwali sale: 40% off')!
    expect(engine.setAutoFile(true)).toEqual({ filed: 1 })
    await engine.flushOutbox()
    for (const split of ['important', 'to-reply', 'calendar', 'codes', 'updates', 'other']) {
      expect((await engine.listThreads(split)).some(t => t.id === sale.id)).toBe(false)
    }
    expect((await provider.summaries([sale.id]))[0]).toMatchObject({ inInbox: false, labels: ['Kestrel/Marketing'] })
    // New marketing skips the inbox as soon as it's sorted.
    provider.receive('news', 'Weekend deals: 60% off', 'Two days only.')
    await engine.sync()
    await engine.sortInbox()
    await engine.flushOutbox()
    expect((await engine.listThreads('other')).some(t => t.subject === 'Weekend deals: 60% off')).toBe(false)
    // Relabelling filed mail brings it back to the inbox.
    engine.setLabel(sale.id, 'News')
    await engine.flushOutbox()
    expect((await provider.summaries([sale.id]))[0]).toMatchObject({ inInbox: true, labels: [] })
  })

  it('counts Laya\'s labels and lists the mail behind each one', async () => {
    const { engine } = await setup()
    const counts = engine.autoLabelCounts()
    expect(counts.map(c => c.label)).toEqual(['To respond', 'FYI', 'Calendar', 'Notification', 'Pitch', 'News'])
    const news = counts.find(c => c.label === 'News')!
    const list = await engine.listThreads('auto:News')
    expect(list).toHaveLength(news.total)
    expect(list.every(t => t.autoLabels?.includes('News'))).toBe(true)
  })

  it('sorts each thread once per version, and again when it changes', async () => {
    const { engine, provider, sorter } = await setup()
    const asked = (sorter as FakeSorter).asked.length
    await engine.sync()
    await engine.sortInbox()
    expect((sorter as FakeSorter).asked.length).toBe(asked)
    provider.receive('ana', 'Dinner?', 'Are you free tonight?')
    await engine.sync()
    await engine.sortInbox()
    expect((sorter as FakeSorter).asked.map(i => i.subject).slice(asked)).toEqual(['Dinner?'])
  })

  it('keeps every thread in Important while there is no model', async () => {
    const missing: Sorter = { sort: async () => Promise.reject(new SortUnavailable('no model')) }
    const { engine } = await setup(undefined, missing)
    expect(await engine.listThreads('other')).toEqual([])
    expect((await engine.listThreads('important')).length).toBeGreaterThan(5)
    expect(engine.getSortState()).toMatchObject({ state: 'unavailable', message: 'no model' })
  })

  it('keeps verdicts in the cache, and redoes them when a new model is installed', async () => {
    const provider = new DemoProvider(me)
    const storage = memoryStorage()
    const first = new AccountEngine(account, provider, storage, undefined, undefined, new FakeSorter())
    await first.start({ poll: false })
    await first.sortInbox()
    first.stop()
    const total = storage.saved!.sorted!.length
    const same = new FakeSorter()
    const again = new AccountEngine(account, provider, memoryStorage(storage.saved), undefined, undefined, same)
    await again.start({ poll: false })
    await again.sortInbox()
    expect(same.asked).toEqual([])
    const newer = new FakeSorter('fake-2')
    const upgraded = new AccountEngine(account, provider, memoryStorage(storage.saved), undefined, undefined, newer)
    await upgraded.start({ poll: false })
    await upgraded.sortInbox()
    expect(newer.asked).toHaveLength(total)
  })

  it('archives optimistically and syncs the change to the provider', async () => {
    const { engine, provider } = await setup()
    const [first] = await engine.listThreads('important')
    const apply = vi.spyOn(provider, 'apply')
    engine.act({ type: 'archive', threadId: first.id })
    expect((await engine.listThreads('important')).some(t => t.id === first.id)).toBe(false)
    await engine.flushOutbox()
    expect(apply).toHaveBeenCalledWith({ type: 'archive', threadId: first.id })
    await engine.sync()
    expect((await engine.listThreads('important')).some(t => t.id === first.id)).toBe(false)
  })

  it('undo restores an archived thread within the window only', async () => {
    let now = 1_000_000
    const { engine } = await setup(() => now)
    const [a, b] = await engine.listThreads('important')
    engine.act({ type: 'archive', threadId: a.id })
    expect(engine.undo()).toEqual({ type: 'unarchive', threadId: a.id })
    expect((await engine.listThreads('important')).some(t => t.id === a.id)).toBe(true)

    engine.act({ type: 'archive', threadId: b.id })
    now += UNDO_WINDOW_MS + 1
    expect(engine.undo()).toBeNull()
  })

  it('keeps failed actions queued and reapplies them over stale server data', async () => {
    const { engine, provider } = await setup()
    const [first] = await engine.listThreads('important')
    const apply = vi.spyOn(provider, 'apply').mockRejectedValue(new Error('fetch failed'))
    engine.act({ type: 'star', threadId: first.id, starred: true })
    await engine.flushOutbox()
    // Server still says unstarred; the pending action must win locally.
    await engine.sync()
    const after = (await engine.listThreads('starred')).find(t => t.id === first.id)
    expect(after?.starred).toBe(true)
    apply.mockRestore()
    await engine.sync()
    expect((await provider.sync(null)).upserts.find(t => t.id === first.id)?.starred).toBe(true)
  })

  it('emits newMail for arrivals after the first sync', async () => {
    const { engine, provider, events } = await setup()
    const id = provider.receive('ana', 'Hello', 'New message')
    await engine.sync()
    const newMail = events.find(e => e.kind === 'newMail')
    expect(newMail && newMail.kind === 'newMail' && newMail.threads.map(t => t.id)).toEqual([id])
  })

  it('persists the cache and restores it on restart', async () => {
    const { storage } = await setup()
    const provider = new DemoProvider(me)
    const offline = vi.spyOn(provider, 'sync').mockRejectedValue(new Error('fetch failed'))
    const engine = new AccountEngine(account, provider, memoryStorage(storage.saved))
    const states: string[] = []
    engine.on(e => e.kind === 'syncState' && states.push(e.state))
    await engine.start({ poll: false })
    expect(offline).toHaveBeenCalled()
    expect(states).toContain('offline')
    expect((await engine.listThreads('important')).length).toBeGreaterThan(0)
  })

  it('cancels a scheduled send', async () => {
    vi.useFakeTimers()
    try {
      const { engine, provider } = await setup()
      const draft = { to: [{ name: 'x', email: 'x@example.com' }], cc: [], subject: 'Hi', body: 'Body' }
      const id = engine.scheduleSend(draft, 10_000)
      expect(engine.cancelSend(id)).toEqual(draft)
      await vi.advanceTimersByTimeAsync(11_000)
      expect(provider.sent).toHaveLength(0)

      engine.scheduleSend(draft, 10_000)
      await vi.advanceTimersByTimeAsync(11_000)
      expect(provider.sent).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows archived threads in Done and moves them back to the inbox', async () => {
    const { engine, provider } = await setup()
    const [first] = await engine.listThreads('important')
    expect(await engine.listThreads('done')).toEqual([])

    engine.act({ type: 'archive', threadId: first.id })
    // Shown in Done at once, before the provider has the change.
    const done = await engine.listThreads('done')
    expect(done.map(t => t.id)).toEqual([first.id])
    expect(done[0].inInbox).toBe(false)
    await engine.flushOutbox()
    expect(await provider.listDoneIds(10)).toEqual([first.id])

    engine.act({ type: 'unarchive', threadId: first.id })
    expect(await engine.listThreads('done')).toEqual([])
    expect((await engine.listThreads('important')).some(t => t.id === first.id)).toBe(true)
  })

  it('keeps trashed threads out of Done, and untrash returns them where they were', async () => {
    const { engine } = await setup()
    const [a] = await engine.listThreads('important')
    engine.act({ type: 'archive', threadId: a.id })
    engine.act({ type: 'trash', threadId: a.id })
    expect(await engine.listThreads('done')).toEqual([])
    engine.undo()
    expect((await engine.listThreads('done')).map(t => t.id)).toEqual([a.id])
    expect((await engine.listThreads('important')).some(t => t.id === a.id)).toBe(false)
  })

  it('stars a thread in Done without putting it back in the inbox', async () => {
    const { engine } = await setup()
    const [a] = await engine.listThreads('important')
    engine.act({ type: 'archive', threadId: a.id })
    engine.act({ type: 'star', threadId: a.id, starred: !a.starred })
    const [inDone] = await engine.listThreads('done')
    expect(inDone.starred).toBe(!a.starred)
    expect((await engine.listThreads('important')).some(t => t.id === a.id)).toBe(false)
  })

  it('shows the inbox batch by batch during the first sync', async () => {
    const demo = new DemoProvider(me)
    const full = await demo.sync(null)
    const seenMidway: number[] = []
    let engine!: AccountEngine
    // Streams the snapshot in two halves and records what the engine lists in between.
    const streaming = Object.assign(Object.create(demo), {
      async sync(cursor: string | null, onProgress?: (b: typeof full.upserts, done: number, total: number) => void) {
        if (cursor) return demo.sync(cursor)
        const half = Math.ceil(full.upserts.length / 2)
        onProgress?.(full.upserts.slice(0, half), half, full.upserts.length)
        seenMidway.push((await engine.listThreads('all')).length)
        onProgress?.(full.upserts.slice(half), full.upserts.length, full.upserts.length)
        return full
      }
    })
    engine = new AccountEngine(account, streaming, memoryStorage())
    const events: EngineEvent[] = []
    engine.on(e => events.push(e))
    await engine.start({ poll: false })
    expect(seenMidway).toEqual([Math.ceil(full.upserts.length / 2)])
    expect(events.filter(e => e.kind === 'syncProgress')).toEqual([
      { kind: 'syncProgress', done: Math.ceil(full.upserts.length / 2), total: full.upserts.length },
      { kind: 'syncProgress', done: full.upserts.length, total: full.upserts.length }
    ])
  })

  it('keeps an action taken while a slow sync is running', async () => {
    const { engine, provider } = await setup()
    const [first] = await engine.listThreads('important')
    // Hold the next sync until the action has been applied and sent to the provider.
    const realSync = provider.sync.bind(provider)
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    let staleSnapshot!: Awaited<ReturnType<typeof realSync>>
    provider.sync = async () => {
      staleSnapshot = await realSync(null) // taken before the archive
      await gate
      return staleSnapshot
    }
    const syncing = engine.sync()
    await new Promise(r => setTimeout(r, 0))
    engine.act({ type: 'archive', threadId: first.id })
    await engine.flushOutbox()
    release()
    await syncing
    expect(staleSnapshot.upserts.some(t => t.id === first.id && t.inInbox)).toBe(true)
    expect((await engine.listThreads('important')).some(t => t.id === first.id)).toBe(false)
  })

  it('leaves your own sent-only threads out of Done', async () => {
    const { engine, provider } = await setup()
    const [a] = await engine.listThreads('important')
    await provider.send({ to: [{ name: 'Ana', email: 'ana@example.com' }], cc: [], subject: 'Just me', body: 'hi' }, me)
    const sentOnly = provider.receive('ana', 'x', 'y')
    // Make that thread look like it holds only my own message, out of the inbox.
    const t = (provider as unknown as { threads: Map<string, { summary: { from: typeof me; participants: (typeof me)[]; inInbox: boolean } }> }).threads.get(sentOnly)!
    t.summary.from = me
    t.summary.participants = [me]
    t.summary.inInbox = false
    engine.act({ type: 'archive', threadId: a.id })
    const ids = (await engine.listThreads('done')).map(x => x.id)
    expect(ids).toContain(a.id)
    expect(ids).not.toContain(sentOnly)
  })

  it('shares one Done fetch between views and reuses it for a while', async () => {
    let now = 1_000_000
    const { engine, provider } = await setup(() => now)
    let fetches = 0
    const real = provider.listDoneIds.bind(provider)
    provider.listDoneIds = async (limit, filter) => (fetches++, real(limit, filter))
    // One refresh asks Gmail twice: read mail, and unread mail you archived yourself.
    await Promise.all([engine.listThreads('done'), engine.listThreads('done'), engine.listThreads('done')])
    expect(fetches).toBe(2)
    await engine.listThreads('done')
    expect(fetches).toBe(2)
    now += 16_000
    await engine.listThreads('done')
    expect(fetches).toBe(4)
  })

  it('splits Done into yours, never opened, and filed away', async () => {
    const { engine, provider } = await setup()
    // Mail archived elsewhere while unread: never opened.
    const lunch = (await engine.listThreads('to-reply')).find(t => t.subject === 'Lunch Friday?')!
    await provider.apply({ type: 'archive', threadId: lunch.id })
    await provider.apply({ type: 'markRead', threadId: lunch.id, read: false })
    await engine.sync()
    // Unread mail you archive here is yours.
    const deploy = (await engine.listThreads('important')).find(t => t.subject === 'Deploy is green')!
    engine.act({ type: 'archive', threadId: deploy.id })
    await engine.flushOutbox()
    const mine = (await engine.listThreads('done')).map(t => t.subject)
    const unopened = (await engine.listThreads('done-unopened')).map(t => t.subject)
    expect(mine).toContain('Deploy is green')
    expect(unopened).toContain('Lunch Friday?')
    expect(unopened).not.toContain('Deploy is green')
    expect(mine).not.toContain('Lunch Friday?')
  })

  it('rescues mail from people that was archived unread, and brings it back', async () => {
    const { engine, provider } = await setup()
    const lunch = (await engine.listThreads('to-reply')).find(t => t.subject === 'Lunch Friday?')!
    const github = (await engine.listThreads('updates')).find(t => t.from.email === 'noreply@github.com')!
    for (const t of [lunch, github]) {
      await provider.apply({ type: 'archive', threadId: t.id })
      await provider.apply({ type: 'markRead', threadId: t.id, read: false })
    }
    await engine.sync()
    expect(engine.rescueScan(90).state).toBe('scanning')
    for (let i = 0; i < 50 && engine.getRescue().state === 'scanning'; i++) await new Promise(r => setTimeout(r, 5))
    expect(engine.getRescue()).toMatchObject({ state: 'done', found: 1 })
    expect((await engine.listThreads('done-rescue')).map(t => t.subject)).toEqual(['Lunch Friday?'])
    expect(engine.bringBack()).toEqual({ moved: 1 })
    await engine.flushOutbox()
    expect((await engine.listThreads('to-reply')).some(t => t.id === lunch.id)).toBe(true)
    expect((await provider.summaries([github.id]))[0].inInbox).toBe(false)
  })

  describe('reminders', () => {
    it('moves a thread to Reminders, keeps it out of Done, and brings it back on top when due', async () => {
      let now = Date.now()
      const { engine, provider, events } = await setup(() => now)
      const list = await engine.listThreads('important')
      const last = list[list.length - 1]
      engine.remind(last.id, now + 60_000)
      expect((await engine.listThreads('important')).some(t => t.id === last.id)).toBe(false)
      expect((await engine.listThreads('reminders')).map(t => [t.id, t.remindAt])).toEqual([[last.id, now + 60_000]])
      expect((await engine.listThreads('done')).some(t => t.id === last.id)).toBe(false)
      await engine.flushOutbox()
      expect(await provider.listDoneIds(10)).toContain(last.id) // archived on the server meanwhile

      engine.checkReminders()
      expect((await engine.listThreads('reminders')).length).toBe(1) // not due yet
      now += 61_000
      engine.checkReminders()
      const back = await engine.listThreads('important')
      expect(back[0].id).toBe(last.id)
      expect(back[0].returnedAt).toBe(now)
      expect(await engine.listThreads('reminders')).toEqual([])
      expect(events.some(e => e.kind === 'newMail' && e.threads.some(t => t.id === last.id))).toBe(true)

      // Marking it done clears the marker.
      engine.act({ type: 'archive', threadId: last.id })
      engine.act({ type: 'unarchive', threadId: last.id })
      expect((await engine.listThreads('important')).find(t => t.id === last.id)?.returnedAt).toBeUndefined()
    })

    it('undo cancels a reminder set from the inbox', async () => {
      const { engine } = await setup()
      const [a] = await engine.listThreads('important')
      engine.remind(a.id, Date.now() + 3_600_000)
      engine.undo()
      expect((await engine.listThreads('important')).some(t => t.id === a.id)).toBe(true)
      expect(await engine.listThreads('reminders')).toEqual([])
    })

    it('ends a reminder when the thread comes back to the inbox on the server', async () => {
      const { engine, provider } = await setup()
      const [a] = await engine.listThreads('important')
      engine.remind(a.id, Date.now() + 3_600_000)
      await engine.flushOutbox()
      await engine.sync()
      // Someone replies: Gmail puts the thread back in the inbox.
      await provider.apply({ type: 'unarchive', threadId: a.id })
      await engine.sync()
      expect(await engine.listThreads('reminders')).toEqual([])
      expect((await engine.listThreads('important')).some(t => t.id === a.id)).toBe(true)
    })

    it('keeps reminders across a restart and fires ones that came due meanwhile', async () => {
      let now = 5_000_000
      const provider = new DemoProvider(me)
      const storage = memoryStorage()
      const first = new AccountEngine(account, provider, storage, undefined, () => now)
      await first.start({ poll: false })
      const [a] = await first.listThreads('important')
      first.remind(a.id, now + 1_000)
      await first.flushOutbox()
      first.stop()

      now += 10_000
      const second = new AccountEngine(account, provider, storage, undefined, () => now)
      await second.start({ poll: false })
      expect(await second.listThreads('reminders')).toEqual([])
      expect((await second.listThreads('important'))[0].id).toBe(a.id)
    })
  })

  describe('inbox insights', () => {
    it('lists senders by volume and marks all of one sender done', async () => {
      const { engine } = await setup()
      const senders = await engine.listThreads('senders')
      expect(senders[0].senderOf!.count).toBeGreaterThanOrEqual(senders[1].senderOf!.count)
      const ana = senders.find(r => r.senderOf!.email === 'ana.ruiz@example.com')!
      expect(ana.senderOf!.count).toBe(2)
      expect(engine.archiveSender('ana.ruiz@example.com')).toBe(2)
      expect((await engine.listThreads('senders')).some(r => r.senderOf!.email === 'ana.ruiz@example.com')).toBe(false)
    })

    it('unsubscribes through the provider and clears that sender', async () => {
      const { engine, provider } = await setup()
      const news = (await engine.listThreads('other')).find(t => t.listUnsubscribe)!
      const out = await engine.unsubscribe(news.id)
      expect(out.result).toEqual({ method: 'one-click' })
      expect(out.archived).toBe(2)
      expect(provider.unsubscribed).toEqual([news.from.email])
      expect((await engine.listThreads('other')).some(t => t.listUnsubscribe)).toBe(false)
    })

    it('Reply Zero: To reply has the other person\'s last word, Waiting has yours', async () => {
      const { engine } = await setup()
      const toReply = await engine.listThreads('to-reply')
      expect(toReply.length).toBeGreaterThan(0)
      expect(toReply.every(t => t.from.email !== me.email)).toBe(true)
      expect(toReply.map(t => t.date)).toEqual([...toReply.map(t => t.date)].sort((a, b) => a - b))
      expect(toReply.every(t => t.autoLabels?.includes('To respond'))).toBe(true)
      const waiting = await engine.listThreads('waiting')
      expect(waiting.map(t => t.subject)).toEqual(['Intro: Priya <> Sam'])
    })

    it('counts mail marked done today, but not reminders', async () => {
      const { engine } = await setup()
      const [a, b] = await engine.listThreads('important')
      engine.act({ type: 'archive', threadId: a.id })
      engine.remind(b.id, Date.now() + 3_600_000)
      const stats = engine.getStats()
      expect(stats.days).toHaveLength(7)
      expect(stats.days.at(-1)!.done).toBe(1)
      expect(stats.pitches).toBe(1)
      expect(stats.topSenders[0].count).toBeGreaterThanOrEqual(1)
    })
  })

  describe('folders and labels', () => {
    it('lists Gmail folders and user labels with counts', async () => {
      const { engine } = await setup()
      const labels = await engine.labels()
      expect(labels.filter(l => l.system).map(l => l.id)).toEqual(['INBOX', 'DRAFT', 'SENT', 'STARRED', 'SPAM', 'TRASH'])
      expect(labels.filter(l => !l.system).map(l => [l.name, l.total])).toEqual([
        ['Investments', 1],
        ['Meeting updates', 1]
      ])
    })

    it('shows Sent, a label, and Starred, and keeps them in step with local changes', async () => {
      const { engine } = await setup()
      expect((await engine.listThreads('sent')).map(t => t.subject)).toEqual(['Intro: Priya <> Sam'])
      const label = await engine.listThreads('label:Investments')
      expect(label.map(t => t.subject)).toEqual(['Term sheet draft'])
      const [starred] = await engine.listThreads('all-starred')
      engine.act({ type: 'star', threadId: starred.id, starred: false })
      expect(await engine.listThreads('all-starred')).toEqual([])
      // Archiving keeps a thread in its label, as in Gmail.
      engine.act({ type: 'archive', threadId: label[0].id })
      expect((await engine.listThreads('label:Investments')).length).toBe(1)
      engine.act({ type: 'trash', threadId: label[0].id })
      expect(await engine.listThreads('label:Investments')).toEqual([])
    })

    it('reuses thread summaries it already has instead of fetching them again', async () => {
      const { engine, provider } = await setup()
      let fetched = 0
      const real = provider.summaries.bind(provider)
      provider.summaries = async ids => ((fetched += ids.length), real(ids))
      await engine.listThreads('label:Meeting updates')
      expect(fetched).toBe(0) // that thread is already in the inbox cache
    })
  })

  describe('inbox window', () => {
    const who = { name: 'Ana', email: 'ana@example.com' }
    const seed = [
      { from: who, subject: 'Fresh', body: 'new', hoursAgo: 2 },
      { from: who, subject: 'Old and read', body: 'x', hoursAgo: 24 * 20 },
      { from: who, subject: 'Old and unread', body: 'x', hoursAgo: 24 * 40, unread: true }
    ]
    const start = async () => {
      const provider = new DemoProvider(me, Date.now(), seed)
      const queries: (string | undefined)[] = []
      const real = provider.sync.bind(provider)
      provider.sync = (cursor, onProgress, query) => (queries.push(query), real(cursor, onProgress, query))
      const engine = new AccountEngine(account, provider, memoryStorage())
      await engine.start({ poll: false })
      return { engine, queries }
    }
    const subjects = async (engine: AccountEngine) => (await engine.listThreads('important')).map(t => t.subject).sort()

    it('shows the last 2 weeks by default and asks Gmail for just that', async () => {
      const { engine, queries } = await start()
      expect(queries[0]).toBe('in:inbox newer_than:14d')
      expect(await subjects(engine)).toEqual(['Fresh'])
    })

    it('keeps what it already has when a wider window takes a new snapshot', async () => {
      const { engine } = await start()
      const before = await engine.listThreads('important')
      const provider = (engine as unknown as { provider: { sync: (...a: unknown[]) => Promise<unknown> } }).provider
      // A snapshot that finds everything already up to date fetches and returns nothing new.
      provider.sync = async () => ({ upserts: [], removals: [], cursor: 'x', full: true, unchanged: before.map(t => t.id) })
      engine.setInboxWindow({ days: 90, keepUnread: false })
      await engine.sync()
      expect((await engine.listThreads('important')).map(t => t.id)).toEqual(before.map(t => t.id))
    })

    it('can keep all unread mail, or show everything', async () => {
      const { engine, queries } = await start()
      engine.setInboxWindow({ days: 14, keepUnread: true })
      await engine.sync()
      expect(queries.at(-1)).toBe('in:inbox {newer_than:14d is:unread}')
      expect(await subjects(engine)).toEqual(['Fresh', 'Old and unread'])
      engine.setInboxWindow({ days: null, keepUnread: false })
      await engine.sync()
      expect(queries.at(-1)).toBe('in:inbox')
      expect(await subjects(engine)).toEqual(['Fresh', 'Old and read', 'Old and unread'])
      expect(engine.getInboxWindow()).toEqual({ days: null, keepUnread: false })
    })
  })

  describe('resync', () => {
    it('fetches nothing when Kestrel already matches Gmail', async () => {
      const { engine, provider } = await setup()
      let fetched = 0
      const real = provider.summaries.bind(provider)
      provider.summaries = async ids => ((fetched += ids.length), real(ids))
      const result = await engine.resync()
      expect(result.updated).toBe(0)
      expect(result.removed).toBe(0)
      expect(fetched).toBe(0)
      expect(result.checked).toBeGreaterThan(0)
    })

    it('catches what the change history missed: deleted labels, vanished and changed threads', async () => {
      const { engine, provider } = await setup()
      // From here on the usual sync sees nothing, as when Gmail's history has gaps.
      provider.sync = async cursor => ({ upserts: [], removals: [], cursor: cursor ?? '0', full: false })
      const [first, second] = await engine.listThreads('important')
      expect((await engine.labels()).some(l => l.name === 'Investments')).toBe(true)

      const internals = provider as unknown as { threads: Map<string, { summary: { labels: string[]; subject: string } }> }
      for (const t of internals.threads.values()) t.summary.labels = t.summary.labels.filter(l => l !== 'Investments') // label deleted in Gmail
      await provider.apply({ type: 'archive', threadId: first.id }) // archived in Gmail on the web
      await provider.apply({ type: 'star', threadId: second.id, starred: true }) // starred elsewhere

      let fetched = 0
      const real = provider.summaries.bind(provider)
      provider.summaries = async ids => ((fetched += ids.length), real(ids))
      const result = await engine.resync()
      expect(result.removed).toBe(1)
      expect(result.updated).toBe(1)
      expect(fetched).toBe(1) // only the starred thread was fetched again
      expect((await engine.labels()).some(l => l.name === 'Investments')).toBe(false)
      const inbox = await engine.listThreads('important')
      expect(inbox.some(t => t.id === first.id)).toBe(false)
      expect(inbox.find(t => t.id === second.id)?.starred).toBe(true)
    })
  })

  it('hides labels in the sidebar, nested ones with their parent, and remembers it', async () => {
    const who = { name: 'Ana', email: 'ana@example.com' }
    const seed = [
      { from: who, subject: 'a', body: 'x', hoursAgo: 1, labels: ['[Superhuman]', '[Superhuman]/AI', '[Superhuman]/AI/News'] },
      { from: who, subject: 'b', body: 'x', hoursAgo: 2, labels: ['Trendlyne'] }
    ]
    const provider = new DemoProvider(me, Date.now(), seed)
    const storage = memoryStorage()
    const engine = new AccountEngine(account, provider, storage)
    await engine.start({ poll: false })
    const hidden = (list: { name: string; hidden?: boolean; system: boolean }[]) => list.filter(l => !l.system && l.hidden).map(l => l.name)
    await engine.labels() // the sidebar loads labels before anything can be hidden

    expect(hidden(engine.setLabelHidden('[Superhuman]', true))).toEqual(['[Superhuman]', '[Superhuman]/AI', '[Superhuman]/AI/News'])
    // Showing a child also clears the parent hiding it.
    expect(hidden(engine.setLabelHidden('[Superhuman]/AI/News', false))).toEqual([])
    engine.setLabelHidden('Trendlyne', true)
    await engine.flushOutbox()
    engine.stop()

    const again = new AccountEngine(account, provider, storage)
    await again.start({ poll: false })
    expect(hidden(await again.labels())).toEqual(['Trendlyne'])
  })

  it('inverse undoes every action type', () => {
    const actions: MailAction[] = [
      { type: 'archive', threadId: 't' },
      { type: 'trash', threadId: 't' },
      { type: 'star', threadId: 't', starred: true },
      { type: 'markRead', threadId: 't', read: true }
    ]
    for (const a of actions) expect(inverse(inverse(a))).toEqual(a)
  })
})
