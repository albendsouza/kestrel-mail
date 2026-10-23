// Talks to this tab's account engine over the MessagePort handed in by the
// preload. If the sync process restarts, the main process sends a new port and
// requests resume on it.

import type { EngineEvent, EventEnvelope, RequestEnvelope, ResponseEnvelope, TabRequest } from '../../shared/types'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; request: TabRequest }

export class EngineClient {
  private port: MessagePort | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Set<(e: EngineEvent) => void>()
  private waiting: (() => void)[] = []

  constructor() {
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin) return
      if (event.data?.type !== 'kestrel:port' || !event.ports[0]) return
      this.attach(event.ports[0])
    })
  }

  private attach(port: MessagePort): void {
    this.port?.close()
    this.port = port
    port.onmessage = ({ data }) => {
      if ('event' in data) {
        for (const l of this.listeners) l((data as EventEnvelope).event)
        return
      }
      const res = data as ResponseEnvelope
      const p = this.pending.get(res.id)
      if (!p) return
      this.pending.delete(res.id)
      if (res.ok) p.resolve(res.result)
      else p.reject(new Error(res.error))
    }
    port.start()
    // Requests in flight on a dead port are replayed on the new one.
    for (const [id, p] of this.pending) port.postMessage({ id, request: p.request } satisfies RequestEnvelope)
    this.waiting.splice(0).forEach(fn => fn())
  }

  ready(): Promise<void> {
    return this.port ? Promise.resolve() : new Promise(resolve => this.waiting.push(resolve))
  }

  request<T>(request: TabRequest): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, request })
      this.port?.postMessage({ id, request } satisfies RequestEnvelope)
    })
  }

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
