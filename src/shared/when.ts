// Turns what people type in the reminder picker ("2d", "tomorrow 3pm", "mon")
// into a time, and offers the usual presets. Dates without a time mean 8 AM,
// the start of a working day. Everything is in local time.

const DAY = 86_400_000
const MORNING = 8
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

const at = (d: Date, hour: number, minute = 0) => {
  const out = new Date(d)
  out.setHours(hour, minute, 0, 0)
  return out
}
const addDays = (d: Date, n: number) => {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

// "9", "9am", "9:30", "9:30pm", "21:00" → [hour, minute]
function parseTime(text: string): [number, number] | null {
  const m = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  const meridiem = m[3]?.[0]
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null
  if (meridiem === 'p' && hour < 12) hour += 12
  if (meridiem === 'a' && hour === 12) hour = 0
  // A bare small number like "3" most likely means the afternoon.
  if (!meridiem && !m[2] && hour >= 1 && hour <= 6) hour += 12
  return [hour, minute]
}

const dayIndex = (word: string) => DAYS.findIndex(d => word.length >= 3 && d.startsWith(word))
const monthIndex = (word: string) => MONTHS.findIndex(m => word.length >= 3 && m.startsWith(word))

// The next date matching `word` ("tomorrow", "mon", "oct 30", "10/30"), or null.
function parseDay(word: string, now: Date): Date | null {
  if (word === 'today') return now
  if (word === 'tomorrow' || word === 'tmrw' || word === 'tom') return addDays(now, 1)
  if (word === 'weekend' || word === 'this weekend') {
    const ahead = (6 - now.getDay() + 7) % 7 || (now.getDay() === 6 ? 7 : 0)
    return addDays(now, ahead)
  }
  if (word === 'next week') return addDays(now, ((1 - now.getDay() + 7) % 7) || 7)
  if (word === 'next month') return new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const weekday = dayIndex(word.replace(/^next /, ''))
  if (weekday >= 0) {
    const ahead = (weekday - now.getDay() + 7) % 7 || 7
    return addDays(now, ahead + (word.startsWith('next ') && ahead < 7 ? 7 : 0))
  }
  const named = word.match(/^([a-z]+)\s+(\d{1,2})$/) ?? word.match(/^(\d{1,2})\s+([a-z]+)$/)
  if (named) {
    const [monthWord, dayText] = /^\d/.test(named[1]) ? [named[2], named[1]] : [named[1], named[2]]
    const month = monthIndex(monthWord)
    if (month < 0) return null
    return nextDate(now, month, Number(dayText))
  }
  const numeric = word.match(/^(\d{1,2})\/(\d{1,2})$/)
  if (numeric) return nextDate(now, Number(numeric[1]) - 1, Number(numeric[2]))
  return null
}

// This year's date if it's still ahead, otherwise next year's.
function nextDate(now: Date, month: number, day: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null
  const thisYear = new Date(now.getFullYear(), month, day, MORNING)
  if (thisYear.getMonth() !== month) return null
  return thisYear.getTime() > now.getTime() ? thisYear : new Date(now.getFullYear() + 1, month, day, MORNING)
}

export function parseWhen(input: string, now: Date = new Date()): Date | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^(in|on|at) /, '')
  if (!text) return null

  // Durations: "2h", "30m", "3d", "1w", "2 hours", "in 3 days"
  const span = text.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?)$/)
  if (span) {
    const n = Number(span[1])
    const unit = span[2][0]
    if (unit === 'm') return new Date(now.getTime() + n * 60_000)
    if (unit === 'h') return new Date(now.getTime() + n * 3_600_000)
    // Whole days and weeks land on that morning, not this exact minute.
    return at(addDays(now, unit === 'd' ? n : 7 * n), MORNING)
  }

  if (text === 'later' || text === 'later today') return new Date(now.getTime() + 3 * 3_600_000)
  if (text === 'tonight' || text === 'this evening') return at(now, 19)
  if (text === 'this afternoon') return at(now, 14)

  // A bare time today, or tomorrow when it has passed: "4pm", "16:30"
  const timeOnly = parseTime(text)
  if (timeOnly) {
    const today = at(now, ...timeOnly)
    return today.getTime() > now.getTime() ? today : addDays(today, 1)
  }

  // A day on its own first, so "oct 30" isn't read as "oct" at 30 o'clock.
  const wholeDay = parseDay(text, now)
  if (wholeDay) {
    const morning = at(wholeDay, MORNING)
    return morning.getTime() > now.getTime() ? morning : null
  }

  // A day followed by a time: "tomorrow 3pm", "mon 9am", "oct 30 2pm"
  const parts = text.match(/^(.*?)(?:\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?))?$/)
  if (!parts) return null
  const day = parseDay(parts[1], now)
  if (!day) return null
  const time = parts[2] ? parseTime(parts[2]) : null
  if (parts[2] && !time) return null
  const result = time ? at(day, ...time) : at(day, MORNING)
  return result.getTime() > now.getTime() ? result : null
}

export interface WhenPreset {
  label: string
  at: Date
}

export function presets(now: Date = new Date()): WhenPreset[] {
  const list: WhenPreset[] = [
    { label: 'Later today', at: new Date(now.getTime() + 3 * 3_600_000) },
    { label: 'Tomorrow', at: parseWhen('tomorrow', now)! },
    { label: 'This weekend', at: parseWhen('weekend', now)! },
    { label: 'Next week', at: parseWhen('next week', now)! }
  ]
  // "Later today" after 8 PM is really tonight's small hours; tomorrow covers it.
  return list.filter((p, i) => i !== 0 || now.getHours() < 20)
}

// "Today, 4:00 PM", "Tomorrow, 8:00 AM", "Sat, 8:00 AM", "Oct 30, 8:00 AM"
export function describeWhen(when: Date | number, now: Date = new Date()): string {
  const d = new Date(when)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((at(d, 0).getTime() - at(now, 0).getTime()) / DAY)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Tomorrow, ${time}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString([], { weekday: 'short' })}, ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })}, ${time}`
}
