// Installs a Laya model where Kestrel Sort looks for it:
//   npm run laya:install -- [<ONNX folder>] [--id name] [--questions <checkpoint>/questions.json]
//                           [--torch <checkpoint folder> --gpu <laya-mps checkout> [--gpu-memory reduced]]
// The ONNX folder (an export_onnx.py output) runs on the CPU. --torch adds the PyTorch
// checkpoint, which Kestrel Sort runs on the Mac's GPU in laya-mps's Python environment
// (--gpu); with only --torch, the model runs on the GPU alone. npm run laya:setup does all
// this on Apple silicon. Writes manifest.json with the model's name and SHA-256 sums.
// Kestrel re-sorts the inbox whenever the name changes.

import path from 'node:path'

import { flags, lib, modelDir } from './lib.mjs'

const args = process.argv.slice(2)
const value = flags(args)
const FLAGS = ['--id', '--questions', '--torch', '--gpu', '--gpu-memory']
const onnx = args.find((a, i) => !a.startsWith('--') && !FLAGS.includes(args[i - 1]))
const torch = value('--torch')
const id = value('--id') ?? path.basename(path.resolve(onnx ?? torch ?? ''))
const python = value('--gpu') && path.join(path.resolve(value('--gpu')), '.venv', 'bin', 'python')

try {
  await lib.installModel({ dest: modelDir, id, onnx, torch, python, memory: value('--gpu-memory'), questions: value('--questions') })
  console.log(`Installed ${id} to ${modelDir}${torch ? ', with a GPU checkpoint' : ''}`)
} catch (e) {
  console.error(`laya:install: ${e instanceof Error ? e.message : e}`)
  console.error('Usage: npm run laya:install -- [<ONNX folder>] [--id name] [--questions file] [--torch <checkpoint> --gpu <laya-mps>]')
  process.exit(1)
}
