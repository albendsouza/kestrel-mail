# Development

## Layout

| Path | What's there |
|---|---|
| `src/main` | Electron main process: windows and tabs, Google sign-in, the encrypted store, menus, starting Sync and Sort, Turn on smart sorting (`sorting-setup.ts`), and the smoke-test driver |
| `src/setup` | Smart-sorting setup shared by the app and `npm run laya:setup`: uv, laya-mps, its Python environment, Laya's checkpoint, installing a model |
| `src/sync` | Kestrel Sync: `engine.ts` (the mail model), `providers/` (Gmail, demo, the tour's practice inbox), `split.ts`, `sorter.ts`, `mime.ts` |
| `src/sort` | Kestrel Sort: runs Laya, on the GPU through a Python worker (`gpu.ts`, `gpu_worker.py`) or on the CPU |
| `src/shared` | Types and logic both sides use: `types.ts`, `sorting.ts` (Laya's questions and the label and split rules), `signals.ts` (the learned signal layer), date parsing, credentials |
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
  each feature end to end. If a Laya model is installed, it sorts with it. On Apple
  silicon it starts with no model and clicks Turn on smart sorting, which copies the
  installed model in instead of downloading. Results and screenshots go to `out/smoke`.
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
| `KESTREL_LAYA_DEVICE=cpu` | sort on the CPU even when the model has a GPU checkpoint |
| `KESTREL_SORTING_SETUP_FROM` | smoke tests: Turn on smart sorting copies this model folder in instead of downloading |
| `KESTREL_GMAIL_UNITS_PER_MINUTE` | Gmail quota pace (default 2,400) |
| `KESTREL_READ_ONLY=1` | refuse every change to Gmail (used by `smoke:live`) |
| `KESTREL_DEMO_LATENCY_MS` | fake network delay in demo mode |
| `KESTREL_SMOKE_DESIGN_QUERY`, `KESTREL_SMOKE_DESIGN_COUNT` | `smoke:live` only: for mail matching a Gmail search, report which backgrounds each email uses and whether Kestrel keeps it on a light page (sender domains and colours only, never content) |

## Laya scripts

| Script | What it does |
|---|---|
| `npm run laya:setup [-- --checkpoint dir] [--laya-mps dir] [--force]` | Apple silicon: what Turn on smart sorting does, from the terminal (uv, laya-mps, Python, a Laya checkpoint) |
| `npm run laya:fit -- --labels file [--test file] [--dry-run]` | fits the learned signal layer for the installed model from checked labels and `L` corrections, scores a held-out set before and after, and installs `combiner.json` ([smart-inbox.md](smart-inbox.md#the-learned-signal-layer)) |
| `npm run laya:install -- <folder> [--id name] [--questions file]` | installs an ONNX model where Kestrel Sort looks for it, with a checksum manifest |
| `... --torch <checkpoint> --gpu <laya-mps> [--gpu-memory reduced]` | also installs the PyTorch checkpoint, so Sort runs Laya on the GPU ([smart-inbox.md](smart-inbox.md#on-the-gpu)) |
| `node scripts/laya/rows.mjs <files> --out <dir> [--topics file]` | turns labelled emails into Laya training rows, holding out a test slice |
| `node scripts/laya/eval.mjs <model> <files>` | scores a model the way Kestrel runs it |

[smart-inbox.md](smart-inbox.md) has the full training workflow.
