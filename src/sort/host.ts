// Entry point of Kestrel Sort, the utility process that runs Laya. The sync
// process sends it threads over a MessagePort and gets back a verdict for each.
// It loads the model on first use and exits after a few idle minutes to hand
// the memory back; the main process starts a fresh one, which stays small until needed.
// When the installed model has a GPU checkpoint, Laya runs on the Mac's GPU through a
// Python worker (gpu.ts); otherwise, or if that fails, on the CPU with ONNX Runtime.

import fs from 'fs'
import os from 'os'
import path from 'path'

import { Agent } from '../../vendor/laya-ts/src/index'
import { combine, usableCombiner, type Combiner } from '../shared/signals'
import { SORT_QUESTIONS, sortState, verdictFromAnswers } from '../shared/sorting'
import { GpuLaya } from './gpu'

import type { SortRequest, SortResponse } from '../sync/sorter'

export type SortCommand = { type: 'init'; modelDir: string } | { type: 'connect' } // connect carries a MessagePort

const IDLE_EXIT_MS = 5 * 60_000
// Laya reads a few threads per forward pass; bigger batches only add memory.
const PASS = 4

const parentPort = process.parentPort
if (!parentPort) throw new Error('Kestrel Sort must run in an Electron utility process')

// Sorting is background work: let the windows and sync have the CPU first.
try {
  os.setPriority(10)
} catch {
  // Not allowed everywhere; sorting still works at normal priority.
}

let modelDir = ''
let agent: Promise<Agent> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

class ModelMissing extends Error {}

const NOT_INSTALLED = () => `Laya's model isn't installed in ${modelDir}. Run npm run laya:setup on a Mac with Apple silicon, or see docs/smart-inbox.md.`
// laya:setup installs the GPU checkpoint alone; an ONNX export adds the CPU copy.
const hasCpuModel = () => fs.existsSync(path.join(modelDir, 'encoder.onnx'))
const hasGpuModel = () => fs.existsSync(path.join(modelDir, 'torch', 'model.safetensors'))

function load(): Promise<Agent> {
  if (!agent) {
    if (!hasCpuModel()) {
      return Promise.reject(
        new ModelMissing(hasGpuModel() ? `Laya can't run on the GPU and ${modelDir} has no CPU copy of the model (see docs/smart-inbox.md).` : NOT_INSTALLED())
      )
    }
    // Half the cores: sorting a big inbox shouldn't make the Mac feel busy.
    agent = Agent.load(modelDir, { numThreads: Math.max(2, Math.floor(os.cpus().length / 2)) })
    agent.catch(() => (agent = null))
  }
  return agent
}

// The GPU worker, when the model folder has a checkpoint for it (laya:install --torch) and a
// gpu.json naming laya-mps's Python. KESTREL_LAYA_DEVICE=cpu keeps sorting on the CPU.
let gpu: Promise<GpuLaya | null> | null = null
let gpuWorker: GpuLaya | null = null

