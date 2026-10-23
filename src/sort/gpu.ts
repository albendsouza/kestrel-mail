// Laya on the Mac's GPU: a Python worker (PyTorch MPS through laya-mps, see gpu_worker.py) that
// Kestrel Sort starts when the installed model has a GPU checkpoint. They talk over stdin and
// stdout, one JSON line per message. Anything that goes wrong rejects, and Sort uses the CPU.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import readline from 'readline'

export interface GpuReady {
  device: string
  memory: string
  load_seconds: number
}

interface Pending {
  resolve: (answers: Record<string, unknown>[]) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class GpuLaya {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private exited: Error | null = null

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly ready: GpuReady,
    private readonly requestTimeoutMs: number
  ) {}

  // Starts the worker and waits for it to load the model.
  static start(command: string, args: string[], opts: { readyTimeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<GpuLaya> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.on('error', () => {}) // a dead worker shows up as its exit, which rejects what's pending
      let stderr = ''
      child.stderr.on('data', d => (stderr = (stderr + String(d)).slice(-2000)))
      const fail = (e: Error) => {
        clearTimeout(timer)
        child.kill()
        reject(e)
      }
      const timer = setTimeout(() => fail(new Error('the GPU worker took too long to load the model')), opts.readyTimeoutMs ?? 120_000)
      child.on('error', e => fail(new Error(`couldn't start the GPU worker: ${e.message}`)))
      child.on('exit', code => fail(new Error(`the GPU worker exited (${code}) ${stderr.trim().split('\n').pop() ?? ''}`.trim())))
      const lines = readline.createInterface({ input: child.stdout })
      let gpu: GpuLaya | null = null
      lines.on('line', line => {
        let message: { ready?: boolean; error?: string; id?: number; answers?: Record<string, unknown>[] } & Partial<GpuReady>
        try {
          message = JSON.parse(line)
        } catch {
          return // not one of ours; libraries sometimes print to stdout
        }
        if (!gpu) {
          if (message.ready) {
            clearTimeout(timer)
            child.removeAllListeners('exit')
            child.removeAllListeners('error')
            gpu = new GpuLaya(child, { device: message.device ?? 'mps', memory: message.memory ?? '', load_seconds: message.load_seconds ?? 0 }, opts.requestTimeoutMs ?? 120_000)
            child.on('exit', code => gpu!.stop(new Error(`the GPU worker exited (${code}) ${stderr.trim().split('\n').pop() ?? ''}`.trim())))
            resolve(gpu)
          } else if (message.error) fail(new Error(message.error))
          return
        }
        gpu.settle(message)
      })
    })
  }

  // Answers for each state, shaped like laya-ts's predictBatch answers.
  predict(states: unknown[], questions: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    if (this.exited) return Promise.reject(this.exited)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('the GPU worker took too long to answer'))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, states, questions }) + '\n')
    })
  }

  close(): void {
    this.stop(new Error('the GPU worker was closed'))
    this.child.stdin.end() // the worker exits when its input closes
    this.child.kill()
  }

  private settle(message: { id?: number; error?: string; answers?: Record<string, unknown>[] }): void {
    const p = message.id === undefined ? undefined : this.pending.get(message.id)
    if (!p) return
    this.pending.delete(message.id as number)
    clearTimeout(p.timer)
    if (message.error || !Array.isArray(message.answers)) p.reject(new Error(message.error ?? 'the GPU worker sent no answers'))
    else p.resolve(message.answers)
  }

  private stop(reason: Error): void {
    this.exited ??= reason
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(reason)
    }
    this.pending.clear()
  }
}
