// Fits the learned signal layer (src/shared/signals.ts) for the installed model, from your checked
// labels and the corrections you made with L, and scores it before and after on threads it never
// trained on. npm run laya:fit runs it (scripts/laya/fit.mjs).
//
// Every number comes from Kestrel's own code: the installed model, run the way Kestrel Sort runs it
// (on the CPU when it has an ONNX copy, otherwise on the GPU), the thread's Gmail signals from
// Kestrel's cache, and Kestrel's buckets (labelsFor).

import fs from 'fs'
import os from 'os'
import path from 'path'

import { Agent } from '../../vendor/laya-ts/src/index'
import { GpuLaya } from '../sort/gpu'
import { combine, featuresOf, fitCombiner, sortInputOf, type Combiner } from '../shared/signals'
import { SORT_QUESTIONS, SPLITS, labelsFor, sortState, verdictFor, verdictFromAnswers } from '../shared/sorting'

import type { SortVerdict, SplitId, ThreadSignals } from '../shared/sorting'
import type { AutoLabel, ThreadSummary } from '../shared/types'

export interface FitOptions {
  dataDir: string // Kestrel's data folder: its account list and caches
  modelDir: string // the installed model; combiner.json goes here
  labels: string[] // checked labels: {thread_id, kind, needs_reply, urgent, topic?} per line
  test: string[] // the same format, never trained on, scored before and after
  gpuWorker?: string // src/sort/gpu_worker.py, for a model that only runs on the GPU
  dryRun?: boolean
  log?: (line: string) => void
}

export interface BucketScore {
  n: number
  before: number
  after: number
}

export interface FitReport {
  combiner: Combiner
  written: boolean
  skipped: { notInCache: number; noSignals: number; correctionsNotFound: number; correctionsInTest: number }
  test?: { n: number; before: number; after: number; buckets: Partial<Record<SplitId, BucketScore>> }
}

interface Example {
  thread: ThreadSummary
  accountEmail: string
  bucket: SplitId
}

interface Labelled {
  thread_id: string
  kind: SortVerdict['kind']
  needs_reply: boolean
  urgent: boolean
  topic?: SortVerdict['topic']
}

const readJsonl = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
const emailOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase()
const bucketOfLabel = (r: Labelled): SplitId =>
  labelsFor({ kind: r.kind, confidence: 1, needsReply: r.needs_reply ? 1 : 0, urgent: r.urgent ? 1 : 0, topic: r.topic }).split