function loadGpu(): Promise<GpuLaya | null> {
  if (!gpu) {
    gpu = (async () => {
      const torchDir = path.join(modelDir, 'torch')
      if (process.env.KESTREL_LAYA_DEVICE === 'cpu' || !hasGpuModel()) return null
      let config: { python?: string; memory?: string }
      try {
        config = JSON.parse(fs.readFileSync(path.join(modelDir, 'gpu.json'), 'utf8'))
      } catch {
        return null
      }
      if (!config.python) return null
      // Python can't read inside the asar archive; release builds unpack the worker beside it.
      const worker = path.join(__dirname, 'gpu_worker.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
      try {
        gpuWorker = await GpuLaya.start(config.python, ['-I', worker, '--model', torchDir, '--memory', config.memory ?? 'reduced'])
        console.log(`Kestrel Sort: Laya on the GPU (${gpuWorker.ready.memory} memory, loaded in ${gpuWorker.ready.load_seconds} s)`)
        return gpuWorker
      } catch (e) {
        console.error(`Kestrel Sort: the GPU isn't available, sorting on the CPU (${e instanceof Error ? e.message : e})`)
        return null
      }
    })()
  }
  return gpu
}

// Answers from the GPU, or null to use the CPU. A failed request turns the GPU off until Sort restarts.
async function onGpu(states: unknown[], questions: Record<string, unknown>): Promise<Answers[] | null> {
  const worker = await loadGpu()
  if (!worker) return null
  try {
    return (await worker.predict(states, questions)) as Answers[]
  } catch (e) {
    console.error(`Kestrel Sort: the GPU failed, sorting on the CPU from now on (${e instanceof Error ? e.message : e})`)
    worker.close()
    gpuWorker = null
    gpu = Promise.resolve(null)
    return null
  }
}

async function onCpu(states: unknown[], questions: Record<string, unknown>): Promise<Answers[]> {
  const laya = await load()
  const answers: Answers[] = []
  for (let i = 0; i < states.length; i += PASS) {
    const results = await laya.predictBatch(states.slice(i, i + PASS), questions as never)
    for (const r of results) answers.push((r as { answers: Answers }).answers)
  }
  return answers
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    gpuWorker?.close()
    process.exit(0)
  }, IDLE_EXIT_MS)
}

type Answers = Parameters<typeof verdictFromAnswers>[0]

// Whether the installed model was trained on the topic question (its questions.json says).
let hasTopics = false
function readQuestions(): void {
  try {
    hasTopics = 'topic' in (JSON.parse(fs.readFileSync(path.join(modelDir, 'questions.json'), 'utf8')) as object)
  } catch {
    hasTopics = false
  }
}

// The installed model's name, from the manifest npm run laya:install writes.
function installedId(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(modelDir, 'manifest.json'), 'utf8')) as { id: string }).id
  } catch {
    return 'unknown'
  }
}

// The learned signal layer fitted for this model (npm run laya:fit), if there is one.
function readCombiner(): Combiner | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(modelDir, 'combiner.json'), 'utf8')) as Combiner
    return usableCombiner(c, installedId()) ? c : null
  } catch {
    return null
  }
}

// What verdicts are stamped with: the model, and the signal layer when there is one, so fitting
// a new layer re-sorts the inbox just as installing a new model does.
function modelId(combiner = readCombiner()): string {
  return combiner ? `${installedId()}+signals-${combiner.id}` : installedId()
}

async function sort(req: SortRequest): Promise<SortResponse> {
  try {
    if (!hasCpuModel() && !hasGpuModel()) throw new ModelMissing(NOT_INSTALLED())
    if (!req.items.length) return { id: req.id, model: modelId(), verdicts: [] }
    readQuestions()
    const { topic: _topic, ...base } = SORT_QUESTIONS
    const questions = hasTopics ? SORT_QUESTIONS : base
    const states = req.items.map(sortState)
    // Both runtimes give the same answers (checked to 1e-4 on 200 real emails), so verdicts
    // keep the model's name either way and nothing is re-sorted when the runtime changes.
    const answers = (await onGpu(states, questions)) ?? (await onCpu(states, questions))
    const combiner = readCombiner()
    const verdicts = answers.map((a, i) => combine(combiner, verdictFromAnswers(a, hasTopics), req.items[i].signals))
    return { id: req.id, model: modelId(combiner), verdicts }
  } catch (e) {
    return { id: req.id, error: e instanceof Error ? e.message : String(e), unavailable: e instanceof ModelMissing }
  } finally {
    touch()
  }
}

parentPort.on('message', ({ data, ports }) => {
  const cmd = data as SortCommand
  if (cmd.type === 'init') {
    modelDir = cmd.modelDir
    touch()
  }
  if (cmd.type === 'connect' && ports[0]) {
    const port = ports[0]
    // One request at a time, in order: the sync process waits for each anyway.
    let queue = Promise.resolve()
    port.on('message', ({ data }) => {
      queue = queue.then(async () => port.postMessage(await sort(data as SortRequest)))
    })
    port.start()
  }
})
