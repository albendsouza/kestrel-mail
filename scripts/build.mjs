import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

const watch = process.argv.includes('--watch')
const prod = process.env.NODE_ENV === 'production'
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist/renderer', { recursive: true })

// Release builds bake in the app's own Google OAuth client so every user can sign in.
// Google does not treat a desktop client's secret as confidential, so shipping it is expected.
const googleClient = {
  __KESTREL_GOOGLE_CLIENT_ID__: JSON.stringify(process.env.KESTREL_GOOGLE_CLIENT_ID ?? ''),
  __KESTREL_GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.KESTREL_GOOGLE_CLIENT_SECRET ?? '')
}
if (prod && !process.env.KESTREL_GOOGLE_CLIENT_ID) {
  console.error('Release builds need KESTREL_GOOGLE_CLIENT_ID and KESTREL_GOOGLE_CLIENT_SECRET (see README).')
  process.exit(1)
}

const common = { bundle: true, sourcemap: prod ? false : 'inline', minify: prod, logLevel: 'info', target: 'es2022' }
const node = { ...common, platform: 'node', format: 'cjs', external: ['electron'], define: googleClient }
// Kestrel Sort loads ONNX Runtime's native addon from node_modules at run time (vendor/laya-ts imports it lazily).
const sort = { ...node, external: ['electron', 'onnxruntime-node', 'onnxruntime-web'] }

await Promise.all([
  build({ ...node, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' }),
  build({ ...node, entryPoints: ['src/sync/host.ts'], outfile: 'dist/sync/host.js' }),
  build({ ...sort, entryPoints: ['src/sort/host.ts'], outfile: 'dist/sort/host.js' }),
  // Sandboxed preloads can only require('electron'), so everything else is bundled in.
  build({ ...node, entryPoints: ['src/preload/tab.ts'], outfile: 'dist/preload/tab.js' }),
  build({ ...node, entryPoints: ['src/preload/strip.ts'], outfile: 'dist/preload/strip.js' }),
  build({ ...node, entryPoints: ['src/preload/guide.ts'], outfile: 'dist/preload/guide.js' }),
  build({
    ...common,
    platform: 'browser',
    format: 'iife',
    entryPoints: { app: 'src/renderer/app/index.tsx', strip: 'src/renderer/strip/index.tsx', guide: 'src/renderer/guide/index.tsx' },
    outdir: 'dist/renderer',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') }
  })
])
cpSync('static', 'dist/renderer', { recursive: true })
// Kestrel Sort's GPU worker runs in laya-mps's Python, so it ships as source beside host.js.
cpSync('src/sort/gpu_worker.py', 'dist/sort/gpu_worker.py')
if (watch) console.log('watch mode not implemented; rerun npm run build')
