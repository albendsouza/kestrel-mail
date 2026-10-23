// Sets up smart sorting on a Mac with Apple silicon: installs laya-mps
// (https://github.com/afshinm/laya-mps, Laya on the Mac's GPU through PyTorch MPS) and a Laya
// checkpoint, and installs that checkpoint where Kestrel Sort looks for it.
//   npm run laya:setup                          laya-mps and Laya's English checkpoint (about 2 GB)
//   npm run laya:setup -- --checkpoint <dir>    your own PyTorch checkpoint (a laya-train output)
//   npm run laya:setup -- --laya-mps <dir>      an existing laya-mps checkout instead of a new one
//   npm run laya:setup -- --force               replace a model that's already installed
// Other options pass through to laya:install: --id, --questions, --gpu-memory.
// Other Macs sort on the CPU with an ONNX model instead (docs/smart-inbox.md).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// laya-mps at the commit Kestrel was tested with. Move it on deliberately, after re-running
// laya-training's CPU-vs-GPU comparison.
const LAYA_MPS_REPO = 'https://github.com/afshinm/laya-mps.git'
const LAYA_MPS_COMMIT = 'cdbf19e1aa5bd763ce4777d7a915849510514349'
const DATA = path.join(os.homedir(), 'Library', 'Application Support', 'kestrel-mail')
const MODEL_DIR = process.env.KESTREL_LAYA_MODEL || path.join(DATA, 'models', 'laya-email')

const args = process.argv.slice(2)
const value = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null)
const say = msg => console.log(`laya:setup: ${msg}`)
const fail = msg => {
  console.error(`laya:setup: ${msg}`)
  process.exit(1)
}
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts })
  if (r.status !== 0) fail(`${cmd} ${argv.join(' ')} failed`)
}
const output = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', ...opts })
const has = cmd => output('/bin/sh', ['-c', `command -v ${cmd}`]).status === 0
const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Apple silicon, even when Node itself runs under Rosetta.
if (process.platform !== 'darwin' || output('sysctl', ['-n', 'hw.optional.arm64']).stdout?.trim() !== '1') {
  say('GPU sorting needs a Mac with Apple silicon. Here Kestrel sorts on the CPU with an ONNX model: see docs/smart-inbox.md.')
  process.exit(0)
}

// Nothing to do when the installed model already runs on the GPU.
const installed = readJson(path.join(MODEL_DIR, 'manifest.json'))
const gpu = readJson(path.join(MODEL_DIR, 'gpu.json'))
if (!args.includes('--force') && installed && gpu?.python && existsSync(gpu.python) && existsSync(path.join(MODEL_DIR, 'torch', 'model.safetensors'))) {
  say(`already set up: ${installed.id} runs on the GPU with laya-mps in ${path.resolve(gpu.python, '../../..')}. Use --force to replace it.`)
  process.exit(0)
}

if (!has('git')) fail('git is missing; install the Xcode command line tools with: xcode-select --install')
if (!has('uv')) {
  if (!has('brew')) fail('laya-mps needs uv: https://docs.astral.sh/uv/getting-started/installation/')
  say('installing uv (Python package manager laya-mps uses) with Homebrew')
  run('brew', ['install', 'uv'])
}

// laya-mps: a new checkout pinned to the tested commit, or the one you name.
const layaMps = path.resolve(value('--laya-mps') ?? path.join(DATA, 'laya-mps'))
if (!existsSync(path.join(layaMps, 'pyproject.toml'))) {
  if (value('--laya-mps')) fail(`${layaMps} isn't a laya-mps checkout`)
  say(`downloading laya-mps into ${layaMps}`)
  run('git', ['clone', '--quiet', LAYA_MPS_REPO, layaMps])
}
const head = output('git', ['-C', layaMps, 'rev-parse', 'HEAD']).stdout?.trim()
if (head !== LAYA_MPS_COMMIT) {
  if (value('--laya-mps')) say(`note: ${layaMps} is at ${head?.slice(0, 7)}; Kestrel was tested with ${LAYA_MPS_COMMIT.slice(0, 7)}`)
  else {
    run('git', ['-C', layaMps, 'fetch', '--quiet', 'origin'])
    run('git', ['-C', layaMps, 'checkout', '--quiet', LAYA_MPS_COMMIT])
  }
}
say('installing laya-mps and PyTorch (uv sync)')
run('uv', ['sync', '--locked', '--no-dev'], { cwd: layaMps })
const python = path.join(layaMps, '.venv', 'bin', 'python')
if (output(python, ['-I', '-c', 'import sys, torch; sys.exit(0 if torch.backends.mps.is_available() else 1)']).status !== 0) {
  fail("PyTorch can't use this Mac's GPU (Metal). Kestrel will sort on the CPU instead; see docs/smart-inbox.md.")
}

// A model already installed without a GPU checkpoint is yours: keep it unless told otherwise.
if (installed && !args.includes('--force')) {
  say(`laya-mps is ready, but ${installed.id} is already installed without a GPU checkpoint. Add its checkpoint with`)
  say(`  npm run laya:install -- <its ONNX folder> --id ${installed.id} --torch <its PyTorch checkpoint> --gpu "${layaMps}"`)
  say('or replace it with Laya\'s English checkpoint: npm run laya:setup -- --force')
  process.exit(0)
}

let checkpoint = value('--checkpoint')
if (!checkpoint) {
  say("downloading Laya's English checkpoint (843 MB) with laya-mps")
  run('uv', ['run', '--locked', '--no-dev', 'laya-mps', 'setup', '--checkpoint', 'english'], { cwd: layaMps })
  checkpoint = path.join(layaMps, '.models', 'laya-english')
}
const id = value('--id') ?? (value('--checkpoint') ? path.basename(path.resolve(checkpoint)) : 'laya-english-base')
const passOn = ['--questions', '--gpu-memory'].flatMap(f => (value(f) ? [f, value(f)] : []))
run(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.mjs'), '--torch', checkpoint, '--gpu', layaMps, '--id', id, ...passOn])
say('done. Kestrel sorts on the GPU from the next time it sorts; restart it if it is running.')
