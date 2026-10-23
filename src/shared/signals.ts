// The learned signal layer. Laya reads a 300-character snippet; Gmail already knows whether it
// flagged a thread important, which tab it put it in, whether it came through a mailing list and
// who it went to. A small logistic regression, fitted on your checked labels and L corrections
// (npm run laya:fit), weighs Laya's answers against those signals and picks the bucket.
// Kestrel Sort applies it when the model folder has a combiner.json fitted for that model.

import { KINDS, SPLITS, labelsFor } from './sorting'

import type { MailKind, SortInput, SortVerdict, SplitId, ThreadSignals } from './sorting'
import type { ThreadSummary } from './types'

// Domains many unrelated people share, so the same domain doesn't make someone a colleague.
const WEBMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com'])
const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? ''

// Gmail's facts about a thread, or undefined when the provider gives none (no inbox category,
// as in demo mode or with Gmail's tabs turned off), in which case Laya decides alone.
export function signalsOf(t: ThreadSummary, accountEmail: string): ThreadSignals | undefined {
  const category = t.labels.find(l => l.startsWith('CATEGORY_'))?.slice('CATEGORY_'.length).toLowerCase()
  if (!category) return undefined
  const to = t.to ?? []
  const undisclosed = to.some(x => /undisclosed/i.test(x))
  const domain = domainOf(t.from.email)
  return {
    important: t.labels.includes('IMPORTANT'),
    category,
    mailingList: t.listUnsubscribe || t.bulk,
    undisclosed,
    toOthers: undisclosed || to.length > 1,
    multi: t.messageCount > 1,
    colleague: !!domain && domain === domainOf(accountEmail) && !WEBMAIL.has(domain)
  }
}

// What Kestrel Sort gets for a thread: what Laya reads, plus the signals for the combiner.
export function sortInputOf(t: ThreadSummary, accountEmail: string): SortInput {
  return {
    from: t.from.name && t.from.name !== t.from.email ? `${t.from.name} <${t.from.email}>` : t.from.email,
    subject: t.subject,
    body: t.snippet,
    mailingList: t.listUnsubscribe || t.bulk,
    signals: signalsOf(t, accountEmail)
  }
}

export const FEATURES = [
  'bias',
  ...KINDS.map(k => `laya.${k}`),
  'laya.needs_reply',
  'laya.urgent',
  'gmail.mailing_list',
  'gmail.promotions',
  'gmail.updates',
  'gmail.personal',
  'gmail.undisclosed',
  'gmail.to_others',
  'gmail.important',
  'thread.multi',
  'sender.colleague'
]
const BUCKETS: SplitId[] = SPLITS.map(s => s.id)

export function featuresOf(v: SortVerdict, s: ThreadSignals): number[] {
  const p: Partial<Record<MailKind, number>> = v.kindProbs ?? { [v.kind]: 1 }
  const on = (b: boolean) => (b ? 1 : 0)
  return [
    1,
    ...KINDS.map(k => p[k] ?? 0),
    v.needsReply,
    v.urgent,
    on(s.mailingList),
    on(s.category === 'promotions'),
    on(s.category === 'updates'),
    on(s.category === 'personal'),
    on(s.undisclosed),
    on(s.toOthers),
    on(s.important),
    on(s.multi),
    on(s.colleague)
  ]
}

export interface Combiner {
  id: string
  forModel: string // the model id whose answers it was fitted on
  features: string[]
  buckets: SplitId[]
  weights: number[][] // [feature][bucket]
  l2: number
  trainedOn: { labels: number; corrections: number }
  crossValidated: number // accuracy in 5-fold cross-validation on the training examples
  fitted: string
}

// A combiner Sort can trust for this model: fitted on its answers, with today's features.
export function usableCombiner(c: Combiner | null | undefined, modelId: string): c is Combiner {
  return !!c && c.forModel === modelId && c.features.join() === FEATURES.join() && c.buckets.join() === BUCKETS.join()
}

export function predictBucket(c: Combiner, x: number[]): SplitId {
  let best = 0
  let bestScore = -Infinity
  for (let b = 0; b < c.buckets.length; b++) {
    let score = 0
    for (let f = 0; f < x.length; f++) score += x[f] * c.weights[f][b]
    if (score > bestScore) [best, bestScore] = [b, score]
  }
  return c.buckets[best]
}

// The verdict that lands in a bucket, changed as little as possible: auto labels follow it.
// A changed kind carries Laya's own probability for it as its confidence, so the layer never
// makes Kestrel file away mail Laya itself wasn't sure was marketing.
export function verdictForBucket(v: SortVerdict, bucket: SplitId): SortVerdict {
  if (labelsFor(v).split === bucket) return v
  const moved = moveTo(v, bucket)
  return moved.kind === v.kind ? moved : { ...moved, confidence: v.kindProbs?.[moved.kind] ?? 0 }
}

