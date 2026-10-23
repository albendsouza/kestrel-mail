// How the sync engine asks Kestrel Sort (src/sort/host.ts) to sort threads.

import type { SortInput, SortVerdict } from '../shared/sorting'

export interface Sorter {
  // Verdicts in input order, and which model made them (asking with no items just
  // reports the model). Throws SortUnavailable when there's no model to run.
  sort(items: SortInput[]): Promise<SortResult>
}

export interface SortResult {
  model: string
  verdicts: SortVerdict[]
}

export class SortUnavailable extends Error {}

// Messages on the port between the sync process and Kestrel Sort.
export type SortRequest = { id: number; items: SortInput[] }
export type SortResponse = ({ id: number } & SortResult) | { id: number; error: string; unavailable: boolean }

// A backstop only: a busy Mac (or a training run) can make one batch take minutes,
// and that's slow, not stuck. Sort stopping is noticed from the port closing.
const TIMEOUT_MS = 10 * 60_000

// The sync process's end of that port. One request at a time keeps Sort's memory flat.
export class PortSorter implements Sorter {
  private next = 1
  private waiting = new Map<number, { resolve: (v: SortResult) => void; reject: (e: Error) => void }>()

  constructor(private readonly port: { postMessage(m: unknown): void; on(e: 'message' | 'close', l: (m: { data: unknown }) => void): void }) {
    // Sort exited or crashed: nothing waiting will be answered, so let the queue retry now.
    port.on('close', () => {
      for (const w of this.waiting.values()) w.reject(new Error('Kestrel Sort stopped'))
      this.waiting.clear()
    })
    port.on('message', ({ data }) => {
      const res = data as SortResponse
      const w = this.waiting.get(res.id)
      if (!w) return
      this.waiting.delete(res.id)
      if ('verdicts' in res) w.resolve({ model: res.model, verdicts: res.verdicts })
      else w.reject(res.unavailable ? new SortUnavailable(res.error) : new Error(res.error))
    })
  }

  sort(items: SortInput[]): Promise<SortResult> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      // If Sort dies mid-request the reply never comes; give up so the queue can retry.
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('Kestrel Sort did not answer'))
      }, TIMEOUT_MS)
      this.waiting.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v)),
        reject: e => (clearTimeout(timer), reject(e))
      })
      this.port.postMessage({ id, items } satisfies SortRequest)
    })
  }
}
