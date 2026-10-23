// Split inbox, Superhuman-style. Laya decides each thread's split
// (src/shared/sorting.ts) and the engine stores it on the thread; mail Laya
// hasn't sorted yet shows in Important, so nothing new is hidden.

import { SPLITS } from '../shared/sorting'

import type { SplitRule, ThreadSummary } from '../shared/types'

export const IMPORTANT_SPLIT = 'important'

export const DEFAULT_SPLITS: SplitRule[] = SPLITS.map(s => ({ id: s.id, name: s.name }))

export function splitFor(thread: ThreadSummary): string {
  return thread.split ?? IMPORTANT_SPLIT
}

export function splitOrder(rules: SplitRule[]): SplitRule[] {
  return rules
}

export function inSplit(thread: ThreadSummary, split: string): boolean {
  if (split === 'starred') return thread.starred
  if (split === 'all') return true
  return splitFor(thread) === split
}
