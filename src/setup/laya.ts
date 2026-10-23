// Sets up smart sorting on a Mac with Apple silicon, for the app (Turn on smart sorting) and
// for npm run laya:setup alike. It installs, inside Kestrel's data folder:
//   - uv, the Python package manager laya-mps uses (a pinned release, checked by SHA-256)
//   - laya-mps (https://github.com/afshinm/laya-mps), which runs Laya on the Mac's GPU, at a
//     pinned commit checked by a hash of its files
//   - laya-mps's Python environment with PyTorch (uv sync --locked)
//   - Laya's English checkpoint, downloaded by laya-mps from Hugging Face at a pinned revision
// and then installs the checkpoint where Kestrel Sort looks for it. Every step can be run again:
// what's already there is kept, so a failed or interrupted setup resumes where it stopped.

import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Move these on deliberately: re-run laya-training/mps (CPU vs GPU answers) first.
const UV_VERSION = '0.13.5'
const UV_SHA256 = '743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73'
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`
const LAYA_MPS_COMMIT = 'cdbf19e1aa5bd763ce4777d7a915849510514349'
const LAYA_MPS_FILES_SHA256 = 'aaad1765dd00716602e0b3382afd94e048b60f438210b88df66208388387b1bd'
const LAYA_MPS_URL = `https://codeload.github.com/afshinm/laya-mps/tar.gz/${LAYA_MPS_COMMIT}`

// Rough sizes, for progress: the Python environment with PyTorch, and the English checkpoint.
const ENV_BYTES = 1_400_000_000
const MODEL_BYTES = 843_000_000

export type Memory = 'minimal' | 'reduced' | 'full'

export interface SetupProgress {
  step: 'uv' | 'laya-mps' | 'python' | 'gpu' | 'model' | 'install'
  label: string
  percent: number // of the whole setup
}

export interface SetupOptions {
  dataDir: string // Kestrel's data folder; everything goes in here
  modelDir: string // where Kestrel Sort looks for the model
  checkpoint?: string // a PyTorch checkpoint to install instead of downloading Laya's English one
  layaMps?: string // an existing laya-mps checkout to use instead of Kestrel's own
  id?: string
  questions?: string
  memory?: Memory
  force?: boolean // replace a model that's already installed
  onProgress?: (p: SetupProgress) => void
  signal?: AbortSignal
}

export type SetupResult =
  | { outcome: 'already'; id: string } // the installed model already runs on the GPU
  | { outcome: 'kept'; id: string; layaMps: string } // a CPU-only model was left as it is
  | { outcome: 'repaired'; id: string } // a GPU model got its Python environment back
  | { outcome: 'installed'; id: string }

export class SetupError extends Error {}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

// Apple silicon, even when this process runs under Rosetta.
export function isAppleSilicon(): boolean {
  return process.platform === 'darwin' && spawnSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).stdout?.trim() === '1'
}

export function gpuModelReady(modelDir: string): boolean {
  const python = readJson<{ python?: string }>(path.join(modelDir, 'gpu.json'))?.python
  return !!python && fs.existsSync(python) && fs.existsSync(path.join(modelDir, 'torch', 'model.safetensors'))
}

// Whether Kestrel Sort can run the installed model at all, on the GPU or the CPU.
export function modelUsable(modelDir: string): boolean {
  return fs.existsSync(path.join(modelDir, 'encoder.onnx')) || gpuModelReady(modelDir)
}

