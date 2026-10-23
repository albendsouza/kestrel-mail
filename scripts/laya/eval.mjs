// Scores a Laya model the way Kestrel Sort runs it:
//   node scripts/laya/eval.mjs <model folder> <labelled .jsonl files...> [--json <results file>]
// Lines are either training rows ({state, expected}) or labelled emails ({from, subject, body, mailing_list, kind, ...}).
// Reports how often a thread lands in the right split (the number that matters), plus each answer.
// --json also writes the scores per file, for comparing models.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

// Laya and Kestrel's sorting definitions, bundled into node_modules/.cache so onnxruntime-node resolves.
const cached = path.resolve('node_modules/.cache/kestrel-laya-eval.mjs')
await build({
  stdin: { contents: "export * from './src/shared/sorting.ts'; export { Agent } from './vendor/laya-ts/src/index.ts'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['onnxruntime-node', 'onnxruntime-web'],
  outfile: cached,
  logLevel: 'error'
})
const { Agent, SORT_QUESTIONS, labelsFor, sortState } = await import(cached)

const args = process.argv.slice(2)
const jsonOut = args.includes('--json') ? args.splice(args.indexOf('--json'), 2)[1] : null
const [modelDir, ...files] = args
const agent = await Agent.load(modelDir)
// Like Kestrel Sort, only a model trained on topics (its questions.json says) is asked about them.
const hasTopics = (() => {
  try {
    return 'topic' in JSON.parse(readFileSync(path.join(modelDir, 'questions.json'), 'utf8'))
  } catch {
    return false
  }
})()
const { topic: _topic, ...withoutTopic } = SORT_QUESTIONS
const questions = hasTopics ? SORT_QUESTIONS : withoutTopic
const installedAs = (() => {
  try {
    return JSON.parse(readFileSync(path.join(modelDir, 'manifest.json'), 'utf8')).id
  } catch {
    return path.basename(modelDir)
  }
})()
const summary = { model: installedAs, files: {} }
for (const file of files) {
  const cases = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .map(r =>
      r.state
        ? { state: r.state, truth: r.expected }
        : { state: sortState({ from: r.from, subject: r.subject, body: r.body, mailingList: !!r.mailing_list }), truth: { kind: r.kind, needs_reply: r.needs_reply, urgent: r.urgent, topic: r.topic } }
    )
  const started = Date.now()
  const results = []
  for (let i = 0; i < cases.length; i += 8) results.push(...(await agent.predictBatch(cases.slice(i, i + 8).map(c => c.state), questions)))
  const ms = (Date.now() - started) / cases.length
  const score = { split: 0, kind: 0, needs_reply: 0, urgent: 0, topic: 0, topics: 0 }
  const bySplit = {}
  const confusion = {}
  const misses = []
  results.forEach((r, i) => {
    const a = r.answers
    const got = { kind: a.kind.choice, confidence: a.kind.answer_confidence, needsReply: a.needs_reply.noul, urgent: a.urgent.noul, topic: a.topic?.choice }
    const t = cases[i].truth
    const want = labelsFor({ kind: t.kind, confidence: 1, needsReply: t.needs_reply ? 1 : 0, urgent: t.urgent ? 1 : 0, topic: t.topic })
    const have = labelsFor(got)
    bySplit[want.split] ??= { n: 0, right: 0 }
    bySplit[want.split].n++
    if (t.topic) {
      score.topics++
      if (got.topic === t.topic) score.topic++
    }
    if (want.split === have.split) {
      score.split++
      bySplit[want.split].right++
    } else misses.push(`${want.split} -> ${have.split} | ${t.kind} as ${got.kind} ${got.confidence.toFixed(2)} urgent ${got.urgent.toFixed(2)} | ${cases[i].state.from} | ${cases[i].state.subject}`)
    if (got.kind === t.kind) score.kind++
    if (got.needsReply >= 0.5 === t.needs_reply) score.needs_reply++
    if (got.urgent >= 0.5 === t.urgent) score.urgent++
    confusion[`${t.kind}->${got.kind}`] = (confusion[`${t.kind}->${got.kind}`] ?? 0) + 1
  })
  const pct = n => `${((100 * n) / cases.length).toFixed(1)}%`
  const share = n => Math.round((1000 * n) / cases.length) / 10
  summary.files[path.basename(file)] = {
    n: cases.length,
    rightSplit: share(score.split),
    kind: share(score.kind),
    needsReply: share(score.needs_reply),
    urgent: share(score.urgent),
    topic: score.topics ? Math.round((1000 * score.topic) / score.topics) / 10 : null,
    bySplit,
    msPerThread: Math.round(ms)
  }
  console.log(`\n## ${path.basename(file)} (${cases.length}) with ${path.basename(modelDir)}: ${Math.round(ms)} ms per thread`)
  console.log(`right split ${pct(score.split)} · kind ${pct(score.kind)} · needs reply ${pct(score.needs_reply)} · urgent ${pct(score.urgent)}${score.topics ? ` · topic ${((100 * score.topic) / score.topics).toFixed(1)}% of ${score.topics}` : ''}`)
  console.log('right split, by the split it belongs in:', Object.entries(bySplit).map(([k, v]) => `${k} ${v.right}/${v.n}`).join(', '))
  console.log('mistakes by kind:', Object.entries(confusion).filter(([k]) => k.split('->')[0] !== k.split('->')[1]).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ${n}`).join(', '))
  console.log(misses.slice(0, 15).join('\n'))
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 2))