// Every account's cache, as the app keeps them: threads by id, and the corrections made with L.
function accounts(dataDir: string) {
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'kestrel.json'), 'utf8')) as { accounts: { id: string; email: string }[] }
  return store.accounts.flatMap(a => {
    const file = path.join(dataDir, 'sync', `cache-${a.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
    if (!fs.existsSync(file)) return []
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as { threads?: ThreadSummary[]; correctionLog?: { from: string; subject: string; label: AutoLabel }[] }
    return [{ email: a.email, threads: new Map((cache.threads ?? []).map(t => [t.id, t])), corrections: cache.correctionLog ?? [] }]
  })
}

// Laya's verdicts for the examples, from the installed model run the way Kestrel Sort runs it.
async function verdictsFor(modelDir: string, inputs: ReturnType<typeof sortInputOf>[], gpuWorker: string | undefined, log: (s: string) => void): Promise<SortVerdict[]> {
  let hasTopics = false
  try {
    hasTopics = 'topic' in JSON.parse(fs.readFileSync(path.join(modelDir, 'questions.json'), 'utf8'))
  } catch {}
  const { topic: _topic, ...base } = SORT_QUESTIONS
  const questions = hasTopics ? SORT_QUESTIONS : base
  const states = inputs.map(sortState)
  type Answers = Parameters<typeof verdictFromAnswers>[0]
  let answers: Answers[] = []
  if (fs.existsSync(path.join(modelDir, 'encoder.onnx'))) {
    log(`running Laya on the CPU for ${states.length} threads`)
    const agent = await Agent.load(modelDir, { numThreads: Math.max(2, Math.floor(os.cpus().length / 2)) })
    for (let i = 0; i < states.length; i += 8) answers.push(...(await agent.predictBatch(states.slice(i, i + 8), questions as never)).map(r => (r as { answers: Answers }).answers))
  } else {
    if (!gpuWorker) throw new Error('This model only runs on the GPU; pass the GPU worker to run it')
    const gpu = JSON.parse(fs.readFileSync(path.join(modelDir, 'gpu.json'), 'utf8')) as { python: string; memory?: string }
    log(`running Laya on the GPU for ${states.length} threads`)
    const worker = await GpuLaya.start(gpu.python, ['-I', gpuWorker, '--model', path.join(modelDir, 'torch'), '--memory', gpu.memory ?? 'reduced'])
    try {
      answers = (await worker.predict(states, questions)) as Answers[]
    } finally {
      worker.close()
    }
  }
  return answers.map(a => verdictFromAnswers(a, hasTopics))
}

export async function fitSignalLayer(o: FitOptions): Promise<FitReport> {
  const log = o.log ?? (() => {})
  const installed = JSON.parse(fs.readFileSync(path.join(o.modelDir, 'manifest.json'), 'utf8')) as { id: string }
  const all = accounts(o.dataDir)
  const find = (id: string) => {
    for (const a of all) {
      const t = a.threads.get(id)
      if (t) return { thread: t, accountEmail: a.email }
    }
    return null
  }
  const skipped = { notInCache: 0, noSignals: 0, correctionsNotFound: 0, correctionsInTest: 0 }
  const fromLabels = (files: string[]): Example[] =>
    files.flatMap(f =>
      (readJsonl(f) as Labelled[]).flatMap(r => {
        const found = find(r.thread_id)
        if (!found) {
          skipped.notInCache++
          return []
        }
        return [{ ...found, bucket: bucketOfLabel(r) }]
      })
    )

  const test = fromLabels(o.test)
  const testIds = new Set(test.map(e => e.thread.id))
  const labelled = fromLabels(o.labels).filter(e => !testIds.has(e.thread.id))
  const labelledIds = new Set(labelled.map(e => e.thread.id))

  // A correction labels its sender; its own thread is the one it was made on (same sender and
  // subject, the most recent). Test threads stay out, and a checked label wins over a correction.
  const corrections: Example[] = []
  for (const a of all) {
    for (const c of a.corrections) {
      const sender = emailOf(c.from)
      const thread = [...a.threads.values()].filter(t => t.from.email.toLowerCase() === sender && t.subject === c.subject).sort((x, y) => y.date - x.date)[0]
      if (!thread) {
        skipped.correctionsNotFound++
        continue
      }
      if (testIds.has(thread.id)) {
        skipped.correctionsInTest++
        continue
      }
      if (labelledIds.has(thread.id)) continue
      corrections.push({ thread, accountEmail: a.email, bucket: labelsFor(verdictFor(c.label)).split })
    }
  }

  const train = [...labelled, ...corrections]
  const inputs = [...train, ...test].map(e => sortInputOf(e.thread, e.accountEmail))
  const verdicts = await verdictsFor(o.modelDir, inputs, o.gpuWorker, log)
  const rows = [...train, ...test].map((e, i) => ({ e, v: verdicts[i], s: inputs[i].signals }))
  const usable = (r: (typeof rows)[number]): r is typeof r & { s: ThreadSignals } => {
    if (r.s) return true
    skipped.noSignals++
    return false
  }
  const trainRows = rows.slice(0, train.length).filter(usable)
  const testRows = rows.slice(train.length).filter(usable)

  log(`fitting on ${trainRows.length} threads: ${labelled.length} checked labels, ${corrections.length} corrections`)
  const combiner = fitCombiner(
    trainRows.map(r => ({ x: featuresOf(r.v, r.s), bucket: r.e.bucket })),
    { forModel: installed.id, trainedOn: { labels: labelled.length, corrections: corrections.length } }
  )

  let testReport: FitReport['test']
  if (testRows.length) {
    const buckets: Partial<Record<SplitId, BucketScore>> = {}
    let before = 0
    let after = 0
    for (const r of testRows) {
      const b = (buckets[r.e.bucket] ??= { n: 0, before: 0, after: 0 })
      b.n++
      if (labelsFor(r.v).split === r.e.bucket) {
        before++
        b.before++
      }
      if (labelsFor(combine(combiner, r.v, r.s)).split === r.e.bucket) {
        after++
        b.after++
      }
    }
    testReport = { n: testRows.length, before, after, buckets: Object.fromEntries(SPLITS.map(s => [s.id, buckets[s.id]]).filter(([, v]) => v)) }
  }

  if (!o.dryRun) fs.writeFileSync(path.join(o.modelDir, 'combiner.json'), JSON.stringify(combiner, null, 2))
  return { combiner, written: !o.dryRun, skipped, test: testReport }
}
