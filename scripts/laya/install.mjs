// Installs a Laya model (an export_onnx.py output folder) where Kestrel Sort looks for it:
//   npm run laya:install -- <model folder> [--id name] [--questions <checkpoint>/questions.json]
// Writes manifest.json with the model's name and SHA-256 sums. Kestrel re-sorts the
// inbox whenever the name changes.

import { createHash } from 'node:crypto'
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const src = args.find((a, i) => !a.startsWith('--') && !['--id', '--questions'].includes(args[i - 1]))
const id = args.includes('--id') ? args[args.indexOf('--id') + 1] : path.basename(path.resolve(src ?? ''))
const NEEDED = ['encoder.onnx', 'head.onnx', 'tokenizer.json', 'rl_agent_config.json']
// The questions the model was trained on; laya-train writes them beside the checkpoint.
const questions = args.includes('--questions') ? args[args.indexOf('--questions') + 1] : null
if (!src || NEEDED.some(f => !existsSync(path.join(src, f)))) {
  console.error(`Usage: npm run laya:install -- <folder with ${NEEDED.join(', ')}> [--id name]`)
  process.exit(1)
}
const dest = process.env.KESTREL_LAYA_MODEL || path.join(os.homedir(), 'Library', 'Application Support', 'kestrel-mail', 'models', 'laya-email')

const sha256 = file =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })

rmSync(dest, { recursive: true, force: true })
mkdirSync(path.dirname(dest), { recursive: true })
cpSync(src, dest, { recursive: true })
if (questions) cpSync(questions, path.join(dest, 'questions.json'))
const files = {}
for (const f of readdirSync(dest).filter(f => f !== 'manifest.json')) files[f] = await sha256(path.join(dest, f))
writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ id, installed: new Date().toISOString(), files }, null, 2))
console.log(`Installed ${id} to ${dest}`)
