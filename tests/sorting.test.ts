import { describe, expect, it } from 'vitest'

import { labelsFor, sortState } from '../src/shared/sorting'

import type { SortVerdict } from '../src/shared/sorting'

const v = (kind: SortVerdict['kind'], needsReply = 0, urgent = 0): SortVerdict => ({ kind, confidence: 0.9, needsReply, urgent })

const notice = (topic: SortVerdict['topic'], urgent = 0): SortVerdict => ({ ...v('notification', 0, urgent), topic })

describe('labelsFor', () => {
  it('sends people waiting on you to To reply, invitations to Calendar, other people to Important', () => {
    expect(labelsFor(v('person', 0.8))).toEqual({ labels: ['To respond'], split: 'to-reply' })
    expect(labelsFor(v('person', 0.2))).toEqual({ labels: ['FYI'], split: 'important' })
    expect(labelsFor(v('calendar'))).toEqual({ labels: ['Calendar'], split: 'calendar' })
  })

  it('gives codes their own split and keeps urgent notices in Important', () => {
    expect(labelsFor(notice('code', 0.9))).toEqual({ labels: ['Code'], split: 'codes' })
    expect(labelsFor(notice('security', 0.9))).toEqual({ labels: ['Important update', 'Security'], split: 'important' })
    expect(labelsFor(notice('other', 0.9))).toEqual({ labels: ['Important update'], split: 'important' })
  })

  it('files routine notices under Updates by topic', () => {
    expect(labelsFor(notice('money'))).toEqual({ labels: ['Finance'], split: 'updates' })
    expect(labelsFor(notice('purchase'))).toEqual({ labels: ['Purchase'], split: 'updates' })
    expect(labelsFor(notice('travel'))).toEqual({ labels: ['Travel'], split: 'updates' })
    // A model without the topic question still files notices.
    expect(labelsFor(notice(undefined))).toEqual({ labels: ['Notification'], split: 'updates' })
  })

  it('sends pitches, promotions, news and social mail to Other', () => {
    for (const [kind, label] of [['pitch', 'Pitch'], ['marketing', 'Marketing'], ['newsletter', 'News'], ['social', 'Social']] as const) {
      // Urgency and questions in these are the sender's, not yours.
      expect(labelsFor(v(kind, 1, 0.9))).toEqual({ labels: [label], split: 'other' })
    }
  })
})

describe('sortState', () => {
  it('gives Laya what an inbox row shows, trimmed', () => {
    expect(sortState({ from: 'Ana <ana@x.io>', subject: ' Lunch? ', body: 'Friday?'.padEnd(400, '.'), mailingList: false })).toEqual({
      from: 'Ana <ana@x.io>',
      subject: 'Lunch?',
      body: 'Friday?'.padEnd(300, '.'),
      mailing_list: 'no'
    })
  })
})
