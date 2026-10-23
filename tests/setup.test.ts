import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'

import { filesHash, gpuModelReady, installModel, isAppleSilicon, modelUsable, setupLaya } from '../src/setup/laya'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kestrel-setup-'))
const write = (file: string, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
// Stand-ins for the files each kind of model needs.
const torchCheckpoint = () => {
  const dir = tmp()
  for (const f of ['model.safetensors', 'rl_agent_config.json', 'encoder/config.json', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json']) write(path.join(dir, f), f)
  write(path.join(dir, 'checkpoint_latest', 'model.safetensors'), 'training leftovers')
  return dir
}
const onnxExport = () => {
  const dir = tmp()
  for (const f of ['encoder.onnx', 'head.onnx', 'tokenizer.json', 'rl_agent_config.json']) write(path.join(dir, f), f)
  return dir
}
const python = () => {
  const file = path.join(tmp(), '.venv', 'bin', 'python')
  write(file, '#!/bin/sh')
  return file
}

describe('installing a model', () => {
  it('installs a GPU-only model: the checkpoint files, gpu.json and a manifest, nothing else', async () => {
    const dest = path.join(tmp(), 'laya-email')
    const py = python()
    await installModel({ dest, id: 'laya-english-base', torch: torchCheckpoint(), python: py, memory: 'reduced' })
    expect(fs.readdirSync(path.join(dest, 'torch')).sort()).toEqual(['encoder', 'model.safetensors', 'rl_agent_config.json', 'tokenizer'])
    expect(JSON.parse(fs.readFileSync(path.join(dest, 'gpu.json'), 'utf8'))).toEqual({ python: py, memory: 'reduced' })
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'))
    expect(manifest.id).toBe('laya-english-base')
    expect(Object.keys(manifest.files)).toContain('torch/model.safetensors')
    expect(gpuModelReady(dest)).toBe(true)
    expect(modelUsable(dest)).toBe(true)
  })

  it('installs a CPU-only model, which runs but not on the GPU', async () => {
    const dest = path.join(tmp(), 'laya-email')
    await installModel({ dest, id: 'ft1', onnx: onnxExport() })
    expect(gpuModelReady(dest)).toBe(false)
    expect(modelUsable(dest)).toBe(true)
  })

  it('replaces whatever was installed before', async () => {
    const dest = path.join(tmp(), 'laya-email')
    await installModel({ dest, id: 'old', onnx: onnxExport() })
    await installModel({ dest, id: 'new', torch: torchCheckpoint(), python: python() })
    expect(fs.existsSync(path.join(dest, 'encoder.onnx'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')).id).toBe('new')
  })

  it('refuses a checkpoint without its files, without Python, or with a made-up memory setting', async () => {
    const dest = path.join(tmp(), 'laya-email')
    const broken = torchCheckpoint()
    fs.rmSync(path.join(broken, 'model.safetensors'))
    await expect(installModel({ dest, id: 'x', torch: broken, python: python() })).rejects.toThrow('missing')
    await expect(installModel({ dest, id: 'x', torch: torchCheckpoint() })).rejects.toThrow("laya-mps's Python")
    await expect(installModel({ dest, id: 'x', torch: torchCheckpoint(), python: python(), memory: 'huge' as never })).rejects.toThrow('minimal, reduced or full')
    await expect(installModel({ dest, id: 'x' })).rejects.toThrow('Nothing to install')
  })

  it("doesn't count a GPU model whose Python is gone as usable", async () => {
    const dest = path.join(tmp(), 'laya-email')
    const py = python()
    await installModel({ dest, id: 'x', torch: torchCheckpoint(), python: py })
    fs.rmSync(py)
    expect(modelUsable(dest)).toBe(false)
  })
})

describe('checking a download by its files', () => {
  it('gives the same hash for the same files, and a different one when any file changes', () => {
    const a = tmp()
    const b = tmp()
    for (const dir of [a, b]) {
      write(path.join(dir, 'pyproject.toml'), '[project]')
      write(path.join(dir, 'src', 'laya_mps', 'cli.py'), 'print(1)')
    }
    expect(filesHash(a)).toBe(filesHash(b))
    write(path.join(b, 'src', 'laya_mps', 'cli.py'), 'print(2)')
    expect(filesHash(a)).not.toBe(filesHash(b))
  })
})

describe.skipIf(!isAppleSilicon())('setting up on Apple silicon', () => {
  it('does nothing when the installed model already runs on the GPU', async () => {
    const modelDir = path.join(tmp(), 'laya-email')
    await installModel({ dest: modelDir, id: 'ready', torch: torchCheckpoint(), python: python() })
    const progress: string[] = []
    await expect(setupLaya({ dataDir: tmp(), modelDir, onProgress: p => progress.push(p.label) })).resolves.toEqual({ outcome: 'already', id: 'ready' })
    expect(progress).toEqual([])
  })
})
