# Architecture

Kestrel is an Electron app with three kinds of process. The main process owns
windows, sign-in and menus. One **Kestrel Sync** utility process owns all mail
data. One **Kestrel Sort** utility process runs the Laya model. The UI never talks
to Gmail itself.

```
main process (src/main)
 ├─ windows: a tab strip view and one WebContentsView per tab (src/renderer)
 ├─ Kestrel Sync (src/sync/host.ts) ── one AccountEngine per account
 │     ▲   ▲
 │     │   └── MessagePort per tab: requests, responses, engine events
 │     └────── MessagePort to Sort
 └─ Kestrel Sort (src/sort/host.ts) ── Laya on the GPU (Python worker, PyTorch MPS)
                                       or on the CPU (ONNX Runtime)
```

The main process creates each `MessageChannel` and hands one end to each side, so
tabs and Sort talk to Sync directly. If Sync crashes, main restarts it (up to five
times) and gives every tab a fresh port; the tab client replays requests that were
in flight. Sort exits after five idle minutes to free the model's memory, and main
starts a new one straight away. It stays small until it has mail to sort.

Turn on smart sorting also runs in the main process (src/main/sorting-setup.ts, with
src/setup/laya.ts doing the work). It downloads and installs laya-mps and Laya's model
with child processes, sends progress to every tab, and restarts Sort when it's done.
The new Sort's port makes Sync sort whatever is waiting.

## The engine (src/sync/engine.ts)

`AccountEngine` is the whole mail model for one account. Everything the UI shows
comes from it.

- **Cache.** Inbox threads (summaries, not bodies), reminders, Laya's verdicts,
  your label corrections and settings, saved to
  `~/Library/Application Support/kestrel-mail/sync/cache-<account>.json` through a
  serialized write queue.
- **Outbox.** Every action (archive, star, read, file away…) changes the cache at
  once, joins the outbox and is sent to Gmail in order, with retries. When a sync
  returns server data the outbox hasn't reached yet, local state wins until the
  next sync. Undo pushes the inverse action.
- **Views.** `listThreads(split)` answers every list in the app: the inbox splits,
  Done's three tabs, folders and labels, Senders, Waiting, Reminders, auto labels
  and search. Server-backed views (Done, folders) are fetched on demand with short
  TTLs and shared between tabs.
- **Inbox window.** The snapshot covers `in:inbox newer_than:Nd` (optionally
  `{… is:unread}`). The window only limits what Kestrel shows; it never archives.

## Gmail (src/sync/providers/gmail.ts)

- **Sync.** A full snapshot lists every thread the inbox window covers, then
  fetches summaries 25 at a time through Gmail's batch endpoint, newest first. After
  that, `history.list` every 30 s returns only what changed. Each thread carries
  Gmail's `historyId`, so a re-snapshot or resync skips threads that haven't
  changed.
- **Quota.** Gmail allows about 6,000 query units per user per minute by default.
  A token bucket (2,400 units a minute, a burst of 400) paces every call. Background
  work leaves 30% of the bucket for what you're doing. On a quota error it pauses
  (30 s, 60 s, then 2 min, or whatever Retry-After says) and halves its rate, then
  recovers by a quarter each calm minute. `KESTREL_GMAIL_UNITS_PER_MINUTE`
  overrides the rate.
- **Lanes.** Opening a thread uses the interactive lane, so it never waits behind
  background sync.

`DemoProvider` (src/sync/providers/demo.ts) implements the same interface in
memory, for demo mode, the tour and tests.

## Sorting

[smart-inbox.md](smart-inbox.md) covers what Laya is asked and how answers become
splits. Mechanically:

1. After each sync the engine queues inbox threads that have no verdict for their
   current version and model, newest first, 8 per request.
2. `PortSorter` (src/sync/sorter.ts) sends them to Sort and waits. It gives up only
   if Sort's port closes (Sort crashed or exited) or after 10 minutes.
3. Sort (src/sort/host.ts) loads the model on first use. If the model folder has a GPU
   checkpoint and a `gpu.json`, Sort starts a Python worker (src/sort/gpu.ts and
   gpu_worker.py) that runs Laya on the Mac's GPU through laya-mps, one email per pass.
   It exits with Sort, and its stdin closing stops it too. Otherwise, or if the worker
   fails, Sort uses ONNX Runtime at low process priority on half the cores. There it runs
   four threads per pass with the memory arena turned off, so memory is released after
   every pass.
4. Verdicts are stored with the thread version and the model's name. Installing a
   new model re-sorts the inbox.

## Windows and security (src/main)

- All UI loads from `kestrel://app`, served from the built files with a path
  traversal guard and a strict CSP. Views run with `sandbox` and `contextIsolation`.
- `src/main/security.ts` accepts IPC only from the top-level frame of a
  `kestrel://app` page. The main process binds each tab to an account; a renderer
  can't pick one.
- Email HTML goes through DOMPurify and renders in a sandboxed iframe that can't run
  scripts, with its own CSP. Remote images stay blocked until you press `i`.
- Sign-in (src/main/google-auth.ts) uses OAuth with PKCE and a loopback redirect.
  Refresh tokens are encrypted with `safeStorage` (the OS keychain).