export async function setupLaya(o: SetupOptions): Promise<SetupResult> {
  if (!isAppleSilicon()) throw new SetupError('GPU sorting needs a Mac with Apple silicon. Kestrel sorts on the CPU with an ONNX model instead (docs/smart-inbox.md).')
  const manifest = readJson<{ id: string }>(path.join(o.modelDir, 'manifest.json'))
  if (!o.force && manifest && gpuModelReady(o.modelDir)) return { outcome: 'already', id: manifest.id }
  const hasTorch = fs.existsSync(path.join(o.modelDir, 'torch', 'model.safetensors'))
  const hasOnnx = fs.existsSync(path.join(o.modelDir, 'encoder.onnx'))
  const report = (step: SetupProgress['step'], label: string, from: number, to: number) => (fraction: number) =>
    o.onProgress?.({ step, label, percent: Math.round(from + (to - from) * Math.min(1, Math.max(0, fraction))) })

  const uv = await ensureUv(o, report('uv', 'Downloading uv', 0, 3))
  const managed = !o.layaMps
  const layaMps = o.layaMps ? path.resolve(o.layaMps) : await ensureLayaMps(o, report('laya-mps', 'Downloading laya-mps', 3, 5))
  if (!fs.existsSync(path.join(layaMps, 'pyproject.toml'))) throw new SetupError(`${layaMps} isn't a laya-mps checkout`)
  const env = uvEnv(o.dataDir, managed)
  await withGrowth([path.join(o.dataDir, 'uv-cache'), path.join(layaMps, '.venv')], ENV_BYTES, report('python', 'Installing Python and PyTorch', 5, 50), () =>
    // laya-mps is tested on Python 3.12, and PyTorch 2.14 has no wheels for the newest Pythons.
    run(uv, ['sync', '--locked', '--no-dev', '--python', '3.12'], { cwd: layaMps, env, signal: o.signal }, "Couldn't install laya-mps's Python environment")
  )
  const python = path.join(layaMps, '.venv', 'bin', 'python')
  report('gpu', 'Checking the GPU', 50, 52)(0)
  await run(python, ['-I', '-c', 'import sys, torch; sys.exit(0 if torch.backends.mps.is_available() else 1)'], { env, signal: o.signal }, "PyTorch can't use this Mac's GPU (Metal)")

  // A CPU-only model is someone's own: keep it unless told to replace it.
  if (manifest && hasOnnx && !hasTorch && !o.force) return { outcome: 'kept', id: manifest.id, layaMps }
  // A GPU model whose Python environment went missing only needs pointing at the new one.
  if (manifest && hasTorch && !o.force && !o.checkpoint) {
    writeGpuConfig(o.modelDir, python, o.memory)
    return { outcome: 'repaired', id: manifest.id }
  }

  let checkpoint = o.checkpoint
  if (!checkpoint) {
    checkpoint = path.join(layaMps, '.models', 'laya-english')
    await withGrowth([checkpoint], MODEL_BYTES, report('model', "Downloading Laya's model", 52, 96), () =>
      run(python, ['-I', '-m', 'laya_mps', 'setup', '--checkpoint', 'english'], { cwd: layaMps, env, signal: o.signal }, "Couldn't download Laya's model")
    )
  }
  report('install', 'Installing the model', 96, 100)(0)
  const id = o.id ?? (o.checkpoint ? path.basename(path.resolve(o.checkpoint)) : 'laya-english-base')
  await installModel({ dest: o.modelDir, torch: checkpoint, python, memory: o.memory, id, questions: o.questions })
  report('install', 'Installing the model', 96, 100)(1)
  return { outcome: 'installed', id }
}

// ---------- installing a model where Kestrel Sort looks for it ----------

