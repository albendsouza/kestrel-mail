import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { GpuLaya } from '../src/sort/gpu'

// A stand-in for gpu_worker.py, in Node, speaking the same JSON-lines protocol.
const WORKER = `
const mode = process.argv[2]
if (mode === 'broken') {
  console.log(JSON.stringify({ error: 'RuntimeError: this Mac has no GPU' }))
  process.exit(1)
}
if (mode === 'silent') setInterval(() => {}, 1000)
else {
  console.log('a library printing to stdout')
  console.log(JSON.stringify({ ready: true, device: 'mps', memory: 'reduced', load_seconds: 1.5 }))
}
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line)
  if (mode === 'crash') process.exit(3)
  if (!r.states.length) return console.log(JSON.stringify({ id: r.id, error: 'ValueError: no states' }))
  console.log(JSON.stringify({ id: r.id, answers: r.states.map(s => ({ kind: { choice: s.subject, answer_confidence: 0.9 } })) }))
})
`
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kestrel-gpu-')), 'worker.cjs')
fs.writeFileSync(file, WORKER)
const open: GpuLaya[] = []
const start = async (mode = 'ok', opts = {}) => {
  const gpu = await GpuLaya.start(process.execPath, [file, mode], opts)
  open.push(gpu)
  return gpu
}

afterEach(() => open.splice(0).forEach(g => g.close()))

describe('GPU worker', () => {
  it('waits for the model, ignores stray output, and answers each email in order', async () => {
    const gpu = await start()
    expect(gpu.ready).toEqual({ device: 'mps', memory: 'reduced', load_seconds: 1.5 })
    const answers = await gpu.predict([{ subject: 'person' }, { subject: 'pitch' }], {})
    expect(answers.map(a => (a as { kind: { choice: string } }).kind.choice)).toEqual(['person', 'pitch'])
  })

  it("rejects when the worker can't load the model, so Sort uses the CPU", async () => {
    await expect(start('broken')).rejects.toThrow('this Mac has no GPU')
  })

  it('rejects when the model takes too long to load', async () => {
    await expect(start('silent', { readyTimeoutMs: 200 })).rejects.toThrow('took too long')
  })

  it('fails only the request that went wrong', async () => {
    const gpu = await start()
    await expect(gpu.predict([], {})).rejects.toThrow('no states')
    await expect(gpu.predict([{ subject: 'calendar' }], {})).resolves.toHaveLength(1)
  })

  it('rejects what is pending, and everything after, when the worker dies', async () => {
    const gpu = await start('crash')
    await expect(gpu.predict([{ subject: 'person' }], {})).rejects.toThrow('exited (3)')
    await expect(gpu.predict([{ subject: 'person' }], {})).rejects.toThrow('exited (3)')
  })
})
