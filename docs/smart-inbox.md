# Smart inbox

Kestrel sorts mail with [Laya](https://github.com/NandhaKishorM/laya), an
Apache-2.0 encoder model that answers typed questions about text in one pass. It
generates no text, so there's nothing to parse and nothing it can make up. Kestrel
runs it on the Mac's CPU through ONNX Runtime. There are no hand-written sorting
rules: an earlier rules-first version was built, tried on a real inbox and dropped.

## What Laya is asked

The questions live in one place, `src/shared/sorting.ts`, and both the app and the
training scripts use them, so the model always sees exactly what it was trained on.

| Question | Type | Answers |
|---|---|---|
| `kind` | choice of 7 | person, pitch, marketing, newsletter, social, notification, calendar |
| `needs_reply` | yes/no | does it ask you something or ask you to do something? |
| `urgent` | yes/no | time-sensitive today: security alert, login code, payment problem, deadline, meeting today |
| `topic` | choice of 6, notices only | code, security, money, purchase, travel, other |

Laya reads what an inbox row shows: sender, subject, the snippet (up to 300
characters), and whether the mail came through a mailing list (a List-Unsubscribe
header). Sorting adds no Gmail calls.

A model only gets the `topic` question if its `questions.json` says it was trained
on it; older models are asked the first three.

## From answers to splits and labels

`labelsFor()` in `src/shared/sorting.ts`:

| Laya says | Auto label | Split |
|---|---|---|
| person, needs a reply | To respond | To reply |
| person, no reply needed | FYI | Important |
| calendar | Calendar | Calendar |
| notification, topic code | Code | Codes |
| notification, urgent | Important update (+ Security, Finance…) | Important |
| notification, routine | Security, Finance, Purchase, Travel or Notification | Updates |
| pitch / marketing / newsletter / social | Pitch / Marketing / News / Social | Other |

Marketing that Laya is at least 80% sure of is filed away (marked done with the
Gmail label `Kestrel/Marketing`) once you've agreed to it. Starred mail never is.

## Corrections

`L` sets a label for a sender. `verdictFor()` turns the label back into the answers
that would produce it, so a correction sorts exactly as if Laya had said it. It
applies to all of that sender's mail at once, outranks Laya, and is logged
(`correctionLog` in the cache) as a training example. On mail that was filed away,
any other label brings it back to the inbox.

## Rescue

**Done → Never opened → Find mail from people** reads mail archived while unread
(up to 1,500 conversations from the last 90 days or the inbox window, whichever is
longer). Laya sorts it, and whatever it would have put in Important, To reply or
Calendar is offered back. The Gmail summaries go through the background quota lane,
so a large Done takes a few minutes, with progress shown.

## Models

Laya's official checkpoints ship as PyTorch weights only. Kestrel needs ONNX, made
once with Laya's own export script and checked against PyTorch to within 1e-4:

```bash
python laya-ts/scripts/export_onnx.py --repo convaiinnovations/laya --subfolder multilingual --out-dir ./model
npm run laya:install -- ./model --id laya-multilingual-base
```

`laya:install` copies the model to
`~/Library/Application Support/kestrel-mail/models/laya-email` with a manifest of
SHA-256 sums. Pass `--questions <checkpoint>/questions.json` for a model trained
with topics. `KESTREL_LAYA_MODEL` points Kestrel at another folder.

### Which checkpoint

| Checkpoint | Speed (M4 Pro CPU) | Zero-shot kind accuracy | Fine-tune time (MPS) |
|---|---|---|---|
| English (ModernBERT-large, 421M) | about 0.35 s per email | 61% (best zero-shot) | over 4 hours |
| Multilingual (mmBERT, 322M) | about 0.13 to 0.2 s per email | 32% | about 20 minutes |

Zero-shot, neither is good enough. Fine-tuned, the multilingual checkpoint is fast,
small and accurate, and it reads Hinglish, so Kestrel uses it.

### Fine-tuning

Training rows are built from labelled emails with `scripts/laya/rows.mjs`, which
asks the same questions Kestrel Sort asks:

```bash
node scripts/laya/rows.mjs data/*.jsonl --out rows --topics data/topics.jsonl
laya-train --data rows/train.jsonl --base <multilingual checkpoint> --out ft \
  --device mps --shuffle-options --label-smoothing 0.05 --epochs 3
python laya-ts/scripts/export_onnx.py --model-dir ft --out-dir model
node scripts/laya/eval.mjs model rows/test.jsonl golden.jsonl
```

Each input line is `{from, subject, body, mailing_list, kind, needs_reply, urgent,
topic?}`, or `{…, label}` for a correction exported from Kestrel. `rows.mjs` holds
out 15% of each kind for testing. `eval.mjs` scores a model the way Kestrel runs it,
reporting how often a thread lands in the right split, then each answer and the
worst mistakes.

The training data so far is about 3,100 synthetic emails written to look like a
VC's inbox in India, plus real corrections. Real mail used for testing never goes
into training. Training data and models are kept outside this repo.

### Results so far (first fine-tune)

| Test set | Right split: base → fine-tuned | Right kind: base → fine-tuned |
|---|---|---|
| 331 held-out sample emails | 78.5% → 95.5% | 61% → 97% |
| 177 threads from a real inbox, labelled by hand | 88.1% → 94.9% | 62% → 72% |

The first fine-tune's weak spots were security alerts and codes (it had no topic
question and too few urgent examples), short "Friday 12:30?"-style replies, and
promotions written to sound like a person. The next model is trained on all three.

## Not built yet

- Apple's on-device Foundation Models as a second opinion on low-confidence verdicts
  (it needs Apple Intelligence set up on the Mac).
- Hosting the fine-tuned model for download, so installs don't have to convert one.
- Trying ONNX Runtime's CoreML provider (Neural Engine and GPU) against the CPU.
