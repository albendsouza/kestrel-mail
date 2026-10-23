// Loads src/setup/laya.ts (the setup Kestrel's app runs) for the laya: scripts, bundled with
// esbuild into node_modules/.cache, the way eval.mjs loads Laya.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = path.join(root, 'node_modules', '.cache', 'kestrel-laya-setup.mjs')
await build({ entryPoints: [path.join(root, 'src', 'setup', 'laya.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' })

export const lib = await import(out)
export const dataDir = process.env.KESTREL_USER_DATA || lib.defaultDataDir()
export const modelDir = process.env.KESTREL_LAYA_MODEL || path.join(dataDir, 'models', 'laya-email')
export const flags = args => flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
