// Fits the learned signal layer for the installed model from your checked labels and the
// corrections you made with L, scores it before and after on a held-out set, and installs it:
//   npm run laya:fit -- --labels <checked.jsonl> [--labels ...] [--test <checked.jsonl>] [--dry-run]
// Labelled lines are {thread_id, kind, needs_reply, urgent, topic?}; the threads must be in
// Kestrel's cache, which supplies their Gmail signals. Kestrel re-sorts the inbox after a fit.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

import { dataDir, modelDir } from './lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = path.join(root, 'node_modules', '.cache', 'kestrel-laya-fit.cjs')
await build({
  entryPoints: [path.join(root, 'src', 'setup', 'fit.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out,
  external: ['onnxruntime-node', 'onnxruntime-web'],
  logLevel: 'error'
})
const { fitSignalLayer } = await import(out)

const args = process.argv.slice(2)
const all = flag => args.flatMap((a, i) => (a === flag && args[i + 1] ? [path.resolve(args[i + 1])] : []))
const labels = all('--labels')
if (!labels.length) {
  console.error('Usage: npm run laya:fit -- --labels <checked.jsonl> [--labels ...] [--test <checked.jsonl>] [--dry-run]')
  process.exit(1)
}
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-')

try {
  const r = await fitSignalLayer({ dataDir, modelDir, labels, test: all('--test'), gpuWorker: path.join(root, 'src', 'sort', 'gpu_worker.py'), dryRun: args.includes('--dry-run'), log: s => console.log(`laya:fit: ${s}`) })
  const c = r.combiner
  console.log(`laya:fit: fitted ${c.id} for ${c.forModel} on ${c.trainedOn.labels} checked labels and ${c.trainedOn.corrections} corrections; ${c.crossValidated}% in cross-validation (L2 ${c.l2})`)
  const s = r.skipped
  if (s.notInCache || s.noSignals || s.correctionsNotFound || s.correctionsInTest) {
    console.log(`laya:fit: left out ${s.notInCache} threads not in Kestrel's cache, ${s.noSignals} without Gmail signals, ${s.correctionsNotFound} corrections whose thread is gone, ${s.correctionsInTest} corrections on test threads`)
  }
  if (r.test) {
    console.log(`\nHeld-out test (${r.test.n} threads): Laya alone ${pct(r.test.before, r.test.n)} -> with the signal layer ${pct(r.test.after, r.test.n)}`)
    for (const [bucket, b] of Object.entries(r.test.buckets)) console.log(`  ${bucket.padEnd(10)} ${b.before}/${b.n} -> ${b.after}/${b.n}`)
  }
  console.log(r.written ? `\nInstalled ${path.join(modelDir, 'combiner.json')}. Kestrel re-sorts the inbox the next time it sorts.` : '\nDry run: nothing installed.')
} catch (e) {
  console.error(`laya:fit: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