const ONNX_NEEDED = ['encoder.onnx', 'head.onnx', 'tokenizer.json', 'rl_agent_config.json']
const TORCH_NEEDED = ['model.safetensors', 'rl_agent_config.json', 'encoder/config.json', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json']

export interface InstallOptions {
  dest: string
  id: string
  onnx?: string // an export_onnx.py output folder: runs on the CPU
  torch?: string // a PyTorch checkpoint: runs on the GPU with laya-mps's Python
  python?: string
  memory?: Memory
  questions?: string // the questions the model was trained on (laya-train writes them)
}

// Copies the model in (as copy-on-write clones on APFS, so nothing takes space twice) and
// writes manifest.json with its name and SHA-256 sums. Kestrel re-sorts when the name changes.
export async function installModel(o: InstallOptions): Promise<void> {
  if (!o.onnx && !o.torch) throw new SetupError('Nothing to install: give an ONNX folder, a PyTorch checkpoint, or both')
  const missing = [
    ...(o.onnx ? ONNX_NEEDED.filter(f => !fs.existsSync(path.join(o.onnx!, f))).map(f => path.join(o.onnx!, f)) : []),
    ...(o.torch ? TORCH_NEEDED.filter(f => !fs.existsSync(path.join(o.torch!, f))).map(f => path.join(o.torch!, f)) : [])
  ]
  if (missing.length) throw new SetupError(`The model is missing ${missing.join(', ')}`)
  if (o.torch && (!o.python || !fs.existsSync(o.python))) throw new SetupError("A PyTorch checkpoint needs laya-mps's Python")
  if (o.memory && !['minimal', 'reduced', 'full'].includes(o.memory)) throw new SetupError('The GPU memory setting is minimal, reduced or full')
  const clone = { recursive: true, mode: fs.constants.COPYFILE_FICLONE }
  fs.rmSync(o.dest, { recursive: true, force: true })
  fs.mkdirSync(o.dest, { recursive: true })
  if (o.onnx) fs.cpSync(o.onnx, o.dest, clone)
  if (o.questions) fs.cpSync(o.questions, path.join(o.dest, 'questions.json'), clone)
  if (o.torch) {
    for (const f of TORCH_NEEDED) fs.cpSync(path.join(o.torch, f), path.join(o.dest, 'torch', f), clone)
    writeGpuConfig(o.dest, o.python!, o.memory)
  }
  const files: Record<string, string> = {}
  for (const f of filesIn(o.dest).filter(f => f !== 'manifest.json' && f !== 'gpu.json')) files[f] = await sha256File(path.join(o.dest, f))
  fs.writeFileSync(path.join(o.dest, 'manifest.json'), JSON.stringify({ id: o.id, installed: new Date().toISOString(), files }, null, 2))
}

function writeGpuConfig(modelDir: string, python: string, memory: Memory = 'reduced'): void {
  fs.writeFileSync(path.join(modelDir, 'gpu.json'), JSON.stringify({ python, memory }, null, 2))
}

// ---------- the steps ----------

async function ensureUv(o: SetupOptions, progress: (f: number) => void): Promise<string> {
  const dir = path.join(o.dataDir, 'tools', `uv-${UV_VERSION}`)
  const uv = path.join(dir, 'uv')
  if (fs.existsSync(uv)) return uv
  const archive = await download(UV_URL, path.join(o.dataDir, 'tools', 'uv.tar.gz'), progress, o.signal, "Couldn't download uv")
  if ((await sha256File(archive)) !== UV_SHA256) throw new SetupError("The uv download didn't match its published checksum")
  const tmp = `${dir}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  await run('/usr/bin/tar', ['-xzf', archive, '-C', tmp, '--strip-components', '1'], {}, "Couldn't unpack uv")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(tmp, dir)
  fs.rmSync(archive, { force: true })
  return uv
}

async function ensureLayaMps(o: SetupOptions, progress: (f: number) => void): Promise<string> {
  const dir = path.join(o.dataDir, 'laya-mps')
  const marker = path.join(dir, '.kestrel-source')
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === LAYA_MPS_COMMIT) return dir
  const archive = await download(LAYA_MPS_URL, path.join(o.dataDir, 'laya-mps.tar.gz'), progress, o.signal, "Couldn't download laya-mps")
  const tmp = `${dir}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  await run('/usr/bin/tar', ['-xzf', archive, '-C', tmp, '--strip-components', '1'], {}, "Couldn't unpack laya-mps")
  if (filesHash(tmp) !== LAYA_MPS_FILES_SHA256) throw new SetupError("The laya-mps download didn't match the version Kestrel was tested with")
  fs.writeFileSync(path.join(tmp, '.kestrel-source'), LAYA_MPS_COMMIT + '\n')
  // Keep an environment and model that a previous run already downloaded.
  for (const keep of ['.venv', '.models']) if (fs.existsSync(path.join(dir, keep))) fs.renameSync(path.join(dir, keep), path.join(tmp, keep))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(tmp, dir)
  fs.rmSync(archive, { force: true })
  return dir
}

// Kestrel's own laya-mps gets its Python and caches inside Kestrel's data folder, so removing
// that folder removes everything. A checkout you name keeps its own settings.
function uvEnv(dataDir: string, managed: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, UV_NO_PROGRESS: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_PROGRESS_BARS: '1' }
  if (!managed) return env
  return {
    ...env,
    UV_NO_CONFIG: '1',
    UV_CACHE_DIR: path.join(dataDir, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: path.join(dataDir, 'uv-python'),
    UV_PYTHON_PREFERENCE: 'only-managed',
    HF_HOME: path.join(dataDir, 'huggingface')
  }
}

// ---------- helpers ----------

async function download(url: string, file: string, progress: (f: number) => void, signal: AbortSignal | undefined, failure: string): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (e) {
    throw new SetupError(`${failure}: ${e instanceof Error ? e.message : e}`)
  }
  if (!res.ok || !res.body) throw new SetupError(`${failure}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const out = fs.createWriteStream(file)
  let received = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()))
      if (total) progress(received / total)
    }
  } finally {
    await new Promise<void>(r => out.end(() => r()))
  }
  progress(1)
  return file
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }, failure: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const keep = (d: Buffer) => (tail = (tail + d.toString()).slice(-4000))
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('error', e => reject(new SetupError(`${failure}: ${e.message}`)))
    child.on('close', code => {
      if (code === 0) return resolve()
      const last = tail.trim().split('\n').filter(Boolean).slice(-3).join(' ')
      reject(new SetupError(`${failure}${last ? `: ${last}` : ` (exit ${code})`}`))
    })
  })
}

// Runs a step while reporting how far the folders it fills have grown towards an expected size.
async function withGrowth(dirs: string[], expected: number, progress: (f: number) => void, step: () => Promise<void>): Promise<void> {
  const start = dirs.reduce((s, d) => s + dirSize(d), 0)
  const timer = setInterval(() => progress(Math.min(0.99, (dirs.reduce((s, d) => s + dirSize(d), 0) - start) / expected)), 2000)
  try {
    await step()
  } finally {
    clearInterval(timer)
  }
  progress(1)
}

function dirSize(dir: string): number {
  let total = 0
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) total += fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0
    }
  }
  walk(dir)
  return total
}

function filesIn(dir: string, prefix = ''): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? filesIn(path.join(dir, e.name), `${prefix}${e.name}/`) : e.isFile() ? [`${prefix}${e.name}`] : []))
}

// A hash of every file's path and contents, so a source archive is checked by what's in it.
export function filesHash(dir: string): string {
  const h = createHash('sha256')
  for (const f of filesIn(dir).sort()) h.update(`${f}\0${createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')}\n`)
  return h.digest('hex')
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    fs.createReadStream(file)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

export const defaultDataDir = (): string => path.join(os.homedir(), 'Library', 'Application Support', 'kestrel-mail')
