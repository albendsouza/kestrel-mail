import { describe, expect, it } from 'vitest'

import { FEATURES, combine, featuresOf, fitCombiner, predictBucket, signalsOf, sortInputOf, usableCombiner, verdictForBucket } from '../src/shared/signals'
import { SPLITS, labelsFor } from '../src/shared/sorting'

import type { SortVerdict, ThreadSignals } from '../src/shared/sorting'
import type { ThreadSummary } from '../src/shared/types'

const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: 't1',
  subject: 'Seed round',
  snippet: 'Hi, we are raising',
  from: { name: 'Founder', email: 'founder@startup.io' },
  participants: [],
  date: 0,
  unread: true,
  starred: false,
  inInbox: true,
  messageCount: 1,
  listUnsubscribe: false,
  bulk: false,
  labels: ['INBOX', 'CATEGORY_PERSONAL', 'IMPORTANT'],
  to: ['me@fund.vc'],
  ...over
})
const verdict = (over: Partial<SortVerdict> = {}): SortVerdict => ({
  kind: 'person',
  confidence: 0.9,
  needsReply: 0.2,
  urgent: 0.1,
  kindProbs: { person: 0.6, pitch: 0.2, marketing: 0.15, newsletter: 0.05 },
  ...over
})
const signals = (over: Partial<ThreadSignals> = {}): ThreadSignals => ({
  important: true,
  category: 'personal',
  mailingList: false,
  undisclosed: false,
  toOthers: false,
  multi: false,
  colleague: false,
  ...over
})

describe("Gmail's signals for a thread", () => {
  it('reads importance, the inbox tab, lists, recipients and thread length', () => {
    expect(signalsOf(thread({ listUnsubscribe: true, to: ['undisclosed-recipients:;'], messageCount: 3 }), 'me@fund.vc')).toEqual({
      important: true,
      category: 'personal',
      mailingList: true,
      undisclosed: true,
      toOthers: true,
      multi: true,
      colleague: false
    })
  })

  it('counts someone at your own domain as a colleague, but not on a webmail domain', () => {
    expect(signalsOf(thread({ from: { name: 'Jai', email: 'jai@fund.vc' } }), 'me@fund.vc')!.colleague).toBe(true)
    expect(signalsOf(thread({ from: { name: 'Sam', email: 'sam@gmail.com' } }), 'me@gmail.com')!.colleague).toBe(false)
  })

  it('has none when the provider gives no inbox tab, so Laya decides alone', () => {
    expect(signalsOf(thread({ labels: ['INBOX'] }), 'me@fund.vc')).toBeUndefined()
    expect(sortInputOf(thread({ labels: ['INBOX'] }), 'me@fund.vc').signals).toBeUndefined()
  })
})

describe('the signal layer', () => {
  it('turns a verdict and signals into one number per feature', () => {
    expect(featuresOf(verdict(), signals())).toHaveLength(FEATURES.length)
  })

  it('moves a verdict to any bucket with the smallest change, so its labels follow', () => {
    for (const { id } of SPLITS) expect(labelsFor(verdictForBucket(verdict(), id)).split).toBe(id)
    expect(verdictForBucket(verdict(), 'other').kind).toBe('pitch') // the likeliest bulk kind
    expect(verdictForBucket(verdict(), 'important')).toEqual(verdict()) // already there
  })

  it("never makes mail look surer than Laya was, so it can't trigger filing marketing away", () => {
    const sure = verdict({ kindProbs: { person: 0.9, marketing: 0.08, pitch: 0.02 } })
    const moved = verdictForBucket(sure, 'other')
    expect(moved.kind).toBe('marketing')
    expect(moved.confidence).toBe(0.08)
  })

  it('learns which signals to trust from labelled examples', () => {
    // Mail Gmail didn't flag important is bulk; mail it did is from a person.
    const examples = Array.from({ length: 40 }, (_, i) => {
      const important = i % 2 === 0
      return { x: featuresOf(verdict(), signals({ important, category: important ? 'personal' : 'promotions' })), bucket: important ? ('important' as const) : ('other' as const) }
    })
    const c = fitCombiner(examples, { forModel: 'laya-test', trainedOn: { labels: 40, corrections: 0 } })
    expect(c.crossValidated).toBe(100)
    expect(predictBucket(c, featuresOf(verdict(), signals({ important: false, category: 'promotions' })))).toBe('other')
    expect(combine(c, verdict(), signals())).toEqual(verdict())
    expect(combine(c, verdict(), undefined)).toEqual(verdict())
  })

  it('is only used for the model it was fitted on, with the same features', () => {
    const c = fitCombiner([{ x: featuresOf(verdict(), signals()), bucket: 'important' }, { x: featuresOf(verdict(), signals({ important: false })), bucket: 'other' }], {
      forModel: 'laya-a',
      trainedOn: { labels: 2, corrections: 0 }
    })
    expect(usableCombiner(c, 'laya-a')).toBe(true)
    expect(usableCombiner(c, 'laya-b')).toBe(false)
    expect(usableCombiner({ ...c, features: c.features.slice(1) }, 'laya-a')).toBe(false)
  })
})
