# Kestrel

A keyboard-first desktop email client for Gmail, with a split inbox sorted by a
small AI model that runs entirely on your Mac.

Kestrel is built with Electron and React. It follows the architecture of
Superhuman's desktop app (one sync process, many windows, local-first), and its
smart inbox runs [Laya](https://github.com/NandhaKishorM/laya), an open encoder
model we fine-tuned on email. No email leaves the machine to be sorted.

- **Split inbox:** Important, To reply, Calendar, Codes, Updates and Other, decided
  by Laya on this Mac. A learned signal layer also weighs what Gmail already knows
  (importance, inbox tab, mailing lists, recipients) against Laya's answers, fitted
  from your own checked labels and corrections
  ([how](docs/smart-inbox.md#the-learned-signal-layer)).
- **Auto labels** on every conversation (To respond, FYI, Calendar, Code,
  Security, Finance, Purchase, Travel, Marketing, News, Social, Pitch…), listed in
  the sidebar.
- **Marketing skips the inbox:** marked done in Gmail with a `Kestrel/Marketing`
  label, once you say so.
- **Corrections teach it:** press `L` to relabel a sender. It applies at once, and
  becomes training data for the next model.
- **Done, three ways:** mail you finished, mail archived before you opened it, and
  mail Kestrel filed away. Laya can find mail from people in the second pile and
  bring it back.
- **Fast by design:** every action is instant and undoable, and the outbox syncs
  with Gmail in the background within its rate limits.

## Quick start

```bash
npm install
npm run demo      # a demo inbox with sample mail, no account needed
npm start         # your Gmail (see "Connect Gmail" below)
```

Requirements: Node 20 or newer and macOS. On a Mac with Apple silicon, Kestrel offers to
**turn on smart sorting** the first time it opens. One click installs
[laya-mps](https://github.com/afshinm/laya-mps) and Laya's model (see
[Smart sorting on Apple silicon](#smart-sorting-on-apple-silicon)). Until then Kestrel works
normally and keeps every conversation in Important.

## Smart sorting on Apple silicon

Kestrel runs Laya on the Mac's GPU with [laya-mps](https://github.com/afshinm/laya-mps) by
Afshin Mehrabani (MIT). laya-mps loads Laya's PyTorch weights onto Apple's Metal
Performance Shaders, the GPU backend PyTorch uses on a Mac. Every Mac with Apple silicon
uses it.

**Turn it on from the app.** A banner offers it the first time Kestrel opens. If you said
"Not now", use **Turn on** beside "Smart sorting is off" in the status bar, or ⌘K, then
*Turn on smart sorting*. Kestrel shows progress while it works, and you can keep using
it meanwhile. Nothing else needs installing first: no Homebrew, git or Python.

What it does, once (about 2 GB, a few minutes):

1. Downloads [uv](https://docs.astral.sh/uv/), the Python package manager laya-mps uses. It's
   a pinned release, checked against its published SHA-256.
2. Downloads laya-mps at the commit Kestrel was tested with, checked by a hash of its files.
3. Installs Python 3.12 and laya-mps's environment with PyTorch (`uv sync --locked`).
4. Downloads Laya's English checkpoint through laya-mps (843 MB) and installs it for Kestrel.

Everything goes in `~/Library/Application Support/kestrel-mail`; deleting that folder
removes it all. After setup, sorting works offline. If setup is interrupted, *Try again*
picks up where it stopped. From the terminal, `npm run laya:setup` runs the same steps.

| On an M4 Pro, per email | One new email | A backlog |
| --- | --- | --- |
| GPU, laya-mps | 42 ms | about 24 emails/s |
| CPU, ONNX Runtime | 254 ms | 3.3 emails/s |

Both give the same answers. If the GPU worker can't start, Kestrel says so in its log and
falls back to the CPU when the model has a CPU copy.

The English checkpoint isn't fine-tuned on email. On a hand-labelled real inbox it put 88%
of mail in the right split; Kestrel's fine-tuned model reached 95%, and it isn't published
yet. The terminal version takes options the app doesn't:
- `--checkpoint <folder>` installs your own checkpoint (a laya-train output).
- `--laya-mps <folder>` reuses a checkout you already have.
- `--force` replaces an installed model.
- `--gpu-memory minimal|reduced|full` picks laya-mps's memory setting. `reduced` is the
  default; `full` measured no faster.

On an Intel Mac, Kestrel sorts on the CPU with an ONNX model:
[docs/smart-inbox.md](docs/smart-inbox.md) explains how to convert, fine-tune and install one.

## Connect Gmail

Gmail needs a Google OAuth client. The easiest way: on the welcome screen click
**Walk me through it, step by step**. A small window stays on top of your browser,
links to each Google Cloud page in turn, and saves the client for you. You can
also drop in the `client_secret_….json` file Google gives you.

By hand:

1. In Google Cloud Console, create a project and enable the **Gmail API**.
2. Configure the OAuth consent screen. While testing, add yourself as a test user.
   Kestrel asks for the `gmail.modify` scope.
3. Create credentials: **OAuth client ID → Desktop app**.
4. Start Kestrel with the client:

```bash
KESTREL_GOOGLE_CREDENTIALS=/path/to/client_secret.json npm start
```

Click your account at the bottom of the sidebar to switch accounts, sign in to
another one, or **sign out**. Signing out revokes Kestrel's access with Google and
forgets the account on this Mac (its sign-in, cached mail, reminders and label
corrections); nothing in Gmail changes.

Sign-in uses PKCE and a loopback redirect on `127.0.0.1`, as Google recommends for
desktop apps. Refresh tokens are encrypted with the OS keychain through Electron
`safeStorage`. Release builds bake the client in, so their users only click
**Connect a Gmail account** (see [Packaging](#packaging)).

## The inbox

| Split | What lands there |
|---|---|
| **Important** | Mail from people that needs no reply (FYI), and automated notices that can't wait: security alerts, failed payments, deadlines |
| **To reply** | People asking you something or asking you to do something, oldest first |
| **Calendar** | Invitations, meeting updates, booking confirmations |
| **Codes** | One-time passwords and verification codes, kept out of Important |
| **Updates** | Routine notices: receipts, shipping, bank alerts, travel, app notices |
| **Other** | Pitches, newsletters, social networks, and marketing if you keep it in the inbox |

Mail Laya hasn't sorted yet stays in Important, so nothing new is ever hidden.
Threads where you wrote last stay in Important and show in **Waiting**.

The sidebar lists every **auto label** with a count; click one to see that mail
across all splits. Press `L` on a conversation to set the label for everything from
its sender. Your label beats Laya's, and it's saved as a training example.

**Marketing** can skip the inbox entirely. The first time Laya finds some, a banner
asks before anything moves. Say yes, and marketing is marked done in Gmail with
the label `Kestrel/Marketing`, now and as it arrives. Laya files mail only when
it's at least 80% sure, and never anything starred. Change your mind with
**Marketing: filed away / in inbox** in the sidebar.

**Done** has three tabs:

- **Done:** mail you read and archived, plus anything you marked done here with `E`.
- **Never opened:** mail archived while unread, by Gmail or another app.
  **Find mail from people** has Laya read it and offer back what it would have put
  in Important, To reply or Calendar.
- **Skipped inbox:** marketing Kestrel filed away for you.

The inbox window (**Inbox: last 2 weeks** in the sidebar) only decides how far back
the inbox reaches. It never archives anything.

## Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| `j` / `k` | next / previous | `Enter` / `o` | open |
| `e` | mark done (archive) | `#` | trash |
| `s` | star | `U` | read / unread |
| `r` / `a` / `f` | reply / reply all / forward | `c` | compose |
| `z` | undo | `/` | search (Gmail syntax) |
| `Tab` / `Shift+Tab` | next / previous split | `l` | label this sender (teaches Laya) |
| `h` | remind me ("2d", "fri 3pm", "oct 30") | `g h` | Reminders |
| `g i` | inbox | `g e` | Done |
| `g r` / `g w` | To reply / Waiting | `g u` | Senders (clean up) |
| `g d` / `g t` | Drafts / Sent | `g s` | starred in the inbox |
| `⌘U` | unsubscribe and clear that sender | `Shift+E` | move back to the inbox |
| `g a` | email stats | `g y` | resync with Gmail |
| `⌘K` | command palette | `?` | all shortcuts |
| `⌘↵` | send (10 s undo) | `⌘T`, `⌘1–9` | new tab / switch tab |
| `i` | load remote images | `Esc` | back |

New users start with a two-minute guided tour in a throwaway practice inbox. Replay
it with `⌘K` → *Take the guided tour*.

## More features

- **Reminders** (`h`): a conversation leaves the inbox until the time you pick, then
  comes back on top. In Gmail it looks archived; the reminder lives on this Mac.
- **Senders** (`g u`): who fills your inbox, most mail first. `e` marks all of a
  sender's mail done; `⌘U` unsubscribes (one-click where supported) and clears them.
- **Reply Zero:** To reply, and Waiting for mail you sent that nobody has answered.
- **Gmail folders and labels** in the sidebar, with colours and counts. Hide labels
  you don't want to see; they stay in Gmail.
- **Resync with Gmail** (`g y`) checks labels, folders and the inbox against Gmail,
  fetching only what changed.
- **Stats** (`g a`): this week's mail in, done and sent.

## How it works

```
main process ─┬─ utilityProcess "Kestrel Sync"   one AccountEngine per account:
              │                                   cache, outbox, undo, Gmail sync
              ├─ utilityProcess "Kestrel Sort"   Laya on the GPU (PyTorch MPS worker)
              │        ▲  MessagePort              or the CPU (ONNX Runtime), sorts
              │        │                           threads for the engines
              │        └──────────────── Sync
              └─ windows: a tab strip plus one sandboxed React view per tab,
                 each talking straight to Sync over its own MessagePort
```

- **Local-first.** The UI reads only from the engine's cache, saved to disk. Actions
  apply at once and queue in an outbox that retries.
- **Gmail sync:** a snapshot of what the inbox window covers, then `history.list`
  every 30 s, with thread details fetched 25 at a time through Gmail's batch
  endpoint. A token-bucket budget keeps Kestrel inside Gmail's per-user quota.
- **Sorting** runs in its own low-priority process, so it never slows the app. It uses
  the Mac's GPU when laya-mps is set up, which leaves the CPU free. Each thread is
  sorted once per Gmail version and model, and Sort exits when idle to give the
  model's memory back.

Details: [docs/architecture.md](docs/architecture.md) and
[docs/smart-inbox.md](docs/smart-inbox.md).

## Security and privacy

- All UI is served from a custom `kestrel://app` origin with a strict CSP. Every
  view is sandboxed with context isolation. IPC only accepts Kestrel's own pages,
  and the main process decides which account a tab belongs to.
- Email HTML is sanitized with DOMPurify and rendered in an iframe that can't run
  scripts. Remote images (tracking pixels) stay blocked until you press `i`.
- Sorting, corrections and training data stay on your Mac. Kestrel never
  auto-deletes or sends; the only automatic Gmail change is filing marketing,
  and only after you've said yes.

## Development

```bash
npm test             # unit tests (engine, Gmail provider against a fake API, sorting, MIME, keys)
npm run typecheck
npm run smoke        # launches the real app on the demo inbox and drives it by keyboard
npm run smoke:all    # also the first-run flows: tour, setup guide, client form
npm run smoke:live   # read-only checks on your real account (Kestrel refuses every Gmail change)
```

See [docs/development.md](docs/development.md) for the layout of the code, test
modes and the Laya scripts.

## Packaging

`npm run dist` builds installers into `release/` with electron-builder: a `.dmg`
and `.zip` for Apple silicon and Intel on a Mac. Release builds need the Google
client baked in:

```bash
KESTREL_GOOGLE_CLIENT_ID=... KESTREL_GOOGLE_CLIENT_SECRET=... npm run dist
```

For signing and notarization, set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID`, with a Developer ID certificate in your keychain. To test
packaging without one, add `CSC_IDENTITY_AUTO_DISCOVERY=false`.

To let anyone sign in, set the OAuth consent screen to **External** and publish it.
Until Google verifies the app, at most 100 users can ever sign in and they see an
"unverified app" warning. `gmail.modify` is a restricted scope, so verification
asks for a privacy policy, a demo video and possibly a security assessment.

## Not built yet

Attachments, rich-text compose, Gmail push through Pub/Sub (Kestrel polls every
30 s), IMAP and Outlook, snippets, Apple's on-device model as a second opinion on
uncertain mail, publishing Kestrel's fine-tuned model, and trying Turn on smart sorting in
a packaged release build. It downloads the same way as from source, but hasn't been tested
there.

## Credits

- [Laya](https://github.com/NandhaKishorM/laya) by Convai Innovations
  (Apache-2.0). Kestrel vendors its TypeScript runtime in `vendor/laya-ts` and
  fine-tunes its multilingual checkpoint.
- [laya-mps](https://github.com/afshinm/laya-mps) by Afshin Mehrabani (MIT) runs Laya
  on the Mac's GPU. Turn on smart sorting (or `npm run laya:setup`) installs it at a
  pinned commit, and Kestrel's GPU worker uses its loader in its environment. No
  laya-mps code is copied into this repo.
- [Inbox Zero](https://github.com/elie222/inbox-zero) inspired Senders, Reply Zero
  and stats. No Inbox Zero code is included.
- Superhuman inspired the architecture and the split inbox. No Superhuman code or
  servers are used.

Kestrel is MIT-licensed (see [LICENSE](LICENSE)).
