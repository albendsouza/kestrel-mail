// Entry point of Kestrel Sort, the utility process that runs Laya. The sync
// process sends it threads over a MessagePort and gets back a verdict for each.
// It loads the model on first use and exits after a few idle minutes to hand
// the memory back; the main process starts a fresh one, which stays small until needed.

import fs from 'fs'
import os from 'os'
import path from 'path'

import { Agent } from '../../vendor/laya-ts/src/index'
import { KINDS, SORT_QUESTIONS, TOPICS, sortState } from '../shared/sorting'

import type { MailKind, NoticeTopic, SortVerdict } from '../shared/sorting'
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

function load(): Promise<Agent> {
  if (!agent) {
    if (!fs.existsSync(path.join(modelDir, 'encoder.onnx'))) {
      return Promise.reject(new ModelMissing(`Laya's model isn't installed in ${modelDir} (run npm run laya:install).`))
    }
    // Half the cores: sorting a big inbox shouldn't make the Mac feel busy.
    agent = Agent.load(modelDir, { numThreads: Math.max(2, Math.floor(os.cpus().length / 2)) })
    agent.catch(() => (agent = null))
  }
  return agent
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS)
}

interface Answers {
  kind?: { choice?: string; answer_confidence?: number }
  needs_reply?: { noul?: number }
  urgent?: { noul?: number }
  topic?: { choice?: string }
}

function verdictOf(answers: Answers): SortVerdict {
  const kind = (KINDS as readonly string[]).includes(answers.kind?.choice ?? '') ? (answers.kind!.choice as MailKind) : 'person'
  return {
    kind,
    confidence: answers.kind?.answer_confidence ?? 0,
    needsReply: answers.needs_reply?.noul ?? 0,
    urgent: answers.urgent?.noul ?? 0,
    // Only a model trained on topics answers this one meaningfully (see readQuestions).
    topic: hasTopics && (TOPICS as readonly string[]).includes(answers.topic?.choice ?? '') ? (answers.topic!.choice as NoticeTopic) : undefined
  }
}

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
function modelId(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(modelDir, 'manifest.json'), 'utf8')) as { id: string }).id
  } catch {
    return 'unknown'
  }
}

async function sort(req: SortRequest): Promise<SortResponse> {
  try {
    if (!fs.existsSync(path.join(modelDir, 'encoder.onnx'))) throw new ModelMissing(`Laya's model isn't installed in ${modelDir} (run npm run laya:install).`)
    if (!req.items.length) return { id: req.id, model: modelId(), verdicts: [] }
    const laya = await load()
    readQuestions()
    const { topic: _topic, ...base } = SORT_QUESTIONS
    const questions = hasTopics ? SORT_QUESTIONS : base
    const verdicts: SortVerdict[] = []
    for (let i = 0; i < req.items.length; i += PASS) {
      const states = req.items.slice(i, i + PASS).map(sortState)
      const results = await laya.predictBatch(states, questions as never)
      for (const r of results) verdicts.push(verdictOf((r as { answers: Answers }).answers))
    }
    return { id: req.id, model: modelId(), verdicts }
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
