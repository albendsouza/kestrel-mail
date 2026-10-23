# Development

## Layout

| Path | What's there |
|---|---|
| `src/main` | Electron main process: windows and tabs, Google sign-in, the encrypted store, menus, starting Sync and Sort, and the smoke-test driver |
| `src/sync` | Kestrel Sync: `engine.ts` (the mail model), `providers/` (Gmail, demo, the tour's practice inbox), `split.ts`, `sorter.ts`, `mime.ts` |
| `src/sort` | Kestrel Sort: runs Laya |
| `src/shared` | Types and logic both sides use: `types.ts`, `sorting.ts` (Laya's questions and the label and split rules), date parsing, credentials |
| `src/renderer` | React UI: `app` (the mail view, sidebar, tour, keys), `strip` (tab strip), `guide` (the Google setup guide) |
| `src/preload` | Sandboxed preload scripts, one per kind of view |
| `vendor/laya-ts` | Laya's TypeScript runtime, vendored (it isn't on npm). Changes are marked `// Kestrel:` |
| `scripts` | Build, smoke-test launcher, and `laya/` (install, training rows, scoring) |
| `static` | CSS and HTML shells copied into `dist/renderer` |
| `tests` | Vitest unit tests |

`npm run build` bundles each entry point with esbuild into `dist/`.
`onnxruntime-node` stays external, loaded from `node_modules` at run time, and is
unpacked from the asar in release builds.

## Tests

```bash
npm test            # unit tests
npm run typecheck   # TypeScript, including tests and the vendored Laya runtime
npm run smoke       # the real app on the demo inbox, driven by keyboard
npm run smoke:all   # also the tour, the setup guide and the client form
npm run smoke:live  # read-only checks on your signed-in Gmail
```

- **Unit tests** cover the engine (sync, outbox, undo, reminders, folders, Done's
  three kinds, sorting with a fake sorter, corrections, filing, rescue), the Gmail
  provider against a fake API (batching, the quota budget, snapshots), sorting
  rules, MIME, dates and keys.
- **`smoke`** launches Electron with a throwaway profile on the demo inbox and checks
  each feature end to end. If a Laya model is installed, it sorts with it. Results and
  screenshots go to `out/smoke`.
- **`smoke:live`** copies your Kestrel data to a temporary profile, starts Kestrel in
  a read-only mode where every change to Gmail is refused, checks sync, folders,
  labels and sorting, and deletes the copy afterwards. Results go to `out/smoke-live`.
  It may contain your mail's subjects, and `out/` is git-ignored.

Machine-specific settings go in `kestrel.local.json` (git-ignored), for example
`{ "googleCredentials": "/path/to/client_secret.json" }`. The smoke tests use that
client.

## Useful environment variables

| Variable | Effect |
|---|---|
| `KESTREL_DEMO=1` | demo inbox instead of your accounts (`npm run demo`) |
| `KESTREL_GOOGLE_CREDENTIALS` | path to a Google `client_secret_….json` |
| `KESTREL_GOOGLE_CLIENT_ID`, `KESTREL_GOOGLE_CLIENT_SECRET` | the client as values; release builds need these |
| `KESTREL_USER_DATA` | another profile folder |
| `KESTREL_LAYA_MODEL` | another Laya model folder |
| `KESTREL_GMAIL_UNITS_PER_MINUTE` | Gmail quota pace (default 2,400) |
| `KESTREL_READ_ONLY=1` | refuse every change to Gmail (used by `smoke:live`) |
| `KESTREL_DEMO_LATENCY_MS` | fake network delay in demo mode |

## Laya scripts

| Script | What it does |
|---|---|
| `npm run laya:install -- <folder> [--id name] [--questions file]` | installs an ONNX model where Kestrel Sort looks for it, with a checksum manifest |
| `node scripts/laya/rows.mjs <files> --out <dir> [--topics file]` | turns labelled emails into Laya training rows, holding out a test slice |
| `node scripts/laya/eval.mjs <model> <files>` | scores a model the way Kestrel runs it |

[smart-inbox.md](smart-inbox.md) has the full training workflow.
