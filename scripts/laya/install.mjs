// Installs a Laya model where Kestrel Sort looks for it:
//   npm run laya:install -- [<ONNX folder>] [--id name] [--questions <checkpoint>/questions.json]
//                           [--torch <checkpoint folder> --gpu <laya-mps checkout> [--gpu-memory reduced]]
// The ONNX folder (an export_onnx.py output) runs on the CPU. --torch adds the PyTorch
// checkpoint, which Kestrel Sort runs on the Mac's GPU in laya-mps's Python environment
// (--gpu); with only --torch, the model runs on the GPU alone. npm run laya:setup does all
// this on Apple silicon. Writes manifest.json with the model's name and SHA-256 sums.
// Kestrel re-sorts the inbox whenever the name changes.

import { createHash } from 'node:crypto'
import { constants, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const FLAGS = ['--id', '--questions', '--torch', '--gpu', '--gpu-memory']
const value = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null)
const src = args.find((a, i) => !a.startsWith('--') && !FLAGS.includes(args[i - 1]))
const id = value('--id') ?? path.basename(path.resolve(src ?? value('--torch') ?? ''))
const NEEDED = ['encoder.onnx', 'head.onnx', 'tokenizer.json', 'rl_agent_config.json']
// The questions the model was trained on; laya-train writes them beside the checkpoint.
const questions = value('--questions')
// The PyTorch checkpoint laya-mps loads (laya-train's output folder), and the files it needs.
const torch = value('--torch')
const TORCH_NEEDED = ['model.safetensors', 'rl_agent_config.json', 'encoder/config.json', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json']
const python = value('--gpu') && path.join(path.resolve(value('--gpu')), '.venv', 'bin', 'python')
const gpuMemory = value('--gpu-memory') ?? 'reduced'

if ((!src && !torch) || (src && NEEDED.some(f => !existsSync(path.join(src, f))))) {
  console.error(`Usage: npm run laya:install -- <folder with ${NEEDED.join(', ')}> [--id name], and/or --torch <checkpoint> --gpu <laya-mps>`)
  process.exit(1)
}
if (torch && TORCH_NEEDED.some(f => !existsSync(path.join(torch, f)))) {
  console.error(`--torch needs a checkpoint folder with ${TORCH_NEEDED.join(', ')}`)
  process.exit(1)
}
if (torch && (!python || !existsSync(python))) {
  console.error('--torch needs --gpu <laya-mps checkout>, set up with uv sync (see docs/smart-inbox.md)')
  process.exit(1)
}
if (!['minimal', 'reduced', 'full'].includes(gpuMemory)) {
  console.error('--gpu-memory is minimal, reduced or full')
  process.exit(1)
}
const dest = process.env.KESTREL_LAYA_MODEL || path.join(os.homedir(), 'Library', 'Application Support', 'kestrel-mail', 'models', 'laya-email')

const sha256 = file =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
const filesIn = (dir, prefix = '') =>
  readdirSync(dir).flatMap(f => (statSync(path.join(dir, f)).isDirectory() ? filesIn(path.join(dir, f), `${prefix}${f}/`) : [`${prefix}${f}`]))

// Copy-on-write clones on APFS, so a model already on disk takes no extra space.
const clone = { recursive: true, mode: constants.COPYFILE_FICLONE }
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
if (src) cpSync(src, dest, clone)
if (questions) cpSync(questions, path.join(dest, 'questions.json'), clone)
if (torch) {
  for (const f of TORCH_NEEDED) cpSync(path.join(torch, f), path.join(dest, 'torch', f), clone)
  writeFileSync(path.join(dest, 'gpu.json'), JSON.stringify({ python, memory: gpuMemory }, null, 2))
}
const files = {}
for (const f of filesIn(dest).filter(f => f !== 'manifest.json' && f !== 'gpu.json')) files[f] = await sha256(path.join(dest, f))
writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ id, installed: new Date().toISOString(), files }, null, 2))
console.log(`Installed ${id} to ${dest}${torch ? `, with a GPU checkpoint (laya-mps, ${gpuMemory} memory)` : ''}`)
