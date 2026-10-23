// Launches the built app and runs src/main/smoke.ts.
//   npm run smoke       everyday checks on the demo inbox, using your Google client from kestrel.local.json
//   npm run smoke:all   also the first-run flows: tour, setup guide, client form (no client set)
//   npm run smoke:live  read-only checks on your real signed-in account; Kestrel refuses to change Gmail
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'

const all = process.argv.includes('--all')
const live = process.argv.includes('--live')
const out = path.resolve(process.argv.slice(2).find(a => !a.startsWith('--')) ?? (live ? 'out/smoke-live' : 'out/smoke'))
const userData = mkdtempSync(path.join(os.tmpdir(), 'kestrel-smoke-'))

// kestrel.local.json (git-ignored) holds machine-specific settings, such as the path
// to your Google client JSON. Only the path is read here; the app reads the file.
const local = existsSync('kestrel.local.json') ? JSON.parse(readFileSync('kestrel.local.json', 'utf8')) : {}
const credentials = !all && local.googleCredentials && existsSync(local.googleCredentials) ? local.googleCredentials : undefined

if (live) {
  // A copy of your Kestrel data (accounts, encrypted sign-in, cache), so the run
  // never touches the real files. Deleted again at the end.
  const real = path.join(os.homedir(), 'Library', 'Application Support', 'kestrel-mail')
  if (!existsSync(path.join(real, 'kestrel.json'))) {
    console.error('smoke:live needs Kestrel signed in to Gmail at least once (npm start).')
    process.exit(1)
  }
  cpSync(path.join(real, 'kestrel.json'), path.join(userData, 'kestrel.json'))
  if (existsSync(path.join(real, 'sync'))) cpSync(path.join(real, 'sync'), path.join(userData, 'sync'), { recursive: true })
}

const args = ['.']
// Root in a container cannot use Chromium's sandbox; never needed for real use.
if (process.getuid?.() === 0) args.unshift('--no-sandbox')
const cmd = process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : electron
const cmdArgs = cmd === 'xvfb-run' ? ['-a', '-s', '-screen 0 1440x900x24', electron, ...args] : args
const env = {
  ...process.env,
  KESTREL_USER_DATA: userData,
  KESTREL_SMOKE_SCREENSHOT: out,
  KESTREL_SMOKE_SUITES: live ? 'live' : all ? 'all' : 'core'
}
// Laya's model lives outside the test profile (it's over a gigabyte); point Kestrel Sort at it.
const model = path.join(os.homedir(), 'Library', 'Application Support', 'kestrel-mail', 'models', 'laya-email')
if (!env.KESTREL_LAYA_MODEL && existsSync(model)) env.KESTREL_LAYA_MODEL = model
if (!env.KESTREL_LAYA_MODEL) console.log('smoke: no Laya model installed (npm run laya:install), so sorting checks will fail')
if (live) env.KESTREL_READ_ONLY = '1'
else Object.assign(env, { KESTREL_DEMO: '1', KESTREL_DEMO_LATENCY_MS: '700' })
// The first-run checks need a Kestrel with no client, so --all never passes one.
delete env.KESTREL_GOOGLE_CREDENTIALS
delete env.KESTREL_GOOGLE_CLIENT_ID
delete env.KESTREL_GOOGLE_CLIENT_SECRET
if (credentials) env.KESTREL_GOOGLE_CREDENTIALS = credentials
console.log(`smoke: ${live ? 'live, read-only, on your account' : all ? 'all suites' : 'core suites'}${credentials ? ', with your Google client' : ''}`)
const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env })
// The temp profile is test data (and, for --live, a copy of your sign-in): always remove it.
rmSync(userData, { recursive: true, force: true })
process.exit(res.status ?? 1)