function moveTo(v: SortVerdict, bucket: SplitId): SortVerdict {
  const p = v.kindProbs ?? {}
  const likeliest = (kinds: MailKind[]) => kinds.reduce((a, b) => ((p[b] ?? 0) > (p[a] ?? 0) ? b : a))
  switch (bucket) {
    case 'to-reply':
      return { ...v, kind: 'person', needsReply: 1 }
    case 'important':
      return v.kind === 'notification' ? { ...v, urgent: 1, topic: v.topic === 'code' ? 'other' : v.topic } : { ...v, kind: 'person', needsReply: 0 }
    case 'calendar':
      return { ...v, kind: 'calendar' }
    case 'codes':
      return { ...v, kind: 'notification', topic: 'code' }
    case 'updates':
      return { ...v, kind: 'notification', urgent: 0, topic: v.topic === 'code' ? 'other' : v.topic }
    case 'other':
      return { ...v, kind: likeliest(['pitch', 'marketing', 'newsletter', 'social']) }
  }
}

export function combine(c: Combiner | null, v: SortVerdict, s: ThreadSignals | undefined): SortVerdict {
  if (!c || !s) return v
  return verdictForBucket(v, predictBucket(c, featuresOf(v, s)))
}

// ---------- fitting (npm run laya:fit) ----------

// Multinomial logistic regression by gradient descent, with L2 on everything but the bias.
export function fitWeights(xs: number[][], ys: number[], l2: number, buckets = BUCKETS.length, steps = 3000, rate = 0.5): number[][] {
  const d = xs[0].length
  const W = Array.from({ length: d }, () => new Array<number>(buckets).fill(0))
  const grad = Array.from({ length: d }, () => new Array<number>(buckets).fill(0))
  for (let step = 0; step < steps; step++) {
    for (const row of grad) row.fill(0)
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]
      const z = new Array<number>(buckets).fill(0)
      for (let f = 0; f < d; f++) for (let b = 0; b < buckets; b++) z[b] += x[f] * W[f][b]
      const top = Math.max(...z)
      const e = z.map(v => Math.exp(v - top))
      const sum = e.reduce((s, v) => s + v, 0)
      for (let b = 0; b < buckets; b++) {
        const err = e[b] / sum - (ys[i] === b ? 1 : 0)
        for (let f = 0; f < d; f++) grad[f][b] += (x[f] * err) / xs.length
      }
    }
    for (let f = 0; f < d; f++) for (let b = 0; b < buckets; b++) W[f][b] -= rate * (grad[f][b] + (f === 0 ? 0 : l2 * W[f][b]))
  }
  return W
}

// A seeded shuffle, so a fit is repeatable.
function shuffled(n: number, seed: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  let s = seed >>> 0 || 1
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

// Picks L2 by 5-fold cross-validation repeated over 3 shuffles, then fits on everything.
export function fitCombiner(examples: { x: number[]; bucket: SplitId }[], meta: Pick<Combiner, 'forModel' | 'trainedOn'>): Combiner {
  const xs = examples.map(e => e.x)
  const ys = examples.map(e => BUCKETS.indexOf(e.bucket))
  let best = { l2: 0.01, accuracy: -1 }
  for (const l2 of [0.003, 0.01, 0.03]) {
    let right = 0
    let total = 0
    for (const seed of [1, 2, 3]) {
      const order = shuffled(xs.length, seed)
      for (let k = 0; k < 5; k++) {
        const held = new Set(order.filter((_, i) => i % 5 === k))
        const train = order.filter(i => !held.has(i))
        const W = fitWeights(
          train.map(i => xs[i]),
          train.map(i => ys[i]),
          l2
        )
        const c = { weights: W, buckets: BUCKETS } as Combiner
        for (const i of held) {
          total++
          if (predictBucket(c, xs[i]) === BUCKETS[ys[i]]) right++
        }
      }
    }
    if (right / total > best.accuracy) best = { l2, accuracy: right / total }
  }
  const weights = fitWeights(xs, ys, best.l2)
  const id = hashOf(JSON.stringify(weights)).slice(0, 8)
  return { id, ...meta, features: FEATURES, buckets: BUCKETS, weights, l2: best.l2, crossValidated: Math.round(1000 * best.accuracy) / 10, fitted: new Date().toISOString() }
}

// FNV-1a, enough to tell one fit from another.
function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
