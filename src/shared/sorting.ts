// What Laya is asked about each thread, and how its answers become splits and
// auto labels. The fine-tuning script (scripts/laya/) builds its training rows
// from these same definitions, so a change here means retraining the model.

import type { AutoLabel } from './types'

export const KINDS = ['person', 'pitch', 'marketing', 'newsletter', 'social', 'notification', 'calendar'] as const
export type MailKind = (typeof KINDS)[number]

// What an automated notice is about; only read when the kind is "notification".
export const TOPICS = ['code', 'security', 'money', 'purchase', 'travel', 'other'] as const
export type NoticeTopic = (typeof TOPICS)[number]

export const SORT_QUESTIONS = {
  kind: {
    type: 'choice',
    instructions: 'What kind of email is the one in `body`?',
    criteria: {
      person: 'a personal message written by someone the recipient knows',
      pitch: 'cold outreach from a stranger',
      marketing: 'promotions, sales and offers',
      newsletter: 'newsletter or news digest',
      social: 'social network notification',
      notification: 'automated alert, receipt, order or code',
      calendar: 'calendar invitation'
    }
  },
  needs_reply: {
    type: 'noul',
    instructions: 'Does `body` ask the recipient a question or ask them to do something?',
    criteria: { true: 'asks a question or makes a request', false: 'only shares information' }
  },
  urgent: {
    type: 'noul',
    instructions: 'Is `body` time-sensitive for the recipient: a security alert, login code, payment problem, hard deadline or meeting today?',
    criteria: { true: 'needs attention today', false: 'can wait' }
  },
  topic: {
    type: 'choice',
    instructions: 'If `body` is an automated notice, what is it about?',
    criteria: {
      code: 'a one-time login or verification code',
      security: 'sign-in, password or account security',
      money: 'bank, card, payment, bill, tax or investment',
      purchase: 'order, receipt, shipping or delivery',
      travel: 'flight, train, hotel, cab or trip',
      other: 'any other app or service notice'
    }
  }
} as const

// What Laya reads: what an inbox row shows, plus whether it came through a mailing list.
export interface SortInput {
  from: string // "Name <email>"
  subject: string
  body: string // the snippet
  mailingList: boolean
  signals?: ThreadSignals // for the learned signal layer (signals.ts), never shown to Laya
}

// Gmail's own facts about a thread, which a snippet can't show.
export interface ThreadSignals {
  important: boolean // Gmail flagged it important
  category: string // Gmail's inbox tab: personal, updates, promotions, social or forums
  mailingList: boolean // a List-Unsubscribe or Precedence: bulk header
  undisclosed: boolean // sent to undisclosed recipients
  toOthers: boolean // not to the recipient alone
  multi: boolean // more than one message in the thread
  colleague: boolean // the sender shares the account's own (non-webmail) domain
}

export function sortState(input: SortInput): Record<string, string> {
  return {
    from: input.from,
    subject: input.subject.trim(),
    body: input.body.trim().slice(0, 300),
    mailing_list: input.mailingList ? 'yes' : 'no'
  }
}

export interface SortVerdict {
  kind: MailKind
  confidence: number // calibrated confidence of the kind answer
  needsReply: number // P(true)
  urgent: number // P(true)
  topic?: NoticeTopic // models before laya-email-2 don't answer it
  kindProbs?: Partial<Record<MailKind, number>> // every kind's probability, for the signal layer
}

// Laya's answers to SORT_QUESTIONS as a verdict, the same for the CPU and the GPU runtime.
// The topic counts only when the model was trained on it.
export function verdictFromAnswers(
  answers: {
    kind?: { choice?: string; answer_confidence?: number; probabilities?: Record<string, number> }
    needs_reply?: { noul?: number }
    urgent?: { noul?: number }
    topic?: { choice?: string }
  },
  hasTopics: boolean
): SortVerdict {
  const kind = (KINDS as readonly string[]).includes(answers.kind?.choice ?? '') ? (answers.kind!.choice as MailKind) : 'person'
  const probs = answers.kind?.probabilities
  return {
    kind,
    confidence: answers.kind?.answer_confidence ?? 0,
    needsReply: answers.needs_reply?.noul ?? 0,
    urgent: answers.urgent?.noul ?? 0,
    topic: hasTopics && (TOPICS as readonly string[]).includes(answers.topic?.choice ?? '') ? (answers.topic!.choice as NoticeTopic) : undefined,
    kindProbs: probs ? Object.fromEntries(KINDS.map(k => [k, probs[k] ?? 0])) : undefined
  }
}

// The inbox splits, in tab order. Each sorted thread lands in exactly one.
export const SPLITS = [
  { id: 'important', name: 'Important' },
  { id: 'to-reply', name: 'To reply' },
  { id: 'calendar', name: 'Calendar' },
  { id: 'codes', name: 'Codes' },
  { id: 'updates', name: 'Updates' },
  { id: 'other', name: 'Other' }
] as const
export type SplitId = (typeof SPLITS)[number]['id']

const TOPIC_LABELS: Record<NoticeTopic, AutoLabel> = {
  code: 'Code',
  security: 'Security',
  money: 'Finance',
  purchase: 'Purchase',
  travel: 'Travel',
  other: 'Notification'
}

// The verdict behind a label you chose yourself, so a correction sorts exactly
// as Laya would have if it had said that.
export function verdictFor(label: AutoLabel): SortVerdict {
  const v = (kind: MailKind, needsReply = 0, urgent = 0, topic?: NoticeTopic): SortVerdict => ({ kind, confidence: 1, needsReply, urgent, topic })
  switch (label) {
    case 'To respond':
      return v('person', 1)
    case 'FYI':
      return v('person')
    case 'Calendar':
      return v('calendar')
    case 'Important update':
      return v('notification', 0, 1, 'other')
    case 'Code':
      return v('notification', 0, 1, 'code')
    case 'Security':
      return v('notification', 0, 0, 'security')
    case 'Finance':
      return v('notification', 0, 0, 'money')
    case 'Purchase':
      return v('notification', 0, 0, 'purchase')
    case 'Travel':
      return v('notification', 0, 0, 'travel')
    case 'Notification':
      return v('notification', 0, 0, 'other')
    case 'Pitch':
      return v('pitch')
    case 'Marketing':
      return v('marketing')
    case 'News':
      return v('newsletter')
    case 'Social':
      return v('social')
  }
}

// Superhuman-style splits. People waiting on you get To reply; other mail from
// people and notices that can't wait stay in Important. Invitations and codes get
// their own splits so they never clutter Important; routine notices go to
// Updates, and pitches, promotions, news and social mail to Other.
export function labelsFor(v: SortVerdict): { labels: AutoLabel[]; split: SplitId } {
  switch (v.kind) {
    case 'person':
      return v.needsReply >= 0.5 ? { labels: ['To respond'], split: 'to-reply' } : { labels: ['FYI'], split: 'important' }
    case 'calendar':
      return { labels: ['Calendar'], split: 'calendar' }
    case 'notification': {
      if (v.topic === 'code') return { labels: ['Code'], split: 'codes' }
      const topic = TOPIC_LABELS[v.topic ?? 'other']
      if (v.urgent >= 0.5) return { labels: topic === 'Notification' ? ['Important update'] : ['Important update', topic], split: 'important' }
      return { labels: [topic], split: 'updates' }
    }
    case 'pitch':
      return { labels: ['Pitch'], split: 'other' }
    case 'marketing':
      return { labels: ['Marketing'], split: 'other' }
    case 'newsletter':
      return { labels: ['News'], split: 'other' }
    case 'social':
      return { labels: ['Social'], split: 'other' }
  }
}
