// Turn on smart sorting, from inside the app. On a Mac with Apple silicon and no model it can
// use, Kestrel offers to install laya-mps and Laya's model (src/setup/laya.ts), shows progress in
// every tab, and restarts Sort when it's done so the inbox gets sorted.

import fs from 'fs'

import { app, webContents } from 'electron'

import { isAppleSilicon, modelUsable, setupLaya, type SetupProgress } from '../setup/laya'
import { APP_ORIGIN, layaModelDir } from './config'

import type { SortingSetup } from '../shared/types'

let appleSilicon: boolean | null = null
let progress: Pick<SortingSetup, 'running' | 'label' | 'percent' | 'error' | 'done'> = { running: false }
let controller: AbortController | null = null
let dismissed = () => false

export function initSortingSetup(isDismissed: () => boolean): void {
  dismissed = isDismissed
}

export function sortingSetup(): SortingSetup {
  appleSilicon ??= isAppleSilicon()
  return { offer: appleSilicon && !modelUsable(layaModelDir()), dismissed: dismissed(), ...progress }
}

export function broadcastSortingSetup(): void {
  const state = sortingSetup()
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed() && wc.getURL().startsWith(APP_ORIGIN)) wc.send('kestrel:sortingSetup', state)
  }
}

export function startSortingSetup(onInstalled: () => void): void {
  if (progress.running) return
  progress = { running: true, label: 'Starting', percent: 0 }
  broadcastSortingSetup()
  controller = new AbortController()
  const onProgress = (p: SetupProgress) => {
    if (p.label === progress.label && p.percent === progress.percent) return
    progress = { running: true, label: p.label, percent: p.percent }
    broadcastSortingSetup()
  }
  const from = process.env.KESTREL_SORTING_SETUP_FROM
  const run = from
    ? fakeSetup(from, onProgress)
    : setupLaya({ dataDir: app.getPath('userData'), modelDir: layaModelDir(), onProgress, signal: controller.signal })
  void run
    .then(() => {
      progress = { running: false, done: true }
      onInstalled()
    })
    .catch(e => {
      progress = { running: false, error: e instanceof Error ? e.message : String(e) }
      console.error(`[sorting setup] ${progress.error}`)
    })
    .finally(() => {
      controller = null
      broadcastSortingSetup()
    })
}

// Quitting stops the download; the next attempt resumes from what's already there.
export function stopSortingSetup(): void {
  controller?.abort()
}

// Smoke tests set up from an installed model instead of downloading 2 GB.
async function fakeSetup(from: string, onProgress: (p: SetupProgress) => void): Promise<void> {
  for (const [step, label, percent] of [
    ['uv', 'Downloading uv', 2],
    ['python', 'Installing Python and PyTorch', 40],
    ['model', "Downloading Laya's model", 80]
  ] as const) {
    onProgress({ step, label, percent })
    await new Promise(r => setTimeout(r, 400))
  }
  fs.cpSync(from, layaModelDir(), { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
  onProgress({ step: 'install', label: 'Installing the model', percent: 100 })
}
