// Turns labelled emails into Laya training rows, asking exactly what Kestrel Sort asks
// (src/shared/sorting.ts). Holds out a slice for testing.
//   node scripts/laya/rows.mjs <labelled .jsonl files...> --out <dir> [--topics <file>]
// Each input line: {"from","subject","body","mailing_list","kind","needs_reply","urgent","topic"?}.
// A line may instead carry "label" (an auto label you set in Kestrel with L); it's turned into answers
// the way the app turns a correction into a verdict.
// --topics adds topics labelled separately: lines of {"id": "<file name>:<line index>", "topic"}.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const bundled = await build({ entryPoints: ['src/shared/sorting.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
const { KINDS, SORT_QUESTIONS, TOPICS, sortState, verdictFor } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const args = process.argv.slice(2)
const out = args[args.indexOf('--out') + 1]
const topicsFile = args.includes('--topics') ? args[args.indexOf('--topics') + 1] : null
const inputs = args.filter((a, i) => !a.startsWith('--') && !['--out', '--topics'].includes(args[i - 1]))
const topics = new Map(
  topicsFile
    ? readFileSync(topicsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
        .map(t => [t.id, t.topic])
    : []
)

const rows = []
const problems = {}
const seen = new Set()
for (const file of inputs) {
  for (const [n, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      problems.bad_json = (problems.bad_json ?? 0) + 1
      continue
    }
    if (r.label && !r.kind) {
      const v = verdictFor(r.label)
      if (!v) {
        problems.bad_label = (problems.bad_label ?? 0) + 1
        continue
      }
      Object.assign(r, { kind: v.kind, needs_reply: v.needsReply >= 0.5, urgent: v.urgent >= 0.5, ...(v.topic ? { topic: v.topic } : {}) })
    }
    if (!KINDS.includes(r.kind) || typeof r.needs_reply !== 'boolean' || typeof r.urgent !== 'boolean' || !r.subject || !r.body) {
      problems.bad_fields = (problems.bad_fields ?? 0) + 1
      continue
    }
    const key = `${r.subject}|${r.body}`.toLowerCase()
    if (seen.has(key)) {
      problems.duplicate = (problems.duplicate ?? 0) + 1
      continue
    }
    seen.add(key)
    const topic = r.kind === 'notification' ? (r.topic ?? topics.get(`${path.basename(file)}:${n}`)) : undefined
    if (topic !== undefined && !TOPICS.includes(topic)) {
      problems.bad_topic = (problems.bad_topic ?? 0) + 1
      continue
    }
    rows.push({
      state: sortState({ from: r.from ?? '', subject: r.subject, body: r.body, mailingList: !!r.mailing_list }),
      questions: SORT_QUESTIONS,
      // Only notices answer the topic question; for other mail it's left unasked in training.
      expected: { kind: r.kind, needs_reply: r.needs_reply, urgent: r.urgent, ...(topic ? { topic } : {}) },
      source: `${path.basename(file)}:${n + 1}`
    })
  }
}

// A fixed shuffle, then 15% of each kind held out for testing.
let seed = 20261023
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
rows.sort(() => rand() - 0.5)
const test = []
const train = []
for (const kind of KINDS) {
  const ofKind = rows.filter(r => r.expected.kind === kind)
  const cut = Math.round(ofKind.length * 0.15)
  test.push(...ofKind.slice(0, cut))
  train.push(...ofKind.slice(cut))
}
train.sort(() => rand() - 0.5)
mkdirSync(out, { recursive: true })
const write = (name, list) => writeFileSync(path.join(out, name), list.map(({ source, ...r }) => JSON.stringify(r)).join('\n') + '\n')
write('train.jsonl', train)
write('test.jsonl', test)
const count = list => Object.fromEntries(KINDS.map(k => [k, list.filter(r => r.expected.kind === k).length]))
console.log(JSON.stringify({ topics: train.filter(r => r.expected.topic).length, train: train.length, test: test.length, skipped: problems, trainKinds: count(train), reply: train.filter(r => r.expected.needs_reply).length, urgent: train.filter(r => r.expected.urgent).length }, null, 1))
