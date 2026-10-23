// Sets up smart sorting on a Mac with Apple silicon from the terminal, exactly as Kestrel's
// "Turn on smart sorting" does (src/setup/laya.ts): uv, laya-mps
// (https://github.com/afshinm/laya-mps), its Python environment and Laya's English checkpoint,
// all inside Kestrel's data folder.
//   npm run laya:setup                          laya-mps and Laya's English checkpoint (about 2 GB)
//   npm run laya:setup -- --checkpoint <dir>    your own PyTorch checkpoint (a laya-train output)
//   npm run laya:setup -- --laya-mps <dir>      an existing laya-mps checkout instead of Kestrel's own
//   npm run laya:setup -- --force               replace a model that's already installed
// Also: --id name, --questions file, --gpu-memory minimal|reduced|full.

import { dataDir, flags, lib, modelDir } from './lib.mjs'

const args = process.argv.slice(2)
const value = flags(args)
const say = msg => console.log(`laya:setup: ${msg}`)

if (!lib.isAppleSilicon()) {
  say('GPU sorting needs a Mac with Apple silicon. Here Kestrel sorts on the CPU with an ONNX model: see docs/smart-inbox.md.')
  process.exit(0)
}

let shown = { label: '', percent: -10 }
try {
  const result = await lib.setupLaya({
    dataDir,
    modelDir,
    checkpoint: value('--checkpoint'),
    layaMps: value('--laya-mps'),
    id: value('--id'),
    questions: value('--questions'),
    memory: value('--gpu-memory'),
    force: args.includes('--force'),
    onProgress: p => {
      if (p.label === shown.label && p.percent < shown.percent + 5) return
      shown = p
      say(`${p.label}: ${p.percent}% of setup`)
    }
  })
  if (result.outcome === 'already') say(`already set up: ${result.id} runs on the GPU. Use --force to replace it.`)
  if (result.outcome === 'repaired') say(`${result.id} runs on the GPU again.`)
  if (result.outcome === 'installed') say(`done: ${result.id} runs on the GPU. Restart Kestrel if it's running.`)
  if (result.outcome === 'kept') {
    say(`laya-mps is ready, but ${result.id} is already installed without a GPU checkpoint. Add its checkpoint with`)
    say(`  npm run laya:install -- <its ONNX folder> --id ${result.id} --torch <its PyTorch checkpoint> --gpu "${result.layaMps}"`)
    say("or replace it with Laya's English checkpoint: npm run laya:setup -- --force")
  }
} catch (e) {
  console.error(`laya:setup: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
