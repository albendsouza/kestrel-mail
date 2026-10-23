import { describe, expect, it } from 'vitest'

import { describeWhen, parseWhen, presets } from '../src/shared/when'

// Thursday 22 October 2026, 10:15 local time.
const now = new Date(2026, 9, 22, 10, 15)
const local = (y: number, m: number, d: number, h = 8, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const when = (text: string) => parseWhen(text, now)?.getTime() ?? null

describe('parseWhen', () => {
  it('reads durations', () => {
    expect(when('2h')).toBe(now.getTime() + 2 * 3_600_000)
    expect(when('in 30 minutes')).toBe(now.getTime() + 30 * 60_000)
    expect(when('3d')).toBe(local(2026, 10, 25))
    expect(when('1w')).toBe(local(2026, 10, 29))
  })

  it('reads named days, defaulting to 8 AM', () => {
    expect(when('tomorrow')).toBe(local(2026, 10, 23))
    expect(when('tomorrow 3pm')).toBe(local(2026, 10, 23, 15))
    expect(when('fri')).toBe(local(2026, 10, 23))
    expect(when('monday 9:30am')).toBe(local(2026, 10, 26, 9, 30))
    // Today is Thursday, so "thu" means next week.
    expect(when('thu')).toBe(local(2026, 10, 29))
    expect(when('next week')).toBe(local(2026, 10, 26))
    expect(when('this weekend')).toBe(local(2026, 10, 24))
  })

  it('reads times of day, rolling to tomorrow when passed', () => {
    expect(when('4pm')).toBe(local(2026, 10, 22, 16))
    expect(when('9am')).toBe(local(2026, 10, 23, 9))
    expect(when('3')).toBe(local(2026, 10, 22, 15))
    expect(when('16:30')).toBe(local(2026, 10, 22, 16, 30))
  })

  it('reads calendar dates, moving to next year when passed', () => {
    expect(when('oct 30')).toBe(local(2026, 10, 30))
    expect(when('30 oct 2pm')).toBe(local(2026, 10, 30, 14))
    expect(when('11/3')).toBe(local(2026, 11, 3))
    expect(when('jan 5')).toBe(local(2027, 1, 5))
  })

  it('rejects what it cannot read', () => {
    for (const text of ['', 'someday', 'feb 30', '25pm', 'tomorrow at noonish', 'yesterday']) expect(when(text)).toBeNull()
  })
})

describe('presets and descriptions', () => {
  it('offers later today until 8 PM', () => {
    expect(presets(now).map(p => p.label)).toEqual(['Later today', 'Tomorrow', 'This weekend', 'Next week'])
    expect(presets(new Date(2026, 9, 22, 21)).map(p => p.label)).toEqual(['Tomorrow', 'This weekend', 'Next week'])
  })

  it('describes a time relative to now', () => {
    expect(describeWhen(local(2026, 10, 23), now)).toMatch(/^Tomorrow, 8:00/)
    expect(describeWhen(local(2026, 10, 25), now)).toMatch(/^Sun, 8:00/)
    expect(describeWhen(local(2026, 11, 3), now)).toMatch(/^Nov 3, 8:00/)
  })
})
